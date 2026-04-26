/**
 * Resend webhook handler — KAN-684.
 *
 * Mounted at POST /webhooks/resend. Public endpoint (no OIDC). Svix-signed.
 *
 * Closes the visibility loop after Resend accepts a send: until this lands
 * we get `data.id` back from `resend.emails.send()` and then go blind. The
 * KAN-687 sender-warmup work depends on seeing bounce/complaint outcomes,
 * and the Tier-1 suppression-roundtrip gap (real send → bounce → suppress
 * → next send blocked) becomes provable end-to-end with this in place.
 *
 * Flow:
 *   POST → Svix middleware verifies signature → 400 if bad
 *   → Redis dedup on svix-id (24h TTL) → 200 if duplicate
 *   → Dispatch by event type
 *   → For state-changing events: publish action.executed for the existing
 *     `action-executed-push` subscriber to land in the action_outcomes table
 *   → For bounce (hard) / complaint: write EmailSuppression row
 *   → 200 OK regardless of internal processing outcome (per Resend retry policy)
 *
 * Schema deviations from the original task brief — see PR description for context:
 *   - email_suppressions has no `source` column; we reuse the existing
 *     `suppressDb()` API with `'bounce'` / `'spam'` reason values
 *   - action_outcomes is append-only via Pub/Sub; no in-place updates,
 *     no openCount/lastOpenedAt columns. Open/click events are logged for
 *     now and TODO'd for a follow-up engagement-tracking schema.
 *   - Idempotency uses Redis (KAN-531 long-standing TODO) instead of a
 *     webhook_events DB table.
 */
import { Hono } from 'hono';
import Redis from 'ioredis';
import type { ActionExecutedEvent } from '@growth/connector-contracts';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { publishEvent } from '../pubsub/index.js';
import { suppressDb } from '../adapters/resend/suppressions.js';
import { buildSvixMiddleware, getSvixContext } from '../middleware/svix.js';

export const resendWebhookApp = new Hono();

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24h
const IDEMPOTENCY_KEY_PREFIX = 'webhook:resend:svix:';

let redis: Redis | null = null;
function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: true });
    redis.on('error', (err) => logger.warn({ err }, '[resend-webhook] redis client error'));
  }
  return redis;
}

interface ResendTag {
  name: string;
  value: string;
}

interface ResendWebhookPayload {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    from?: string;
    to?: string[] | string;
    subject?: string;
    tags?: ResendTag[];
    bounce?: {
      type?: string; // 'hard' | 'soft'
      subType?: string;
      message?: string;
    };
    click?: { link?: string; ipAddress?: string; userAgent?: string };
  };
}

interface Correlated {
  tenantId?: string;
  actionId?: string;
  decisionId?: string;
  contactId?: string;
  connectionId?: string;
  traceId?: string;
}

/** Pull our outbound tags back out of the Resend echo. */
function correlate(tags: ResendTag[] | undefined): Correlated {
  const out: Correlated = {};
  if (!Array.isArray(tags)) return out;
  for (const t of tags) {
    switch (t.name) {
      case 'tenant_id':
        out.tenantId = t.value;
        break;
      case 'action_id':
        out.actionId = t.value;
        break;
      case 'decision_id':
        out.decisionId = t.value;
        break;
      case 'contact_id':
        out.contactId = t.value;
        break;
      case 'connection_id':
        out.connectionId = t.value;
        break;
      case 'trace_id':
        out.traceId = t.value;
        break;
    }
  }
  return out;
}

function firstRecipient(to: string[] | string | undefined): string | undefined {
  if (!to) return undefined;
  if (Array.isArray(to)) return to[0];
  return to;
}

/**
 * Publish an action.executed event. Returns true on success. Logs but
 * doesn't rethrow — webhook handler stays at HTTP 200 regardless.
 */
