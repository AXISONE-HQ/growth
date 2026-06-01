/**
 * KAN-794 — Brain Service MVP (Phase 2 epic 1 of 5).
 *
 * Pure module that loads a Deal's current state from the Phase 1 substrate
 * (Deal + Pipeline + Stage + Engagement + DealStageHistory), calls the LLM
 * for next-best-action evaluation, and returns a structured BrainDecision.
 *
 * **No persistence in MVP.** Caller decides what to do with the decision
 * (write to `decisions` table, dispatch action via Communication Shaper,
 * surface in UI, etc.). Phase 2 epics KAN-795/796/797 wire consumers:
 *   - KAN-795 Pipeline Logic — reads BrainDecision to drive Pipeline routing
 *   - KAN-796 Stages Evolution — reads BrainDecision.nextBestAction.targetStageId
 *     for AI-driven Stage advancement
 *   - KAN-797 Communication Shaper — reads suggestedChannel + suggestedTone
 *
 * Determinism: same Deal state + mocked LLM response = same BrainDecision.
 * Tests use this property to assert idempotent shape via the prisma + llm-client
 * mocks.
 *
 * Cost: returns `llmInputTokens` + `llmOutputTokens` raw; does NOT compute or
 * return $USD. Per KAN-745 architecture, llm-client.complete() emits cost
 * asynchronously via the `llm.call` Pub/Sub topic → llm-cost-aggregator
 * partitions per-tenant. Brain Service avoids duplicating MODEL_PRICING
 * (`feedback_model_pricing_refresh_discipline`) — consumers needing $USD
 * either query the rollup or compute via MODEL_PRICING themselves.
 *
 * Module-scoped exports per sibling-service convention (matches
 * lead-normalizer.ts / engagement-service.ts / lead-assignment.ts).
 */
import type {
  PrismaClient,
  Contact,
  Engagement,
  DealStageHistory,
} from '@prisma/client';
import { complete } from './llm-client.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type BrainActionType =
  | 'send_follow_up'
  | 'wait_for_response'
  | 'advance_stage'
  | 'escalate_to_human'
  | 'close_deal_lost'
  | 'no_action'
  // KAN-1042 PR A1 — engine-driven sub-objective transition. Emitted
  // when a contact's reply provides clear factual information that
  // matches an unfilled BANT-5 sub-objective key (timeline / budget /
  // authority / need / motivation). Payload sits on
  // `BrainNextBestAction.subObjectiveTransition`.
  //
  // Governance: DISPATCHER-LEVEL gating, NOT a HIGH_STAKES_ACTION_TYPES
  // clamp. Per Phase 1 Q6 finding (threshold-gate.ts clamp is binary
  // — tenant cannot opt-in once an action is in the high-stakes set;
  // the M2-3 safety invariant always wins). PR A2's wirePhase2Consumers
  // arm reads `Tenant.autoTransitionSubObjectives` (default false →
  // escalate to Recommendations queue via originalAction; true →
  // dispatch via `transitionSubObjectiveState` with source='engine').
  | 'transition_sub_objective';

export type BrainSuggestedChannel = 'email' | 'sms' | 'meta_messenger';
export type BrainSuggestedTone = 'curious' | 'professional' | 'urgent' | 'closing';

/**
 * KAN-1042 PR A1 — `transition_sub_objective` payload shape. Carried on
 * `BrainNextBestAction.subObjectiveTransition` when (and only when)
 * `type === 'transition_sub_objective'`.
 *
 * `subObjectiveKey` clamps to BANT-5 to match the router enum at
 * `apps/api/src/router.ts:6617`. Vocab extension beyond BANT-5 is
 * tracked separately (KAN-1050); Phase A respects the existing
 * contract.
 *
 * `value` type matches the router contract exactly: `string | number |
 * null` (no `boolean` — booleans cast to enum_value strings at
 * dispatcher level if a future BANT row needs them).
 */
export type SubObjectiveTransitionKey =
  | 'timeline'
  | 'budget'
  | 'authority'
  | 'need'
  | 'motivation';

export interface SubObjectiveTransitionPayload {
  subObjectiveKey: SubObjectiveTransitionKey;
  toState: 'known' | 'not_applicable';
  value: string | number | null;
}

export interface BrainNextBestAction {
  type: BrainActionType;
  targetStageId?: string;
  suggestedChannel?: BrainSuggestedChannel;
  suggestedTone?: BrainSuggestedTone;
  reasoning: string;
  /**
   * KAN-1042 PR A1 — populated when `type === 'transition_sub_objective'`.
   * Omitted on all other action types (parseLlmResponse drops the field
   * unless the action type matches).
   */
  subObjectiveTransition?: SubObjectiveTransitionPayload;
}

export interface BrainStateSnapshot {
  /** Derived from currentStage.outcomeType (open / terminal_won / terminal_lost). */
  dealStatus: 'open' | 'closed_won' | 'closed_lost';
  currentStageName: string;
  currentStageOutcomeType: 'open' | 'terminal_won' | 'terminal_lost';
  daysInCurrentStage: number;
  /** Count of recent engagements loaded (capped by recentEngagementLimit), NOT total. */
  engagementCount: number;
  lastEngagementType: string | null;
  lastEngagementClass: 'positive' | 'negative' | 'neutral' | null;
  daysSinceLastEngagement: number | null;
  /** Percent of MO entries with completedAt set. null when MO progress is empty. */
  moProgressPercent: number | null;
  pipelineName: string;
  pipelineObjectiveType: string;
  /**
   * KAN-963 (slice 2a PR B) — bound Objective (when Pipeline.objectiveId is
   * set). Threads the tenant's declared objective intent into Brain's
   * prompt so the LLM can reason about "what success looks like" beyond the
   * Pipeline name / objective_type enum. Light prompt enhancement — NOT a
   * full objective-aware routing rebuild (slice 4 work). Null when Pipeline
   * isn't bound to an Objective row (legacy fixtures, etc.).
   */
  boundObjective: {
    type: string;
    name: string;
    successCondition: unknown;
    subObjectives: unknown;
  } | null;
}

