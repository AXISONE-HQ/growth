/**
 * Meta Messenger webhook event parser.
 *
 * Meta POSTs webhook events in this shape:
 *   {
 *     object: "page",
 *     entry: [
 *       {
 *         id: "<page_id>",
 *         time: <epoch_ms>,
 *         messaging: [
 *           { sender: {id: <psid>}, recipient: {id: <page_id>}, timestamp, message | postback | delivery | read | ... }
 *         ]
 *       }, ...
 *     ]
 *   }
 *
 * Each `entry.messaging[]` item is an independent event. We normalize to
 * `InboundEvent` only for `message` and `postback` (user-initiated). Delivery
 * and read receipts update action status (future: map back via `mid`).
 *
 * KAN-626: Entry/messaging array parser with batching + dedup
 * KAN-627: Publish normalized events to inbound.raw
 */

import type { InboundEvent } from '@growth/connector-contracts';
import { logger } from '../../logger.js';

export interface RawMetaWebhook {
  object: string;
  entry?: Array<{
    id: string;
    time: number;
    messaging?: RawMessaging[];
  }>;
}

export interface RawMessaging {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: {
    mid: string;
    text?: string;
    attachments?: Array<{ type: string; payload?: { url?: string } }>;
    is_echo?: boolean; // true when our own Page sent the message
  };
  postback?: {
    mid?: string;
    title: string;
    payload: string;
  };
  delivery?: { mids: string[]; watermark: number };
  read?: { watermark: number };
}

export function parseMetaWebhook(raw: RawMetaWebhook): InboundEvent[] {
  if (raw.object !== 'page') {
    logger.debug({ object: raw.object }, 'ignoring non-page webhook');
    return [];
  }

  const events: InboundEvent[] = [];
  for (const entry of raw.entry ?? []) {
    for (const m of entry.messaging ?? []) {
      // Skip echoes (our own agent's outbound messages coming back)
      if (m.message?.is_echo) continue;
      // Skip delivery/read — those hit a different path (action.executed updates)
      if (m.delivery || m.read) continue;

      const event = toInboundEvent(entry.id, m);
      if (event) events.push(event);
    }
  }
  return events;
}

function toInboundEvent(pageId: string, m: RawMessaging): InboundEvent | null {
  const psid = m.sender?.id;
  if (!psid) return null;

  if (m.message) {
    const text =
      m.message.text ??
      m.message.attachments?.map((a) => `[${a.type}${a.payload?.url ? `:${a.payload.url}` : ''}]`).join(' ') ??
      '';
    return {
      tenantId: '00000000-0000-0000-0000-000000000000', // webhook router resolves by pageId
      channel: 'MESSENGER',
      provider: 'meta',
      fromIdentifier: psid,
      threadKey: `meta:${pageId}:${psid}`,
      rawMessage: text,
      receivedAt: m.timestamp
        ? new Date(m.timestamp).toISOString()
        : new Date().toISOString(),
      providerMessageId: m.message.mid,
      raw: m as unknown as Record<string, unknown>,
    };
  }

  if (m.postback) {
    return {
      tenantId: '00000000-0000-0000-0000-000000000000',
      channel: 'MESSENGER',
      provider: 'meta',
      fromIdentifier: psid,
      threadKey: `meta:${pageId}:${psid}`,
      rawMessage: `[POSTBACK:${m.postback.payload}] ${m.postback.title}`,
      receivedAt: m.timestamp
        ? new Date(m.timestamp).toISOString()
        : new Date().toISOString(),
      providerMessageId: m.postback.mid ?? `postback-${Date.now()}-${psid}`,
      raw: m as unknown as Record<string, unknown>,
    };
  }

  return null;
}
