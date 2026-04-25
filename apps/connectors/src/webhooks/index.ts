/**
 * Public webhook ingress for all providers.
 *
 * Routes:
 *   GET  /webhooks/:provider            — OAuth/subscription verification (Meta)
 *   POST /webhooks/:provider            — inbound message events
 *   POST /webhooks/:provider/status     — message delivery status callbacks (Twilio)
 *
 * Note: Resend status events arrive via /webhooks/:provider (POST, not /status)
 * once the KAN-684 webhook handler ships. SendGrid was the prior email provider
 * and used /status — Resend uses unified webhook events instead.
 *
 * Flow (POST):
 *   verify signature → dedup by provider event id → dispatch → publish → 200
 *
 * Must return within 5s (provider timeout). Heavy processing happens async via Pub/Sub.
 *
 * KAN-480: Public webhook ingress with signature verification
 * KAN-495, KAN-576: Twilio status callback handler
 * KAN-578: Inbound SMS webhook routing
 */

import { Hono, type Context } from 'hono';
import { InboundRawEventSchema } from '@growth/connector-contracts';
import { logger } from '../logger.js';
import { publishEvent } from '../pubsub/index.js';
import { registry } from '../adapters/registry.js';
import { processTwilioStatusCallback } from '../adapters/twilio/status-callback.js';
import { loadWebhookVerifyToken } from '../adapters/meta/signature.js';
import { verifierRegistry } from './verifier.js';

export const webhooksApp = new Hono();

// ── Meta OAuth subscription challenge ────────────────
webhooksApp.get('/:provider', async (c) => {
  const provider = c.req.param('provider');
  if (provider === 'meta') {
    const mode = c.req.query('hub.mode');
    const challenge = c.req.query('hub.challenge');
    const verifyToken = c.req.query('hub.verify_token');
    const expected = await loadWebhookVerifyToken();
    if (mode === 'subscribe' && challenge && verifyToken && expected && verifyToken === expected) {
      return c.text(challenge, 200);
    }
    logger.warn({ provider }, 'Meta subscription challenge rejected (token mismatch)');
    return c.text('Forbidden', 403);
  }
  return c.text('Method Not Allowed', 405);
});

// ── Provider-specific status callbacks ───────────────
// These update the status of previously-sent outbound actions rather than
// producing inbound messages. Separate route so the dispatch is unambiguous.
webhooksApp.post('/:provider/status', async (c) => {
  const provider = c.req.param('provider');
  const verifier = verifierRegistry.get(provider);
  if (!verifier) return c.text('Unknown provider', 404);

  const rawBody = await c.req.text();
  const headers = toHeadersRecord(c);
  if (!(await verifier.verify(rawBody, headers))) {
    logger.warn({ provider, path: 'status' }, 'signature verification failed');
    return c.text('Unauthorized', 401);
  }

  if (provider === 'twilio') {
    const params = Object.fromEntries(new URLSearchParams(rawBody));
    // actionId + connectionId are carried in our outbound send as query params
    // on the statusCallback URL — e.g. ?actionId=...&connectionId=...&tenantId=...
    const actionId = c.req.query('actionId') ?? '';
    const connectionId = c.req.query('connectionId') ?? '';
    const tenantId = c.req.query('tenantId') ?? '';
    if (!actionId || !connectionId || !tenantId) {
      logger.warn('twilio status callback missing correlation ids');
      return c.text('OK', 200); // ack so Twilio doesn't retry
    }
    await processTwilioStatusCallback(params, tenantId, actionId, connectionId);
    return c.text('OK', 200);
  }

  // Other providers' status callbacks land here once implemented
  logger.info({ provider }, 'status callback accepted (no-op for provider)');
  return c.text('OK', 200);
});

// ── Inbound message events (the big dispatch) ───────────
webhooksApp.post('/:provider', async (c) => {
  const provider = c.req.param('provider');
  const verifier = verifierRegistry.get(provider);
  if (!verifier) return c.text('Unknown provider', 404);

  const rawBody = await c.req.text();
  const headers = toHeadersRecord(c);

  if (!(await verifier.verify(rawBody, headers))) {
    logger.warn({ provider }, 'inbound webhook signature verification failed');
    return c.text('Unauthorized', 401);
  }

  // TODO(KAN-531): Redis idempotency dedup by provider event id

  // Parse the payload per provider. Twilio sends form-encoded, others JSON.
  let payload: unknown;
  if (provider === 'twilio') {
    payload = Object.fromEntries(new URLSearchParams(rawBody));
  } else {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.text('Bad Request', 400);
    }
  }

  // Look up the adapter by channel+provider. We need to know the channel:
  // Twilio=SMS, Resend=EMAIL, Meta=MESSENGER.
  const channel = channelForProvider(provider);
  if (!channel) return c.text('Unknown provider', 404);

  const adapter = registry.get(channel, provider);
  const events = await adapter.handleWebhook(payload, headers[headerForProviderSig(provider)] ?? '');

  if (events.length === 0) {
    return c.text('OK', 200);
  }

  // TODO(KAN-549): tenantId is resolved here via providerAccountId reverse-lookup.
  // Adapters currently return a placeholder tenantId; overwrite before publishing.
  // For now we accept what the adapter returned.

  await publishEvent({
    topic: 'inbound.raw',
    timestamp: new Date().toISOString(),
    events,
  });

  logger.info({ provider, count: events.length }, 'inbound webhook published');
  return c.text('OK', 200);
});

// ── helpers ─────────────────────────────────────────────
function toHeadersRecord(c: Context): Record<string, string> {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

function channelForProvider(provider: string): 'SMS' | 'EMAIL' | 'MESSENGER' | null {
  switch (provider) {
    case 'twilio':
      return 'SMS';
    case 'resend':
      return 'EMAIL';
    case 'meta':
      return 'MESSENGER';
    default:
      return null;
  }
}

function headerForProviderSig(provider: string): string {
  switch (provider) {
    case 'twilio':
      return 'x-twilio-signature';
    case 'resend':
      // KAN-684 will wire Resend's `svix-signature` (Svix-backed webhook auth)
      return 'svix-signature';
    case 'meta':
      return 'x-hub-signature-256';
    default:
      return '';
  }
}

// Also — validate that InboundRawEventSchema is imported so tree-shakers keep it
void InboundRawEventSchema;