async function publishExecuted(
  base: Correlated & { providerMessageId?: string },
  status: ActionExecutedEvent['status'],
  errorClass?: ActionExecutedEvent['errorClass'],
  errorMessage?: string,
): Promise<boolean> {
  if (!base.tenantId || !base.actionId || !base.decisionId || !base.contactId || !base.connectionId) {
    logger.warn(
      { base },
      '[resend-webhook] missing correlation tags — cannot publish action.executed',
    );
    return false;
  }
  const event: ActionExecutedEvent = {
    topic: 'action.executed',
    timestamp: new Date().toISOString(),
    tenantId: base.tenantId,
    actionId: base.actionId,
    decisionId: base.decisionId,
    contactId: base.contactId,
    connectionId: base.connectionId,
    channel: 'EMAIL',
    provider: 'resend',
    status,
    attemptNumber: 1,
    ...(base.providerMessageId ? { providerMessageId: base.providerMessageId } : {}),
    ...(errorClass ? { errorClass } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
  try {
    await publishEvent(event);
    return true;
  } catch (err) {
    logger.error({ err, status, actionId: base.actionId }, '[resend-webhook] publish failed');
    return false;
  }
}

resendWebhookApp.post('/', buildSvixMiddleware(), async (c) => {
  const { payload, svixId } = getSvixContext(c);

  // Idempotency: Resend may fire the same webhook multiple times. Redis SET
  // NX with TTL = atomic "first time wins". Hits return 200 immediately.
  const key = IDEMPOTENCY_KEY_PREFIX + svixId;
  let isFirst = false;
  try {
    const result = await getRedis().set(key, '1', 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
    isFirst = result === 'OK';
  } catch (err) {
    // Fail-open on Redis: process the event but log loudly. Better duplicate
    // processing than dropping events because Redis blipped.
    logger.error({ err, svixId }, '[resend-webhook] redis dedup failed — fail-open');
    isFirst = true;
  }
  if (!isFirst) {
    logger.info({ svixId }, '[resend-webhook] duplicate (svix-id seen) — ack');
    return c.text('OK', 200);
  }

  const evt = payload as unknown as ResendWebhookPayload;
  const type = evt.type ?? '(missing)';
  const corr = correlate(evt.data?.tags);
  const providerMessageId = evt.data?.email_id;
  const recipient = firstRecipient(evt.data?.to);
  const log = logger.child({ svixId, type, actionId: corr.actionId, providerMessageId });

  log.info({ recipient }, '[resend-webhook] event received');

  try {
    switch (type) {
      case 'email.sent':
      case 'email.delivery_delayed':
        // Informational only — the send-side action.executed already covers
        // the 'sent' state; delivery_delayed is transient.
        break;

      case 'email.delivered':
        await publishExecuted({ ...corr, providerMessageId }, 'delivered');
        break;

      case 'email.bounced': {
        const bounceType = evt.data?.bounce?.type;
        const bounceSubType = evt.data?.bounce?.subType;
        const isHard = bounceType === 'hard' || bounceType === 'Permanent';
        await publishExecuted(
          { ...corr, providerMessageId },
          'failed',
          isHard ? 'permanent' : 'transient',
          evt.data?.bounce?.message ?? `${bounceType ?? 'unknown'} bounce${bounceSubType ? ` (${bounceSubType})` : ''}`,
        );
        if (isHard && corr.tenantId && recipient) {
          await suppressDb(corr.tenantId, recipient, 'bounce').catch((err) =>
            log.error({ err }, '[resend-webhook] hard-bounce suppression write failed'),
          );
          log.info({ recipient }, '[resend-webhook] hard bounce → suppression added');
        }
        break;
      }

      case 'email.complained':
        await publishExecuted(
          { ...corr, providerMessageId },
          'suppressed',
          'permanent',
          'recipient marked as spam',
        );
        if (corr.tenantId && recipient) {
          await suppressDb(corr.tenantId, recipient, 'spam').catch((err) =>
            log.error({ err }, '[resend-webhook] complaint suppression write failed'),
          );
          log.info({ recipient }, '[resend-webhook] complaint → suppression added');
        }
        break;

      case 'email.opened':
      case 'email.clicked':
        // No engagement-counter columns on action_outcomes today. Logged
        // for now; pending follow-up engagement-tracking schema.
        log.info(
          { recipient, link: evt.data?.click?.link },
          '[resend-webhook] engagement event (logging only — no schema for counters)',
        );
        break;

      default:
        log.warn({ type }, '[resend-webhook] unknown event type — logging only');
    }
  } catch (err) {
    // Per Resend retry policy: never bubble internal errors to a non-2xx.
    log.error({ err }, '[resend-webhook] internal processing failed — returning 200 anyway');
  }

  return c.text('OK', 200);
});
