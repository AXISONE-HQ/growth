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
import OpenAI from 'openai';
import {
  LeadReceivedEventSchema,
  stripMessageIdBrackets,
  parseReferencesHeader,
  // KAN-1037-PR3 — M3-2.5c reply-loop-closure event contract.
  CONTACT_REPLIED_TOPIC,
  buildContactRepliedEvent,
  type ContactRepliedEvent,
} from '@growth/shared';
import { prisma } from '../prisma.js';
import { verifyPubsubOidc } from '../lib/oidc-pubsub-verify.js';
import { getRedisClient } from '../services/redis-client.js';

// KAN-828 fix-forward — Brain Service + Message Shaper need redis + openai
// clients injected so the Knowledge Layer retrieval (retrieveRelevantChunks)
// fires on every Brain/Shaper invocation. Without these, the modules treat
// `redis=undefined / openai=undefined` as "retrieval disabled" and silently
// skip the `## Company knowledge` section. The KAN-828 caller-wire-up gap
// surfaced via 515-token Brain prompt forensic anchor on the post-deploy
// smoke (matched pre-feature baseline exactly → retrieval never fired).
//
// Lazy singleton + null-on-missing-key. OpenAI's constructor throws
// synchronously on missing/empty `apiKey` even when invoked lazily — so
// in test envs without OPENAI_API_KEY we return null. Brain Service +
// Message Shaper accept `openai: null` and skip retrieval entirely
// (same behavior as pre-KAN-828 callers). In Cloud Run with the secret
// injected, the real client is constructed on first call.
let _openai: OpenAI | null = null;
let _openaiAttempted = false;
function getOpenAIClient(): OpenAI | null {
  if (_openai || _openaiAttempted) return _openai;
  _openaiAttempted = true;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  _openai = new OpenAI({ apiKey });
  return _openai;
}

// ─────────────────────────────────────────────
// Variable-specifier dynamic imports — TS6059 cohort hygiene per
// reference_variable_specifier_dynamic_import. Manually-declared types
// mirror the canonical signatures in packages/api/src/services/.
// ─────────────────────────────────────────────

// KAN-965 — local mirror of packages/api/src/services/lead-assignment.ts:70
// AssignmentResult tagged-union. We can't import the type directly because
// the variable-specifier dynamic import pattern (reference: KAN-689 cohort,
// `await import(spec)` with a non-literal spec) deliberately keeps that
// module out of the static type graph to bypass TS6059. The duplication is
// the price; the structural-elimination test below (and the new exhaustive
// switch's `never` default) catches drift between the two.
type AssignmentResult =
  | { mode: 'rule'; ruleId: string; pipelineId: string; stageId: string | null }
  | { mode: 'objective_primary'; pipelineId: string; stageId: string | null; objectiveId: string }
  | { mode: 'ai_fallback'; pipelineId: string; stageId: string | null; confidence: number; reasoning: string }
  | { mode: 'default_pipeline'; pipelineId: string; stageId: string | null }
  | { mode: 'escalated'; escalationId: string }
  | { mode: 'unassigned'; reason: string };

interface AssignmentModule {
  assignLeadToPipeline: (
    prisma: unknown,
    contactId: string,
    options?: { skipIfAssigned?: boolean; aiConfidenceThresholdOverride?: number },
  ) => Promise<AssignmentResult>;
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
      companyName: string | null;
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

// M3-2.5b — resolve-active-deal loader. Variable-specifier dynamic import
// keeps the helper out of the apps/api TS6059 cohort (same pattern as
// engagement-service + lead-normalizer loaders above; tactical until KAN-689).
interface ResolveActiveDealModule {
  resolveActiveDealForContact: (
    prisma: unknown,
    tenantId: string,
    contactId: string,
  ) => Promise<string | null>;
}
let _resolveActiveDealModule: ResolveActiveDealModule | null = null;
async function loadResolveActiveDealModule(): Promise<ResolveActiveDealModule> {
  if (_resolveActiveDealModule) return _resolveActiveDealModule;
  const spec = '../../../../packages/api/src/services/resolve-active-deal.js';
  _resolveActiveDealModule = (await import(spec)) as ResolveActiveDealModule;
  return _resolveActiveDealModule;
}

// KAN-1042 PR A2 — sub-objectives loader for the engine-driven
// transition_sub_objective dispatcher arm. Variable-specifier dynamic
// import (KAN-689 cohort) — sibling to loadResolveActiveDealModule above.
// Inline interface mirrors the EXTENDED signature shipped by PR A2:
// source + optional engineContext + wasNoOp return. Operator-path caller
// at router.ts:6630 uses the same module via router's own loader and
// flows through default source='manual' (back-compat).
interface SubObjectivesModule {
  transitionSubObjectiveState: (
    prisma: unknown,
    tenantId: string,
    actor: string,
    input: {
      contactId: string;
      subObjectiveKey: string;
      toState: 'known' | 'not_applicable';
      value?: string | number | null;
    },
    source?: 'manual' | 'engine',
    engineContext?: {
      reasoning: string;
      confidence: number;
      decisionId: string | null;
      eventId: string;
    },
  ) => Promise<{ ok: true; previousState: string; wasNoOp: boolean }>;
}
let _subObjectivesModule: SubObjectivesModule | null = null;
async function loadSubObjectivesModule(): Promise<SubObjectivesModule> {
  if (_subObjectivesModule) return _subObjectivesModule;
  const spec = '../../../../packages/api/src/services/sub-objective-gap-tracker.js';
  _subObjectivesModule = (await import(spec)) as SubObjectivesModule;
  return _subObjectivesModule;
}

// ─────────────────────────────────────────────
// KAN-815 Phase 2 wiring — module loaders for the substrate the trigger
// invokes after the engagement-write transaction commits. Brain Service
// (KAN-794) is the only one wired in 815a; stage-transition-engine
// (KAN-796a) and message-shaper/send-policy/legacy-publish (KAN-797a +
// KAN-798a + KAN-660 dispatch) are wired in 815b/815c.
// ─────────────────────────────────────────────

// KAN-1052 — local mirror of `BrainLatestInbound` (canonical at
// packages/api/src/services/brain-service.ts). KAN-689 boundary
// (variable-specifier dynamic import; apps/api cannot statically import
// packages/api types). Sibling-discipline pattern: both shapes must
// move together.
interface BrainLatestInbound {
  receivedAt: string;
  senderEmail: string;
  bodyText: string;
  subjectLine: string;
  inReplyToDecisionId: string;
  threadDepth: number;
}

interface BrainServiceModule {
  evaluateDealState: (
    prisma: unknown,
    dealId: string,
    options?: {
      tier?: 'cheap' | 'reasoning';
      recentEngagementLimit?: number;
      // KAN-825 — origin-aware chained Brain calls. Inline mirror of the
      // canonical `EvaluateOptions` in brain-service.ts; both must move
      // together (sibling discipline to KAN-817 schema mirror).
      // KAN-835 extends with `post_wait_acknowledgment`.
      triggerContext?: 'inbound' | 'post_stage_advance' | 'post_wait_acknowledgment';
      postStageAdvance?: { fromStageName: string; toStageName: string };
      // KAN-828 — duck-typed Redis + OpenAI clients for Knowledge Layer
      // retrieval. Inline mirror of canonical `EvaluateOptions.redis/openai`.
      redis?: unknown;
      openai?: unknown;
      // KAN-1037-PR4 — latestInbound for the reply-chain cognitive
      // surface. KAN-1052 extends use to the initial-lead path so the
      // engine reads first-inquiry body text on the FIRST evaluation.
      latestInbound?: BrainLatestInbound;
    },
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
        | 'no_action'
        // KAN-1042 PR A1 — engine-driven sub-objective transition.
        // Dispatcher-level governance (PR A2's new arm reads
        // Tenant.autoTransitionSubObjectives).
        | 'transition_sub_objective';
      targetStageId?: string;
      suggestedChannel?: 'email' | 'sms' | 'meta_messenger';
      suggestedTone?: 'curious' | 'professional' | 'urgent' | 'closing';
      reasoning: string;
      // KAN-1042 PR A1 — payload carried when type === 'transition_sub_objective'.
      // BANT-5 key contract matches the router enum at
      // apps/api/src/router.ts:6617.
      subObjectiveTransition?: {
        subObjectiveKey: 'timeline' | 'budget' | 'authority' | 'need' | 'motivation';
        toState: 'known' | 'not_applicable';
        value: string | number | null;
      };
    };
    confidence: number;
    modelTier: 'cheap' | 'reasoning';
    llmInputTokens: number;
    llmOutputTokens: number;
  }>;
  // KAN-1052 — pure builder for `BrainLatestInbound`. Surfaced through the
  // loader so both initial-lead (here) and reply-chain (contact-replied-
  // push.ts) callers go through one helper. Phase B's multi-turn extension
  // touches one helper, not two callers.
  buildLatestInboundContext: (input: BrainLatestInbound) => BrainLatestInbound;
}
let _brainServiceModule: BrainServiceModule | null = null;
async function loadBrainServiceModule(): Promise<BrainServiceModule> {
  if (_brainServiceModule) return _brainServiceModule;
  const spec = '../../../../packages/api/src/services/brain-service.js';
  _brainServiceModule = (await import(spec)) as BrainServiceModule;
  return _brainServiceModule;
}

/**
 * Captured Brain decision shape — convenience alias for in-handler code.
 * Exported (KAN-1037-PR4.5) so cross-subscriber callers (specifically
 * contact-replied-push) can declare the precomputedDecision param shape
 * when calling wirePhase2Consumers with the PR4-evaluated decision.
 */
export type Phase2BrainDecision = Awaited<ReturnType<BrainServiceModule['evaluateDealState']>>;

interface MessageShaperModule {
  shapeMessage: (
    prisma: unknown,
    dealId: string,
    options?: {
      tier?: 'cheap' | 'reasoning';
      brainDecision?: Phase2BrainDecision;
      recentOutboundLimit?: number;
      forceChannel?: 'email' | 'sms' | 'meta_messenger';
      // KAN-828 — duck-typed clients for Knowledge Layer retrieval.
      redis?: unknown;
      openai?: unknown;
    },
  ) => Promise<
    | {
        type: 'shaped';
        message: {
          dealId: string;
          shapedAt: Date;
          channel: 'email' | 'sms' | 'meta_messenger';
          subject?: string;
          body: string;
          tone: 'curious' | 'professional' | 'urgent' | 'closing';
          rationale: string;
          antiRepetitionContextCount: number;
          modelTier: 'cheap' | 'reasoning';
          llmInputTokens: number;
          llmOutputTokens: number;
        };
        brainDecision: Phase2BrainDecision;
      }
    | { type: 'no_shape'; dealId: string; reason: string; brainDecision?: Phase2BrainDecision }
  >;
}
let _messageShaperModule: MessageShaperModule | null = null;
async function loadMessageShaperModule(): Promise<MessageShaperModule> {
  if (_messageShaperModule) return _messageShaperModule;
  const spec = '../../../../packages/api/src/services/message-shaper.js';
  _messageShaperModule = (await import(spec)) as MessageShaperModule;
  return _messageShaperModule;
}

