/**
 * KAN-1037-PR3 — `contact.replied` push subscriber (M3-2.5c PR3 SKELETON).
 *
 * Cloud Run Pub/Sub push endpoint. Consumes the new `contact.replied`
 * topic published from `lead-received-push.ts`'s
 * `emitContactRepliedIfCorrelated` helper (fires on every
 * `inbound_correlated` outcome from `writeSidecarAndCorrelate`).
 *
 * **PR3 SCOPE = SKELETON ONLY.** The handler verifies OIDC, parses the
 * envelope + event, applies the Redis cooldown + in-flight gates,
 * writes the bookmark audit row, and sets the cooldown key — but does
 * NOT yet invoke `runDecisionForContact`. PR4 wires the real engine
 * call here, swapping the `decision_re_evaluated_skipped_pr3_skeleton`
 * audit reason for the canonical `decision_re_evaluated` reason. This
 * separation lets PR3 verify the event-driven trigger fires correctly
 * BEFORE introducing the engine prompt modality shift that PR4 + PRD
 * §7 risk register call out as the load-bearing quality risk.
 *
 * **Topic + subscription provisioning** at `infra/terraform/contact-replied.tf`.
 * Push endpoint is `/pubsub/contact-replied` (mounted via
 * `app.route("/pubsub", contactRepliedPushApp)` at `index.ts`).
 *
 * Flow:
 *   Pub/Sub push → POST /pubsub/contact-replied → verifyPubsubOidc
 *   → PushEnvelopeSchema.parse → base64-decode → ContactRepliedEventSchema.parse
 *   → cooldown check (5min TTL — replies are high-signal, shorter than
 *     the 30-min general DEDUP at decision-run-push.ts:322)
 *   → in-flight check (30s NX TTL — anti-flapping on concurrent inbounds)
 *   → write skeleton audit (`decision_re_evaluated_skipped_pr3_skeleton`)
 *   → set cooldown key with `decisionId` value (5 min EX)
 *   → release in-flight lock via finally
 *   → 200.
 *
 * **OIDC discipline (KAN-732):** verifyPubsubOidc derives the expected
 * audience from the request URL — NO `CONTACT_REPLIED_AUDIENCE` env
 * var needed. Audience-mismatch class stays structurally impossible.
 * Structural regression test at
 * `apps/api/src/__tests__/knowledge-ingest-audience.test.ts`
 * (SUBSCRIBERS array; PR3 adds `contact-replied-push.ts`).
 *
 * **Redis discipline:** keys scoped `<tenantId>:<contactId>` — tenant-
 * isolated by construction. In-flight lock released in `finally` block
 * — orphan locks structurally impossible even on subscriber error.
 *
 * Error policy:
 *   - 200 (ack + drop) on malformed envelope or invalid event payload
 *     (poison-message defense; redelivery won't help if the producer
 *     emitted a bad shape).
 *   - 200 (ack + cooldown audit) when cooldown is active — operator-
 *     visible skip, not a failure.
 *   - 200 (ack + in-flight audit) when in-flight lock is held — concurrent
 *     processing already underway, drop this delivery.
 *   - 200 (ack + skeleton audit + cooldown set) on the happy path.
 *   - 401 on missing/invalid OIDC token.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { ContactRepliedEventSchema } from '@growth/shared';
import { prisma } from '../prisma.js';
import { verifyPubsubOidc } from '../lib/oidc-pubsub-verify.js';
import { getRedisClient } from '../services/redis-client.js';

// ─────────────────────────────────────────────
// Constants — Redis gate TTLs
// ─────────────────────────────────────────────

/**
 * In-flight lock TTL: 30s. Anti-flapping on concurrent inbounds for
 * the same (tenant, contact) pair. Set via `SET key val NX EX 30` —
 * if the key exists, another delivery is mid-processing; drop this
 * one. Released via `DEL` in the handler's `finally` block so a
 * subscriber error can't leave an orphan lock.
 *
 * 30s is conservative: the skeleton handler does no expensive work
 * (just two Prisma writes + Redis ops); the PR4 engine invocation
 * stays under this window with comfortable headroom (Brain Service
 * typical latency ~2-5s per `decision-run-push` observability).
 */
const IN_FLIGHT_TTL_SECONDS = 30;

/**
 * Cooldown TTL: 5 minutes. After successful processing of a reply,
 * subsequent `contact.replied` events for the same (tenant, contact)
 * are skipped for this window — prevents double-evaluation when a
 * second reply arrives within the cooldown.
 *
 * Why shorter than `DEDUP_WINDOW_MINUTES = 30` at
 * `decision-run-push.ts:322`? Replies are high-signal — the operator
 * (or post-PR4 the engine) just decided what to do based on a reply;
 * a second reply within 5 minutes is likely a continuation worth
 * waiting on, but more than 5 minutes apart should re-evaluate fresh.
 */
const COOLDOWN_TTL_SECONDS = 300;

// ─────────────────────────────────────────────
// Hono app
// ─────────────────────────────────────────────

export const contactRepliedPushApp = new Hono();

const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

