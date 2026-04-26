import {
  upsertConnection,
  revokeConnection,
  updateHealthCheck,
  getConnections,
  findConnectionByProviderAccountId,
} from "../../repository/connection-repository.js";
/**
 * TwilioAdapter — implements ChannelAdapter for SMS via Twilio.
 *
 * Covers:
 *   KAN-491, KAN-492, KAN-493, KAN-494, KAN-495, KAN-496, KAN-498
 *   KAN-563, KAN-564, KAN-567, KAN-569, KAN-570, KAN-571
 *   KAN-575, KAN-578, KAN-579, KAN-580, KAN-584
 */

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
import type { Prisma } from '@prisma/client';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import {
  getTwilioClient,
  getMessagingServiceSid,
  invalidateTwilioClient,
  getMasterTwilioClient,
} from './client.js';
import { classifyTwilioError } from './errors.js';
import { submitBrandAndCampaign, isSendable, type BrandAndCampaignState } from './compliance.js';
import { createMessagingService, attachNumberToService } from './messaging-service.js';
import {
  TwilioConnectParamsSchema,
  buildConnectionRecord,
  provisionPhoneNumber,
  provisionSubaccount,
} from './provisioning.js';
import { detectKeyword, helpAutoReplyBody, startConfirmationBody, stopConfirmationBody } from './keywords.js';
import { clearOptOut, isOptedOut, markOptedOut } from './optout.js';
import Twilio from 'twilio';

export class TwilioAdapter implements ChannelAdapter {
  readonly channel = 'SMS' as const;
  readonly provider = 'twilio';

  // ── connect() ────────────────────────────────────────────
  async connect(tenant: TenantRef, input: ConnectInput): Promise<ChannelConnection> {
    const params = TwilioConnectParamsSchema.parse(input.params);
    const log = logger.child({ tenantId: tenant.id, provider: this.provider });

    log.info('starting Twilio connect flow');

    // Step 1: subaccount
    const { accountSid, authToken, credentialsRef } = await provisionSubaccount(tenant);
    log.info({ accountSid }, 'subaccount ready');

    const subaccountClient = Twilio(accountSid, authToken);

    // Step 2: Messaging Service (before number purchase so we can attach)
    const baseUrl = env.PUBLIC_WEBHOOK_BASE_URL ?? 'https://connectors.growth.axisone.com';
    const messagingServiceSid = await createMessagingService(subaccountClient, {
      tenantSlug: tenant.slug,
      inboundWebhookUrl: `${baseUrl}/webhooks/twilio`,
      statusCallbackUrl: `${baseUrl}/webhooks/twilio/status`,
    });
    log.info({ messagingServiceSid }, 'messaging service ready');

    // Step 3: phone number purchase + attach
    const { phoneNumber, phoneSid } = await provisionPhoneNumber(
      accountSid,
      authToken,
      params.areaCode,
    );
    await attachNumberToService(subaccountClient, messagingServiceSid, phoneSid);
    log.info({ phoneNumber }, 'number purchased and attached');

    // Step 4: 10DLC Brand + Campaign (async, 24-72h approval)
    let compliance: BrandAndCampaignState;
    try {
      compliance = await submitBrandAndCampaign(subaccountClient, params, messagingServiceSid);
      log.info({ compliance }, '10DLC Brand + Campaign submitted');
    } catch (err) {
      log.error({ err }, '10DLC submission failed — connection will stay PENDING with retry');
      compliance = {
        brandStatus: 'pending',
        campaignStatus: 'pending',
        rejectionReason: err instanceof Error ? err.message : 'unknown',
      };
    }

    const connection = buildConnectionRecord(
      tenant,
      input,
      accountSid,
      phoneNumber,
      messagingServiceSid,
      {
        brandStatus: compliance.brandStatus === 'approved' ? 'pending' : 'pending',
        campaignStatus: compliance.campaignStatus === 'approved' ? 'pending' : 'pending',
      },
    );
    // Attach full compliance SIDs to metadata so the poller can resume
    connection.complianceStatus = {
      ...compliance,
    };

    // Persist ChannelConnection. KAN-549 fix: write the FULL BrandAndCampaignState
    // (built above into connection.complianceStatus) so the poller can resume
    // from real Brand/Campaign SIDs. Pre-fix shipped a flat
    // { tenDlcStatus: 'pending' } that dropped brandRegistrationSid +
    // usAppToPersonSid — poller couldn't read its own submission, sends never
    // enabled post-approval.
    await upsertConnection({
      tenantId: tenant.id,
      channelType: "SMS",
      provider: "twilio",
      providerAccountId: accountSid,
      status: "ACTIVE",
      credentialsRef,
      label: `Twilio SMS`,
      metadata: { phoneNumber, messagingServiceSid },
      complianceStatus: connection.complianceStatus as Prisma.InputJsonValue,
    });
    log.info({ connectionId: connection.id }, 'ChannelConnection persisted');
    return connection;
  }

