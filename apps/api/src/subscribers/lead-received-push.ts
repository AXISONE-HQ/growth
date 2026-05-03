/**
 * lead.received push subscriber — KAN-774 + KAN-793
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
 * Flow (KAN-793 — Phase 1 epic 3 of 3):
 *   Pub/Sub push → POST /pubsub/lead-received → verify OIDC → base64-decode
 *   → LeadReceivedEventSchema.parse
 *   → load Contact (need tenantId for bootstrap)
 *   → ensureTenantHasDefaultPipeline(tenantId)            ← KAN-793 lazy bootstrap
 *   → assignLeadToPipeline(prisma, contactId, ...)        ← rules / AI / posture
 *   → if mode ∈ {rule,ai_fallback,default_pipeline}:
 *       normalizeInbound(email payload)                   ← KAN-792 normalizer
 *       find startingStage(pipelineId, isInitial=true)
 *       tx: create Deal + DealStageHistory + Engagement   ← KAN-791 lifecycle entities
 *   → else (unassigned/escalated): log warn + skip Deal write
 *   → 200.
 *
 * Sequencing invariant (PRD §4 KAN-793):
 *   ensure-then-assign-then-write — the bootstrap eliminates the "no
 *   Pipelines exist" failure mode so assignLeadToPipeline always has at
 *   least one Pipeline to route to. Deal.pipelineId always matches the
 *   assignment's pipelineId by construction (no divergence with
 *   Contact.currentPipelineId — both come from the same assignment.result).
 *
 * Idempotency:
 *   - skipIfAssigned=true makes redelivery a no-op when the contact is
 *     already on a pipeline. assignLeadToPipeline writes its own audit log
 *     row per call regardless of mode.
 *   - Deal.correlationId = `deal:lead-received:${event.eventId}` (UNIQUE
 *     constraint) → second delivery for the same eventId hits the unique
 *     and is caught as a no-op (logged + 200).
 *   - Engagement.correlationId = `engagement:lead-received:${event.eventId}`
 *     handled inside logEngagement (existing-row return).
 *
 * Phase 1 ambiguous-routing posture:
 *   When assignment.mode === 'unassigned' or 'escalated', the Contact still
 *   exists (PRD §9.4 — no lead dropped) but no Deal is created. Phase 2
 *   (KAN-794 Brain Service + KAN-795 Customer Decision meta-pipeline) will
 *   resolve the ambiguous case asynchronously. For Phase 1 MVP this is
 *   logged as a warn; if it fires at scale, file a follow-up ticket.
 *
 * Error policy:
 *   - 200 (ack + drop) on malformed envelope / invalid LeadReceivedEvent
 *     payload (poison-message defense; redelivery won't help if the producer
 *     emitted a bad shape).
 *   - 200 (ack + log error) on Contact-not-found — producer should have
 *     created the Contact before publishing; redelivery won't conjure it.
 *   - 200 (ack + log error) on Deal correlationId UNIQUE collision (Pub/Sub
 *     redelivery, idempotent by construction).
 *   - 401 on missing/invalid OIDC token.
 *   - 500 (nack → Pub/Sub retries up to 5x → DLQ) on Prisma errors / other
 *     transient failures inside the assignment + Deal-write transaction.
 *   - 200 on `assignLeadToPipeline` returning escalated/unassigned modes —
 *     these are valid governance decisions, not errors.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { LeadReceivedEventSchema } from '@growth/shared';
import { prisma } from '../prisma.js';
import { verifyPubsubOidc } from '../lib/oidc-pubsub-verify.js';

// ─────────────────────────────────────────────
// Variable-specifier dynamic imports — TS6059 cohort hygiene per
// reference_variable_specifier_dynamic_import. Manually-declared types
// mirror the canonical signatures in packages/api/src/services/.
// ─────────────────────────────────────────────

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

interface BootstrapModule {
  ensureTenantHasDefaultPipeline: (
    prisma: unknown,
    tenantId: string,
  ) => Promise<{ id: string }>;
}
let _bootstrapModule: BootstrapModule | null = null;
async function loadBootstrapModule(): Promise<BootstrapModule> {
  if (_bootstrapModule) return _bootstrapModule;
  const spec = '../../../../packages/api/src/services/default-pipeline-bootstrap.js';
  _bootstrapModule = (await import(spec)) as BootstrapModule;
  return _bootstrapModule;
}

interface NormalizerModule {
  normalizeInbound: (input: {
    source: 'email';
    tenantId: string;
    payload: {
      fromAddress: string;
      subject?: string | null;
      bodyPreview?: string | null;
      attachmentCount?: number;
    };
  }) => Promise<{
    source: string;
    preParsed: { senderEmail: string; senderNameGuess: string | null; subject: string | null; bodyText: string | null };
    extracted: {
      firstName: string | null;
      lastName: string | null;
      company: string | null;
      phone: string | null;
      intentSummary: string | null;
      qualificationSignals: string[];
    };
    extractionConfidence: 'high' | 'medium' | 'low';
    extractionError: string | null;
  }>;
}
let _normalizerModule: NormalizerModule | null = null;
async function loadNormalizerModule(): Promise<NormalizerModule> {
  if (_normalizerModule) return _normalizerModule;
  const spec = '../../../../packages/api/src/services/lead-normalizer.js';
  _normalizerModule = (await import(spec)) as NormalizerModule;
  return _normalizerModule;
}

interface EngagementModule {
  logEngagement: (
    prisma: unknown,
    input: {
      tenantId: string;
      dealId: string;
      contactId: string;
      engagementType: string;
      channel?: string | null;
      occurredAt: Date;
      metadata?: Record<string, unknown>;
      correlationId?: string;
    },
  ) => Promise<unknown>;
}
let _engagementModule: EngagementModule | null = null;
async function loadEngagementModule(): Promise<EngagementModule> {
  if (_engagementModule) return _engagementModule;
  const spec = '../../../../packages/api/src/services/engagement-service.js';
  _engagementModule = (await import(spec)) as EngagementModule;
  return _engagementModule;
}

// ─────────────────────────────────────────────
// KAN-815 Phase 2 wiring — module loaders for the substrate the trigger
// invokes after the engagement-write transaction commits. Brain Service
// (KAN-794) is the only one wired in 815a; stage-transition-engine
// (KAN-796a) and message-shaper/send-policy/legacy-publish (KAN-797a +
// KAN-798a + KAN-660 dispatch) are wired in 815b/815c.
// ─────────────────────────────────────────────

interface BrainServiceModule {
  evaluateDealState: (
    prisma: unknown,
    dealId: string,
    options?: { tier?: 'cheap' | 'reasoning'; recentEngagementLimit?: number },
  ) => Promise<{
    dealId: string;
    evaluatedAt: Date;
    currentStateSnapshot: {
      dealStatus: string;
      currentStageName: string;
      currentStageOutcomeType: string;
      daysInCurrentStage: number;
      engagementCount: number;
      lastEngagementType: string | null;
      lastEngagementClass: string | null;
      daysSinceLastEngagement: number | null;
      moProgressPercent: number | null;
      pipelineName: string;
      pipelineObjectiveType: string;
    };
    nextBestAction: {
      type:
        | 'send_follow_up'
        | 'wait_for_response'
        | 'advance_stage'
        | 'escalate_to_human'
        | 'close_deal_lost'
        | 'no_action';
      targetStageId?: string;
      suggestedChannel?: 'email' | 'sms' | 'meta_messenger';
      suggestedTone?: 'curious' | 'professional' | 'urgent' | 'closing';
      reasoning: string;
    };
    confidence: number;
    modelTier: 'cheap' | 'reasoning';
    llmInputTokens: number;
    llmOutputTokens: number;
  }>;
}
let _brainServiceModule: BrainServiceModule | null = null;
async function loadBrainServiceModule(): Promise<BrainServiceModule> {
  if (_brainServiceModule) return _brainServiceModule;
  const spec = '../../../../packages/api/src/services/brain-service.js';
  _brainServiceModule = (await import(spec)) as BrainServiceModule;
  return _brainServiceModule;
}

/** Captured Brain decision shape — convenience alias for in-handler code. */
type Phase2BrainDecision = Awaited<ReturnType<BrainServiceModule['evaluateDealState']>>;

