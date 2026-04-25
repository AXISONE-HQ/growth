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
import { OAuth2Client } from 'google-auth-library';
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

const oauth = new OAuth2Client();

const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

async function verifyOidc(authHeader: string | undefined, audience: string): Promise<boolean> {
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice('Bearer '.length);
  try {
    const ticket = await oauth.verifyIdToken({ idToken: token, audience });
    return !!ticket.getPayload();
  } catch {
    return false;
  }
}

const CHANNEL_TO_ACTION: Record<string, string> = {
  EMAIL: 'email_send',
  SMS: 'sms_send',
  MESSENGER: 'meta_send',
  WHATSAPP: 'whatsapp_send',
};

actionExecutedPushApp.post('/action-executed', async (c) => {
  const skipAuth = process.env.NODE_ENV === 'test' || process.env.PUBSUB_PUSH_SKIP_AUTH === 'true';
  if (!skipAuth) {
    const audience = process.env.APP_API_URL;
    if (!audience) {
      console.error('[action-executed-push] APP_API_URL unset — rejecting');
      return c.text('server misconfigured', 500);
    }
    const ok = await verifyOidc(c.req.header('authorization'), audience);
    if (!ok) return c.text('unauthorized', 401);
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

  // Sanity-check: Decision exists + scoped to claimed tenant.
  const decision = await prisma.decision.findFirst({
    where: { id: event.decisionId, tenantId: event.tenantId },
    select: { id: true },
  });
  if (!decision) {
    console.error(
      `[action-executed-push] decision ${event.decisionId} not found in tenant ${event.tenantId} — ack + drop`,
    );
    return c.text('ok', 200);
  }

  const action = CHANNEL_TO_ACTION[event.channel] ?? `${event.channel.toLowerCase()}_send`;

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
    return c.text('ok', 200);
  } catch (err) {
    console.error(
      `[action-executed-push] write failed decisionId=${event.decisionId} — nack`,
      err,
    );
    return c.text('retry', 500);
  }
});
