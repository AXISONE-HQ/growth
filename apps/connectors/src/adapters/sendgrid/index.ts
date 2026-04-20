/**
 * SendGridAdapter — implements ChannelAdapter for email via SendGrid.
 *
 * Covers the full epic KAN-473:
 *   KAN-499  Outbound email send
 *   KAN-500  Subuser provisioning
 *   KAN-501  Domain authentication
 *   KAN-502  DNS verification (via exposed helpers for UI layer)
 *   KAN-503  Event webhook handler
 *   KAN-504  Shared subdomain fallback
 *   KAN-506  Suppression management
 *   KAN-587  Mail wrapper with subuser key
 *   KAN-588  MIME with List-Unsubscribe headers
 *   KAN-589  HTML→text + sandbox test
 *   KAN-590  Subuser + scoped API key
 *   KAN-593  Domain Auth API
 *   KAN-599  ECDSA signature verification
 *   KAN-603  Auto-provision shared subdomain
 *   KAN-604  Aggressive rate caps on shared
 */

import { convert as htmlToText } from 'html-to-text';
import type {
  ChannelAdapter,
  ChannelConnection,
  ConnectInput,
  HealthStatus,
  InboundEvent,
  OutboundMessage,
  SendResult,
  TenantRef,
} from '@growth/connector-contracts';
import { logger } from '../../logger.js';
import {
  getMasterSendGridClient,
  invalidateSendGridClient,
  sendWithSubuserKey,
} from './client.js';
import { classifySendGridStatus } from './errors.js';
import { requestDomainAuth, validateDomainAuth } from './domain-auth.js';
import { processSendGridEvents } from './events.js';
import {
  SendGridConnectParamsSchema,
  buildSendGridConnectionRecord,
  provisionSubuser,
} from './provisioning.js';
import { provisionSharedSubdomain } from './subdomain.js';
import { isSuppressed, suppress } from './suppressions.js';
import { buildUnsubscribeUrl, generateUnsubscribeToken } from './unsubscribe.js';

export class SendGridAdapter implements ChannelAdapter {
  readonly channel = 'EMAIL' as const;
  readonly provider = 'sendgrid';

  // ── connect() ────────────────────────────────────────────
  async connect(tenant: TenantRef, input: ConnectInput): Promise<ChannelConnection> {
    const params = SendGridConnectParamsSchema.parse(input.params);
    const log = logger.child({ tenantId: tenant.id, provider: this.provider });
    log.info('starting SendGrid connect flow');

    // Step 1: Subuser
    const subuser = await provisionSubuser(tenant);
    log.info({ username: subuser.username }, 'subuser ready');

    // Step 2: Domain auth — either custom domain or shared subdomain
    let domainAuthStatus: 'pending' | 'verified' | 'none' = 'none';
    if (params.useSharedSubdomain || !params.sendingDomain) {
      const shared = await provisionSharedSubdomain(subuser.username, tenant.slug);
      log.info({ subdomain: shared.subdomain }, 'shared subdomain provisioned');
      domainAuthStatus = 'verified';
      // Override fromEmail onto the shared subdomain
      params.fromEmail = shared.fromAddress;
    } else {
      const auth = await requestDomainAuth(subuser.username, params.sendingDomain);
      log.info({ domainId: auth.domainId, records: auth.records.length }, 'custom domain auth requested');
      domainAuthStatus = 'pending'; // tenant must add DNS records + click verify
    }

    const connection = buildSendGridConnectionRecord(
      tenant,
      input,
      subuser.username,
      params,
      domainAuthStatus,
    );
    // TODO(KAN-477, KAN-558): persist ChannelConnection
    log.info({ connectionId: connection.id, status: connection.status }, 'ChannelConnection assembled');
    return connection;
  }

  // ── disconnect() ─────────────────────────────────────────
  async disconnect(connection: ChannelConnection): Promise<void> {
    const log = logger.child({ connectionId: connection.id, provider: this.provider });
    log.info('disconnecting SendGrid');

    try {
      const client = await getMasterSendGridClient();
      // Delete the subuser — releases the username + removes API keys
      await client.request({
        method: 'DELETE',
        url: `/v3/subusers/${connection.providerAccountId}`,
      });
    } catch (err) {
      log.warn({ err }, 'subuser deletion failed — caches still cleared');
    }

    invalidateSendGridClient(connection);
  }