// ─────────────────────────────────────────────
// Hono app
// ─────────────────────────────────────────────

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

  // Load Contact for tenantId (producer created it pre-publish).
  const contact = await prisma.contact.findUnique({
    where: { id: event.contactId },
    select: { id: true, tenantId: true },
  });
  if (!contact) {
    console.error(
      `[lead-received-push] contact not found eventId=${event.eventId} contactId=${event.contactId} — ack+drop (producer invariant violation; redelivery cannot recover)`,
    );
    return c.text('ok', 200);
  }

  try {
    // KAN-793 sequencing: ensure-then-assign-then-write.
    const { ensureTenantHasDefaultPipeline } = await loadBootstrapModule();
    await ensureTenantHasDefaultPipeline(prisma, contact.tenantId);

    const { assignLeadToPipeline } = await loadAssignmentModule();
    const assignment = await assignLeadToPipeline(prisma, event.contactId, {
      skipIfAssigned: true,
    });

    console.log(
      `[lead-received-push] assigned contactId=${event.contactId} tenantId=${event.tenantId} mode=${assignment.mode}`,
    );

    let dealId: string | null = null;
    if (
      assignment.mode === 'rule' ||
      assignment.mode === 'ai_fallback' ||
      assignment.mode === 'default_pipeline'
    ) {
      dealId = await writePhase1Deal(event, contact.tenantId, assignment);
    } else {
      // Phase 1 posture: ambiguous routing produces Contact-only state.
      // Phase 2 KAN-794/795 resolves via Customer Decision meta-pipeline.
      console.warn(
        `[lead-received-push] phase-1-ambiguous-assignment-deal-skipped contactId=${event.contactId} tenantId=${event.tenantId} mode=${assignment.mode}`,
      );
    }

    // KAN-815a Phase 2 wiring trigger. Runs AFTER the engagement-write
    // transaction commits — Brain reads the just-written Engagement as
    // input. Wrapped in its own try/catch: Brain or downstream consumer
    // failures must NOT propagate (inbound Engagement is already
    // committed; failing the response would trigger Pub/Sub redelivery
    // and potentially double-write the Engagement).
    if (dealId) {
      await wirePhase2Consumers(dealId, event.eventId).catch((err) => {
        console.warn(
          `[lead-received-push] phase-2-wiring-error dealId=${dealId} eventId=${event.eventId} err=${(err as Error)?.message ?? String(err)}`,
        );
      });
    }

    return c.text('ok', 200);
  } catch (err) {
    // Idempotency catch — repeated delivery of the same eventId hits
    // Deal.correlationId UNIQUE. Treat as no-op (200).
    if (isUniqueConstraintViolation(err)) {
      console.log(
        `[lead-received-push] idempotent-redelivery eventId=${event.eventId} contactId=${event.contactId} — ack`,
      );
      return c.text('ok', 200);
    }
    console.error(
      `[lead-received-push] assignment+deal write failed contactId=${event.contactId} eventId=${event.eventId} — nack`,
      err,
    );
    return c.text('retry', 500);
  }
});

