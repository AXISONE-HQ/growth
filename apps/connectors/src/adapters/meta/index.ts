import { upsertConnection, revokeConnection } from "../../repository/connection-repository.js";
/**
 * MetaAdapter — implements ChannelAdapter for Facebook Messenger.
 *
 * Covers epic KAN-474:
 *   KAN-507, KAN-508, KAN-509, KAN-510, KAN-511, KAN-512, KAN-513, KAN-514
 *   KAN-611-634
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
import { logger } from '../../logger.js';
import {
  GRAPH_API_VERSION,
  graphFetch,
  loadPageToken,
  invalidateMetaClient,
  MetaApiError,
} from './client.js';
import { classifyMetaError } from './errors.js';
import { parseMetaWebhook, type RawMetaWebhook } from './events.js';
import {
  MetaConnectParamsSchema,
  buildMetaConnectionRecord,
  exchangeForLongLivedUserToken,
  fetchUserPages,
  storePageToken,
  subscribePage,
  unsubscribePage,
} from './provisioning.js';
import { checkTokenHealth } from './token-health.js';

/**
 * Meta messaging windows:
 *   - "RESPONSE": 24 hours after user's last inbound message (most common)
 *   - "MESSAGE_TAG": Outside the 24h window using an approved tag
 *   - "UPDATE": Promotional — App Review required, very restrictive
 */
export type MessagingType = 'RESPONSE' | 'UPDATE' | 'MESSAGE_TAG';

export class MetaAdapter implements ChannelAdapter {
  readonly channel = 'MESSENGER' as const;
  readonly provider = 'meta';

  // ── connect() ────────────────────────────────────────────
  async connect(tenant: TenantRef, input: ConnectInput): Promise<ChannelConnection> {
    const params = MetaConnectParamsSchema.parse(input.params);
    const log = logger.child({ tenantId: tenant.id, provider: this.provider });

    // Step 1: exchange short-lived → long-lived user token
    const { access_token: longLivedUser } = await exchangeForLongLivedUserToken(
      params.userAccessToken,
    );
    log.info('long-lived user token obtained');

    // Step 2: fetch Pages + find the selected ones
    const pages = await fetchUserPages(longLivedUser);
    const selected = pages.filter((p) => params.selectedPageIds.includes(p.id));
    if (selected.length === 0) {
      throw new Error('None of the selected Page IDs are admins-with-messaging on this user');
    }

    // Step 3: for each selected Page — subscribe + persist + build connection
    // We return the FIRST connection; additional Pages are sibling connections
    // created in a second pass by the Connection Manager. The Messenger UI
    // (KAN-633) handles the multi-select flow end-to-end.
    const connections: ChannelConnection[] = [];
    for (const page of selected) {
      await subscribePage(page.id, page.access_token);
      await storePageToken(tenant.id, page.id, page.name, page.access_token);
      const connection = buildMetaConnectionRecord(tenant, input, page);
      connections.push(connection);
      log.info({ pageId: page.id, pageName: page.name }, 'Page connected');
    }

    // Persist connections (KAN-558) — one per Page
    for (const page of pages) {
      await upsertConnection({
        tenantId,
        channelType: "MESSENGER",
        provider: "meta",
        providerAccountId: page.id,
        status: "ACTIVE",
        label: `Messenger - ${page.name}`,
        metadata: { pageId: page.id, pageName: page.name },
      });
    }
    // KAN-558 persistence wired
    return connections[0];
  }

  // ── disconnect() ─────────────────────────────────────────
  async disconnect(connection: ChannelConnection): Promise<void> {
    const log = logger.child({ connectionId: connection.id, provider: this.provider });
    try {
      const { pageAccessToken, pageId } = await loadPageToken(connection);
      await unsubscribePage(pageId, pageAccessToken);
    } catch (err) {
      log.warn({ err }, 'Page unsubscribe failed — invalidating cache anyway');
    }
    invalidateMetaClient(connection);
    // Revoke connection on disconnect (KAN-625)
    // Note: Page token secret deletion is a fast-follow
    // KAN-625 partially wired (Secret Manager destroy)
  }

  // ── healthCheck() ────────────────────────────────────────
  async healthCheck(connection: ChannelConnection): Promise<HealthStatus> {
    const r = await checkTokenHealth(connection);
    return {
      healthy: r.healthy,
      reason: r.reason,
      checkedAt: new Date().toISOString(),
    };
  }

  // ── send() ───────────────────────────────────────────────
  async send(connection: ChannelConnection, msg: OutboundMessage): Promise<SendResult> {
    const log = logger.child({
      connectionId: connection.id,
      actionId: msg.actionId,
      tenantId: msg.tenantId,
      channel: this.channel,
      provider: this.provider,
    });

    const psid = msg.recipient.pageScopedUserId;
    if (!psid) {
      return {
        providerMessageId: '',
        status: 'failed',
        errorClass: 'permanent',
        errorMessage: 'Missing recipient pageScopedUserId',
      };
    }

    try {
      const { pageAccessToken } = await loadPageToken(connection);
      // Default to RESPONSE — within 24h window is the common case.
      // Outside the window callers must pass an approved message tag in `categories`
      // (e.g. "HUMAN_AGENT" for the human-agent extension). We detect this heuristically.
      const tag = msg.categories?.find((c) => c.startsWith('tag:'));
      const messagingType: MessagingType = tag ? 'MESSAGE_TAG' : 'RESPONSE';

      const body: Record<string, unknown> = {
        recipient: { id: psid },
        messaging_type: messagingType,
        message: { text: msg.content.body },
      };
      if (tag) body.tag = tag.slice('tag:'.length);

      const res = await graphFetch<{ recipient_id: string; message_id: string }>(
        '/me/messages',
        { method: 'POST', accessToken: pageAccessToken, body },
      );
      log.info({ mid: res.message_id }, 'Messenger message sent');

      return {
        providerMessageId: res.message_id,
        status: 'sent',
        metadata: { messagingType, graphApiVersion: GRAPH_API_VERSION },
      };
    } catch (err) {
      if (err instanceof MetaApiError) {
        const cls = classifyMetaError(err.code, err.subcode, err.httpStatus);
        if (cls.sideEffect === 'mark_connection_error') {
          invalidateMetaClient(connection);
          // TODO(KAN-558): update channel_connections.status = ERROR in Prisma
        }
        log.warn({ err, cls }, 'Messenger send failed');
        return {
          providerMessageId: '',
          status: 'failed',
          errorClass: cls.errorClass,
          errorMessage: err.message,
          metadata: { metaCode: err.code, metaSubcode: err.subcode, sideEffect: cls.sideEffect },
        };
      }
      log.error({ err }, 'unexpected Messenger send error');
      return {
        providerMessageId: '',
        status: 'failed',
        errorClass: 'transient',
        errorMessage: err instanceof Error ? err.message : 'unknown',
      };
    }
  }

  // ── handleWebhook() ──────────────────────────────────────
  async handleWebhook(payload: unknown, _signature: string): Promise<InboundEvent[]> {
    return parseMetaWebhook(payload as RawMetaWebhook);
  }
}
