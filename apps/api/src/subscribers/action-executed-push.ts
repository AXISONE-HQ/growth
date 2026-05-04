/**
 * action.executed push subscriber — KAN-657
 *
 * Cloud Run Pub/Sub push endpoint. Subscription:
 *   action.executed.outcome-writer (push to /pubsub/action-executed)
 *
 * Flow:
 *   Pub/Sub push → POST /pubsub/action-executed
 *   → Verify OIDC Bearer token (reject 401 on fail)
 *   → Decode base64 payload + zod-validate ActionExecutedEvent
 *   → Sanity-check Decision exists in this tenant (ack-and-drop if not)
 *   → Insert ActionOutcome row
 *   → 200 on success
 *
 * Error policy (mirrors KAN-660/661):
 *   - 500 (nack → Pub/Sub retries up to 5x → DLQ) on DB connection / write errors (transient)
 *   - 200 (ack + drop) on malformed payload, zod failures, unknown decision (deterministic)
 *   - 401 on missing or invalid OIDC token
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { verifyPubsubOidc } from '../lib/oidc-pubsub-verify.js';
// Inline the schema for ActionExecutedEvent — packages/connector-contracts is
// not a workspace dep of apps/api. Mirrors the canonical shape at
// packages/connector-contracts/src/events.ts.
const ActionExecutedEventSchema = z.object({
  topic: z.literal('action.executed'),
  timestamp: z.string().datetime(),
  tenantId: z.string().uuid(),
  actionId: z.string().uuid(),
  decisionId: z.string(),
  contactId: z.string().uuid(),
  connectionId: z.string().uuid(),
  channel: z.enum(['SMS', 'EMAIL', 'MESSENGER', 'WHATSAPP']),
  provider: z.string().min(1),
  status: z.enum(['sent', 'delivered', 'failed', 'suppressed']),
  providerMessageId: z.string().optional(),
  errorClass: z.enum(['transient', 'permanent']).optional(),
  errorMessage: z.string().optional(),
  attemptNumber: z.number().int().min(1).default(1),
});
import { prisma } from '../prisma.js';

export const actionExecutedPushApp = new Hono();

const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

const CHANNEL_TO_ACTION: Record<string, string> = {
  EMAIL: 'email_send',
  SMS: 'sms_send',
  MESSENGER: 'meta_send',
  WHATSAPP: 'whatsapp_send',
};

actionExecutedPushApp.post('/action-executed', async (c) => {
  // KAN-732: shared helper derives audience from request URL.
  if (!(await verifyPubsubOidc(c))) {
    return c.text('unauthorized', 401);
  }

  let envelope: z.infer<typeof PushEnvelopeSchema>;
  try {
    envelope = PushEnvelopeSchema.parse(await c.req.json());
  } catch (err) {
    console.error('[action-executed-push] malformed envelope', err);
    return c.text('ok', 200);
  }

  let event: z.infer<typeof ActionExecutedEventSchema>;
  try {
    const decoded = Buffer.from(envelope.message.data, 'base64').toString('utf8');
    event = ActionExecutedEventSchema.parse(JSON.parse(decoded));
  } catch (err) {
    console.error('[action-executed-push] malformed action.executed payload', err);
    return c.text('ok', 200);
  }

  // Sanity-check: Decision exists + scoped to claimed tenant. KAN-816:
  // also pull metadata so we can recover dealId (KAN-815c shim writes it
  // there) for the co-located outbound Engagement write below.
  const decision = await prisma.decision.findFirst({
    where: { id: event.decisionId, tenantId: event.tenantId },
    select: { id: true, metadata: true },
  });
  if (!decision) {
    console.error(
      `[action-executed-push] decision ${event.decisionId} not found in tenant ${event.tenantId} — ack + drop`,
    );
    return c.text('ok', 200);
  }

  const action = CHANNEL_TO_ACTION[event.channel] ?? `${event.channel.toLowerCase()}_send`;

  // KAN-816: extract dealId from Decision metadata for the outbound
  // Engagement write (KAN-815c shim writes dealId here). Legacy KAN-660
  // Decisions don't include dealId — those Engagement writes get
  // gracefully skipped with a warn log (ActionOutcome write still proceeds).
  const decisionMetadata = (decision.metadata ?? {}) as Record<string, unknown>;
  const dealId = typeof decisionMetadata.dealId === 'string' ? decisionMetadata.dealId : null;

  try {
    await (prisma as any).actionOutcome.create({
      data: {
        tenantId: event.tenantId,
        decisionId: event.decisionId,
        contactId: event.contactId,
        action,
        status: event.status,
        occurredAt: new Date(event.timestamp),
        metadata: {
          actionId: event.actionId,
          connectionId: event.connectionId,
          channel: event.channel,
          provider: event.provider,
          ...(event.providerMessageId ? { providerMessageId: event.providerMessageId } : {}),
          ...(event.errorClass ? { errorClass: event.errorClass } : {}),
          ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
          attemptNumber: event.attemptNumber,
        },
      },
    });
    console.log(
      `[action-executed-push] wrote ActionOutcome decisionId=${event.decisionId} status=${event.status}`,
    );

    // KAN-816: outbound Engagement write co-located with ActionOutcome.
    // Closes the producer-consumer gap that blocks KAN-797a anti-repetition
    // discipline (per feedback_message_shaper_anti_repetition_engagement_history_pattern).
    // Only fires on status='sent' or 'delivered' — failed/suppressed sends
    // didn't actually reach the recipient and shouldn't count toward
    // anti-repetition history. Idempotency: correlationId UNIQUE catches
    // Resend webhook retries (Resend may fire 'sent' + 'delivered' for the
    // same outbound; the 'delivered' write is deduped to no-op).
    if (dealId && (event.status === 'sent' || event.status === 'delivered')) {
      const engagementType = `${event.channel.toLowerCase()}_send`;
      try {
        await prisma.engagement.create({
          data: {
            tenantId: event.tenantId,
            dealId,
            contactId: event.contactId,
            engagementType,
            signalClass: 'neutral', // outbound action; not contact-initiated
            channel: event.channel.toLowerCase(),
            occurredAt: new Date(event.timestamp),
            // Resend webhook may fire multiple events for the same outbound
            // (sent → delivered → opened …). actionId is the canonical anchor
            // for "this specific outbound Action's first observed engagement";
            // UNIQUE catches retries within the same status AND across statuses
            // (the first 'sent' wins; subsequent 'delivered' is a no-op).
            correlationId: `engagement:outbound:${event.actionId}`,
            metadata: {
              actionId: event.actionId,
              decisionId: event.decisionId,
              status: event.status,
              channel: event.channel,
              provider: event.provider,
              ...(event.providerMessageId ? { providerMessageId: event.providerMessageId } : {}),
            },
          },
        });
        console.log(
          `[action-executed-push] wrote outbound Engagement actionId=${event.actionId} dealId=${dealId} engagementType=${engagementType}`,
        );
      } catch (err) {
        // P2002 = unique constraint violation = Resend retry; dedup success.
        if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') {
          console.log(
            `[action-executed-push] outbound Engagement already written (idempotent) actionId=${event.actionId}`,
          );
        } else {
          // Non-dedup error — log but don't fail the response. ActionOutcome
          // already committed; failing the response would trigger Pub/Sub
          // retry → double-ActionOutcome (which has no idempotency anchor).
          console.warn(
            `[action-executed-push] outbound Engagement write failed actionId=${event.actionId} dealId=${dealId} — continuing`,
            err,
          );
        }
      }
    } else if (!dealId && (event.status === 'sent' || event.status === 'delivered')) {
      console.warn(
        `[action-executed-push] no-deal-id-in-decision-metadata decisionId=${event.decisionId} actionId=${event.actionId} — outbound Engagement skipped (legacy Decision pre-KAN-815c?)`,
      );
    }

    return c.text('ok', 200);
  } catch (err) {
    console.error(
      `[action-executed-push] write failed decisionId=${event.decisionId} — nack`,
      err,
    );
    return c.text('retry', 500);
  }
});