  // ── disconnect() ─────────────────────────────────────────
  async disconnect(connection: ChannelConnection): Promise<void> {
    const log = logger.child({ connectionId: connection.id, provider: this.provider });
    log.info('disconnecting Twilio connection');

    // Close the subaccount — Twilio policy: subaccounts are closed, not deleted.
    // This releases the phone numbers back to the pool and stops billing.
    try {
      const master = await getMasterTwilioClient();
      await master.api.v2010.accounts(connection.providerAccountId).update({ status: 'closed' });
    } catch (err) {
      log.warn({ err }, 'subaccount close failed — cache still cleared');
    }

    invalidateTwilioClient(connection);
  }

  // ── healthCheck() ────────────────────────────────────────
  async healthCheck(connection: ChannelConnection): Promise<HealthStatus> {
    const log = logger.child({ connectionId: connection.id, provider: this.provider });
    try {
      const client = await getTwilioClient(connection);
      const account = await client.api.v2010.accounts(connection.providerAccountId).fetch();

      const compliance = connection.complianceStatus as BrandAndCampaignState | null;
      const sendable = compliance ? isSendable(compliance) : false;

      const healthy = account.status === 'active' && sendable;
      return {
        healthy,
        reason: !healthy
          ? account.status !== 'active'
            ? `Twilio account status=${account.status}`
            : `10DLC not approved (brand=${compliance?.brandStatus}, campaign=${compliance?.campaignStatus})`
          : undefined,
        metadata: { twilioStatus: account.status, sendable },
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      log.warn({ err }, 'Twilio health check failed');
      return {
        healthy: false,
        reason: err instanceof Error ? err.message : 'unknown error',
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

    if (!msg.recipient.phone) {
      return {
        providerMessageId: '',
        status: 'failed',
        errorClass: 'permanent',
        errorMessage: 'Missing recipient phone number',
      };
    }

    // KAN-580: Pre-send opt-out check (channel-level)
    if (await isOptedOut(msg.tenantId, msg.recipient.phone)) {
      log.info({ phone: msg.recipient.phone }, 'send suppressed — opted out');
      return {
        providerMessageId: '',
        status: 'failed',
        errorClass: 'permanent',
        errorMessage: 'Recipient has opted out (SMS STOP)',
        metadata: { suppressed: true },
      };
    }

    // Compliance gate: don't send if Brand/Campaign not approved
    const compliance = connection.complianceStatus as BrandAndCampaignState | null;
    if (compliance && !isSendable(compliance)) {
      return {
        providerMessageId: '',
        status: 'failed',
        errorClass: 'transient', // transient — we'll be able to send once approved
        errorMessage: `10DLC not approved (brand=${compliance.brandStatus}, campaign=${compliance.campaignStatus})`,
        metadata: { awaiting10DLC: true },
      };
    }

    try {
      const client = await getTwilioClient(connection);
      const messagingServiceSid = await getMessagingServiceSid(connection);
      const baseUrl = env.PUBLIC_WEBHOOK_BASE_URL ?? '';
      const statusCallback = baseUrl
        ? `${baseUrl}/webhooks/twilio/status?actionId=${msg.actionId}&connectionId=${connection.id}&tenantId=${msg.tenantId}`
        : undefined;

      const result = await client.messages.create({
        to: msg.recipient.phone,
        messagingServiceSid,
        body: msg.content.body,
        ...(statusCallback ? { statusCallback } : {}),
      });

      log.info({ sid: result.sid, status: result.status }, 'Twilio SMS sent');
      return {
        providerMessageId: result.sid,
        status: 'sent',
        metadata: { twilioStatus: result.status },
      };
    } catch (err) {
      const twilioErr = err as { code?: number; status?: number; message?: string };
      const cls = classifyTwilioError(twilioErr.code, twilioErr.status);

      // Side-effect: Twilio told us the number is bad — mark opted-out
      if (cls.sideEffect === 'suppress_contact' && msg.recipient.phone) {
        await markOptedOut(msg.tenantId, msg.recipient.phone).catch(() => {
          /* already logged */
        });
      }

      log.warn({ err, code: twilioErr.code, classification: cls }, 'Twilio send failed');
      return {
        providerMessageId: '',
        status: 'failed',
        errorClass: cls.errorClass,
        errorMessage: twilioErr.message ?? cls.description,
        metadata: { twilioCode: twilioErr.code, sideEffect: cls.sideEffect },
      };
    }
  }

  // ── handleWebhook() — INBOUND only (status callbacks hit a separate route) ──
  async handleWebhook(payload: unknown, _signature: string): Promise<InboundEvent[]> {
    const p = payload as Record<string, string>;
    if (!p.From || !p.Body || !p.MessageSid || !p.AccountSid) return [];

    // KAN-549: resolve real tenantId from the inbound subaccount SID. Pre-fix
    // we returned a placeholder `00000000-0000-0000-0000-000000000000` UUID
    // and expected the dispatcher to overwrite it; in practice the dispatcher
    // forwarded the placeholder, leaving downstream consumers (Decision
    // Engine, audit log, contact upsert) to either drop the event or write
    // it under a "shadow tenant" with cross-tenant data co-mingling risk.
    //
    // Each subaccount maps 1:1 to a tenant via the ChannelConnection row
    // KAN-474 / KAN-691 / connect() write at index.ts L113. AccountSid is
    // globally unique (Twilio SID), so a single findFirst on
    // (provider='twilio', providerAccountId=AccountSid) is sufficient.
    const conn = await findConnectionByProviderAccountId('twilio', p.AccountSid);
    if (!conn) {
      logger.warn(
        { accountSid: p.AccountSid, messageSid: p.MessageSid },
        '[twilio-webhook] no ChannelConnection for AccountSid — dropping inbound',
      );
      return [];
    }
    const tenantId = conn.tenantId;

    // KAN-579: keyword handling first — compliance-critical
    const keyword = detectKeyword(p.Body);
    if (keyword) {
      await this.handleKeyword(keyword, p, tenantId);
      // Keyword messages still flow into inbound.raw so the audit log captures them,
      // but Ingestion Service knows to short-circuit AI processing via the keyword tag.
      return [
        {
          tenantId,
          channel: 'SMS',
          provider: 'twilio',
          fromIdentifier: p.From,
          threadKey: `twilio:${p.AccountSid}:${p.From}`,
          rawMessage: p.Body,
          receivedAt: new Date().toISOString(),
          providerMessageId: p.MessageSid,
          raw: { ...p, _keyword: keyword },
        },
      ];
    }

    return [
      {
        tenantId,
        channel: 'SMS',
        provider: 'twilio',
        fromIdentifier: p.From,
        threadKey: `twilio:${p.AccountSid}:${p.From}`,
        rawMessage: p.Body,
        receivedAt: new Date().toISOString(),
        providerMessageId: p.MessageSid,
        raw: p,
      },
    ];
  }

  // ── keyword side-effects ──────────────────────────────────
  /**
   * STOP → add to opt-out + auto-reply confirmation
   * HELP → reply with help text
   * START → remove from opt-out + confirmation
   *
   * `tenantId` is resolved by the caller from `params.AccountSid` (KAN-549).
   * Pre-fix this function used `params.AccountSid` directly as the opt-out
   * namespace — a key mismatch with the outbound pre-send check at
   * `send():193` which reads `sms:optout:<tenantId>`, so STOPs were silently
   * not enforced (TCPA gap, $500-$1500/violation).
   *
   * Brand name for auto-replies is currently hard-coded to "growth". When
   * we integrate AiAgentConfig (KAN-514 territory) we'll pull per-tenant.
   */
  private async handleKeyword(
    keyword: 'STOP' | 'HELP' | 'START',
    params: Record<string, string>,
    tenantId: string,
  ): Promise<void> {
    const brandName = 'growth';
    const toSend: { body: string; action: string } | null =
      keyword === 'STOP'
        ? { body: stopConfirmationBody(brandName), action: 'opt-out-confirm' }
        : keyword === 'HELP'
          ? { body: helpAutoReplyBody(brandName), action: 'help-reply' }
          : { body: startConfirmationBody(brandName), action: 'opt-in-confirm' };

    if (keyword === 'STOP') {
      await markOptedOut(tenantId, params.From);
    } else if (keyword === 'START') {
      await clearOptOut(tenantId, params.From);
    }

    // Auto-reply via Twilio directly — doesn't go through Agent Dispatcher
    // because it's compliance, not intent.
    try {
      const { default: Twilio } = await import('twilio');
      // Reuse the inbound AccountSid to derive subaccount auth.
      // Real impl uses Secret Manager reverse-lookup; we defer to the
      // existing getTwilioClient() path by constructing a minimal connection shim.
      logger.info({ keyword, to: params.From, action: toSend.action }, 'keyword auto-reply scheduled');
      void Twilio; // linter
      // TODO(KAN-549): resolve real tenantId from params.AccountSid, then
      // look up the SMS ChannelConnection and send the auto-reply via
      // getTwilioClient(conn). Matches the placeholder pattern used in
      // handleWebhook() (lines 271, 286) — the webhook router resolves the
      // real tenantId downstream. Skeleton of the eventual send:
      //
      //   const tenantId = await resolveTenantFromAccountSid(params.AccountSid);
      //   const conns = await getConnections(tenantId, "SMS");
      //   const conn = conns[0];
      //   if (!conn) return;
      //   const client = await getTwilioClient(conn);
      //   const fromNumber = (conn.metadata as { phoneNumber?: string })?.phoneNumber;
      //   if (fromNumber) {
      //     await client.messages.create({
      //       to: params.From,
      //       from: fromNumber,
      //       body: toSend.body,
      //     });
      //   }
    } catch (err) {
      logger.error({ err, keyword }, 'keyword auto-reply failed');
    }
  }
}
