/**
 * ResendAdapter — implements ChannelAdapter for email via Resend.
 *
 * Replaces the prior SendGridAdapter after Twilio's fraud-team hard-rejected
 * the SendGrid account. Pub/Sub topology, message composer, action.executed
 * schema, and ActionOutcome all stay identical — provider swap only.
 *
 * Scope (post-swap):
 *   - sendSimpleMode: single global RESEND_API_KEY, configured from-address.
 *     This is the wedge-demo path (KAN-661 → KAN-662 territory).
 *   - connect/disconnect/healthCheck/handleWebhook: stubbed. The full epic
 *     (formerly KAN-473) is being re-scoped — Resend has no subuser /
 *     domain-auth-API equivalent; per-tenant identity will look different.
 */

// @ts-expect-error - html-to-text ships no types
import { convert as htmlToText } from 'html-to-text';
import { Resend } from 'resend';
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
import { classifyResendStatus } from './errors.js';
import { isSuppressedDb, suppressDb } from './suppressions.js';

// Lazy singleton — instantiating Resend at import time would force every
// connectors process boot to require RESEND_API_KEY, which we don't want
// (only the simple-mode send path actually needs it).
let resendClient: Resend | null = null;
function getResendClient(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!resendClient) resendClient = new Resend(key);
  return resendClient;
}

export class ResendAdapter implements ChannelAdapter {
  readonly channel = 'EMAIL' as const;
  readonly provider = 'resend';

  // ── connect() — stubbed; per-tenant Resend identity is re-scoped ──
  async connect(_tenant: TenantRef, _input: ConnectInput): Promise<ChannelConnection> {
    throw new Error(
      'ResendAdapter.connect() is not implemented. Per-tenant Resend identity (re-scoped from the SendGrid subuser model) lands in the rewritten KAN-473 epic. Use scripts/seed-resend-simple-mode.ts to seed a simple-mode ChannelConnection in the meantime.',
    );
  }

  // ── disconnect() — stubbed ────────────────────────────────
  async disconnect(_connection: ChannelConnection): Promise<void> {
    // No-op: simple-mode rows are removed via direct DB manipulation; per-tenant
    // Resend identity teardown lands with the rewritten KAN-473 epic.
  }

  // ── healthCheck() — stubbed ───────────────────────────────
  async healthCheck(_connection: ChannelConnection): Promise<HealthStatus> {
    // The simple-mode path doesn't have meaningful per-connection health
    // (one global API key serves all tenants). Reporting healthy here lets
    // the broader infra surface stay green; real per-tenant health checks
    // ship with the rewritten KAN-473 epic.
    return {
      healthy: true,
      reason: undefined,
      checkedAt: new Date().toISOString(),
    };
  }

  // ── send() ────────────────────────────────────────────────
  async send(connection: ChannelConnection, msg: OutboundMessage): Promise<SendResult> {
    if (!msg.recipient.email) {
      return {
        providerMessageId: '',
        status: 'failed',
        errorClass: 'permanent',
        errorMessage: 'Missing recipient email',
      };
    }

    // Only simple-mode is supported post-Resend-swap. Any non-simple-mode
    // ChannelConnection is treated as an error until the KAN-473 rewrite
    // defines a Resend-native multi-tenant model.
    const mode = (connection.metadata as Record<string, unknown> | undefined)?.mode;
    if (mode !== 'simple') {
      return {
        providerMessageId: '',
        status: 'failed',
        errorClass: 'permanent',
        errorMessage: `ResendAdapter only supports metadata.mode === 'simple' (got ${mode ?? 'undefined'}). Per-tenant Resend identity lands with the rewritten KAN-473 epic.`,
      };
    }

    return this.sendSimpleMode(connection, msg);
  }