contactRepliedPushApp.post('/contact-replied', async (c) => {
  // KAN-732: shared helper derives audience from request URL — no
  // CONTACT_REPLIED_AUDIENCE env var. Audience-mismatch class
  // structurally impossible.
  if (!(await verifyPubsubOidc(c))) {
    return c.text('unauthorized', 401);
  }

  let envelope: z.infer<typeof PushEnvelopeSchema>;
  try {
    envelope = PushEnvelopeSchema.parse(await c.req.json());
  } catch (err) {
    console.error(
      `[contact-replied-push] malformed envelope: ${(err as Error)?.message ?? String(err)}`,
    );
    return c.text('ok', 200);
  }

  let event: z.infer<typeof ContactRepliedEventSchema>;
  try {
    const decoded = Buffer.from(envelope.message.data, 'base64').toString('utf8');
    event = ContactRepliedEventSchema.parse(JSON.parse(decoded));
  } catch (err) {
    console.error(
      `[contact-replied-push] malformed contact.replied payload: ${(err as Error)?.message ?? String(err)}`,
    );
    return c.text('ok', 200);
  }

  const redis = getRedisClient();
  // Tenant-isolated by construction — no cross-tenant key collision possible.
  const cooldownKey = `decision-run:cooldown:${event.tenantId}:${event.contactId}`;
  const inFlightKey = `decision-run:in-flight:${event.tenantId}:${event.contactId}`;

  // ─── Cooldown check (high-signal-reply 5-min window) ───────────
  const cooldownActive = await redis.get(cooldownKey);
  if (cooldownActive) {
    void prisma.auditLog
      .create({
        data: {
          tenantId: event.tenantId,
          actor: 'contact_replied_subscriber',
          actionType: 'contact_replied_suppressed_cooldown',
          reasoning: 'cooldown_active',
          payload: {
            eventId: event.eventId,
            contactId: event.contactId,
            cooldownDecisionId: cooldownActive,
            // The decisionId that triggered the cooldown is on the value side;
            // this delivery's decisionId is on `event.decisionId` for trace.
            currentEventDecisionId: event.decisionId,
          },
        },
      })
      .catch((err: unknown) => {
        console.warn(
          `[contact-replied-push] cooldown-audit-failed eventId=${event.eventId} err=${(err as Error)?.message ?? String(err)}`,
        );
      });
    return c.text('ok', 200);
  }

  // ─── In-flight lock (concurrent delivery defense) ──────────────
  // ioredis positional-arg signature: set(key, val, 'NX', 'EX', seconds).
  // Returns 'OK' on success, null when NX fails (key already exists).
  const acquired = await redis.set(
    inFlightKey,
    event.eventId,
    'NX',
    'EX',
    IN_FLIGHT_TTL_SECONDS,
  );
  if (acquired !== 'OK') {
    void prisma.auditLog
      .create({
        data: {
          tenantId: event.tenantId,
          actor: 'contact_replied_subscriber',
          actionType: 'contact_replied_suppressed_in_flight',
          reasoning: 'in_flight_lock_held',
          payload: {
            eventId: event.eventId,
            contactId: event.contactId,
          },
        },
      })
      .catch((err: unknown) => {
        console.warn(
          `[contact-replied-push] in-flight-audit-failed eventId=${event.eventId} err=${(err as Error)?.message ?? String(err)}`,
        );
      });
    return c.text('ok', 200);
  }

  try {
    // PR3 SKELETON — bookmark audit row proves the plumbing fires end-to-end.
    // PR4 replaces this with the canonical `decision_re_evaluated` audit and
    // the real `runDecisionForContact` invocation.
    await prisma.auditLog.create({
      data: {
        tenantId: event.tenantId,
        actor: 'contact_replied_subscriber',
        actionType: 'decision_re_evaluated_skipped_pr3_skeleton',
        reasoning: 'pr3_skeleton_no_engine_invocation',
        payload: {
          eventId: event.eventId,
          contactId: event.contactId,
          dealId: event.dealId,
          decisionId: event.decisionId,
          inboundEngagementId: event.inboundEngagementId,
          outboundEngagementId: event.outboundEngagementId,
          replyReceivedAt: event.replyReceivedAt,
          note: 'PR3 ships skeleton — PR4 wires runDecisionForContact here',
        },
      },
    });

    // Set 5-min cooldown anchored to this delivery's decisionId so the
    // suppressed-cooldown audit payload above can trace WHICH decision
    // is currently the "freshest evaluation."
    await redis.set(cooldownKey, event.decisionId, 'EX', COOLDOWN_TTL_SECONDS);

    return c.text('ok', 200);
  } catch (err) {
    console.error(
      `[contact-replied-push] handler-error eventId=${event.eventId} err=${(err as Error)?.message ?? String(err)}`,
    );
    // Resend the message — Pub/Sub will retry per the subscription's retry
    // policy (10s/600s exponential, 24h retention per Terraform). Return
    // 500 so the message is nack'd. The in-flight lock is released in the
    // finally block below — when the retry arrives within 30s, it will
    // see the cooldown key (set above only on success), so it falls
    // through to re-acquire the in-flight lock fresh.
    return c.text('internal error', 500);
  } finally {
    // Always release the in-flight lock — even on error — so a retry can
    // re-acquire it. Orphan locks are structurally impossible.
    await redis.del(inFlightKey).catch((err: unknown) => {
      console.warn(
        `[contact-replied-push] in-flight-release-failed eventId=${event.eventId} err=${(err as Error)?.message ?? String(err)}`,
      );
    });
  }
});