// ─────────────────────────────────────────────
// Deal + DealStageHistory + Engagement write — KAN-793
// ─────────────────────────────────────────────

async function writePhase1Deal(
  event: z.infer<typeof LeadReceivedEventSchema>,
  tenantId: string,
  assignment: { mode: string; pipelineId?: string; stageId?: string | null },
): Promise<string | null> {
  const pipelineId = assignment.pipelineId;
  if (!pipelineId) {
    // Should not reach here — caller filtered modes that always include
    // pipelineId. Guard preserves the invariant explicitly.
    console.error(
      `[lead-received-push] invariant-violation: assignment.mode=${assignment.mode} without pipelineId (eventId=${event.eventId})`,
    );
    return null;
  }

  // Find the initial Stage of the assigned Pipeline. The KAN-791 partial
  // UNIQUE index guarantees at most one isInitial Stage per Pipeline; the
  // KAN-793 bootstrap guarantees the default Pipeline always has one. For
  // tenant-created Pipelines this still depends on the editor not breaking
  // the invariant — the index would catch it; this lookup either finds
  // the Stage or skips the Deal write.
  const startingStage = await prisma.stage.findFirst({
    where: { pipelineId, isInitial: true },
    select: { id: true },
  });
  if (!startingStage) {
    console.error(
      `[lead-received-push] no-initial-stage-for-pipeline pipelineId=${pipelineId} eventId=${event.eventId} — Deal NOT created`,
    );
    return null;
  }

  // Normalize the inbound email payload (KAN-792). Failure-isolated by
  // design — extractionConfidence='low' on LLM error; we still write the
  // Deal + Engagement so the lead lands.
  const { normalizeInbound } = await loadNormalizerModule();
  const normalized = await normalizeInbound({
    source: 'email',
    tenantId,
    payload: {
      fromAddress: event.metadata.fromAddress ?? '',
      subject: event.metadata.subject ?? null,
      bodyPreview: event.metadata.bodyPreview ?? null,
      attachmentCount: event.metadata.attachmentCount,
    },
  });

  const { logEngagement } = await loadEngagementModule();

  // Single transaction — Deal.correlationId UNIQUE catches Pub/Sub
  // redelivery; logEngagement does its own correlationId existence
  // check before insert.
  const dealId = await prisma.$transaction(async (tx) => {
    const deal = await tx.deal.create({
      data: {
        tenantId,
        contactId: event.contactId,
        pipelineId,
        currentStageId: startingStage.id,
        enteredStageAt: new Date(),
        value: 0,
        currency: 'USD',
        // event.eventId is UUID-shaped + always present per
        // LeadReceivedEventSchema; safe as the idempotency anchor across
        // Pub/Sub redeliveries.
        correlationId: `deal:lead-received:${event.eventId}`,
        microObjectiveProgress: {},
        metadata: {
          source: 'track_a_email_inbound',
          assignmentMode: assignment.mode,
          normalizedLeadConfidence: normalized.extractionConfidence,
          ...(normalized.extractionError && {
            normalizerError: normalized.extractionError,
          }),
        },
      },
    });

    await tx.dealStageHistory.create({
      data: {
        dealId: deal.id,
        fromStageId: null,
        toStageId: startingStage.id,
        triggeredBy: 'normalizer',
        metadata: { source: 'track_a_email_inbound', eventId: event.eventId },
      },
    });

    await logEngagement(tx, {
      tenantId,
      dealId: deal.id,
      contactId: event.contactId,
      engagementType: 'email_received',
      channel: 'email',
      // event.receivedAt is the canonical inbound timestamp (root-level on
      // LeadReceivedEventSchema, not nested in metadata).
      occurredAt: new Date(event.receivedAt),
      correlationId: `engagement:lead-received:${event.eventId}`,
      metadata: {
        senderEmail: normalized.preParsed.senderEmail,
        subject: normalized.preParsed.subject,
        extractionConfidence: normalized.extractionConfidence,
      },
    });

    // Return dealId so the caller can pass it to KAN-815 Phase 2 wiring.
    return deal.id as string;
  });

  return dealId;
}

