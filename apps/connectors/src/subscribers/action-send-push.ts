/**
 * action.send push subscriber — KAN-661.
 *
 * Subscription: action.send.sendgrid-adapter (push to /pubsub/action-send)
 *
 * Flow:
 *   Pub/Sub push → POST /pubsub/action-send
 *   → Verify OIDC Bearer token (401 on fail)
 *   → Decode base64 payload + zod-validate ActionSendEvent
 *   → Resolve ChannelConnection (nil-UUID fallback → any ACTIVE simple-mode EMAIL conn for tenant)
 *   → Dispatch to SendGridAdapter.send()
 *   → Publish action.executed with status sent/failed/suppressed
 *   → 200 on success
 *
 * Error policy (matches KAN-660):
 *   - 200 (ack + drop) on malformed envelope/payload, unknown connection, zod failures
 *   - 500 (nack → Pub/Sub retry → DLQ) on SendGrid 5xx / network / publish errors
 *   - 401 on missing or invalid OIDC token
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { ActionSendEventSchema, type ActionExecutedEvent } from '@growth/connector-contracts';
import { SendGridAdapter } from '../adapters/sendgrid/index.js';
import { prisma } from '../repository/connection-repository.js';
import { publishEvent } from '../pubsub/index.js';
import { logger } from '../logger.js';

export const actionSendPushApp = new Hono();

const oauth = new OAuth2Client();
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

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

// Singleton adapter — no per-request state; uses sgMail singleton internally.
const sendgrid = new SendGridAdapter();

actionSendPushApp.post('/action-send', async (c) => {
  const skipAuth = process.env.NODE_ENV === 'test' || process.env.PUBSUB_PUSH_SKIP_AUTH === 'true';
  if (!skipAuth) {
    const audience = process.env.PUBLIC_WEBHOOK_BASE_URL;
    if (!audience) {
      logger.error('[action-send-push] PUBLIC_WEBHOOK_BASE_URL unset — cannot verify OIDC audience');
      return c.text('server misconfigured', 500);
    }
    const ok = await verifyOidc(c.req.header('authorization'), audience);
    if (!ok) return c.text('unauthorized', 401);
  }

  let envelope: z.infer<typeof PushEnvelopeSchema>;
  try {
    envelope = PushEnvelopeSchema.parse(await c.req.json());
  } catch (err) {
    logger.error({ err }, '[action-send-push] malformed envelope');
    return c.text('ok', 200);
  }

  let event: z.infer<typeof ActionSendEventSchema>;
  try {
    const decoded = Buffer.from(envelope.message.data, 'base64').toString('utf8');
    event = ActionSendEventSchema.parse(JSON.parse(decoded));
  } catch (err) {
    logger.error({ err }, '[action-send-push] malformed action.send payload');
    return c.text('ok', 200);
  }

  const { connectionId } = event;
  const { tenantId, actionId } = event.message;

  // Resolve ChannelConnection. KAN-660 composer falls back to nil UUID when
  // no ACTIVE email connection exists — translate here.
  let connectionRow = null;
  if (connectionId !== NIL_UUID) {
    connectionRow = await prisma.channelConnection.findUnique({ where: { id: connectionId } });
  }
  if (!connectionRow) {
    connectionRow = await prisma.channelConnection.findFirst({
      where: { tenantId, channelType: 'EMAIL', status: 'ACTIVE' },
      orderBy: { connectedAt: 'desc' },
    });
  }
  if (!connectionRow) {
    logger.error(
      { tenantId, actionId, connectionId },
      '[action-send-push] no ACTIVE email ChannelConnection — ack + drop',
    );
    return c.text('ok', 200);
  }

  const connection = {
    id: connectionRow.id,
    tenantId: connectionRow.tenantId,
    channelType: connectionRow.channelType,
    provider: connectionRow.provider,
    providerAccountId: connectionRow.providerAccountId,
    status: connectionRow.status,
    credentialsRef: connectionRow.credentialsRef,
    label: connectionRow.label ?? undefined,
    metadata: (connectionRow.metadata as Record<string, unknown>) ?? {},
    connectedAt: connectionRow.connectedAt ?? undefined,
  } as any; // ChannelConnection shape from @growth/connector-contracts

  try {
    const result = await sendgrid.send(connection, event.message);

    const executedStatus: ActionExecutedEvent['status'] =
      result.status === 'sent'
        ? 'sent'
        : result.metadata?.suppressed === true
          ? 'suppressed'
          : 'failed';

    await publishEvent({
      topic: 'action.executed',
      timestamp: new Date().toISOString(),
      tenantId,
      actionId,
      // KAN-657: forward decisionId + contactId so outcome-writer can
      // correlate the executed event back to a Decision row + Contact row.
      decisionId: event.message.decisionId,
      contactId: event.message.contactId,
      connectionId: connection.id,
      channel: 'EMAIL',
      provider: 'sendgrid',
      status: executedStatus,
      ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
      ...(result.errorClass ? { errorClass: result.errorClass } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      attemptNumber: 1,
    });

    logger.info(
      { actionId, tenantId, status: executedStatus, providerMessageId: result.providerMessageId },
      '[action-send-push] dispatched',
    );

    // Transient failure → nack so Pub/Sub retries; deterministic → ack.
    if (executedStatus === 'failed' && result.errorClass === 'transient') {
      return c.text('retry', 500);
    }
    return c.text('ok', 200);
  } catch (err) {
    logger.error({ err, actionId, tenantId }, '[action-send-push] transient failure — nack');
    return c.text('retry', 500);
  }
});
