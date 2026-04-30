/**
 * lead.received push subscriber — KAN-774
 *
 * Cloud Run Pub/Sub push endpoint. Closes the consumer gap surfaced during
 * KAN-741 audit (Lead Inbox producer was complete but consumer subscriber
 * was never built; would have caused DLQ accumulation + lost lead
 * assignments at first tenant onboarding).
 *
 * Subscription provisioned operator-side per `reference_lead_inbox.md`
 * step 2:
 *   gcloud pubsub subscriptions create lead.received.assignment-worker \
 *     --topic=lead.received \
 *     --push-endpoint=$GROWTH_API_URL/pubsub/lead-received \
 *     --push-auth-service-account=pubsub-invoker@growth-493400.iam.gserviceaccount.com \
 *     --push-auth-token-audience=$GROWTH_API_URL/pubsub/lead-received
 *
 * Audience MUST equal `pushEndpoint` exactly. KAN-732 retires per-subscriber
 * audience env vars: the verifyPubsubOidc helper derives the expected
 * audience from the inbound request URL. No LEAD_RECEIVED_AUDIENCE env var
 * needed.
 *
 * Flow: Pub/Sub push → POST /pubsub/lead-received → verify OIDC → base64-decode
 *       → LeadReceivedEventSchema.parse (from @growth/shared)
 *       → assignLeadToPipeline(prisma, contactId, { skipIfAssigned: true })
 *       → 200.
 *
 * Idempotency: skipIfAssigned=true makes redelivery a no-op when the contact
 * is already on a pipeline. assignLeadToPipeline writes its own audit log
 * row per call regardless of mode.
 *
 * Error policy:
 *   - 200 (ack + drop) on malformed envelope / invalid LeadReceivedEvent
 *     payload (poison-message defense; redelivery won't help if the producer
 *     emitted a bad shape).
 *   - 401 on missing/invalid OIDC token.
 *   - 500 (nack → Pub/Sub retries up to 5x → DLQ) on Prisma errors or other
 *     transient failures inside assignLeadToPipeline.
 *   - 200 on `assignLeadToPipeline` returning escalated/unassigned modes —
 *     these are valid governance decisions, not errors.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { LeadReceivedEventSchema } from '@growth/shared';
import { prisma } from '../prisma.js';
import { verifyPubsubOidc } from '../lib/oidc-pubsub-verify.js';

// Variable-specifier dynamic import keeps lead-assignment.ts out of the
// apps/api static graph (TS6059 cohort hygiene). Manually-declared types
// per the established pattern (mirrors llm-call-push.ts).
interface AssignmentModule {
  assignLeadToPipeline: (
    prisma: unknown,
    contactId: string,
    options?: { skipIfAssigned?: boolean; aiConfidenceThresholdOverride?: number },
  ) => Promise<{ mode: string; pipelineId?: string; stageId?: string | null }>;
}
let _assignmentModule: AssignmentModule | null = null;
async function loadAssignmentModule(): Promise<AssignmentModule> {
  if (_assignmentModule) return _assignmentModule;
  const spec = '../../../../packages/api/src/services/lead-assignment.js';
  _assignmentModule = (await import(spec)) as AssignmentModule;
  return _assignmentModule;
}

export const leadReceivedPushApp = new Hono();

const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

leadReceivedPushApp.post('/lead-received', async (c) => {
  // KAN-732: shared helper derives audience from request URL — no
  // LEAD_RECEIVED_AUDIENCE env var. Audience-mismatch class structurally
  // impossible.
  if (!(await verifyPubsubOidc(c))) {
    return c.text('unauthorized', 401);
  }

  let envelope: z.infer<typeof PushEnvelopeSchema>;
  try {
    envelope = PushEnvelopeSchema.parse(await c.req.json());
  } catch (err) {
    console.error(
      `[lead-received-push] malformed envelope: ${(err as Error)?.message ?? String(err)}`,
    );
    return c.text('ok', 200);
  }

  let event: z.infer<typeof LeadReceivedEventSchema>;
  try {
    const decoded = Buffer.from(envelope.message.data, 'base64').toString('utf8');
    event = LeadReceivedEventSchema.parse(JSON.parse(decoded));
  } catch (err) {
    console.error(
      `[lead-received-push] malformed lead.received payload: ${(err as Error)?.message ?? String(err)}`,
    );
    return c.text('ok', 200);
  }

  try {
    const { assignLeadToPipeline } = await loadAssignmentModule();
    const result = await assignLeadToPipeline(prisma, event.contactId, {
      skipIfAssigned: true,
    });
    console.log(
      `[lead-received-push] assigned contactId=${event.contactId} tenantId=${event.tenantId} mode=${result.mode}`,
    );
    return c.text('ok', 200);
  } catch (err) {
    console.error(
      `[lead-received-push] assignment failed contactId=${event.contactId} — nack`,
      err,
    );
    return c.text('retry', 500);
  }
});
