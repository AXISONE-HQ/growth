/**
 * KAN-1018 — decision.run.dlq push subscriber.
 *
 * Receives dead-lettered messages from both flows:
 *   1. EXPLICIT publish from decision-run-push handler when the
 *      error classifier categorizes a throw as 'persistent'
 *      (attribute dlqSource=persistent_classifier; immediate — no
 *      wait for 5 nack-retries).
 *   2. AUTO dead-letter when transient errors return 500 for 5
 *      consecutive deliveries (maxDeliveryAttempts=5 on the upstream
 *      subscription; attribute dlqSource is absent — Pub/Sub doesn't
 *      add one, the message arrives with the original event payload
 *      and the CloudPubSubDeadLetterSourceDeliveryCount attribute).
 *
 * Behavior: structured-log the dead-lettered event with full context
 * (tenant, contact, campaign, error, source) + ACK 200. NO retry. The
 * DLQ is the terminal — by definition, retrying again won't help.
 *
 * Scope is observability-only. Full re-drive tooling (manual replay,
 * batch re-run, etc.) is a follow-up. Alerting hooks to PagerDuty /
 * Slack / etc. read the structured log via Cloud Logging.
 *
 * Same OIDC-verification posture as the other Pub/Sub push subscribers
 * (class_structural_elimination/audience_mismatch: audience derived
 * from request URL automatically).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { verifyPubsubOidc } from '../lib/oidc-pubsub-verify.js';

export const decisionRunDlqApp = new Hono();

const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
    publishTime: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

decisionRunDlqApp.post('/decision-run-dlq', async (c) => {
  // OIDC: same posture as the other Pub/Sub push subscribers. The
  // audience is derived from the request URL, so subscription config
  // and code stay in lockstep (KAN-732 structural elimination).
  if (!(await verifyPubsubOidc(c))) {
    return c.text('unauthorized', 401);
  }

  let envelope: z.infer<typeof PushEnvelopeSchema>;
  try {
    envelope = PushEnvelopeSchema.parse(await c.req.json());
  } catch (err) {
    console.error(
      JSON.stringify({
        type: 'decision_run_dlq_malformed_envelope',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    // ACK — malformed messages can't be retried productively. They're
    // dead-lettered already; logging the malformation is the most we
    // can do from here.
    return c.text('ok', 200);
  }

  // Decode the inner payload. For dlqSource=persistent_classifier this
  // is the rich payload the handler published (originalEvent + error
  // context). For auto-dead-lettered transient retries this is the
  // ORIGINAL decision.run event (Pub/Sub re-publishes the source data
  // verbatim to the DLQ topic).
  let inner: unknown;
  try {
    const decoded = Buffer.from(envelope.message.data, 'base64').toString('utf8');
    inner = JSON.parse(decoded);
  } catch (err) {
    inner = {
      _decodeError: err instanceof Error ? err.message : String(err),
      _rawDataLength: envelope.message.data.length,
    };
  }

  const attrs = envelope.message.attributes ?? {};
  const dlqSource = attrs.dlqSource ?? 'auto_dead_letter';
  const deliveryAttempts = attrs.CloudPubSubDeadLetterSourceDeliveryCount;

  // Extract tenant/contact/campaign context — works for both inner
  // shapes (rich payload from explicit publish + raw event from
  // auto-dead-letter).
  type DlqContext = {
    tenantId: string | null;
    contactId: string | null;
    campaignId: string | null;
    classification: unknown;
    error: unknown;
    errorName: unknown;
    stack: unknown;
    engineStarted: unknown;
    originalMessageId: unknown;
  };
  const EMPTY_CTX: DlqContext = {
    tenantId: null,
    contactId: null,
    campaignId: null,
    classification: null,
    error: null,
    errorName: null,
    stack: null,
    engineStarted: null,
    originalMessageId: null,
  };
  const ctx: DlqContext =
    inner && typeof inner === 'object'
      ? (() => {
          const i = inner as Record<string, unknown>;
          const orig = (i.originalEvent as Record<string, unknown> | undefined) ?? i;
          return {
            tenantId: (orig.tenantId as string | undefined) ?? null,
            contactId: (orig.contactId as string | undefined) ?? null,
            campaignId: (orig.campaignId as string | undefined) ?? null,
            classification: i.classification ?? null,
            error: i.error ?? null,
            errorName: i.errorName ?? null,
            stack: i.stack ?? null,
            engineStarted: i.engineStarted ?? null,
            originalMessageId: i.originalMessageId ?? null,
          };
        })()
      : EMPTY_CTX;

  console.error(
    JSON.stringify({
      type: 'decision_run_dlq_received',
      dlqSource,
      deliveryAttempts: deliveryAttempts ?? null,
      dlqMessageId: envelope.message.messageId,
      publishTime: envelope.message.publishTime,
      ...ctx,
      // For ops triage — keep enough context to root-cause without
      // exposing PII. Original message payload, if present, is fully
      // captured by the persistent-classifier flow's `originalEvent`.
      reasonCode: typeof ctx.classification === 'object' && ctx.classification != null
        ? (ctx.classification as { reasonCode?: string }).reasonCode ?? null
        : null,
    }),
  );

  // ACK — DLQ is terminal by definition. Returning 500 would re-loop
  // the message in the DLQ subscription itself (not the upstream), which
  // is exactly the storm posture we're trying to prevent.
  return c.text('ok', 200);
});