export interface BrainDecision {
  dealId: string;
  evaluatedAt: Date;
  currentStateSnapshot: BrainStateSnapshot;
  nextBestAction: BrainNextBestAction;
  /** 0-1. Caller decides escalation threshold (analogous to lead-assignment AI fallback). */
  confidence: number;
  modelTier: 'cheap' | 'reasoning';
  /**
   * KAN-745 architecture: llm-client emits cost asynchronously via llm.call
   * topic → llm-cost-aggregator. Brain Service returns raw token counts so
   * consumers can compute cost themselves (via MODEL_PRICING) or join the
   * async rollup. See feedback_model_pricing_refresh_discipline.
   */
  llmInputTokens: number;
  llmOutputTokens: number;
}

/**
 * KAN-825 / KAN-835 — origin-aware Brain evaluation context.
 *
 *   - 'inbound' (default): the Brain call is reacting to a fresh customer
 *     inbound. No assumed prior chain; Brain decides freely across all six
 *     action types.
 *   - 'post_stage_advance' (KAN-825): chained Brain call fired AFTER a
 *     previous Brain call returned `advance_stage` and the Stage Transition
 *     Engine successfully transitioned the Deal. Brain receives a directive
 *     `## Trigger` block that frames the choice as "what to communicate
 *     about the just-completed advancement" and explicitly biases toward
 *     `send_follow_up` (the conservative-default `wait_for_response` produces
 *     a customer-perceived UX dead-end at this point — see Sprint 10 evening
 *     diagnosis).
 *   - 'post_wait_acknowledgment' (KAN-835): chained Brain call fired AFTER
 *     a previous Brain call returned `wait_for_response`. Empirical anchor
 *     (Sprint 10 + 11-pre): 4 observed wait_for_response inbounds produced
 *     0 customer-visible outbounds. Customer perception was "I asked, AI
 *     ignored me" — even when Brain's reasoning was sound (e.g., "wait for
 *     the human to deliver the quote"). Directive Trigger block biases
 *     toward `send_follow_up` with a brief acknowledgment ("got your
 *     message, will follow up shortly") so the customer hears something
 *     while we wait for human action.
 *
 * Loop guard lives at the call site (lead-received-push.ts), NOT in this
 * module — the chain depth max=1 invariant is enforced by the orchestrator
 * via a local boolean parameter, not via persisted state.
 */
export type BrainTriggerContext =
  | 'inbound'
  | 'post_stage_advance'
  | 'post_wait_acknowledgment';

export interface EvaluateOptions {
  /** Default 'reasoning' (Sonnet). Caller can downshift to 'cheap' (Haiku) for batch eval. */
  tier?: 'cheap' | 'reasoning';
  /** Default 5. Caps how many recent Engagements feed into the prompt. */
  recentEngagementLimit?: number;
  /** KAN-825 — origin context for the prompt. Default 'inbound'. */
  triggerContext?: BrainTriggerContext;
  /** KAN-825 — when triggerContext='post_stage_advance', the human-readable
   *  from/to stage names from the just-completed transition. Threaded into
   *  the directive prompt block so Brain's reasoning has the concrete
   *  pipeline state. Optional even with the post-advance context (the prompt
   *  renders "the new stage" as a fallback) but recommended. */
  postStageAdvance?: { fromStageName: string; toStageName: string };
  /**
   * KAN-828 — Knowledge Layer wiring. Caller injects Redis + OpenAI clients;
   * Brain calls `retrieveRelevantChunks` with the most-recent inbound body
   * as queryText and renders the result into the `## Company knowledge`
   * prompt section. Both null → retrieval skipped entirely (the section is
   * omitted from the prompt). Cache discipline: this is the FIRST retrieval
   * for the (tenantId, dealId, queryHash) tuple; Shaper hits the same cache
   * via the architect-spec §1.3 once-and-pass-via-Redis pattern.
   */
  redis?: KnowledgeRedis | null;
  openai?: KnowledgeOpenAI | null;
  /**
   * KAN-1037-PR4 — M3-2.5c reply-loop-closure: latest inbound that triggered
   * this re-evaluation. Threaded by the `contact-replied-push.ts` subscriber
   * (PR3 plumbing → PR4 cognition) so the engine prompt's new
   * `## Latest inbound` section can render the contact's verbatim words.
   *
   * **First time the engine prompt sees inbound BODY text.** Pre-PR4 the
   * `## Recent engagement` section rendered metadata only (timestamp /
   * type / signalClass / channel) — never the message content. This field
   * carries the body (already capped at 2000 chars by
   * `ContactRepliedEventSchema.replyText` upstream of the publisher).
   *
   * Omitted (undefined) when the caller is the existing `lead-received-push.ts`
   * Phase 2 wiring at L1338 — first-turn lead processing, no prior outbound
   * to "reply to" — so the new prompt section gracefully omits and the
   * legacy callers see no prompt diff. The load-bearing PRD §7 quality risk
   * surface ("can the engine emit contextually-appropriate actions when it
   * can see what the contact actually said?") is observable ONLY on the
   * contact-replied path.
   *
   * Field shape mirrors `ContactRepliedEvent.{replyReceivedAt, replyText,
   * metadata.*}` subset — only the fields the prompt actually renders.
   * Internal IDs (inboundEngagementId / outboundEngagementId) stay on the
   * wire event but don't flow into the engine context (the engine reasons
   * about content, not row identities).
   */
  latestInbound?: BrainLatestInbound;
}

