/**
 * action.send push subscriber — KAN-661 (provider-swapped to Resend).
 *
 * Subscription: action.send.sendgrid-adapter (push to /pubsub/action-send)
 *   ↑ subscription name retained for stability with the existing Pub/Sub
 *     topology; the adapter dispatched-to is now Resend (provider swap only).
 *
 * Flow:
 *   Pub/Sub push → POST /pubsub/action-send
 *   → Decode base64 payload + zod-validate ActionSendEvent
 *   → Resolve ChannelConnection (nil-UUID fallback → any ACTIVE simple-mode EMAIL conn for tenant)
 *   → Dispatch to ResendAdapter.send()
 *   → Publish action.executed with status sent/failed/suppressed
 *   → 200 on success
 *
 * Auth: Pub/Sub OIDC is enforced by `buildOidcMiddleware` mounted on
 * `/pubsub/*` in app.ts (KAN-688). This handler runs only for verified
 * requests — no inline check needed.
 *
 * Error policy (matches KAN-660):
 *   - 200 (ack + drop) on malformed envelope/payload, unknown connection, zod failures
 *   - 500 (nack → Pub/Sub retry → DLQ) on Resend 5xx / network / publish errors
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { convert as htmlToText } from 'html-to-text';
import { ActionSendEventSchema, type ActionExecutedEvent } from '@growth/connector-contracts';
import { ResendAdapter } from '../adapters/resend/index.js';
import { prisma } from '../repository/connection-repository.js';
import { publishEvent } from '../pubsub/index.js';
import { logger } from '../logger.js';

// KAN-817 — content visibility for cross-turn anti-repetition. Hard caps
// applied here at the publish site so the schema's `.max()` is enforced
// before zod sees the payload. Any cap drift between this file and
// `packages/connector-contracts/src/events.ts` will fail loud at publish.
const SUBJECT_CAP = 200;
const BODY_PREVIEW_CAP = 500;

/**
 * Derive a plain-text preview from the OutboundMessage content. Used to
 * populate `bodyPreview` on the action.executed event.
 *
 *   - Prefer `content.body` (already plain) when present
 *   - Fall back to `htmlToText(content.html)` — drops links + images,
 *     collapses whitespace (KAN-817 defaults; sibling configuration to the
 *     ResendAdapter's existing htmlToText call site)
 *   - Returns `undefined` (NOT empty string) when neither is present, so
 *     the Shaper's anti-repetition block skips the entry entirely instead
 *     of rendering a blank `body:` line
 */
function deriveBodyPreview(content: {
  body?: string;
  html?: string;
}): string | undefined {
  // Plain-body path — trim + post-trim length check. A whitespace-only body
  // (e.g. "   \n\n   ") should fall through to the html fallback or return
  // undefined, NOT take precedence and ship noise to Brain's prompt.
  if (content.body) {
    const trimmed = content.body.trim();
    if (trimmed.length > 0) {
      return trimmed.slice(0, BODY_PREVIEW_CAP);
    }
  }
  if (content.html && content.html.length > 0) {
    const plain = htmlToText(content.html, {
      wordwrap: false,
      selectors: [
        // Drop links — we want the prose, not "click here ▸ https://…".
        { selector: 'a', options: { ignoreHref: true } },
        // Drop images.
        { selector: 'img', format: 'skip' },
      ],
    })
      // Collapse whitespace into single spaces — multi-newline runs in
      // converted HTML hurt the prompt's signal-to-noise.
      .replace(/\s+/g, ' ')
      .trim();
    if (plain.length === 0) return undefined;
    return plain.slice(0, BODY_PREVIEW_CAP);
  }
  return undefined;
}

export const actionSendPushApp = new Hono();

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

// Singleton adapter — no per-request state; the Resend SDK client is
// memoized lazily inside the adapter module.
const resend = new ResendAdapter();

actionSendPushApp.post('/action-send', async (c) => {
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
    const result = await resend.send(connection, event.message);

    const executedStatus: ActionExecutedEvent['status'] =
      result.status === 'sent'
        ? 'sent'
        : result.metadata?.suppressed === true
          ? 'suppressed'
          : 'failed';

    // KAN-817 — content visibility. Capture rendered subject + bodyPreview
    // from the OutboundMessage about to be sent, so the consumer can persist
    // them in Engagement.metadata and the next-turn Shaper can read them
    // for cross-turn anti-repetition. Caps applied here (NOT at the schema
    // level alone) so that runaway content never reaches zod.
    //
    // Webhook-side asymmetry: the Resend webhook handler's `publishExecuted`
    // (apps/connectors/src/webhooks/resend.ts) leaves these undefined — it
    // doesn't have the full body in scope. Acceptable because the consumer
    // is idempotent on actionId; this send-time event fires first and wins.
    //
    // In the rare case this 'sent' publish fails but Resend's 'delivered'
    // webhook succeeds, the Engagement will be created from the webhook
    // event with subject but no bodyPreview. Acceptable degradation for v1;
    // Brain will have less anti-repetition signal on that one engagement.
    const rawSubject = event.message.content.subject;
    const subjectField = rawSubject ? rawSubject.slice(0, SUBJECT_CAP) : undefined;
    const bodyPreviewField = deriveBodyPreview(event.message.content);

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
      provider: 'resend',
      status: executedStatus,
      ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
      ...(result.errorClass ? { errorClass: result.errorClass } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      attemptNumber: 1,
      ...(subjectField ? { subject: subjectField } : {}),
      ...(bodyPreviewField ? { bodyPreview: bodyPreviewField } : {}),
      // KAN-1036 — thread the per-decision reply token from the rendered
      // OutboundMessage into the action.executed wire so the apps/api
      // action-executed-push consumer persists it at the M3-2.5a sidecar
      // $transaction (engagement_email_metadata.reply_token). Recipient's
      // reply preserves the subaddress (`<slug>+<token>@<domain>`),
      // Resend Receiving forwards it, lead-received-push correlates via
      // the token. Replaces the wire-Message-ID-based Plan A.
      ...(event.message.replyToken ? { replyToken: event.message.replyToken } : {}),
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