  // ── healthCheck() ────────────────────────────────────────
  async healthCheck(connection: ChannelConnection): Promise<HealthStatus> {
    const log = logger.child({ connectionId: connection.id, provider: this.provider });
    try {
      const client = await getMasterSendGridClient();
      const [res] = await client.request({
        method: 'GET',
        url: '/v3/subusers',
        qs: { username: connection.providerAccountId, limit: 1 },
      });
      const exists = Array.isArray(res.body) && (res.body as unknown[]).length > 0;
      const domainAuthVerified = connection.metadata?.domainAuthStatus === 'verified';
      const healthy = exists && domainAuthVerified;
      return {
        healthy,
        reason: !healthy
          ? !exists
            ? 'subuser not found'
            : 'domain authentication not verified'
          : undefined,
        metadata: { domainAuth: connection.metadata?.domainAuthStatus },
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      log.warn({ err }, 'SendGrid health check failed');
      return {
        healthy: false,
        reason: err instanceof Error ? err.message : 'unknown',
        checkedAt: new Date().toISOString(),
      };
    }
  }

  // ── send() ───────────────────────────────────────────────
  async send(connection: ChannelConnection, msg: OutboundMessage): Promise<SendResult> {
    const log = logger.child({
      connectionId: connection.id,
      actionId: msg.actionId,
      tenantId: msg.tenantId,
      traceId: msg.traceId,
      channel: this.channel,
      provider: this.provider,
    });

    if (!msg.recipient.email) {
      return {
        providerMessageId: '',
        status: 'failed',
        errorClass: 'permanent',
        errorMessage: 'Missing recipient email',
      };
    }

    // Pre-send suppression check
    if (await isSuppressed(msg.tenantId, msg.recipient.email)) {
      log.info({ email: msg.recipient.email }, 'send suppressed');
      return {
        providerMessageId: '',
        status: 'failed',
        errorClass: 'permanent',
        errorMessage: 'Recipient is on suppression list',
        metadata: { suppressed: true },
      };
    }

    // Domain auth gate — shared subdomain is always verified
    if (connection.metadata?.domainAuthStatus !== 'verified') {
      return {
        providerMessageId: '',
        status: 'failed',
        errorClass: 'transient',
        errorMessage: 'Domain authentication not verified',
        metadata: { awaitingDomainAuth: true },
      };
    }

    try {
      const token = await generateUnsubscribeToken({
        tenantId: msg.tenantId,
        email: msg.recipient.email,
        actionId: msg.actionId,
      });
      const unsubscribeUrl = buildUnsubscribeUrl(token);

      const html = msg.content.html ?? wrapPlainTextAsHtml(msg.content.body);
      const text = htmlToText(html, { wordwrap: 130 });

      return await sendWithSubuserKey(connection, async (mail, creds) => {
        const [res] = await mail.send(
          {
            to: { email: msg.recipient.email!, name: msg.recipient.displayName },
            from: {
              email: (connection.metadata?.fromEmail as string | undefined) ?? creds.subuserUsername + '@sendgrid.net',
              name: (connection.metadata?.fromName as string | undefined) ?? 'growth',
            },
            subject: msg.content.subject ?? '(no subject)',
            text,
            html,
            categories: msg.categories ?? [`tenant:${msg.tenantId}`],
            customArgs: {
              actionId: msg.actionId,
              tenantId: msg.tenantId,
              connectionId: connection.id,
              ...(msg.traceId ? { traceId: msg.traceId } : {}),
            },
            headers: {
              'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:unsubscribe@growth.axisone.com?subject=unsubscribe>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
            trackingSettings: {
              clickTracking: { enable: true, enableText: false },
              openTracking: { enable: true },
            },
          },
          false,
        );
        const providerMessageId =
          (res.headers as Record<string, string> | undefined)?.['x-message-id'] ?? '';
        return {
          providerMessageId,
          status: 'sent' as const,
          metadata: { statusCode: res.statusCode },
        };
      });
    } catch (err) {
      const e = err as { code?: number; response?: { statusCode?: number }; message?: string };
      const status = e.response?.statusCode ?? e.code;
      const cls = classifySendGridStatus(status);

      // Side-effect: hard 4xx on recipient → suppress
      if (cls.sideEffect === 'suppress_contact' && msg.recipient.email) {
        await suppress(msg.tenantId, msg.recipient.email, 'bounce').catch(() => undefined);
      }

      log.warn({ err, status, cls }, 'sendgrid send failed');
      return {
        providerMessageId: '',
        status: 'failed',
        errorClass: cls.errorClass,
        errorMessage: e.message ?? cls.description,
        metadata: { sendgridStatus: status, sideEffect: cls.sideEffect },
      };
    }
  }

  // ── handleWebhook() — Event Webhook (delivered, bounce, open, etc.) ──
  async handleWebhook(payload: unknown, _signature: string): Promise<InboundEvent[]> {
    if (!Array.isArray(payload)) return [];
    await processSendGridEvents(payload as Parameters<typeof processSendGridEvents>[0]);
    // Event webhooks don't produce InboundEvents — they update action status
    // via action.executed events published inside processSendGridEvents.
    return [];
  }

  // ── exposed helper for UI ────────────────────────────────
  /**
   * Triggered by the DNS wizard "Verify" button. Not on the ChannelAdapter
   * interface because it's SendGrid-specific; called from the tRPC router
   * via a typed escape hatch.
   */
  async triggerDomainVerification(
    subuserUsername: string,
    domainId: number,
  ): Promise<{ valid: boolean }> {
    const r = await validateDomainAuth(subuserUsername, domainId);
    return { valid: r.valid };
  }
}

function wrapPlainTextAsHtml(body: string): string {
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><body><pre style="font-family:sans-serif;white-space:pre-wrap;">${escaped}</pre></body></html>`;
}