/**
 * KAN-1037-PR4 — shape of the latest-inbound context block. Defined as a
 * standalone interface so the subscriber's TypeScript can declare the
 * field shape at the call site without importing the full EvaluateOptions
 * (the subscriber lives in apps/api; brain-service lives in packages/api;
 * the cross-package surface should be the minimal shape).
 */
export interface BrainLatestInbound {
  /** ISO 8601 — when the reply actually arrived (Resend webhook occurredAt). */
  receivedAt: string;
  /** From-address on the inbound (the contact's email). */
  senderEmail: string;
  /** Body of the reply, ≤2000 chars per upstream normalization. */
  bodyText: string;
  /** Subject line on the inbound. Empty string when absent. */
  subjectLine: string;
  /**
   * Originating Decision id from the matched outbound. Prisma cuid. Not
   * rendered into the prompt directly — included for forensic anchoring
   * if a future iteration wants to surface the originating-decision
   * reasoning alongside the inbound.
   */
  inReplyToDecisionId: string;
  /**
   * Thread depth — PR3 publisher ships hardcoded `1`. PR4 renders the
   * value verbatim; true depth derivation is deferred to a future
   * iteration when the engine actually uses it for context-window sizing.
   */
  threadDepth: number;
}

/**
 * KAN-828 — minimal duck-typed client interfaces. We don't import ioredis /
 * openai directly here because (a) Brain Service is a pure module with
 * minimal deps and (b) callers (apps/api push subscribers) already
 * instantiate these clients via the existing redis-client.ts +
 * llm-client.ts patterns. Accept whatever client they pass in; the
 * retrieval service does the actual calls.
 */
export interface KnowledgeRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}
export interface KnowledgeOpenAI {
  embeddings: {
    create(params: { model: string; input: string; dimensions?: number }): Promise<{
      data: Array<{ embedding: number[] }>;
    }>;
  };
}

/**
 * KAN-828 — local mirror of the retrieval service result type, declared
 * here to avoid importing from knowledge-retrieval-service.ts at the type
 * level (the actual function is loaded via dynamic import inside
 * evaluateDealState to keep the module graph clean for tests that mock
 * the retrieval call).
 */
export interface KnowledgeRetrievalResult {
  chunks: Array<{
    chunk_id: string;
    source_id: string;
    source_title: string | null;
    category: string;
    chunk_text: string;
    score: number;
  }>;
  tenantHasAnyKnowledge: boolean;
}

/**
 * KAN-828 — extract queryText for retrieval from the most-recent inbound
 * Engagement. Returns null when no inbound is available (caller skips
 * retrieval). Reads `metadata.bodyPreview` first (KAN-839 producer-consumer
 * contract) then falls back to `metadata.subject` (subject-only inbound),
 * then null.
 */
export function extractQueryTextFromInbound(
  engagements: Array<{ engagementType: string; metadata?: unknown; occurredAt?: Date }>,
): string | null {
  for (const eng of engagements) {
    if (!eng.engagementType.endsWith('_received')) continue;
    const meta = (eng.metadata ?? {}) as Record<string, unknown>;
    const body = typeof meta.bodyPreview === 'string' ? meta.bodyPreview.trim() : '';
    if (body.length > 0) return body;
    const subject = typeof meta.subject === 'string' ? meta.subject.trim() : '';
    if (subject.length > 0) return subject;
    return null;
  }
  return null;
}

/**
 * KAN-828 — inline renderer matching the retrieval service's
 * `renderKnowledgeSection`. Duplicated here so the prompt-builder is a
 * pure function with no cross-module imports (the retrieval service
 * itself is loaded via dynamic import in evaluateDealState; the prompt
 * builder must stay synchronously callable from tests).
 *
 * Format locked per architect spec §3.4. Two empty cases per Fred's
 * sub-cohort 1 note #1.
 */
function renderKnowledgeSectionInline(result: KnowledgeRetrievalResult): string {
  if (result.chunks.length === 0) {
    return result.tenantHasAnyKnowledge
      ? '(none relevant to this message)'
      : '(none — no company knowledge configured yet)';
  }
  const sorted = [...result.chunks].sort((a, b) => b.score - a.score);
  const lines: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    const sourceLabel = c.source_title ?? '(untitled source)';
    const preview = c.chunk_text.slice(0, 400);
    lines.push(`${i + 1}. [${sourceLabel}] (${c.category}) — score ${c.score.toFixed(2)}\n   ${preview}`);
  }
  return lines.join('\n');
}