  // ── sendSimpleMode() — wedge-demo path (KAN-661 → Resend) ──
  private async sendSimpleMode(
    connection: ChannelConnection,
    msg: OutboundMessage,
  ): Promise<SendResult> {
    const log = logger.child({
      connectionId: connection.id,
      actionId: msg.actionId,
      tenantId: msg.tenantId,
      mode: 'simple',
    });
    const email = msg.recipient.email!;

    const check = await isSuppressedDb(msg.tenantId, email);
    if (check.suppressed) {
      log.info({ email, reason: check.reason }, 'simple-mode send suppressed');
      return {
        providerMessageId: '',
        status: 'failed',
        errorClass: 'permanent',
        errorMessage: `Recipient suppressed: ${check.reason}`,
        metadata: { suppressed: true, reason: check.reason, mode: 'simple' },
      };
    }

    const resend = getResendClient();
    if (!resend) {
      log.error('RESEND_API_KEY env var not set in simple mode');
      return {
        providerMessageId: '',
        status: 'failed',
        errorClass: 'transient',
        errorMessage: 'RESEND_API_KEY not configured',
      };
    }

    const metadata = (connection.metadata ?? {}) as Record<string, unknown>;
    const fromEmail = (metadata.fromEmail as string | undefined) ?? 'hello@growth.axisone.ca';
    const fromName = (metadata.fromName as string | undefined) ?? 'growth';
    const replyTo = metadata.replyTo as string | undefined;

    const html = msg.content.html ?? wrapPlainTextAsHtml(msg.content.body);
    const text = htmlToText(html, { wordwrap: 130 });

    try {
      const result = await resend.emails.send({
        from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
        to: msg.recipient.displayName
          ? [`${msg.recipient.displayName} <${email}>`]
          : [email],
        subject: msg.content.subject ?? '(no subject)',
        html,
        text,
        ...(replyTo ? { replyTo } : {}),
        // Idempotency: Resend dedupes within the project for the configured
        // window (default 24h) when this header is set. KAN-660's actionId is
        // a UUID per-action; perfect natural key.
        headers: {
          'List-Unsubscribe':
            '<mailto:unsubscribe@growth.axisone.ca?subject=unsubscribe>',
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          'Idempotency-Key': msg.actionId,
        },
        // Resend tags map analogously to SendGrid customArgs/categories — used
        // for filtering in the Resend dashboard; KAN-684 webhook handler can
        // also key off them for correlation.
        tags: [
          { name: 'tenant_id', value: msg.tenantId },
          { name: 'action_id', value: msg.actionId },
          { name: 'connection_id', value: connection.id },
          { name: 'mode', value: 'simple' },
          ...(msg.traceId ? [{ name: 'trace_id', value: msg.traceId }] : []),
        ],
      });

      if (result.error) {
        // Resend SDK returns errors on the result object rather than throwing
        // for status-coded failures. Treat below.
        const statusCode =
          (result.error as { statusCode?: number }).statusCode ?? undefined;
        const cls = classifyResendStatus(statusCode);
        if (cls.sideEffect === 'suppress_contact') {
          await suppressDb(msg.tenantId, email, 'bounce').catch(() => undefined);
        }
        log.warn({ err: result.error, statusCode, cls }, 'simple-mode send rejected');
        return {
          providerMessageId: '',
          status: 'failed',
          errorClass: cls.errorClass,
          errorMessage: result.error.message ?? cls.description,
          metadata: { resendStatus: statusCode, sideEffect: cls.sideEffect, mode: 'simple' },
        };
      }

      const providerMessageId = result.data?.id ?? '';
      log.info({ providerMessageId }, 'simple-mode send ok');
      return {
        providerMessageId,
        status: 'sent',
        metadata: { mode: 'simple' },
      };
    } catch (err) {
      // Network errors or unexpected throws (Resend SDK shouldn't normally throw
      // for HTTP errors — those come back on result.error — but defend anyway).
      const e = err as { statusCode?: number; message?: string };
      const cls = classifyResendStatus(e.statusCode);
      if (cls.sideEffect === 'suppress_contact') {
        await suppressDb(msg.tenantId, email, 'bounce').catch(() => undefined);
      }
      log.warn({ err, statusCode: e.statusCode, cls }, 'simple-mode send threw');
      return {
        providerMessageId: '',
        status: 'failed',
        errorClass: cls.errorClass,
        errorMessage: e.message ?? cls.description,
        metadata: { resendStatus: e.statusCode, sideEffect: cls.sideEffect, mode: 'simple' },
      };
    }
  }

  // ── handleWebhook() — stubbed; KAN-684 will wire Resend webhooks ──
  async handleWebhook(_payload: unknown, _signature: string): Promise<InboundEvent[]> {
    // Resend webhook events (email.delivered, email.bounced, email.opened,
    // email.clicked, email.complained) ship with the KAN-684 webhook epic.
    return [];
  }
}

function wrapPlainTextAsHtml(body: string): string {
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><body><pre style="font-family:sans-serif;white-space:pre-wrap;">${escaped}</pre></body></html>`;
}