interface SendPolicyModule {
  evaluateSendPolicy: (
    prisma: unknown,
    tenantId: string,
    contactId: string,
    message: { channel: 'email' | 'sms' | 'meta_messenger' },
    options?: { skipSuppression?: boolean; skipRateLimit?: boolean; skipTimeOfDay?: boolean },
  ) => Promise<
    | { type: 'allow'; reason: string }
    | { type: 'deny'; reason: string; ruleViolated: 'suppression' | 'rate_limit' }
    | { type: 'defer'; reason: string; deferUntil: Date }
  >;
}
let _sendPolicyModule: SendPolicyModule | null = null;
async function loadSendPolicyModule(): Promise<SendPolicyModule> {
  if (_sendPolicyModule) return _sendPolicyModule;
  const spec = '../../../../packages/api/src/services/send-policy.js';
  _sendPolicyModule = (await import(spec)) as SendPolicyModule;
  return _sendPolicyModule;
}

/**
 * Legacy publish helpers from message-composer.ts (KAN-660/661 dispatch
 * infrastructure). KAN-815c reuses these — no new connector code. Note that
 * publishActionSend takes a PubSubClient as first arg + a ComposedMessage
 * (legacy shape with subject/body/unsubscribeUrl). KAN-815c maps the
 * Phase 2 ShapedMessage to ComposedMessage at the call site.
 */
interface MessageComposerModule {
  publishActionSend: (
    client: unknown,
    input: {
      tenantId: string;
      contactId: string;
      decisionId: string;
      toEmail: string;
      composed: { subject: string; body: string; unsubscribeUrl: string };
      connectionId: string;
      // KAN-816: optional per-message Reply-To override for customer-reply
      // routing (`<inboxSlug>@leads.<LEAD_INBOX_DOMAIN>`).
      replyTo?: string;
      // KAN-1036: per-decision reply correlation token. Threaded through
      // to outbound sidecar persistence so the recipient's reply can
      // O(1)-correlate to the originating Decision row at the inbound
      // consumer.
      replyToken?: string;
    },
  ) => Promise<string>;
  resolveEmailConnectionId: (prisma: unknown, tenantId: string) => Promise<string | null>;
  // KAN-816 + KAN-1036: lookup helper that constructs the tenant's customer-
  // reply address from `Tenant.inboxSlug` + `LEAD_INBOX_DOMAIN`. Pre-KAN-1036
  // shape was `Promise<string | null>` (just the Reply-To address). Post-
  // KAN-1036 the resolver also mints a per-decision token when a decisionId
  // is in scope — returns `{ replyTo: string; replyToken: string | null }`
  // or null (no inboxSlug → omit Reply-To).
  //
  // KAN-1051 fix-forward — pre-fix this interface still declared the
  // pre-KAN-1036 `string | null` shape, masking the type mismatch at
  // L2168 from tsc. The caller spread the object into `replyTo`, the
  // connector rejected every dispatch with `Expected string, received
  // object`. Aligning the loader signature with the real return type
  // makes the class of bug structurally impossible going forward.
  resolveReplyToForTenant: (
    prisma: unknown,
    tenantId: string,
    decisionId?: string,
  ) => Promise<{ replyTo: string; replyToken: string | null } | null>;
}
let _messageComposerModule: MessageComposerModule | null = null;
async function loadMessageComposerModule(): Promise<MessageComposerModule> {
  if (_messageComposerModule) return _messageComposerModule;
  const spec = '../../../../packages/api/src/services/message-composer.js';
  _messageComposerModule = (await import(spec)) as MessageComposerModule;
  return _messageComposerModule;
}

interface PubSubClientModule {
  getPubSubClient: () => unknown;
}
let _pubsubClientModule: PubSubClientModule | null = null;
async function loadPubSubClientModule(): Promise<PubSubClientModule> {
  if (_pubsubClientModule) return _pubsubClientModule;
  const spec = '../../../../packages/api/src/lib/pubsub-client.js';
  _pubsubClientModule = (await import(spec)) as PubSubClientModule;
  return _pubsubClientModule;
}