export class BrainServiceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrainServiceNotFoundError';
  }
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Evaluate a single Deal's state and return a next-best-action recommendation.
 *
 * Pure function — no persistence. Caller holds the decision-write authority.
 *
 * Throws BrainServiceNotFoundError when dealId doesn't exist.
 *
 * Graceful degradation: LLM call failure / malformed JSON / wrong-shape JSON
 * all return type='no_action' + confidence=0 + zero tokens (the latter
 * because no successful LLM call was made — consumers can detect "no_action
 * + confidence=0" as "Brain failed gracefully, decide your retry policy").
 */
export async function evaluateDealState(
  prisma: PrismaClient,
  dealId: string,
  options: EvaluateOptions = {},
): Promise<BrainDecision> {
  const tier = options.tier ?? 'reasoning';
  const recentEngagementLimit = options.recentEngagementLimit ?? 5;
  const evaluatedAt = new Date();

  // 1. Load Deal + relations needed for snapshot + prompt.
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      contact: true,
      pipeline: {
        // KAN-963 — include bound Objective (slice 2a PR B). Null when
        // Pipeline.objectiveId is unset (legacy fixtures, pre-slice-2a).
        include: {
          objective: {
            select: {
              type: true,
              name: true,
              successCondition: true,
              subObjectives: true,
            },
          },
        },
      },
      currentStage: true,
      engagements: {
        orderBy: { occurredAt: 'desc' },
        take: recentEngagementLimit,
      },
      stageHistory: {
        orderBy: { transitionedAt: 'desc' },
        take: 10,
      },
    },
  });

  if (!deal) {
    throw new BrainServiceNotFoundError(`Deal not found: ${dealId}`);
  }

  // 2. Compute snapshot.
  const snapshot = buildStateSnapshot(deal, evaluatedAt);

  // 3. Short-circuit on terminal Stages — no LLM call needed.
  if (snapshot.dealStatus === 'closed_won' || snapshot.dealStatus === 'closed_lost') {
    return {
      dealId,
      evaluatedAt,
      currentStateSnapshot: snapshot,
      nextBestAction: {
        type: 'no_action',
        reasoning: `Deal is in terminal stage (${snapshot.currentStageName}); no further action needed.`,
      },
      confidence: 1.0,
      modelTier: tier,
      llmInputTokens: 0,
      llmOutputTokens: 0,
    };
  }

  // 4a. KAN-828 — Knowledge Layer retrieval. Run BEFORE buildEvaluationPrompt
  // so the rendered prompt includes the `## Company knowledge` section.
  // Skip retrieval entirely when:
  //   - caller didn't inject redis/openai (legacy callers; backwards-compat)
  //   - no inbound body to query against (e.g., post_stage_advance chained
  //     calls have no fresh inbound — the section is omitted from prompt
  //     rather than rendering a misleading empty case)
  // Best-effort: retrieval failure does NOT block Brain; section is skipped
  // and a warn log fires for ops visibility.
  const queryText = extractQueryTextFromInbound(deal.engagements);
  let knowledge: KnowledgeRetrievalResult | null = null;
  if (options.redis && options.openai && queryText) {
    try {
      const { retrieveRelevantChunks } = await import('./knowledge-retrieval-service.js');
      // KAN-1022: RetrievalResult and KnowledgeRetrievalResult have
      // identical shapes (chunks + tenantHasAnyKnowledge); the local mirror
      // pattern is documented inline at the consumer interface declarations.
      // Safe cast — if shapes diverge later, remove the cast and update
      // the local mirror.
      knowledge = (await retrieveRelevantChunks(
        prisma,
        options.redis as unknown as Parameters<typeof retrieveRelevantChunks>[1],
        options.openai as unknown as Parameters<typeof retrieveRelevantChunks>[2],
        deal.tenantId,
        dealId,
        queryText,
      )) as KnowledgeRetrievalResult;
    } catch (err) {
      console.warn(
        `[brain-service] knowledge-retrieval-failed dealId=${dealId} err=${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  // 4b. Build prompt. KAN-825 threads the triggerContext through so chained
  // post-stage-advance calls render a directive prompt block that biases
  // Brain toward send_follow_up (default 'inbound' renders the legacy
  // prompt unchanged). KAN-828 threads the retrieval result into the new
  // `## Company knowledge` section.
  const userPrompt = buildEvaluationPrompt({
    snapshot,
    contact: deal.contact,
    recentEngagements: deal.engagements,
    recentTransitions: deal.stageHistory,
    triggerContext: options.triggerContext ?? 'inbound',
    postStageAdvance: options.postStageAdvance,
    knowledge,
    // KAN-1037-PR4 — M3-2.5c reply-loop-closure. Undefined for every
    // legacy caller (lead-received Phase 2 wiring, post-stage-advance
    // chains, etc.); contact-replied-push passes the matched outbound's
    // reply context so `## Latest inbound` renders the contact's body.
    latestInbound: options.latestInbound,
  });

  // 5. Call LLM. tenantId derived from the loaded Deal (KAN-745 per-tenant
  //    cost partition requirement).
  let llmText: string;
  let llmInputTokens = 0;
  let llmOutputTokens = 0;
  try {
    const response = await complete({
      tenantId: deal.tenantId,
      tier,
      systemPrompt: BRAIN_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 800,
      callerTag: 'brain-service:evaluate-deal-state',
    });
    llmText = response.text;
    llmInputTokens = response.inputTokens;
    llmOutputTokens = response.outputTokens;
  } catch (err) {
    console.warn(
      `[brain-service] llm-call-failed dealId=${dealId} err=${(err as Error)?.message ?? String(err)}`,
    );
    return gracefulFallback(dealId, evaluatedAt, snapshot, tier, 'LLM call failed');
  }

  // 6. Parse + validate response.
  const parsed = parseLlmResponse(llmText);
  if (!parsed.ok) {
    console.warn(
      `[brain-service] parse-failed dealId=${dealId} reason=${parsed.error} preview=${llmText.slice(0, 200)}`,
    );
    return gracefulFallback(dealId, evaluatedAt, snapshot, tier, parsed.error);
  }

  return {
    dealId,
    evaluatedAt,
    currentStateSnapshot: snapshot,
    nextBestAction: parsed.value.nextBestAction,
    confidence: parsed.value.confidence,
    modelTier: tier,
    llmInputTokens,
    llmOutputTokens,
  };
}

// ─────────────────────────────────────────────
// State snapshot computation (pure, exported for test introspection)
// ─────────────────────────────────────────────

interface DealWithRelations {
  id: string;
  tenantId: string;
  enteredStageAt: Date;
  microObjectiveProgress: unknown;
  contact: Contact;
  pipeline: {
    name: string;
    objectiveType: string;
    // KAN-963 — Pipeline → Objective binding (KAN-959 + KAN-962). Nullable;
    // null on legacy fixtures + pre-slice-2a tenants.
    objective?: {
      type: string;
      name: string;
      successCondition: unknown;
      subObjectives: unknown;
    } | null;
  };
  currentStage: { name: string; outcomeType: 'open' | 'terminal_won' | 'terminal_lost' };
  engagements: Engagement[];
  stageHistory: DealStageHistory[];
}

export function buildStateSnapshot(
  deal: DealWithRelations,
  evaluatedAt: Date,
): BrainStateSnapshot {
  const lastEngagement = deal.engagements[0] ?? null;
  const daysInCurrentStage = Math.floor(
    (evaluatedAt.getTime() - deal.enteredStageAt.getTime()) / (1000 * 60 * 60 * 24),
  );
  const daysSinceLastEngagement = lastEngagement
    ? Math.floor(
        (evaluatedAt.getTime() - lastEngagement.occurredAt.getTime()) / (1000 * 60 * 60 * 24),
      )
    : null;

  const dealStatus =
    deal.currentStage.outcomeType === 'terminal_won'
      ? 'closed_won'
      : deal.currentStage.outcomeType === 'terminal_lost'
        ? 'closed_lost'
        : 'open';

  return {
    dealStatus,
    currentStageName: deal.currentStage.name,
    currentStageOutcomeType: deal.currentStage.outcomeType,
    daysInCurrentStage,
    engagementCount: deal.engagements.length,
    lastEngagementType: lastEngagement?.engagementType ?? null,
    lastEngagementClass: lastEngagement
      ? (lastEngagement.signalClass as BrainStateSnapshot['lastEngagementClass'])
      : null,
    daysSinceLastEngagement,
    moProgressPercent: computeMoProgressPercent(deal.microObjectiveProgress),
    pipelineName: deal.pipeline.name,
    pipelineObjectiveType: deal.pipeline.objectiveType,
    // KAN-963 — bound Objective (when Pipeline.objectiveId set; null otherwise).
    boundObjective: deal.pipeline.objective
      ? {
          type: deal.pipeline.objective.type,
          name: deal.pipeline.objective.name,
          successCondition: deal.pipeline.objective.successCondition,
          subObjectives: deal.pipeline.objective.subObjectives,
        }
      : null,
  };
}

export function computeMoProgressPercent(progress: unknown): number | null {
  if (
    !progress ||
    typeof progress !== 'object' ||
    Array.isArray(progress) ||
    Object.keys(progress as Record<string, unknown>).length === 0
  ) {
    return null;
  }
  const entries = Object.values(progress as Record<string, unknown>);
  const total = entries.length;
  const completed = entries.filter(
    (p) =>
      p != null &&
      typeof p === 'object' &&
      typeof (p as { completedAt?: unknown }).completedAt === 'string' &&
      ((p as { completedAt?: unknown }).completedAt as string).length > 0,
  ).length;
  return Math.round((completed / total) * 100);
}

// ─────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────

const BRAIN_SYSTEM_PROMPT = `You are an AI sales assistant helping a sales team decide the best next action for a Deal.

Given the current state of a Deal — its Stage, recent engagement history, Pipeline objective, and time-in-stage — recommend ONE next action from this set:

- send_follow_up: send a new outbound message (specify channel + tone)
- wait_for_response: contact recently engaged; give them time
- advance_stage: move Deal to next Stage in Pipeline
- escalate_to_human: confidence too low or situation requires human judgment
- close_deal_lost: stalled too long; give up
- no_action: explicit no-op
- transition_sub_objective: the contact's reply provides factual information matching an unfilled BANT sub-objective (timeline / budget / authority / need / motivation) — set the value (specify subObjectiveKey, toState, value via the subObjectiveTransition payload)

Respond ONLY with valid JSON in this exact shape:
{
  "nextBestAction": {
    "type": "<one of the action types>",
    "reasoning": "<1-2 sentence explanation>",
    "suggestedChannel": "<email|sms|meta_messenger or null>",
    "suggestedTone": "<curious|professional|urgent|closing or null>",
    "targetStageId": "<stage id or null>",
    "subObjectiveTransition": {
      "subObjectiveKey": "<one of: timeline|budget|authority|need|motivation>",
      "toState": "<known|not_applicable>",
      "value": "<string|number or null>"
    }
  },
  "confidence": <0.0-1.0>
}

\`subObjectiveTransition\` is required ONLY when \`type === "transition_sub_objective"\`; omit or set null on all other action types.

Be conservative: if unsure, recommend escalate_to_human or wait_for_response with low confidence.`;

/**
 * Render the user prompt for the Brain evaluation LLM call.
 *
 * Exported for KAN-825 sentinel-token tests — the `## Trigger` block's
 * literal phrasing is part of the contract pin (any rename / removal /
 * conditional drift breaks the test loudly).
 */
export function buildEvaluationPrompt(input: {
  snapshot: BrainStateSnapshot;
  contact: Contact;
  recentEngagements: Engagement[];
  recentTransitions: DealStageHistory[];
  triggerContext?: BrainTriggerContext;
  postStageAdvance?: { fromStageName: string; toStageName: string };
  /**
   * KAN-828 — retrieval result from `retrieveRelevantChunks`. When null,
   * the `## Company knowledge` section is OMITTED from the prompt entirely
   * (legacy callers, post_stage_advance chained calls without an inbound,
   * and retrieval-disabled paths all flow through this branch). When
   * non-null, renders per architect spec §3.4.
   */
  knowledge?: KnowledgeRetrievalResult | null;
  /**
   * KAN-1037-PR4 — M3-2.5c reply-loop-closure: latest inbound that
   * triggered this evaluation. When defined, renders a `## Latest inbound`
   * section between `## Recent engagement` (metadata-only signal context)
   * and `## Recent stage transitions` (pipeline state context). Section
   * is OMITTED when undefined — every legacy caller (lead-received Phase 2
   * wiring, post-stage-advance chains, sync trpc paths) flows through this
   * branch unchanged.
   */
  latestInbound?: BrainLatestInbound;
}): string {
  const {
    snapshot,
    contact,
    recentEngagements,
    recentTransitions,
    triggerContext = 'inbound',
    postStageAdvance,
    knowledge,
    latestInbound,
  } = input;

  const contactName =
    [contact.firstName, contact.lastName].filter((p) => !!p && p.trim().length > 0).join(' ') ||
    contact.email ||
    '(unknown contact)';
  const company = contact.companyName ?? '(unknown company)';

  const engagementsBlock =
    recentEngagements.length === 0
      ? '(no recent engagements)'
      : recentEngagements
          .map(
            (e, i) =>
              `${i + 1}. ${e.occurredAt.toISOString()} — ${e.engagementType} (${e.signalClass})${e.channel ? ` via ${e.channel}` : ''}`,
          )
          .join('\n');

  const transitionsBlock =
    recentTransitions.length === 0
      ? '(no recent stage transitions)'
      : recentTransitions
          .slice(0, 3)
          .map(
            (t, i) =>
              `${i + 1}. ${t.transitionedAt.toISOString()} — ${t.fromStageId ?? 'initial'} → ${t.toStageId} (triggered by ${t.triggeredBy})`,
          )
          .join('\n');

  // KAN-825 / KAN-835 — directive Trigger block for chained Brain calls.
  // Two flavors today; structure scales as new chain triggers ship.
  //
  //   post_stage_advance (KAN-825): chained call after a successful Stage
  //     Transition. Empirical anchor (Sprint 10 evening): without this
  //     directive framing, chained Brain reasoning often returns
  //     wait_for_response — the conservative-default produces a customer-
  //     perceived UX dead-end after a stage advance the contact wasn't
  //     notified about. The "Strong preference: send_follow_up" phrase plus
  //     the explicit "silence at this point produces a UX dead-end"
  //     framing is the load-bearing nudge.
  //
  //   post_wait_acknowledgment (KAN-835): chained call after Brain returned
  //     wait_for_response on the original inbound. Empirical anchor (4
  //     observed silences across Sprint 10 + Sprint 11-pre Deal Y at Quote
  //     Sent): customer perception was "I asked, AI ignored me," even when
  //     Brain's reasoning was sound (e.g., wait for human to deliver the
  //     quote). Directive biases toward send_follow_up with a brief
  //     acknowledgment so the customer hears SOMETHING while we wait for
  //     human action. Loop guard at call site (lead-received-push.ts):
  //     chained wait_for_response → log + skip; chained advance_stage →
  //     log + skip (state didn't change); chained close_deal_lost /
  //     no_action → log + skip (legitimate but silent — chain doesn't
  //     override).
  //
  // Sentinel-token test pins both `post_stage_advance` AND
  // `post_wait_acknowledgment` AND the load-bearing directive phrases.
  const fromStageName = postStageAdvance?.fromStageName ?? '(prior stage)';
  const toStageName = postStageAdvance?.toStageName ?? snapshot.currentStageName;
  let triggerBlock = '';
  if (triggerContext === 'post_stage_advance') {
    triggerBlock = `## Trigger
This evaluation is the second call in a chain (triggerContext=post_stage_advance). Brain just transitioned this Deal from ${fromStageName} to ${toStageName} based on the inbound. The contact has NOT yet been notified of this progression.

Your task on this call: decide what to communicate to the contact about this stage advancement.

Strong preference: send_follow_up. The contact engaged, Brain advanced the pipeline, and silence at this point produces a UX dead-end. Choose wait_for_response or escalate_to_human ONLY if there's an explicit content reason (e.g., the new stage is terminal closed_won/closed_lost, or the contact's message contained explicit instructions to wait).

`;
  } else if (triggerContext === 'post_wait_acknowledgment') {
    triggerBlock = `## Trigger
This evaluation is the second call in a chain (triggerContext=post_wait_acknowledgment). Brain just decided to wait_for_response on the contact's inbound. The contact has NOT been notified that their message was received.

Your task on this call: decide what acknowledgment or human-handoff action to take.

Strong preference: send_follow_up with a brief acknowledgment that we received their message and what to expect next. Acknowledgments do not need to deliver substantive content — a simple "got your message, looking into it, will follow up shortly" is appropriate when human action is genuinely required.

If the contact's message specifically requests human action that we cannot fulfill autonomously (e.g., requesting a price quote that requires human approval, requesting cancellation that requires legal review), choose escalate_to_human — this triggers the Sprint 11b escalation flow and the contact still receives an acknowledgment.

DO NOT return wait_for_response on this chained call — silence after the customer engaged produces a UX dead-end. DO NOT return advance_stage — the Deal state didn't change, only the contact's expectation needs setting.

`;
  }

  // KAN-963 (slice 2a PR B) — bound objective block. Renders only when the
  // Pipeline is bound to an Objective row (via KAN-959 Pipeline.objectiveId +
  // KAN-962 declaration UI adoption). Threads the declared objective's
  // successCondition + sub-objectives so Brain can reason about "what counts
  // as success here" beyond the Pipeline-level objective_type enum. Light
  // prompt enhancement — NOT a full objective-aware routing rebuild
  // (slice-4 work that gates stage transitions on objective progress).
  const boundObjectiveBlock =
    snapshot.boundObjective
      ? `

## Bound objective
This Pipeline serves the tenant's declared objective: **${snapshot.boundObjective.name}** (type: ${snapshot.boundObjective.type}).

Success condition: ${formatBoundCondition(snapshot.boundObjective.successCondition)}
Sub-objectives: ${formatSubObjectives(snapshot.boundObjective.subObjectives)}

Use this objective intent to inform your next-action choice — but DO NOT override the bounded action vocabulary; reasoning continues to flow through send_follow_up / wait_for_response / advance_stage / escalate_to_human / close_deal_lost / no_action.`
      : '';

  // KAN-1037-PR4 — M3-2.5c reply-loop-closure: `## Latest inbound` section.
  //
  // FIRST time this prompt template renders inbound BODY text. Pre-PR4 the
  // `## Recent engagement` block above carries metadata only (timestamp /
  // type / signalClass / channel) — never the content. This section gives
  // the engine the contact's verbatim words so it can produce a follow-up
  // action grounded in what was actually said.
  //
  // Slot position: BETWEEN `## Recent engagement` (metadata-signal context)
  // and `## Recent stage transitions` (pipeline state context). The
  // ordering invariant is "what just happened (signal + body) → where
  // we are (stage state) → what we know (knowledge) → what to do." Putting
  // the body BEFORE stage transitions ensures the engine reads the new
  // information first, then reconciles against the existing pipeline
  // state, rather than the inverse.
  //
  // Section is OMITTED when `latestInbound` is undefined — every legacy
  // caller (lead-received Phase 2 wiring on first-turn inbound, post-stage-
  // advance chains, sync trpc paths, etc.) flows through this branch
  // unchanged. No empty `## Latest inbound` header renders.
  //
  // Body rendering: blockquote prefix `> ` with `\n> ` multi-line handling
  // for RFC 5322-style quoted content. Stray `> ` chars in bodyText pass
  // through verbatim (matches KAN-839's `## Recent inbound from contact`
  // Shaper-side convention — empirically clean even with nested quoting).
  const latestInboundBlock = latestInbound
    ? `

## Latest inbound

The contact replied on ${latestInbound.receivedAt} (thread depth: ${latestInbound.threadDepth}).
From: ${latestInbound.senderEmail}
Subject: ${latestInbound.subjectLine}

> ${latestInbound.bodyText.replace(/\n/g, '\n> ')}
`
    : '';

  return `${triggerBlock}## Deal context
Pipeline: ${snapshot.pipelineName} (objective: ${snapshot.pipelineObjectiveType})
Contact: ${contactName} @ ${company}
${boundObjectiveBlock}
## Current Stage
Name: ${snapshot.currentStageName}
Outcome type: ${snapshot.currentStageOutcomeType}
Days in stage: ${snapshot.daysInCurrentStage}
Micro-objective progress: ${snapshot.moProgressPercent ?? '(none tracked)'}${snapshot.moProgressPercent != null ? '%' : ''}

## Recent engagement (last ${snapshot.engagementCount}, capped)
${engagementsBlock}
Last engagement signal: ${snapshot.lastEngagementClass ?? '(none)'}
Days since last engagement: ${snapshot.daysSinceLastEngagement ?? '(no engagements)'}
${latestInboundBlock}
## Recent stage transitions (last 3)
${transitionsBlock}
${knowledge ? `\n## Company knowledge (relevant to this conversation)\n${renderKnowledgeSectionInline(knowledge)}\n` : ''}
## Decision required
Pick the best next action. Respond ONLY with the JSON shape specified in the system prompt.`;
}

/**
 * KAN-963 — defensive renderer for Objective.successCondition JSON. The
 * column is free-shape JSON; renderer prints "(unspecified)" for null/empty
 * and JSON.stringify for richer values so Brain's prompt can adapt.
 */
function formatBoundCondition(condition: unknown): string {
  if (condition == null) return '(unspecified)';
  if (typeof condition === 'object' && Object.keys(condition as object).length === 0) {
    return '(unspecified)';
  }
  try {
    return JSON.stringify(condition);
  } catch {
    return '(unrenderable)';
  }
}

/**
 * KAN-963 — defensive renderer for Objective.subObjectives JSON. Empty
 * arrays + null/undefined render as "(none defined)" so the prompt stays
 * readable. Each subObj's `name` is shown if available, else the raw item.
 */
function formatSubObjectives(subObjs: unknown): string {
  if (!Array.isArray(subObjs) || subObjs.length === 0) return '(none defined)';
  return subObjs
    .map((s, i) => {
      if (s && typeof s === 'object' && 'name' in s) {
        return `${i + 1}. ${(s as { name: string }).name}`;
      }
      return `${i + 1}. ${JSON.stringify(s)}`;
    })
    .join('\n');
}

// ─────────────────────────────────────────────
// Response parsing (defensive — LLMs can return partial/wrong shapes)
// ─────────────────────────────────────────────

const VALID_ACTION_TYPES: ReadonlySet<BrainActionType> = new Set<BrainActionType>([
  'send_follow_up',
  'wait_for_response',
  'advance_stage',
  'escalate_to_human',
  'close_deal_lost',
  'no_action',
  // KAN-1042 PR A1
  'transition_sub_objective',
]);
const VALID_CHANNELS: ReadonlySet<BrainSuggestedChannel> = new Set<BrainSuggestedChannel>([
  'email',
  'sms',
  'meta_messenger',
]);
const VALID_TONES: ReadonlySet<BrainSuggestedTone> = new Set<BrainSuggestedTone>([
  'curious',
  'professional',
  'urgent',
  'closing',
]);
// KAN-1042 PR A1 — sub-objective transition payload validation sets.
// `VALID_SUB_OBJECTIVE_KEYS` mirrors the BANT-5 router enum at
// `apps/api/src/router.ts:6617`. Vocab extension is tracked separately
// (KAN-1050) and intentionally NOT in scope here.
const VALID_SUB_OBJECTIVE_KEYS: ReadonlySet<SubObjectiveTransitionKey> =
  new Set<SubObjectiveTransitionKey>([
    'timeline',
    'budget',
    'authority',
    'need',
    'motivation',
  ]);
const VALID_SUB_OBJECTIVE_TO_STATES: ReadonlySet<'known' | 'not_applicable'> = new Set<
  'known' | 'not_applicable'
>(['known', 'not_applicable']);

type ParsedLlmResponse =
  | { ok: true; value: { nextBestAction: BrainNextBestAction; confidence: number } }
  | { ok: false; error: string };

export function parseLlmResponse(text: string): ParsedLlmResponse {
  let cleaned = text.trim();
  // Strip optional ```json fences.
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${(err as Error).message}` };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Response is not an object' };
  }
  const root = parsed as Record<string, unknown>;
  const action = root.nextBestAction;
  const confidence = root.confidence;

  if (typeof confidence !== 'number' || !isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, error: 'confidence not a number in [0,1]' };
  }
  if (!action || typeof action !== 'object') {
    return { ok: false, error: 'nextBestAction missing' };
  }
  const a = action as Record<string, unknown>;
  if (typeof a.type !== 'string' || !VALID_ACTION_TYPES.has(a.type as BrainActionType)) {
    return { ok: false, error: `invalid action type: ${String(a.type)}` };
  }
  if (typeof a.reasoning !== 'string' || a.reasoning.trim().length === 0) {
    return { ok: false, error: 'reasoning missing or empty' };
  }

  const nextBestAction: BrainNextBestAction = {
    type: a.type as BrainActionType,
    reasoning: a.reasoning,
  };
  if (
    typeof a.suggestedChannel === 'string' &&
    VALID_CHANNELS.has(a.suggestedChannel as BrainSuggestedChannel)
  ) {
    nextBestAction.suggestedChannel = a.suggestedChannel as BrainSuggestedChannel;
  }
  if (
    typeof a.suggestedTone === 'string' &&
    VALID_TONES.has(a.suggestedTone as BrainSuggestedTone)
  ) {
    nextBestAction.suggestedTone = a.suggestedTone as BrainSuggestedTone;
  }
  if (typeof a.targetStageId === 'string' && a.targetStageId.trim().length > 0) {
    nextBestAction.targetStageId = a.targetStageId;
  }

  // KAN-1042 PR A1 — subObjectiveTransition payload validation.
  // The field is REQUIRED when type === 'transition_sub_objective' and
  // dropped otherwise. Validation is structural (key + state are
  // narrow enums; value passes through as string|number|null with
  // no business-logic check). Malformed payload on a
  // transition_sub_objective emission → reject the whole response;
  // caller falls back to graceful escalation.
  if (a.type === 'transition_sub_objective') {
    const t = a.subObjectiveTransition;
    if (!t || typeof t !== 'object') {
      return { ok: false, error: 'subObjectiveTransition payload missing for transition_sub_objective action' };
    }
    const payload = t as Record<string, unknown>;
    if (
      typeof payload.subObjectiveKey !== 'string' ||
      !VALID_SUB_OBJECTIVE_KEYS.has(payload.subObjectiveKey as SubObjectiveTransitionKey)
    ) {
      return {
        ok: false,
        error: `invalid subObjectiveTransition.subObjectiveKey: ${String(payload.subObjectiveKey)} (must be one of timeline|budget|authority|need|motivation per BANT-5 router contract)`,
      };
    }
    if (
      typeof payload.toState !== 'string' ||
      !VALID_SUB_OBJECTIVE_TO_STATES.has(payload.toState as 'known' | 'not_applicable')
    ) {
      return {
        ok: false,
        error: `invalid subObjectiveTransition.toState: ${String(payload.toState)} (must be "known" or "not_applicable")`,
      };
    }
    // value type: string | number | null (matches router contract at
    // apps/api/src/router.ts:6619 exactly). Boolean intentionally NOT
    // supported — boolean signals must be cast to enum_value at the
    // dispatcher layer if a future BANT row needs them.
    const value = payload.value;
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') {
      return {
        ok: false,
        error: `invalid subObjectiveTransition.value: must be string | number | null (got ${typeof value})`,
      };
    }
    // Cross-rule consistency: toState='known' requires non-null,
    // non-empty value. Mirrors the service-level guard at
    // sub-objective-gap-tracker.ts:334.
    if (
      payload.toState === 'known' &&
      (value === null || (typeof value === 'string' && value.trim().length === 0))
    ) {
      return {
        ok: false,
        error: 'subObjectiveTransition.value required (non-null, non-empty) when toState="known"',
      };
    }
    nextBestAction.subObjectiveTransition = {
      subObjectiveKey: payload.subObjectiveKey as SubObjectiveTransitionKey,
      toState: payload.toState as 'known' | 'not_applicable',
      value: value as string | number | null,
    };
  }

  return { ok: true, value: { nextBestAction, confidence } };
}

// ─────────────────────────────────────────────
// Graceful fallback
// ─────────────────────────────────────────────

function gracefulFallback(
  dealId: string,
  evaluatedAt: Date,
  snapshot: BrainStateSnapshot,
  tier: 'cheap' | 'reasoning',
  reason: string,
): BrainDecision {
  return {
    dealId,
    evaluatedAt,
    currentStateSnapshot: snapshot,
    nextBestAction: {
      type: 'no_action',
      reasoning: `Brain Service fallback: ${reason}. Caller should retry or escalate.`,
    },
    confidence: 0.0,
    modelTier: tier,
    // Zero tokens: no successful LLM call was made (or the response was
    // unparseable, in which case the caller treats this as "no decision yet").
    llmInputTokens: 0,
    llmOutputTokens: 0,
  };
}