// ─────────────────────────────────────────────
// KAN-815 Phase 2 wiring — invoked AFTER the engagement-write transaction
// commits. Brain Service evaluates the just-written Deal state and routes
// the decision to consumers (KAN-815b stage transitions / KAN-815c message
// dispatch). All failures isolated via .catch in the caller — Phase 2
// errors must not propagate (inbound Engagement is already committed).
// ─────────────────────────────────────────────

async function wirePhase2Consumers(dealId: string, eventId: string): Promise<void> {
  // Step 1: Brain evaluation — single LLM call per inbound; same decision
  // is passed through to all consumers (no double-eval per Phase 2 design).
  const { evaluateDealState } = await loadBrainServiceModule();
  const brainDecision: Phase2BrainDecision = await evaluateDealState(prisma, dealId);

  console.log(
    `[lead-received-push] phase-2-brain-evaluated dealId=${dealId} eventId=${eventId} actionType=${brainDecision.nextBestAction.type} confidence=${brainDecision.confidence.toFixed(2)} tokens=${brainDecision.llmInputTokens}/${brainDecision.llmOutputTokens}`,
  );

  // KAN-815b stage-transition consumer wired in commit 2.
  // KAN-815c message-dispatch consumer wired in commit 3.
}

/**
 * Detect Prisma UNIQUE constraint violation. Caught at the top-level handler
 * to make Pub/Sub redelivery (same eventId) a 200 no-op.
 */
function isUniqueConstraintViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'P2002';
}