interface StageTransitionEngineModule {
  evaluateStageTransition: (
    prisma: unknown,
    dealId: string,
    options?: {
      tier?: 'cheap' | 'reasoning';
      minConfidenceForTransition?: number;
      triggeredBy?: 'normalizer' | 'agent' | 'human' | 'system' | 'rule';
      // KAN-834: pre-computed Brain decision from the dispatcher. When
      // supplied, the engine SKIPS its internal evaluateDealState call.
      // Cures the LLM-non-determinism double-eval disagreement class
      // (the prior "MVP accepts the double-eval" comment described what
      // closes here). Single Brain call per inbound now.
      brainDecision?: Phase2BrainDecision;
    },
  ) => Promise<{
    type: 'transitioned' | 'no_transition' | 'skipped';
    dealId: string;
    fromStageId?: string;
    toStageId?: string;
    // KAN-825 — only present on type='transitioned'. Used by the chained
    // Brain call's prompt to render fromStageName/toStageName in the
    // directive Trigger block.
    fromStageName?: string;
    toStageName?: string;
    reason?: string;
    transitionRowId?: string;
  }>;
}
let _stageTransitionEngineModule: StageTransitionEngineModule | null = null;
async function loadStageTransitionEngineModule(): Promise<StageTransitionEngineModule> {
  if (_stageTransitionEngineModule) return _stageTransitionEngineModule;
  const spec = '../../../../packages/api/src/services/stage-transition-engine.js';
  _stageTransitionEngineModule = (await import(spec)) as StageTransitionEngineModule;
  return _stageTransitionEngineModule;
}

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
    // KAN-819: Deal continuity for multi-turn AI conversations. Per Sprint 6
    // pivot constraint, a Contact may have AT MOST one open Deal per Pipeline
    // — so an existing open Deal means this inbound is a follow-up turn in an
    // ongoing conversation, not a new lead. Reuse the existing Deal so the
    // Brain reads the full conversation history. Only create a fresh Deal
    // when the Contact has no open Deals (first contact OR all prior closed).
    //
    // Multi-open-Deal anomaly (against constraint): pick most recent + warn.
    // Pre-Sprint-10 smoke iterations already produced multiple open Deals
    // for the dogfood Contact; the warn path is exercised on every smoke
    // until manual cleanup. KAN-820 follow-up will deduplicate on read.
    const existingOpenDeals = await prisma.deal.findMany({
      where: {
        contactId: contact.id,
        currentStage: { outcomeType: 'open' },
      },
      orderBy: { createdAt: 'desc' },
      include: { currentStage: { select: { id: true, name: true, outcomeType: true } } },
    });

    let dealId: string | null = null;

    if (existingOpenDeals.length > 0) {
      // ── Multi-turn case: reuse existing open Deal ──
      const reusedDeal = existingOpenDeals[0]!;
      dealId = reusedDeal.id;

      if (existingOpenDeals.length > 1) {
        console.warn(
          `[lead-received-push] kan-819-multiple-open-deals-violates-constraint-using-most-recent contactId=${contact.id} openDealCount=${existingOpenDeals.length} reusingDealId=${reusedDeal.id} otherOpenDealIds=${existingOpenDeals.slice(1).map((d) => d.id).join(',')}`,
        );
      } else {
        console.log(
          `[lead-received-push] kan-819-reusing-existing-open-deal-multi-turn contactId=${contact.id} reusingDealId=${reusedDeal.id} stageName=${reusedDeal.currentStage.name}`,
        );
      }

      // Write the inbound Engagement attached to the reused Deal. Skips
      // bootstrap + assign + Deal.create + DealStageHistory.create entirely
      // (none are appropriate when Pipeline+Stage state is already set).
      await writeInboundEngagementForExistingDeal(event, contact.tenantId, reusedDeal.id);
    } else {
      // ── First-turn case: existing KAN-793 path (bootstrap → assign → write) ──
      const { ensureTenantHasDefaultPipeline } = await loadBootstrapModule();
      await ensureTenantHasDefaultPipeline(prisma, contact.tenantId);

      const { assignLeadToPipeline } = await loadAssignmentModule();
      const assignment = await assignLeadToPipeline(prisma, event.contactId, {
        skipIfAssigned: true,
      });

      console.log(
        `[lead-received-push] assigned contactId=${event.contactId} tenantId=${event.tenantId} mode=${assignment.mode}`,
      );

      // KAN-965 — exhaustive switch on the AssignmentResult tagged-union.
      // Pre-KAN-963 this was an `if (mode === 'rule' | 'ai_fallback' |
      // 'default_pipeline')` whitelist; tier-1.5 objective_primary (added by
      // KAN-963) fell through the else branch and silently skipped Deal
      // creation. The `never` default makes a future-added mode a compile
      // error rather than a silent-skip regression.
      switch (assignment.mode) {
        case 'rule':
        case 'ai_fallback':
        case 'default_pipeline':
        case 'objective_primary':
          dealId = await writePhase1Deal(event, contact.tenantId, assignment);
          break;
        case 'escalated':
        case 'unassigned':
          // Phase 1 posture: ambiguous/escalated routing produces
          // Contact-only state. Phase 2 KAN-794/795 resolves via Customer
          // Decision meta-pipeline.
          console.warn(
            `[lead-received-push] phase-1-ambiguous-assignment-deal-skipped contactId=${event.contactId} tenantId=${event.tenantId} mode=${assignment.mode}`,
          );
          break;
        default: {
          const _exhaustive: never = assignment;
          throw new Error(
            `[lead-received-push] unhandled assignment.mode (exhaustive-switch invariant): ${JSON.stringify(_exhaustive)}`,
          );
        }
      }
    }

    // KAN-815a Phase 2 wiring trigger. Runs AFTER the engagement-write
    // transaction commits — Brain reads the just-written Engagement as
    // input. Wrapped in its own try/catch: Brain or downstream consumer
    // failures must NOT propagate (inbound Engagement is already
    // committed; failing the response would trigger Pub/Sub redelivery
    // and potentially double-write the Engagement).
    if (dealId) {
      // KAN-1052 — construct the latestInbound context from the just-
      // received lead.received event so the engine prompt's `## Latest
      // inbound` section + Stop-condition guidance render on the FIRST
      // evaluation (not just on reply chains). `event.metadata.bodyPreview`
      // carries the full normalized body (≤2000 chars per the normalizer
      // convention; misleading field name — see KAN-1052 Phase 1 trace).
      const { buildLatestInboundContext } = await loadBrainServiceModule();
      const initialLeadInbound = buildLatestInboundContext({
        receivedAt: event.receivedAt,
        senderEmail: event.metadata.fromAddress ?? '',
        bodyText: event.metadata.bodyPreview ?? '',
        subjectLine: event.metadata.subject ?? '',
        // KAN-1052: initial leads have no prior Decision row at this point;
        // using lead.received eventId as forensic anchor. Phase B (multi-turn
        // thread context) will revisit when a real prior-turn reference becomes
        // available across the multi-turn surface.
        inReplyToDecisionId: event.eventId,
        // KAN-1052: initial leads are the contact's first inquiry — no prior
        // outbound to reply to. threadDepth=0 triggers the "reached out for
        // the first time" prompt phrasing at brain-service.ts:962.
        threadDepth: 0,
      });
      await wirePhase2Consumers(
        dealId,
        event.eventId,
        false,
        undefined,
        initialLeadInbound,
      ).catch((err) => {
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
// M3-2.5b — Inbound sidecar write + correlation lookup + override.
// Shared between the first-turn (writePhase1Deal) and multi-turn
// (writeInboundEngagementForExistingDeal) write paths. Runs INSIDE the
// caller's $transaction so the inbound Engagement create, the sidecar
// write, and the optional Engagement override are atomic.
// ─────────────────────────────────────────────

type LeadReceivedEvent = z.infer<typeof LeadReceivedEventSchema>;

interface CorrelationOutcome {
  /**
   * Reason string for audit + observability.
   *
   * KAN-1036 — pre-pivot reasons (`no_in_reply_to_header`,
   * `unmatched_in_reply_to`, `autoreply_race`) replaced by the
   * subaddress-anchored equivalents (`no_reply_token`,
   * `unmatched_reply_token`). The old strings are kept in the union for
   * type-back-compat with any forensic queries of older audit rows;
   * write-side only emits the new values.
   */
  reason:
    | 'inbound_correlated'
    | 'no_reply_token'
    | 'unmatched_reply_token'
    | 'no_in_reply_to_header'   // pre-KAN-1036; back-compat
    | 'unmatched_in_reply_to'   // pre-KAN-1036; back-compat
    | 'autoreply_race';
  /** Matched originating Decision id (only set when reason='inbound_correlated'). */
  matchedDecisionId: string | null;
  /** Matched originating contact id (set when reason='inbound_correlated'). */
  matchedContactId: string | null;
  /** Resolved active Deal for matchedContactId (set when reason='inbound_correlated' AND originator has open Deal). */
  matchedDealId: string | null;
}

/**
 * Inside the caller's transaction: write the inbound sidecar row from the
 * parsed headers, then look up the outbound sidecar (M3-2.5a) by the
 * KAN-1036 subaddress-anchored `reply_token`. On match: override
 * Engagement.{decisionId, contactId, dealId} per M3-2.5b design call (B)
 * — preserves the denormalization invariant so the conversation thread
 * is findable via BOTH Engagement.contactId queries AND Deal.engagements
 * queries. Override-dealId uses the SAME resolveActiveDealForContact
 * helper the engine sites use (single source — three engine call sites
 * + this one).
 *
 * KAN-1036 correlation anchor change: pre-KAN-1036 the lookup keyed on
 * `provider_message_id = stripMessageIdBrackets(inReplyTo)` (Plan A —
 * empirically falsified, Resend has no API surface that exposes the SES
 * wire Message-ID). Post-KAN-1036 the lookup keys on `reply_token`, a
 * value WE mint at outbound send time and that rides the Reply-To
 * subaddress through the recipient's MUA → Resend Receiving → consumer.
 *
 * Returns the outcome for the caller to audit-log post-transaction
 * (audit is best-effort + fire-and-forget; the override is atomic).
 */
async function writeSidecarAndCorrelate(
  tx: unknown,
  args: {
    tenantId: string;
    engagementId: string;
    headers: NonNullable<LeadReceivedEvent['metadata']['inboundHeaders']> | undefined;
    /**
     * KAN-1036 — per-decision reply correlation token, parsed by the
     * webhook (extractSlugAndToken). 16-char hex per producer; null when
     * the inbound's To: had no `+suffix` or the suffix didn't match the
     * token shape regex.
     */
    replyToken: string | null;
  },
): Promise<CorrelationOutcome> {
  // Cast to the minimal Prisma surface we use; the apps/api TS6059 cohort
  // already swallows Prisma model surfacing at this consumer (mirror of
  // existing patterns in this file).
  const txAny = tx as {
    engagementEmailMetadata: {
      findFirst: (args: unknown) => Promise<{
        engagement: { id: string; decisionId: string | null; contactId: string };
      } | null>;
      create: (args: unknown) => Promise<unknown>;
    };
    engagement: {
      update: (args: unknown) => Promise<unknown>;
    };
  };

  const headers = args.headers;
  const rawInReplyTo = headers?.inReplyTo;
  const ownMessageIdRaw = headers?.messageId;
  const ownMessageId = stripMessageIdBrackets(ownMessageIdRaw);
  const references = parseReferencesHeader(headers?.references);

  // M3-2.5b sidecar write — fires when we have at least an own Message-ID
  // (the inbound's own provider_message_id). Skipped when both are absent
  // (no usable correlation/forensic signal). raw inReplyTo is stored as-is
  // (wire form) for forensic value; references are stripped+filtered
  // (queryable shape). reply_token left NULL on the inbound row — that
  // column is producer-side anchoring for the OUTBOUND row.
  if (ownMessageId) {
    await txAny.engagementEmailMetadata.create({
      data: {
        engagementId: args.engagementId,
        provider: 'resend',
        providerMessageId: ownMessageId,
        ...(rawInReplyTo ? { inReplyTo: rawInReplyTo } : {}),
        referencesArray: references,
      },
    });
  }

  // KAN-1036 — correlation lookup keys on reply_token, parsed from the
  // inbound's subaddressed To: at the webhook (extractSlugAndToken). When
  // the token is absent (direct inbound to <slug>@<domain>, no plus-suffix)
  // OR the inbound came from a path that doesn't carry our token
  // (autoreply, manually-typed recipient), we miss with no_reply_token —
  // gracefully degrades to today's orphan-engagement behavior.
  if (!args.replyToken) {
    return {
      reason: 'no_reply_token',
      matchedDecisionId: null,
      matchedContactId: null,
      matchedDealId: null,
    };
  }

  // Tenant scope via relation filter — defense-in-depth on the global
  // UNIQUE(reply_token) which already makes cross-tenant collision
  // impossible (our token namespace is global per-mint via CSPRNG).
  const matched = await txAny.engagementEmailMetadata.findFirst({
    where: {
      replyToken: args.replyToken,
      engagement: { tenantId: args.tenantId },
    },
    select: {
      engagement: { select: { id: true, decisionId: true, contactId: true } },
    },
  });

  if (!matched?.engagement) {
    // Could be: outbound never happened (truly orphan inbound) OR the
    // outbound rows for this tenant pre-date KAN-1036's column. We can't
    // distinguish post-hoc.
    return {
      reason: 'unmatched_reply_token',
      matchedDecisionId: null,
      matchedContactId: null,
      matchedDealId: null,
    };
  }

  // Outbound matched but the originating Decision is unknown — shouldn't
  // happen post-M3-2.5a (outbound always writes with top-level decisionId),
  // but defend so we don't NULL-clobber and skip the override.
  if (!matched.engagement.decisionId) {
    return {
      reason: 'unmatched_reply_token',
      matchedDecisionId: null,
      matchedContactId: matched.engagement.contactId,
      matchedDealId: null,
    };
  }

  // (B) override — look up the originator contact's active Deal so we can
  // override BOTH dealId AND contactId, preserving the denormalization
  // invariant. Falls back to leaving the inbound's existing dealId when
  // the originator has no open Deal (edge: deal closed between dispatch
  // and reply; still correlation-rescue contactId+decisionId; engagement
  // attached to the from-address path's dealId remains).
  const { resolveActiveDealForContact } = await loadResolveActiveDealModule();
  const originatorDealId = await resolveActiveDealForContact(
    tx,
    args.tenantId,
    matched.engagement.contactId,
  );

  await txAny.engagement.update({
    where: { id: args.engagementId },
    data: {
      decisionId: matched.engagement.decisionId,
      contactId: matched.engagement.contactId,
      ...(originatorDealId ? { dealId: originatorDealId } : {}),
    },
  });

  return {
    reason: 'inbound_correlated',
    matchedDecisionId: matched.engagement.decisionId,
    matchedContactId: matched.engagement.contactId,
    matchedDealId: originatorDealId,
  };
}

/**
 * Fire-and-forget audit emit. Best-effort + .catch() so a failed audit row
 * cannot destabilize the inbound flow. Mirrors the kan-1005 M2-2 pattern
 * elsewhere in this file.
 */
function emitCorrelationAudit(
  args: {
    tenantId: string;
    engagementId: string;
    eventId: string;
    outcome: CorrelationOutcome;
  },
): void {
  void prisma.auditLog
    .create({
      data: {
        tenantId: args.tenantId,
        actor: 'lead_inbox_correlation',
        actionType:
          args.outcome.reason === 'inbound_correlated'
            ? 'lead_inbox.inbound_correlated'
            : 'lead_inbox.inbound_correlation_miss',
        reasoning: args.outcome.reason,
        payload: {
          engagementId: args.engagementId,
          eventId: args.eventId,
          ...(args.outcome.matchedDecisionId
            ? { matchedDecisionId: args.outcome.matchedDecisionId }
            : {}),
          ...(args.outcome.matchedContactId
            ? { matchedContactId: args.outcome.matchedContactId }
            : {}),
          ...(args.outcome.matchedDealId
            ? { matchedDealId: args.outcome.matchedDealId }
            : {}),
        },
      },
    })
    .catch((err: unknown) => {
      console.warn(
        `[lead-received-push] audit-emit-correlation-failed engagementId=${args.engagementId} eventId=${args.eventId} err=${(err as Error)?.message ?? String(err)}`,
      );
    });
}

/**
 * KAN-1037-PR3 — fire-and-forget `contact.replied` publish.
 *
 * Fires ONLY when `writeSidecarAndCorrelate` returned `inbound_correlated`
 * — the only branch where we have a matched outbound + B-override target
 * IDs (decisionId, contactId, dealId) that point at the originator's
 * lineage rather than the redirect-shadowed inbound identity. PR2's
 * autoresponder filter at `apps/connectors/src/webhooks/resend-inbound.ts`
 * already cut machine-generated replies upstream, so anything reaching
 * this point through `inbound_correlated` is a candidate for engine
 * re-evaluation.
 *
 * Called from BOTH `writeInboundEngagementForExistingDeal` (multi-turn
 * path) AND `writePhase1Deal` (first-turn path) per M3-2.5c Phase 1
 * Finding #1 — first-turn correlation is rare but valid (new contact
 * replies to discovery outbound on a different deal lineage; the B-
 * override rescues correctly per M3-2.5b's redirect-shadowed-rescue
 * pattern).
 *
 * Best-effort `.catch` so a failed publish cannot destabilize the
 * inbound flow — the inbound Engagement row + correlation audit have
 * already committed. Mirrors the `emitCorrelationAudit` posture above.
 * The audit row at `contact_replied` actionType records the publish
 * outcome (messageId on success, error on failure) for forensic grep.
 *
 * Topic + subscription provisioning at
 * `infra/terraform/contact-replied.tf`. PR3 subscriber writes audit
 * + Redis cooldown only (skeleton); PR4 wires `runDecisionForContact`.
 */
function emitContactRepliedIfCorrelated(
  args: {
    tenantId: string;
    event: z.infer<typeof LeadReceivedEventSchema>;
    inboundEngagementId: string;
    outcome: CorrelationOutcome;
  },
): void {
  // Only fire when correlation succeeded with a real Decision id. The
  // partial-correlation case (`matched.engagement.decisionId === null`
  // at writeSidecarAndCorrelate:782) returns reason `unmatched_reply_token`
  // so this guard is structurally redundant with the `reason` check —
  // belt-and-suspenders against future refactors.
  if (
    args.outcome.reason !== 'inbound_correlated' ||
    !args.outcome.matchedDecisionId ||
    !args.outcome.matchedContactId
  ) {
    return;
  }

  const matchedDecisionId = args.outcome.matchedDecisionId;
  const matchedContactId = args.outcome.matchedContactId;

  // KAN-1044 (follow-up filed during PR3 review) — extend
  // `CorrelationOutcome` from `writeSidecarAndCorrelate` to carry the
  // matched outbound's `engagement.id` alongside `matchedDecisionId /
  // matchedContactId / matchedDealId`. Until that lands, the publisher
  // passes `outboundEngagementId: null` — honest about the gap rather
  // than emitting `inboundEngagementId` as a UUID-valid placeholder
  // (the placeholder shape would semantically lie: code that JOINs
  // `outboundEngagementId` to `engagements` would read the inbound
  // row's data). PR4+ consumers re-derive the outbound row from
  // `decisionId` (one indexed Prisma roundtrip) when they need it;
  // an `if (outboundEngagementId)` guard skips that lookup cleanly
  // post-KAN-1044.

  const event = args.event;
  void (async () => {
    try {
      const { getPubSubClient } = await loadPubSubClientModule();
      const client = getPubSubClient() as {
        publish: (
          topic: string,
          data: Buffer,
          attributes?: Record<string, string>,
        ) => Promise<string>;
      };

      // KAN-1056 — derive threadDepth from prior outbounds on the matched
      // Deal. Replaces the PR3-era `threadDepth: 1` hardcode now that Phase B
      // engine prompt rendering will read the value verbatim.
      //
      // Q1 fallback: when matchedDealId is null (originator's Deal closed
      // between dispatch and reply — edge case at writeSidecarAndCorrelate
      // L791-796), fall back to 1. Correlation reaching this code path
      // means writeSidecarAndCorrelate already matched a prior outbound by
      // reply_token, so at least one prior outbound exists by definition.
      // Phrasing stays truthful as "replied" rather than the misleading
      // "reached out for the first time" the threadDepth=0 ternary at
      // brain-service.ts:962 would emit.
      //
      // Q2 cutoff: temporal cutoff via event.receivedAt is defensive against
      // concurrent send races (engine fires + dispatches an outbound while a
      // contact's reply is in flight). Indexed on [tenantId, dealId, occurredAt]
      // per schema.prisma:1980; single-digit ms cost.
      //
      // engagementType string literal `'email_send'` matches the canonical
      // outbound write at action-executed-push.ts:152 — derived from
      // `${event.channel.toLowerCase()}_send`.
      const threadDepth = args.outcome.matchedDealId
        ? await prisma.engagement.count({
            where: {
              tenantId: args.tenantId,
              dealId: args.outcome.matchedDealId,
              engagementType: 'email_send',
              occurredAt: { lt: new Date(event.receivedAt) },
            },
          })
        : 1;

      const payload: ContactRepliedEvent = buildContactRepliedEvent({
        tenantId: args.tenantId,
        contactId: matchedContactId,
        // outcome.matchedDealId can be null (originator has no open Deal —
        // edge case in writeSidecarAndCorrelate at L791-796); schema permits.
        dealId: args.outcome.matchedDealId ?? null,
        decisionId: matchedDecisionId,
        inboundEngagementId: args.inboundEngagementId,
        // KAN-1044 to follow — extend CorrelationOutcome to carry
        // outboundEngagementId; null is the honest placeholder until then
        // (the schema is nullable + consumers re-derive from decisionId).
        outboundEngagementId: null,
        replyText: event.metadata.bodyPreview ?? '',
        replyReceivedAt: event.receivedAt,
        metadata: {
          senderEmail: event.metadata.fromAddress ?? '',
          subjectLine: event.metadata.subject ?? '',
          threadDepth,
        },
      });

      const data = Buffer.from(JSON.stringify(payload));
      const attributes: Record<string, string> = {
        eventType: 'contact.replied',
        tenantId: args.tenantId,
        version: '1.0',
      };
      const messageId = await client.publish(CONTACT_REPLIED_TOPIC, data, attributes);

      void prisma.auditLog
        .create({
          data: {
            tenantId: args.tenantId,
            actor: 'lead_inbox_correlation',
            actionType: 'contact_replied',
            reasoning: 'inbound_correlated',
            payload: {
              eventId: payload.eventId,
              decisionId: matchedDecisionId,
              contactId: matchedContactId,
              dealId: args.outcome.matchedDealId ?? null,
              inboundEngagementId: args.inboundEngagementId,
              messageId,
            },
          },
        })
        .catch((err: unknown) => {
          console.warn(
            `[lead-received-push] contact-replied-audit-failed eventId=${payload.eventId} err=${(err as Error)?.message ?? String(err)}`,
          );
        });
    } catch (err) {
      console.warn(
        `[lead-received-push] contact-replied-publish-failed inboundEngagementId=${args.inboundEngagementId} err=${(err as Error)?.message ?? String(err)}`,
      );
    }
  })();
}

// ─────────────────────────────────────────────
// KAN-819 — Multi-turn Engagement-only write (no Deal/DealStageHistory)
// ─────────────────────────────────────────────

/**
 * Write only the inbound Engagement, attached to an existing open Deal. Used
 * when KAN-819 detects a multi-turn case (Contact already has an open Deal on
 * a Pipeline). Mirrors writePhase1Deal's normalize+log shape so the Engagement
 * metadata stays consistent across first-turn and follow-up rows; the Deal +
 * DealStageHistory writes are skipped (the existing Deal already carries that
 * state and the inbound is not a stage transition — Brain re-eval downstream
 * decides what to do next).
 *
 * logEngagement is idempotent on correlationId, so Pub/Sub redelivery of the
 * same eventId is a no-op. No transaction needed (single write).
 */
async function writeInboundEngagementForExistingDeal(
  event: z.infer<typeof LeadReceivedEventSchema>,
  tenantId: string,
  dealId: string,
): Promise<void> {
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

  // M3-2.5b — wrap Engagement create + sidecar write + correlation override
  // in a single $transaction so the multi-turn path has the same atomicity
  // shape as the first-turn writePhase1Deal path. Pre-M3-2.5b this was a
  // bare prisma.create call; the inbound sidecar + override now require
  // transactional rollback symmetry with the outbound side (M3-2.5a).
  const { engagementId, outcome } = await prisma.$transaction(async (tx) => {
    const engagement = (await logEngagement(tx, {
      tenantId,
      dealId,
      contactId: event.contactId,
      engagementType: 'email_received',
      channel: 'email',
      occurredAt: new Date(event.receivedAt),
      correlationId: `engagement:lead-received:${event.eventId}`,
      metadata: {
        senderEmail: normalized.preParsed.senderEmail,
        subject: normalized.preParsed.subject,
        // KAN-839 — persist inbound body so Shaper's `## Recent inbound from
        // contact` section can render the customer's verbatim words. Cap
        // matches Shaper's render cap (2000 chars) so DB and prompt see the
        // same binding constraint. Mirrors KAN-817's outbound bodyPreview
        // field naming for producer-consumer contract symmetry.
        bodyPreview: normalized.preParsed.bodyText?.slice(0, 2000) ?? null,
        extractionConfidence: normalized.extractionConfidence,
        // KAN-819 marker — distinguishes follow-up Engagement rows from the
        // first-turn write that's attached to the originating Deal create.
        kan819Reused: true,
      },
    })) as { id: string };

    const correlationOutcome = await writeSidecarAndCorrelate(tx, {
      tenantId,
      engagementId: engagement.id,
      headers: event.metadata.inboundHeaders,
      // KAN-1036 — per-decision reply correlation token from data.to subaddress.
      replyToken: event.metadata.replyToken ?? null,
    });
    return { engagementId: engagement.id, outcome: correlationOutcome };
  });

  // Best-effort audit emit AFTER the tx commits.
  emitCorrelationAudit({
    tenantId,
    engagementId,
    eventId: event.eventId,
    outcome,
  });

  // KAN-1037-PR3 — M3-2.5c reply-loop-closure: fire `contact.replied`
  // when correlation succeeded. Multi-turn path (this function) is
  // expected to be the primary trigger source — a follow-up on an
  // existing open Deal IS the reply-on-existing-thread case.
  emitContactRepliedIfCorrelated({
    tenantId,
    event,
    inboundEngagementId: engagementId,
    outcome,
  });
}

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
  const { dealId, engagementId, correlationOutcome } = await prisma.$transaction(
    async (tx) => {
      const deal = await tx.deal.create({
        data: {
          tenantId,
          contactId: event.contactId,
          pipelineId,
          currentStageId: startingStage.id,
          enteredStageAt: new Date(),
          value: 0,
          currency: 'USD',
          // KAN-954 — Formspree-parsed events provide a meaningful deal
          // name in metadata. Legacy/non-Formspree events omit it and the
          // Prisma column default (`Untitled deal`) applies.
          ...(event.metadata.dealName ? { name: event.metadata.dealName } : {}),
          // KAN-954 — Formspree form fields land on Deal.customFields
          // (Contact has no custom_fields column). Pre-KAN-954 events omit
          // this; Prisma default `{}` applies.
          ...(event.metadata.customFields ? { customFields: event.metadata.customFields } : {}),
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
            // KAN-954 — propagate vendor + lead-source attribution.
            ...(event.metadata.vendor && { leadVendor: event.metadata.vendor }),
            ...(event.metadata.formSource && { formSource: event.metadata.formSource }),
            ...(event.metadata.leadType && { leadType: event.metadata.leadType }),
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

      const engagement = (await logEngagement(tx, {
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
          // KAN-839 — see writeInboundEngagementForExistingDeal for full
          // rationale. Same producer-consumer contract on both inbound write
          // paths so first-turn and multi-turn Engagement rows render
          // identically into the Shaper prompt.
          bodyPreview: normalized.preParsed.bodyText?.slice(0, 2000) ?? null,
          extractionConfidence: normalized.extractionConfidence,
        },
      })) as { id: string };

      // M3-2.5b — inbound sidecar write + correlation lookup + override.
      // Inside the same $transaction so the inbound Engagement, the sidecar,
      // and the Engagement override are atomic. Override (per design call
      // B) flips Engagement.{decisionId, contactId, dealId} when In-Reply-To
      // matches an outbound sidecar from M3-2.5a — preserves the
      // denormalization invariant so Brain/Shaper queries via either
      // Engagement.contactId OR Deal.engagements find the inbound row.
      const outcome = await writeSidecarAndCorrelate(tx, {
        tenantId,
        engagementId: engagement.id,
        headers: event.metadata.inboundHeaders,
        // KAN-1036 — per-decision reply correlation token from data.to subaddress.
        replyToken: event.metadata.replyToken ?? null,
      });

      // Return dealId so the caller can pass it to KAN-815 Phase 2 wiring.
      return {
        dealId: deal.id as string,
        engagementId: engagement.id,
        correlationOutcome: outcome,
      };
    },
  );

  // M3-2.5b — best-effort audit emit after the tx commits. Fire-and-forget.
  emitCorrelationAudit({
    tenantId,
    engagementId,
    eventId: event.eventId,
    outcome: correlationOutcome,
  });

  // KAN-1037-PR3 — M3-2.5c reply-loop-closure: fire `contact.replied`
  // when correlation succeeded on the first-turn path. Rare but valid
  // (new contact replies to a discovery outbound on a different deal
  // lineage; the B-override rescues the matched contact+decision+deal).
  emitContactRepliedIfCorrelated({
    tenantId,
    event,
    inboundEngagementId: engagementId,
    outcome: correlationOutcome,
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

/**
 * KAN-815 Phase 2 orchestrator. Re-evaluates Brain (or accepts a
 * precomputed decision per KAN-1037-PR4.5) and routes the decision
 * through stage-transition (KAN-815b), KAN-825/835 follow-up chains,
 * dispatch (KAN-815c), and the engine-proposed escalation consumer
 * (KAN-1037-PR4.5).
 *
 * Exported (KAN-1037-PR4.5) so contact-replied-push can call this
 * directly with the PR4-evaluated Brain decision. Legacy inbound-driven
 * Phase 2 wiring at L607 still uses the 3-arg form (no precomputed
 * decision; internal eval fires).
 */
export async function wirePhase2Consumers(
  dealId: string,
  eventId: string,
  // KAN-825 — chain-depth guard. Default `false` (initial inbound-driven
  // Brain call). Set `true` only when this function is called recursively
  // from the post-stage-advance chain. Max chain depth = 1 — if a chained
  // Brain call returns `advance_stage` again, do NOT re-enter the chain;
  // log a warning and stop. Local boolean (no DB column) is sufficient at
  // depth=1.
  isChainedInvocation: boolean = false,
  // KAN-1037-PR4.5 — optional precomputed Brain decision. When provided,
  // the internal evaluateDealState call at L1335-1341 is SKIPPED and the
  // passed-in decision flows through the dispatch chain. Same KAN-834
  // pattern that evaluateStageTransition uses (avoids double Brain eval).
  //
  // **Critical for contact.replied path:** PR4's subscriber evaluates
  // Brain with `latestInbound` populated (the first time the prompt sees
  // inbound body text — the load-bearing PRD §7 demonstration). Without
  // this param, calling wirePhase2Consumers would re-evaluate Brain
  // WITHOUT latestInbound — the cognitive-aware reasoning gets discarded
  // for the dispatch routing, undoing PR4's empirical proof.
  //
  // Legacy callers (lead-received-push:606 inbound-driven Phase 2 wiring,
  // and the internal chained calls at L1388 / L1432) pass nothing → the
  // optional param defaults to undefined → the eval runs as before.
  // Back-compat is zero-change for those callers.
  precomputedDecision?: Phase2BrainDecision,
  // KAN-1052 — initial-lead path threads `latestInbound` into the
  // internal evaluateDealState call so the engine prompt renders the
  // contact's first-inquiry body text via the `## Latest inbound`
  // section (the same surface PR4 lit up for the reply chain). Optional
  // 5th arg; legacy callers pass nothing → latestInbound stays
  // undefined → existing behavior preserved. Ignored when
  // `precomputedDecision` is provided (PR4.5 path — the precomputed
  // decision already captures the latestInbound-aware reasoning).
  latestInbound?: BrainLatestInbound,
): Promise<void> {
  // KAN-814 — supersession path. A fresh inbound on this (dealId, contactId)
  // means any prior pending deferred_send for the same conversation is now
  // stale (Brain about to re-evaluate with the new context anyway). Cancel
  // pending rows BEFORE Brain so a stale defer doesn't double-send if the
  // cron worker happens to fire the old row between now and the new
  // outbound landing.
  //
  // Skip supersession on chained invocations — the inbound that triggered
  // the chain already cleared pending rows on the first call; the chained
  // call shouldn't re-cancel anything (no new inbound has arrived).
  //
  // We need contactId for the supersession query. Re-load the Deal's
  // contactId here (cheap; one indexed lookup). updateMany on a no-match
  // is a no-op (zero rows updated) so the common case (no pending row)
  // costs only the query.
  if (!isChainedInvocation) {
    const dealForSupersession = await prisma.deal.findUnique({
      where: { id: dealId },
      select: { contactId: true },
    });
    if (dealForSupersession) {
      const cancelled = await (
        prisma as unknown as { deferredSend: { updateMany: (args: unknown) => Promise<{ count: number }> } }
      ).deferredSend.updateMany({
        where: { dealId, contactId: dealForSupersession.contactId, status: 'pending' },
        data: { status: 'cancelled', cancelReason: 'superseded_by_fresh_inbound' },
      });
      if (cancelled.count > 0) {
        console.log(
          `[lead-received-push] kan-814-deferred-send-superseded dealId=${dealId} contactId=${dealForSupersession.contactId} cancelledRows=${cancelled.count} reason=superseded_by_fresh_inbound`,
        );
      }
    }
  }


  // Step 1: Brain evaluation — single LLM call per inbound; same decision
  // is passed through to all consumers (no double-eval per Phase 2 design).
  // KAN-828: inject redis + openai so the Knowledge Layer retrieval fires.
  //
  // KAN-1037-PR4.5: when a precomputed Brain decision is passed in (from
  // contact-replied-push's PR4-evaluated decision with latestInbound), the
  // internal eval is SKIPPED entirely. Same single-call discipline; no
  // double-eval. Caller's `redis` + `openai` clients are still constructed
  // below because the downstream chain (stage-transition, dispatchPhase2Send,
  // KAN-825/835 chained calls) consumes them.
  const { evaluateDealState } = await loadBrainServiceModule();
  const redis = getRedisClient();
  const openai = getOpenAIClient();
  const brainDecision: Phase2BrainDecision =
    precomputedDecision ??
    (await evaluateDealState(prisma, dealId, {
      redis,
      openai,
      // KAN-1052 — thread initial-lead body text into the engine prompt's
      // `## Latest inbound` section + Stop-condition guidance sub-section.
      // Undefined for legacy callers (post_stage_advance / chained calls
      // / pre-KAN-1052 callers) → section omits gracefully via the
      // existing conditional render at brain-service.ts:918.
      latestInbound,
    }));

  console.log(
    `[lead-received-push] phase-2-brain-evaluated dealId=${dealId} eventId=${eventId} actionType=${brainDecision.nextBestAction.type} confidence=${brainDecision.confidence.toFixed(2)} tokens=${brainDecision.llmInputTokens}/${brainDecision.llmOutputTokens}${isChainedInvocation ? ' chained=true' : ''}${precomputedDecision ? ' precomputed=true' : ''}`,
  );

  // KAN-815b stage-transition consumer. Brain decisions to advance or close
  // route to stage-transition-engine which writes Deal.currentStageId +
  // DealStageHistory in its own transaction. Engine has its own terminal-
  // Stage short-circuit (per feedback_stage_transition_engine_brain_consumer_pattern)
  // so already-closed Deals return skipped:already_terminal without LLM call.
  if (
    brainDecision.nextBestAction.type === 'advance_stage' ||
    brainDecision.nextBestAction.type === 'close_deal_lost'
  ) {
    const { evaluateStageTransition } = await loadStageTransitionEngineModule();
    // KAN-834 — thread the dispatcher's first Brain decision into the
    // engine so it doesn't re-evaluate. Single Brain call per inbound;
    // engine's terminal-stage short-circuit still runs first; KAN-825
    // chain logic downstream sees the same decision the dispatcher saw.
    const transitionResult = await evaluateStageTransition(prisma, dealId, {
      brainDecision,
    });
    console.log(
      `[lead-received-push] phase-2-stage-transition dealId=${dealId} eventId=${eventId} brainAction=${brainDecision.nextBestAction.type} resultType=${transitionResult.type}${transitionResult.reason ? ` reason=${transitionResult.reason}` : ''}${transitionResult.toStageId ? ` toStageId=${transitionResult.toStageId}` : ''}`,
    );

    // KAN-825 — post-stage-advance auto-follow-up chain. After a successful
    // Stage Transition, fire a chained Brain call with `triggerContext=
    // post_stage_advance` so Brain decides what to communicate to the
    // contact about the just-completed advancement. Without this chain,
    // the original `advance_stage` produces a customer-perceived UX
    // dead-end (4-of-4 Sprint 10 evening smokes confirmed: stage advanced
    // but no outbound, contact got silence).
    //
    // Loop guard: only chain if this is the FIRST Brain call (not already
    // a chained invocation). If a chained Brain returns advance_stage
    // AGAIN, do NOT recurse — log warning, stop. close_deal_lost on a
    // chained call also stops (terminal stage; KAN-832 audit-symmetry
    // ticket may revisit closing-comm UX).
    if (
      transitionResult.type === 'transitioned' &&
      !isChainedInvocation &&
      brainDecision.nextBestAction.type === 'advance_stage'
    ) {
      const fromStageName = transitionResult.fromStageName ?? '(prior stage)';
      const toStageName = transitionResult.toStageName ?? '(new stage)';
      const chainedDecision: Phase2BrainDecision = await evaluateDealState(prisma, dealId, {
        triggerContext: 'post_stage_advance',
        postStageAdvance: { fromStageName, toStageName },
        // KAN-828: chained Brain hits Redis cache from initial call (same
        // queryHash) → architectural payoff per spec §1.3.
        redis,
        openai,
      });
      console.log(
        `[lead-received-push] phase-2-brain-evaluated dealId=${dealId} eventId=${eventId} actionType=${chainedDecision.nextBestAction.type} confidence=${chainedDecision.confidence.toFixed(2)} tokens=${chainedDecision.llmInputTokens}/${chainedDecision.llmOutputTokens} chained=true triggerContext=post_stage_advance`,
      );

      if (chainedDecision.nextBestAction.type === 'send_follow_up') {
        // Chained dispatch. Pass isChainedInvocation=true so dispatch's
        // own internal Brain interactions don't re-enter the chain.
        await dispatchPhase2Send(dealId, eventId, chainedDecision);
      } else {
        console.warn(
          `[lead-received-push] kan-825-chained-brain-not-follow-up dealId=${dealId} eventId=${eventId} chainedAction=${chainedDecision.nextBestAction.type} confidence=${chainedDecision.confidence.toFixed(2)} reasoning=${chainedDecision.nextBestAction.reasoning}`,
        );
      }
    }
  }

  // KAN-835 — post-wait-acknowledgment chain. After Brain returns
  // `wait_for_response` on a fresh inbound, fire a chained Brain call
  // with directive Trigger block biasing toward `send_follow_up` (a
  // brief acknowledgment so the customer hears something instead of
  // silence). Empirical anchor: 4 wait_for_response inbounds across
  // Sprint 10 + Sprint 11-pre Deal Y → 0 customer-visible outbounds.
  // Customer perception was "I asked, AI ignored me," even when Brain's
  // reasoning was sound. This chain closes the third silence-producing
  // decision class (after KAN-825 closed advance_stage).
  //
  // Loop guard mirrors KAN-825: only chain if NOT already a chained
  // invocation. Strict-loop-guard Option (a): a chained Brain that
  // returns `wait_for_response` AGAIN gets logged + skipped (NO recursion,
  // NO outbound). Telemetry: kan-835-chained-brain-not-acknowledgment
  // warn log lets us monitor production frequency. >5% threshold triggers
  // directive revisit per KAN-835 close-out memory.
  if (
    brainDecision.nextBestAction.type === 'wait_for_response' &&
    !isChainedInvocation
  ) {
    const chainedDecision: Phase2BrainDecision = await evaluateDealState(
      prisma,
      dealId,
      {
        triggerContext: 'post_wait_acknowledgment',
        // KAN-828: chained Brain hits Redis cache from initial call.
        redis,
        openai,
      },
    );
    console.log(
      `[lead-received-push] phase-2-brain-evaluated dealId=${dealId} eventId=${eventId} actionType=${chainedDecision.nextBestAction.type} confidence=${chainedDecision.confidence.toFixed(2)} tokens=${chainedDecision.llmInputTokens}/${chainedDecision.llmOutputTokens} chained=true triggerContext=post_wait_acknowledgment`,
    );

    if (chainedDecision.nextBestAction.type === 'send_follow_up') {
      // Chained acknowledgment dispatch — normal path (Shaper → Send Policy
      // → Decision row shim → publishActionSend).
      await dispatchPhase2Send(dealId, eventId, chainedDecision);
    } else if (chainedDecision.nextBestAction.type === 'escalate_to_human') {
      // Sprint 11b will wire escalation_queue + email notification + admin
      // dashboard. v1: log-only stub so production telemetry captures
      // chain decisions that route to escalation; the customer-acknowledgment
      // half of that flow is Sprint 11b's job.
      console.log(
        `[lead-received-push] kan-835-chained-brain-escalate dealId=${dealId} eventId=${eventId} chainedAction=escalate_to_human confidence=${chainedDecision.confidence.toFixed(2)} reasoning=${chainedDecision.nextBestAction.reasoning} — Sprint 11b will wire escalation_queue + acknowledgment`,
      );
    } else {
      // Strict-loop-guard Option (a): chained wait_for_response /
      // advance_stage / close_deal_lost / no_action all log+skip.
      // wait_for_response + advance_stage are directive failures (chain
      // told Brain explicitly NOT to return these); close_deal_lost +
      // no_action are legitimate but silent (chain doesn't override).
      // The warn log gives us telemetry for monitoring KAN-835 effectiveness.
      console.warn(
        `[lead-received-push] kan-835-chained-brain-not-acknowledgment dealId=${dealId} eventId=${eventId} chainedAction=${chainedDecision.nextBestAction.type} confidence=${chainedDecision.confidence.toFixed(2)} reasoning=${chainedDecision.nextBestAction.reasoning}`,
      );
    }
  }

  // KAN-815c message-dispatch consumer. Brain decision to send_follow_up
  // routes through shape → policy → Decision row shim → publishActionSend.
  // Email-only MVP per Phase 2 architectural decision (sms/meta_messenger
  // dispatch deferred to KAN-800/801 Phase 3 connectors); non-email shaped
  // output is logged + skipped here.
  if (brainDecision.nextBestAction.type === 'send_follow_up') {
    await dispatchPhase2Send(dealId, eventId, brainDecision);
  }

  // KAN-1037-PR4.5 — engine-proposed escalation consumer.
  //
  // When Brain emits `escalate_to_human`, the engine has explicitly
  // determined that this contact's reply (or current state) needs human
  // judgment. Pre-PR4.5 this action class was UNHANDLED here — Brain
  // emitted, telemetry logged, nothing observable downstream. PR4's
  // empirical smoke (2026-05-31 23:21 UTC) demonstrated the engine
  // emitting escalate_to_human at 0.85 confidence with reply-aware
  // reasoning ("explicit 30-minute call next Tuesday afternoon request +
  // outbound contained TEST REDIRECT guardrail warning"). Without this
  // consumer, that cognitive proof produces zero operator-observable
  // signal — milestone value-prop hollow.
  //
  // Consumer creates an Escalation row that surfaces in the Recommendations
  // queue (per KAN-754) with:
  //   - `triggerType: 'engine_proposed_action'` — new discriminator
  //     alongside AGENTIC_GATE_DECISION / CONFIDENCE_BELOW_THRESHOLD /
  //     guardrail_block / lead_assignment_below_threshold / SAMPLED_*.
  //     Reads as "the engine proposed this action; operator decides."
  //   - `aiSuggestion: brainDecision.nextBestAction.reasoning` —
  //     human-readable summary the operator sees in the queue UI.
  //   - `originalAction` — engine's structured action mapped to the
  //     SuggestedAction shape (per KAN-1037 PR1's runFreeform / runAgentic
  //     producer pattern at run-decision-for-contact.ts:566 / 1252).
  //     Operator's accept-without-modify path dispatches via this column
  //     per the KAN-1037 fix; for escalate_to_human the actionType is
  //     itself escalate_to_human, so accept-without-modify is a status-
  //     transition-only operation (no real dispatch — operator should
  //     modify to compose a follow-up before accepting).
  //   - `decisionId` — populated when the originating Decision is known
  //     (from contact.replied path: matched outbound's decisionId; from
  //     lead-received first-turn path: the just-created Decision row id).
  //     Per Phase 1 confirmation #3, this ties the audit chain together
  //     so operators tracing "what happened on this contact" can walk
  //     the originating Decision → reply → engine eval → escalation.
  //
  // Chain-depth guard: skip if this is a chained invocation. A chained
  // call returning escalate_to_human would create two escalations for
  // the same inbound — once on the original Brain decision, once on the
  // chained one. The KAN-825/835 chained paths already have their own
  // escalate_to_human telemetry stubs (L1481) that we leave intact for
  // now. KAN-1047 tracks chain-aware escalation discipline once we have
  // empirical PROD signal on chain-loop frequency.
  if (
    brainDecision.nextBestAction.type === 'escalate_to_human' &&
    !isChainedInvocation
  ) {
    await createEngineProposedEscalation(dealId, eventId, brainDecision);
  }

  // KAN-1042 PR A2 — engine-proposed sub-objective transition consumer.
  //
  // When Brain emits `transition_sub_objective`, the engine has parsed a
  // factual signal from the contact's reply matching an unfilled BANT-5
  // sub-objective key. Per Phase 1 Q6 architectural distinction, this
  // action is DISPATCHER-LEVEL gated (NOT a HIGH_STAKES_ACTION_TYPES
  // clamp — the threshold-gate clamp is binary, tenant cannot opt-in
  // once an action is in the high-stakes set per M2-3 safety invariant):
  //
  //   - Tenant.autoTransitionSubObjectives === false (default) → escalate
  //     to Recommendations queue (KAN-1037 PR1 originalAction path).
  //   - Tenant.autoTransitionSubObjectives === true (opt-in) → dispatch
  //     via transitionSubObjectiveState with source='engine' (PR A2
  //     signature extension).
  //
  // Chain-depth guard mirrors the escalate_to_human consumer above —
  // a chained call returning transition_sub_objective would create two
  // transitions/escalations for the same inbound.
  if (
    brainDecision.nextBestAction.type === 'transition_sub_objective' &&
    !isChainedInvocation
  ) {
    await handleEngineTransitionSubObjective(dealId, eventId, brainDecision);
  }
}

/**
 * KAN-1037-PR4.5 — write an Escalation row representing the engine's
 * explicit `escalate_to_human` decision. Surfaces in the Recommendations
 * queue (per KAN-754); the operator's accept-then-modify flow dispatches
 * via the KAN-1037 PR1 path (`originalAction` populated below).
 *
 * Best-effort posture: on any failure (Deal lookup miss, Escalation
 * create reject, audit write fail), log + return without throwing. The
 * caller's outer `.catch` in contact-replied-push.ts is the
 * fire-and-forget boundary; we don't want a downstream failure to
 * destabilize the cognitive audit row that PR4 already committed.
 */
async function createEngineProposedEscalation(
  dealId: string,
  eventId: string,
  brainDecision: Phase2BrainDecision,
): Promise<void> {
  // Load Deal for tenantId + contactId. dispatchPhase2Send at L1542-1550
  // already shows this lookup pattern; we mirror it for symmetry.
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: { id: true, tenantId: true, contactId: true },
  });
  if (!deal) {
    console.warn(
      `[lead-received-push] kan-1037-pr4-5-escalate-no-deal dealId=${dealId} eventId=${eventId} — Deal lookup miss; escalation NOT created`,
    );
    return;
  }

  // Map Brain's nextBestAction shape (`{ type, reasoning,
  // suggestedChannel?, suggestedTone?, targetStageId? }`) to the canonical
  // SuggestedAction shape (`{ actionType, channel, payload }`) per
  // KAN-1037 PR1's run-decision-for-contact.ts:566 producer pattern.
  // The payload carries forensic context (reasoning + tone + confidence)
  // so an operator inspecting the Recommendations detail drawer sees
  // exactly what the engine reasoned.
  const originalAction = {
    actionType: brainDecision.nextBestAction.type,
    channel: brainDecision.nextBestAction.suggestedChannel ?? null,
    payload: {
      reasoning: brainDecision.nextBestAction.reasoning,
      ...(brainDecision.nextBestAction.suggestedTone
        ? { suggestedTone: brainDecision.nextBestAction.suggestedTone }
        : {}),
      brainConfidence: brainDecision.confidence,
      brainModelTier: brainDecision.modelTier,
    },
  };

  // KAN-1037-PR4.5 — find the originating Decision id. Two callers:
  //   - contact-replied-push (PR4.5 primary use case): the matched
  //     outbound's `engagement.decisionId` flows through the
  //     ContactRepliedEvent and ends up here. Looked up via the most
  //     recent Decision row on this Deal+Contact (one indexed query;
  //     the contact-replied path's eventId is the audit anchor, not
  //     the foreign key).
  //   - lead-received-push first-turn path: a Decision row was just
  //     created upstream of this call; same lookup picks it up.
  // Best-effort — null is acceptable per KAN-1005 M2-6b's null-safe
  // Escalation pattern (the originally-broken state at recommendations.ts:354).
  const recentDecision = await prisma.decision.findFirst({
    where: { tenantId: deal.tenantId, contactId: deal.contactId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  let createdEscalationId: string | null = null;
  try {
    const created = await prisma.escalation.create({
      data: {
        tenantId: deal.tenantId,
        contactId: deal.contactId,
        decisionId: recentDecision?.id ?? null,
        triggerType: 'engine_proposed_action',
        triggerReason: brainDecision.nextBestAction.reasoning,
        severity: brainDecision.confidence < 0.4 ? 'high' : 'medium',
        aiSuggestion: brainDecision.nextBestAction.reasoning,
        originalAction: originalAction as unknown as object,
        status: 'open',
        context: {
          source: 'kan_1037_pr4_5_engine_proposal',
          eventId,
          dealId,
          brainModelTier: brainDecision.modelTier,
          brainConfidence: brainDecision.confidence,
          brainSuggestedChannel: brainDecision.nextBestAction.suggestedChannel ?? null,
          brainSuggestedTone: brainDecision.nextBestAction.suggestedTone ?? null,
          llmInputTokens: brainDecision.llmInputTokens,
          llmOutputTokens: brainDecision.llmOutputTokens,
        } as unknown as object,
      },
      select: { id: true },
    });
    createdEscalationId = created.id;
    console.log(
      `[lead-received-push] kan-1037-pr4-5-escalate-created dealId=${dealId} eventId=${eventId} escalationId=${createdEscalationId} decisionId=${recentDecision?.id ?? 'null'} confidence=${brainDecision.confidence.toFixed(2)}`,
    );
  } catch (err) {
    console.warn(
      `[lead-received-push] kan-1037-pr4-5-escalate-create-failed dealId=${dealId} eventId=${eventId} err=${(err as Error)?.message ?? String(err)}`,
    );
    return;
  }

  // Audit row — operators tracing the engine-proposal → escalation →
  // operator-handling flow query on this actionType.
  void prisma.auditLog
    .create({
      data: {
        tenantId: deal.tenantId,
        actor: 'engine_proposed_escalation_consumer',
        actionType: 'escalation_created_from_engine_proposal',
        reasoning: 'brain_emitted_escalate_to_human',
        payload: {
          eventId,
          dealId,
          contactId: deal.contactId,
          escalationId: createdEscalationId,
          triggerDecisionId: recentDecision?.id ?? null,
          brainConfidence: brainDecision.confidence,
          brainReasoning: brainDecision.nextBestAction.reasoning,
        },
      },
    })
    .catch((err: unknown) => {
      console.warn(
        `[lead-received-push] kan-1037-pr4-5-escalate-audit-failed dealId=${dealId} eventId=${eventId} escalationId=${createdEscalationId} err=${(err as Error)?.message ?? String(err)}`,
      );
    });
}

/**
 * KAN-1042 PR A2 — engine-proposed sub-objective transition handler.
 *
 * Dispatcher-level governance: reads `Tenant.autoTransitionSubObjectives`
 * (default false → escalate; true → auto-dispatch). Sibling to
 * `createEngineProposedEscalation` (PR4.5) in posture: best-effort
 * (warn-log on failure, don't throw), one Deal lookup + one Tenant
 * lookup + one Decision lookup, originalAction populated for the
 * operator-accept fallback path (KAN-1037 PR1).
 *
 * Phase 1 architectural decisions baked in:
 *   - Q1: fresh Tenant.findUnique at the arm (no caching infra; ~1ms
 *     PROD; missing/null row treated as opt-out per fail-safe).
 *   - Q2: wasNoOp threading into the audit payload happens inside
 *     transitionSubObjectiveState — this handler doesn't pre-check.
 *   - Q3: Deal.findUnique mirrors createEngineProposedEscalation pattern.
 */
async function handleEngineTransitionSubObjective(
  dealId: string,
  eventId: string,
  brainDecision: Phase2BrainDecision,
): Promise<void> {
  // Defensive: parser at brain-service.ts:892+ enforces payload presence
  // when type === 'transition_sub_objective'. Empty payload here would
  // indicate a parser bypass; warn + return.
  const payload = brainDecision.nextBestAction.subObjectiveTransition;
  if (!payload) {
    console.warn(
      `[lead-received-push] kan-1042-transition-no-payload dealId=${dealId} eventId=${eventId} — type=transition_sub_objective without subObjectiveTransition payload`,
    );
    return;
  }

  // Load Deal for tenantId + contactId. Mirrors createEngineProposedEscalation
  // pattern at L1593-1596.
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: { id: true, tenantId: true, contactId: true },
  });
  if (!deal) {
    console.warn(
      `[lead-received-push] kan-1042-transition-no-deal dealId=${dealId} eventId=${eventId} — Deal lookup miss; arm skipped`,
    );
    return;
  }

  // Phase 1 Q6 dispatcher-level gating — read Tenant.autoTransitionSubObjectives.
  // Default false / null → escalate. true → dispatch. Missing-row =
  // opt-out (fail-safe direction).
  const tenant = await prisma.tenant.findUnique({
    where: { id: deal.tenantId },
    select: { autoTransitionSubObjectives: true },
  });
  const optedIn = tenant?.autoTransitionSubObjectives === true;

  // Find originating Decision for audit linkage. Same pattern as
  // createEngineProposedEscalation at L1635-1639.
  const recentDecision = await prisma.decision.findFirst({
    where: { tenantId: deal.tenantId, contactId: deal.contactId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  if (!optedIn) {
    // ESCALATE path — tenant opt-out (default). Write an Escalation row
    // with originalAction carrying the subObjectiveTransition payload.
    // Operator accept-without-modify dispatches via the KAN-1037 PR1
    // fallback path (escalations.originalAction column).
    const originalAction = {
      actionType: 'transition_sub_objective',
      channel: null,
      payload: {
        reasoning: brainDecision.nextBestAction.reasoning,
        subObjectiveKey: payload.subObjectiveKey,
        toState: payload.toState,
        value: payload.value,
        brainConfidence: brainDecision.confidence,
        brainModelTier: brainDecision.modelTier,
      },
    };
    try {
      const created = await prisma.escalation.create({
        data: {
          tenantId: deal.tenantId,
          contactId: deal.contactId,
          decisionId: recentDecision?.id ?? null,
          triggerType: 'engine_proposed_action',
          triggerReason: brainDecision.nextBestAction.reasoning,
          severity: brainDecision.confidence < 0.4 ? 'high' : 'medium',
          aiSuggestion: brainDecision.nextBestAction.reasoning,
          originalAction: originalAction as unknown as object,
          status: 'open',
          context: {
            source: 'kan_1042_engine_transition_proposal',
            eventId,
            dealId,
            subObjectiveKey: payload.subObjectiveKey,
            toState: payload.toState,
            value: payload.value,
            brainConfidence: brainDecision.confidence,
            brainModelTier: brainDecision.modelTier,
            llmInputTokens: brainDecision.llmInputTokens,
            llmOutputTokens: brainDecision.llmOutputTokens,
            tenantOptIn: false,
          } as unknown as object,
        },
        select: { id: true },
      });
      console.log(
        `[lead-received-push] kan-1042-transition-escalated dealId=${dealId} eventId=${eventId} escalationId=${created.id} subObjectiveKey=${payload.subObjectiveKey} toState=${payload.toState} reason=tenant_opt_out confidence=${brainDecision.confidence.toFixed(2)}`,
      );
    } catch (err) {
      console.warn(
        `[lead-received-push] kan-1042-transition-escalate-failed dealId=${dealId} eventId=${eventId} subObjectiveKey=${payload.subObjectiveKey} err=${(err as Error)?.message ?? String(err)}`,
      );
    }
    return;
  }

  // DISPATCH path — tenant opt-in. Call transitionSubObjectiveState with
  // source='engine' + engineContext (reasoning + confidence + decisionId
  // + eventId). Phase 1 locked decision #3 — PR A2 signature extension.
  // wasNoOp is computed inside the function + threaded into the audit
  // payload (Q2 finding — operator-path semantics preserved).
  try {
    const { transitionSubObjectiveState } = await loadSubObjectivesModule();
    const result = await transitionSubObjectiveState(
      prisma,
      deal.tenantId,
      'engine_agentic_live',
      {
        contactId: deal.contactId,
        subObjectiveKey: payload.subObjectiveKey,
        toState: payload.toState,
        value: payload.value,
      },
      'engine',
      {
        reasoning: brainDecision.nextBestAction.reasoning,
        confidence: brainDecision.confidence,
        decisionId: recentDecision?.id ?? null,
        eventId,
      },
    );
    console.log(
      `[lead-received-push] kan-1042-transition-auto-dispatched dealId=${dealId} eventId=${eventId} subObjectiveKey=${payload.subObjectiveKey} toState=${payload.toState} previousState=${result.previousState} wasNoOp=${result.wasNoOp} confidence=${brainDecision.confidence.toFixed(2)}`,
    );
  } catch (err) {
    console.warn(
      `[lead-received-push] kan-1042-transition-dispatch-failed dealId=${dealId} eventId=${eventId} subObjectiveKey=${payload.subObjectiveKey} err=${(err as Error)?.message ?? String(err)}`,
    );
  }
}

async function dispatchPhase2Send(
  dealId: string,
  eventId: string,
  brainDecision: Phase2BrainDecision,
): Promise<void> {
  // 1. Shape the message via KAN-797a. Pass the pre-computed brainDecision
  //    to avoid double Brain eval. KAN-828: inject redis + openai so the
  //    Knowledge Layer retrieval HITs the cache from Brain's earlier call
  //    (same queryHash → ~3ms vs ~150ms cold).
  const { shapeMessage } = await loadMessageShaperModule();
  const redis = getRedisClient();
  const openai = getOpenAIClient();
  const shapeResult = await shapeMessage(prisma, dealId, { brainDecision, redis, openai });
  if (shapeResult.type !== 'shaped') {
    console.warn(
      `[lead-received-push] phase-2-shape-no-shape dealId=${dealId} eventId=${eventId} reason=${shapeResult.reason}`,
    );
    return;
  }
  const shaped = shapeResult.message;

  // 2. Channel branch — email-only MVP. SMS + Messenger dispatch deferred
  //    to KAN-800/801 Phase 3 connectors.
  if (shaped.channel !== 'email') {
    console.log(
      `[lead-received-push] phase-2-dispatch-channel-not-yet-supported dealId=${dealId} eventId=${eventId} channel=${shaped.channel} — KAN-800/801 will wire these channels`,
    );
    return;
  }

  // 3. Load Deal + Contact for tenantId/contactId/recipient email lookup.
  //    publishActionSend needs toEmail + connectionId; the trigger only
  //    has dealId, so re-load here. (Could be threaded through from
  //    wirePhase2Consumers caller for one fewer query, but the savings
  //    are negligible vs the LLM round-trip already paid.)
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: {
      id: true,
      tenantId: true,
      contactId: true,
      contact: { select: { id: true, email: true } },
    },
  });
  if (!deal || !deal.contact?.email) {
    console.warn(
      `[lead-received-push] phase-2-dispatch-no-recipient dealId=${dealId} eventId=${eventId} — Contact missing or email null`,
    );
    return;
  }

  // 4. Send Policy gate per KAN-798a.
  const { evaluateSendPolicy } = await loadSendPolicyModule();
  const policyResult = await evaluateSendPolicy(prisma, deal.tenantId, deal.contactId, {
    channel: 'email',
  });
  if (policyResult.type === 'deny') {
    console.warn(
      `[lead-received-push] phase-2-send-policy-denied dealId=${dealId} eventId=${eventId} ruleViolated=${policyResult.ruleViolated} reason=${policyResult.reason}`,
    );
    // KAN-1005 M2-2 — symmetric best-effort AuditLog on deny. Mirrors the
    // engine-path action-decided-push.ts pattern: opt-out / suppression
    // blocks are compliance-relevant and belong in the immutable audit
    // log where they're greppable, not just in ephemeral console output.
    // Fire-and-forget + catch so a failed audit write can't destabilize
    // the deny path or the live Lead Inbox flow.
    void prisma.auditLog
      .create({
        data: {
          tenantId: deal.tenantId,
          actor: 'lead_inbox_send_policy',
          actionType: 'lead_inbox.send_policy_denied',
          reasoning: policyResult.reason,
          payload: {
            dealId,
            contactId: deal.contactId,
            eventId,
            ruleViolated: policyResult.ruleViolated,
            source: 'lead_received',
          },
        },
      })
      .catch((err: unknown) => {
        console.warn(
          `[lead-received-push] audit-emit-send-policy-denied-failed dealId=${dealId} eventId=${eventId} err=${(err as Error)?.message ?? String(err)}`,
        );
      });
    return;
  }
  if (policyResult.type === 'defer') {
    // KAN-814 — persist the deferred send so the cron worker can re-evaluate
    // and dispatch when the window opens. Replaces the prior log+ack+drop
    // behavior (which permanently lost the message — see Sprint 10 evening
    // diagnosis: 1 of 4 inbounds went send_follow_up, hit defer, never
    // re-dispatched).
    //
    // Payload captures Brain's T1 intent (composed message + brainDecision +
    // contactEmail + replyTo). The cron worker re-resolves connectionId at
    // re-dispatch time so a tenant that revoked + re-added an EMAIL
    // ChannelConnection between T1 and T2 dispatches via the LATEST one
    // (Brain's intent for the message body stays fixed; the transport
    // resolves to current state).
    //
    // Decision row is NOT written here — it's written at re-dispatch time
    // by the cron evaluator, matching the existing KAN-815c shim pattern
    // (Decision created during dispatch, not before). Temporal lineage
    // recoverable via deferred_send.created_at.
    try {
      await (
        prisma as unknown as {
          deferredSend: { create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }> };
        }
      ).deferredSend.create({
        data: {
          tenantId: deal.tenantId,
          dealId: deal.id,
          contactId: deal.contactId,
          deferUntil: policyResult.deferUntil,
          deferReason: policyResult.reason,
          status: 'pending',
          attempts: 0,
          payload: {
            // Brain's T1 intent — full decision blob for Decision row write
            // at re-dispatch.
            brainDecision: brainDecision as unknown as Record<string, unknown>,
            // Composed message — DO NOT re-shape at re-dispatch.
            composed: {
              subject: shaped.subject ?? '(no subject)',
              body: shaped.body,
              tone: shaped.tone,
            },
            // Recipient — captured at T1 so a contact email change between
            // defer and re-dispatch doesn't change destination.
            contactEmail: deal.contact.email,
            // Shaper telemetry for the eventual Decision row metadata.
            shaperTier: shaped.modelTier,
            shaperInputTokens: shaped.llmInputTokens,
            shaperOutputTokens: shaped.llmOutputTokens,
            // Trace anchor for log-correlation across defer → re-dispatch.
            originalEventId: eventId,
          },
        },
      });
      console.log(
        `[lead-received-push] phase-2-send-policy-deferred dealId=${dealId} eventId=${eventId} deferUntil=${policyResult.deferUntil.toISOString()} reason=${policyResult.reason} persisted=true`,
      );
    } catch (err) {
      // Persistence failure is observable but non-fatal — without the
      // queued row the message is lost the same as pre-KAN-814, but at
      // least the failure is audited.
      console.error(
        `[lead-received-push] phase-2-send-policy-deferred-persist-failed dealId=${dealId} eventId=${eventId} err=${(err as Error)?.message ?? String(err)}`,
      );
    }
    return;
  }

  // 5. ChannelConnection lookup for Resend connector dispatch.
  const { publishActionSend, resolveEmailConnectionId } = await loadMessageComposerModule();
  const connectionId = await resolveEmailConnectionId(prisma, deal.tenantId);
  if (!connectionId) {
    console.warn(
      `[lead-received-push] phase-2-dispatch-no-connection dealId=${dealId} eventId=${eventId} tenantId=${deal.tenantId} — no ACTIVE EMAIL ChannelConnection`,
    );
    return;
  }

  // 6. Decision row shim per KAN-815c architectural decision (Option A).
  //    Writes a real audit anchor for "Brain decided to send X at time T"
  //    in its OWN transaction (separate from the engagement-write tx that
  //    already committed). KAN-805 Shared Learning Layer will read these
  //    rows to learn from Brain's decisions.
  const decisionRow = await prisma.decision.create({
    data: {
      tenantId: deal.tenantId,
      contactId: deal.contactId,
      strategySelected: 'brain_phase_2_v1',
      actionType: brainDecision.nextBestAction.type,
      confidence: brainDecision.confidence,
      reasoning: brainDecision.nextBestAction.reasoning,
      metadata: {
        dealId,
        eventId,
        brainEvaluatedAt: brainDecision.evaluatedAt.toISOString(),
        brainModelTier: brainDecision.modelTier,
        brainInputTokens: brainDecision.llmInputTokens,
        brainOutputTokens: brainDecision.llmOutputTokens,
        currentStageId: brainDecision.currentStateSnapshot.currentStageName, // snapshot-side label
        currentStageName: brainDecision.currentStateSnapshot.currentStageName,
        daysInCurrentStage: brainDecision.currentStateSnapshot.daysInCurrentStage,
        shaperTier: shaped.modelTier,
        shaperInputTokens: shaped.llmInputTokens,
        shaperOutputTokens: shaped.llmOutputTokens,
        shapedTone: shaped.tone,
      },
    },
  });

  // 7. Construct ComposedMessage (legacy shape) from ShapedMessage.
  //    Email channel guarantees subject (KAN-797a parser strict-rejects
  //    email without subject — sibling discipline to KAN-794
  //    VALID_ACTION_TYPES allowlist). Falls back to a synthetic subject
  //    only as defense-in-depth.
  //
  //    KAN-1005 M2-6b dispatch-fix — Lead Inbox writes the same plain-
  //    text unsubscribe footer as composeMessage (CAN-SPAM body keyword
  //    + real recipient link). Lead Inbox doesn't currently pass through
  //    gateAndPublishComposed, so guardrail-block isn't the gate here —
  //    this is a correctness improvement (every Lead Inbox AI reply
  //    will carry the footer going forward, aligning with the composer
  //    path). KAN-808 owns the HTML-styled compliance footer.
  const publicWebhookBaseUrl = process.env.PUBLIC_WEBHOOK_BASE_URL ?? 'https://example.invalid';
  const unsubscribeUrl = `${publicWebhookBaseUrl}/unsubscribe/${deal.contactId}`;
  const composed = {
    subject: shaped.subject ?? '(no subject)',
    body: shaped.body.trimEnd() + `\n\n---\nUnsubscribe: ${unsubscribeUrl}`,
    unsubscribeUrl,
  };

  // 8. KAN-816 + KAN-1036: resolve tenant Reply-To for customer-reply
  //    routing. Recipient replies route to
  //    <inboxSlug>+<replyToken>@leads.<LEAD_INBOX_DOMAIN> (subaddressed
  //    per KAN-1036, when a decisionId is in scope) → lands at the
  //    Track A inbound chain → correlated to the originating Decision
  //    via the engagement_email_metadata.reply_token sidecar lookup.
  //    Enables multi-turn AI conversation with O(1) per-decision reply
  //    correlation. Helper warn-logs + returns null when tenant has no
  //    inboxSlug; we omit Reply-To rather than fail the dispatch.
  //
  //    KAN-1051 fix-forward — pre-fix this site spread the
  //    `ResolvedReplyTo = { replyTo, replyToken }` object directly into
  //    publishActionSend's `replyTo` field, causing the connector to
  //    reject every send_follow_up dispatch with `Expected string,
  //    received object`. Pre-launch zero customers + send-redirect floor
  //    masked the bug from PR4.5 verifies (escalate_to_human routes
  //    through a different consumer). Pass decisionRow.id so the resolver
  //    returns the subaddressed shape; destructure .replyTo for the
  //    string field and thread .replyToken separately for the
  //    correlation sidecar.
  const { resolveReplyToForTenant } = await loadMessageComposerModule();
  const replyToResolved = await resolveReplyToForTenant(
    prisma,
    deal.tenantId,
    decisionRow.id,
  );

  // 9. Publish to action.send for Resend connector to actually send.
  const { getPubSubClient } = await loadPubSubClientModule();
  const messageId = await publishActionSend(getPubSubClient(), {
    tenantId: deal.tenantId,
    contactId: deal.contactId,
    decisionId: decisionRow.id,
    toEmail: deal.contact.email,
    composed,
    connectionId,
    ...(replyToResolved ? { replyTo: replyToResolved.replyTo } : {}),
    ...(replyToResolved?.replyToken ? { replyToken: replyToResolved.replyToken } : {}),
  });

  console.log(
    `[lead-received-push] phase-2-dispatch-published dealId=${dealId} eventId=${eventId} decisionId=${decisionRow.id} channel=email pubsubMessageId=${messageId} brainConfidence=${brainDecision.confidence.toFixed(2)} shaperTokens=${shaped.llmInputTokens}/${shaped.llmOutputTokens}`,
  );
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
