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
  ContactSubObjectiveGapState,
  Engagement,
  DealStageHistory,
} from '@prisma/client';
import { complete } from './llm-client.js';
// KAN-1042 PR B — gap-state self-fetch from inside evaluateDealState. Same-
// rootDir static import; no cross-rootDir TS6059 concerns. computeGapState
// is fail-safe (returns empty prioritizedGaps/resolvedGaps on any DB error)
// per its own contract, so a transient failure here gracefully omits the
// new prompt section rather than blocking the engine call.
import { computeGapState } from './sub-objective-gap-tracker.js';
import {
  DEFAULT_SUB_OBJECTIVES_GENERIC_B2B,
  type SubObjectiveGapState,
  // KAN-1064 (Cluster II PR II) — EnginePhase canonical types + operator
  // detection discriminator. SubObjectiveSource enum is the structured
  // discriminator authored by KAN-1042 PR A2 (manual = operator; engine =
  // dispatcher arm; decision_initialize / extraction / enrichment = system).
  type BlueprintEnginePhase,
  type SubObjectiveSource,
} from '@growth/shared';

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
  | 'transition_sub_objective'
  // KAN-1063 (Cluster II PR I, foundation for KAN-1062) — engine-driven
  // EnginePhase advancement. Emitted when the contact's accumulated
  // sub-objective signal indicates the current phase is sufficiently
  // resolved AND the reply shows signal aligned with the next phase.
  // Payload sits on `BrainNextBestAction.enginePhaseAdvance`.
  //
  // Strict sequential v1 (Cluster II Phase 1 Lock 1) — only the canonical
  // adjacent-phase transitions are valid: qualify→problem, problem→proof,
  // proof→closing. Lock 4 invariant: engine cannot emit `advance_engine_phase`
  // FROM `closing` — exit paths are `advance_stage` (Cluster III handoff),
  // `close_deal_lost`, `wait_for_response`, `escalate_to_human`.
  // `isValidPhaseAdvance(from, to)` enforces both rules.
  //
  // Governance: same dispatcher-level gating shape as `transition_sub_objective`.
  // Cluster II PR V's wirePhase2Consumers arm reads `Tenant.autoAdvanceEnginePhase`
  // (default false → escalate via originalAction; true → dispatch via
  // `handleEngineAdvancePhase`). PR I (this PR) ships the action vocabulary
  // + validation infrastructure; PR IV ships the parser payload extraction
  // + engine prompt rendering; PR V wires the dispatcher arm.
  | 'advance_engine_phase';

export type BrainSuggestedChannel = 'email' | 'sms' | 'meta_messenger';
export type BrainSuggestedTone = 'curious' | 'professional' | 'urgent' | 'closing';

/**
 * KAN-1042 PR A1 — `transition_sub_objective` payload shape. Carried on
 * `BrainNextBestAction.subObjectiveTransition` when (and only when)
 * `type === 'transition_sub_objective'`.
 *
 * `subObjectiveKey` originally clamped to BANT-5 to match the router enum
 * at `apps/api/src/router.ts:6617`. KAN-1063 (Cluster II PR I) folds in
 * KAN-1050 vocab extension — adds 3 keys (`cost_of_problem`, `roi_metrics`,
 * `committed_amount`) for the 4-phase EnginePhase model (Problem / Proof /
 * Closing). Sub-objective keys stay framework-agnostic; the phase grouping
 * lives in `Blueprint.enginePhases` (per-vertical config).
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
  | 'motivation'
  // KAN-1063 (Cluster II PR I) — vocab extension folding in KAN-1050.
  | 'cost_of_problem'
  | 'roi_metrics'
  | 'committed_amount';

export interface SubObjectiveTransitionPayload {
  subObjectiveKey: SubObjectiveTransitionKey;
  toState: 'known' | 'not_applicable';
  value: string | number | null;
}

// ─────────────────────────────────────────────
// KAN-1063 (Cluster II PR I) — EnginePhase canonical types + validators
// ─────────────────────────────────────────────

/**
 * KAN-1063 (Cluster II PR I) — canonical EnginePhase keys. The 4-phase
 * engine workflow model introduced by Cluster II (KAN-1062). Strict
 * sequential ordering: qualify → problem → proof → closing.
 *
 * Naming: `EnginePhase` (NOT `MicroObjective`) per Phase 1 Lock 1 —
 * existing `MicroObjective` Prisma model at schema.prisma:1061
 * (KAN-700/701 platform-default completion-gate tracking) is a
 * fundamentally different concept; see memo
 * `feedback_cluster_ii_engine_phase_vs_micro_objective_disambiguation.md`.
 */
export type EnginePhaseKey = 'qualify' | 'problem' | 'proof' | 'closing';

/**
 * Canonical phase order — load-bearing for `isValidPhaseAdvance` boundary
 * checks. Lock 4 invariant: `closing` is terminal; engine cannot emit
 * `advance_engine_phase` from this phase.
 */
export const ENGINE_PHASE_ORDER: readonly EnginePhaseKey[] = [
  'qualify',
  'problem',
  'proof',
  'closing',
] as const;

export const VALID_ENGINE_PHASES: ReadonlySet<EnginePhaseKey> = new Set<EnginePhaseKey>([
  'qualify',
  'problem',
  'proof',
  'closing',
]);

/**
 * KAN-1063 (Cluster II PR I) — `advance_engine_phase` payload shape.
 * Carried on `BrainNextBestAction.enginePhaseAdvance` when (and only
 * when) `type === 'advance_engine_phase'`. PR IV wires the parser
 * payload extraction; PR I (this PR) ships the type contract only.
 */
export interface AdvanceEnginePhasePayload {
  fromPhase: EnginePhaseKey;
  toPhase: EnginePhaseKey;
}

/**
 * KAN-1063 (Cluster II PR I) — strict-sequential phase-advance validator.
 *
 * Returns true ONLY when `to` is exactly one position after `from` in
 * the canonical `ENGINE_PHASE_ORDER`. All other transitions are invalid:
 *   - skip transitions (qualify → proof, qualify → closing, problem → closing) → false
 *   - reverse transitions (problem → qualify, closing → proof) → false
 *   - same-phase (qualify → qualify) → false
 *   - Lock 4 invariant: closing has no exit — closing → ??? returns false
 *     for ALL `to` values. Engine must use `advance_stage` (Cluster III
 *     handoff), `close_deal_lost`, `wait_for_response`, or
 *     `escalate_to_human` at the closing boundary.
 *
 * Used at:
 *   - Cluster II PR IV: parser validation in parseLlmResponse (reject
 *     LLM responses that violate the strict-sequential contract)
 *   - Cluster II PR V: dispatcher-arm defense-in-depth before
 *     handleEngineAdvancePhase fires
 */
export function isValidPhaseAdvance(from: EnginePhaseKey, to: EnginePhaseKey): boolean {
  const fromIdx = ENGINE_PHASE_ORDER.indexOf(from);
  // Defensive: invalid `from` value (not in canonical order) → reject.
  // Lock 4: closing has no exit — fromIdx === length-1 returns false because
  // `fromIdx < ENGINE_PHASE_ORDER.length - 1` fails.
  return (
    fromIdx >= 0 &&
    fromIdx < ENGINE_PHASE_ORDER.length - 1 &&
    ENGINE_PHASE_ORDER[fromIdx + 1] === to
  );
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
  /**
   * KAN-1063 (Cluster II PR I) — populated when
   * `type === 'advance_engine_phase'`. Omitted on all other action types.
   * PR IV wires the parser payload extraction; PR I (this PR) ships the
   * type contract + validation infrastructure (isValidPhaseAdvance) only.
   */
  enginePhaseAdvance?: AdvanceEnginePhasePayload;
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
  /**
   * KAN-1042 PR B — pre-computed sub-objective gap state. When provided,
   * `evaluateDealState` SKIPS its internal `computeGapState` call and uses
   * this value verbatim. When undefined (default), the engine fetches it
   * internally so legacy callers see no behavioral diff beyond the new
   * prompt section.
   *
   * Use-case: callers (e.g., runDecisionForContact at L1117) that already
   * loaded gap state for their own logic can pass it through to avoid a
   * duplicate DB round-trip. Best-effort fail-safe — a transient compute
   * failure inside evaluateDealState produces an empty gap-state structure
   * (per computeGapState's own contract) and the prompt's gap-state
   * section is omitted rather than rendering an empty header.
   */
  subObjectiveGapState?: SubObjectiveGapState;
  /**
   * KAN-1065 (Cluster II PR III) — current EnginePhase focus computed by
   * the caller (lead-received-push initial-lead path OR contact-replied-push
   * reply chain) via `resolveEnginePhases` + `computeCurrentEnginePhase`
   * (PR II). When defined, PR IV's prompt-rendering extension splices the
   * `## Engine phase focus` section between the `## Latest inbound` block
   * and the `## Sub-objective gap state for this contact` section. PR V
   * threads `payload->>'currentEnginePhase'` + `payload->>'currentEnginePhaseReason'`
   * into the `decision_re_evaluated` audit row for Tier 1 telemetry.
   *
   * PR III (this PR) ships the THREADING ONLY — engine prompt + parser
   * extension for `advance_engine_phase` are deferred to PR IV
   * ([KAN-1066](https://axisone-team.atlassian.net/browse/KAN-1066)).
   * Until PR IV lands, this field is consumed only for audit-payload
   * forwarding; the engine prompt template doesn't yet render the new
   * sub-section.
   *
   * Omitted (undefined) by legacy callers (pre-KAN-1065 sites + any future
   * caller that doesn't compute focus) → the prompt + audit payload omit
   * the EnginePhase surface gracefully. Cluster II Phase 1 Lock 2
   * derived-with-fallback discipline means a transient compute failure
   * upstream produces a defensible default (DEFAULT_ENGINE_PHASES_GENERIC_B2B
   * + qualify-derived) rather than throwing — the caller's fail-safe is
   * the safety net.
   */
  currentEnginePhase?: CurrentEnginePhase;
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
   * Thread depth — count of prior outbounds the inbound is replying to,
   * derived at the publisher (KAN-1056 for the reply path; KAN-1052 for
   * the initial-lead path).
   *
   *   - Reply path (lead-received-push.ts:emitContactRepliedIfCorrelated)
   *     — live `prisma.engagement.count` of prior `email_send` engagements
   *     on the matched Deal; matchedDealId-null fallback to 1.
   *   - Initial-lead path (lead-received-push.ts:723) — hardcoded 0
   *     because the inbound is a fresh inquiry, not a reply.
   *
   * The latestInboundBlock prompt ternary keys off `0` to emit "reached
   * out for the first time" phrasing; any ≥1 value renders as "replied"
   * (Phase B will extend with depth-aware phrasing per KAN-1060).
   */
  threadDepth: number;
  /**
   * KAN-1058 (Phase B PR III) — prior conversation turn-pairs on the Deal,
   * ordered oldest-first. Renders into the engine prompt's
   * `### Prior conversation context` sub-section between the latest body
   * blockquote and `### Stop-condition guidance`.
   *
   *   - Reply path (contact-replied-push.ts L398+) — fetched via
   *     `buildThreadContext(prisma, {tenantId, dealId, excludeEngagementId})`
   *     before the `evaluateDealState` call; up to `THREAD_DEPTH_CAP * 2`
   *     prior `email_send` + `email_received` engagements.
   *   - Initial-lead path (lead-received-push.ts L708+) — always `[]`
   *     because a fresh inquiry has no prior turns to render.
   *   - Test fixtures hand-constructing this interface — defaulted to
   *     `[]` by the `buildLatestInboundContext` helper at L334 (optional
   *     input, required-with-default resolved-shape per Phase B Phase 1
   *     trace Q1+Q2 locks).
   *
   * Required (not optional) on the resolved object so the prompt template
   * at `latestInboundBlock` (L1115+) can read `priorTurns.length === 0`
   * directly without `priorTurns?.length` or `(priorTurns ?? []).length`
   * gymnastics. Gating: omit the sub-section entirely when length === 0.
   */
  priorTurns: ThreadTurn[];
}

/**
 * KAN-1052 — pure builder for the `BrainLatestInbound` shape. Single
 * source of truth used by BOTH:
 *   - `apps/api/src/subscribers/lead-received-push.ts` (initial-lead path;
 *     KAN-1052) — inbound is a fresh inquiry, no prior Decision exists at
 *     the call site; passes `event.eventId` (lead.received) as the
 *     forensic anchor for `inReplyToDecisionId`.
 *   - `apps/api/src/subscribers/contact-replied-push.ts` (reply chain; PR4)
 *     — inbound IS a reply; passes the originating outbound's Decision id.
 *
 * Cluster I roadmap pin: Phase B's multi-turn thread context extension
 * (~1-2 weeks of work) will add prior-turn fields. Centralizing the
 * construction here means Phase B touches ONE helper, not TWO callers.
 *
 * Pure passthrough — no business logic, no defaulting. Forces explicit
 * value supply for each field at call sites; no hidden decisions.
 */
export function buildLatestInboundContext(input: {
  receivedAt: string;
  senderEmail: string;
  bodyText: string;
  subjectLine: string;
  inReplyToDecisionId: string;
  threadDepth: number;
  /**
   * KAN-1058 — optional input per Phase B Phase 1 Q1 lock. Test fixtures
   * that hand-construct without priorTurns + legacy callers stay
   * back-compat; the helper defaults to `[]` and the resolved shape
   * carries the required field with safe-empty value.
   */
  priorTurns?: ThreadTurn[];
}): BrainLatestInbound {
  return {
    receivedAt: input.receivedAt,
    senderEmail: input.senderEmail,
    bodyText: input.bodyText,
    subjectLine: input.subjectLine,
    inReplyToDecisionId: input.inReplyToDecisionId,
    threadDepth: input.threadDepth,
    priorTurns: input.priorTurns ?? [],
  };
}

// ─────────────────────────────────────────────
// KAN-1064 (Cluster II PR II) — Current EnginePhase derivation + operator
// override (derived-with-fallback per Cluster II Phase 1 Lock 2)
// ─────────────────────────────────────────────

/**
 * KAN-1064 — return shape for `computeCurrentEnginePhase`.
 *
 * `currentPhase` is the BlueprintEnginePhase the engine should treat as
 * the contact's active workflow phase. `reason` carries the derivation
 * provenance (the operator-override path vs. the unfilled-priority derive
 * path). `operatorOverrideRecencyDays` is included ONLY on the
 * `operator_override` branch so the prompt-renderer (PR IV) can splice
 * the recency into the operator-override snippet.
 */
export interface CurrentEnginePhase {
  currentPhase: BlueprintEnginePhase;
  reason: 'operator_override' | 'derived';
  operatorOverrideRecencyDays?: number;
}

/**
 * KAN-1064 (Cluster II PR II) — pure-builder current EnginePhase
 * derivation with recency-based operator-override detection.
 *
 * Derived-with-fallback discipline per Cluster II Phase 1 Lock 2:
 *   - Operator-override path (Q2 lock): when `contactRecentSetBy` is
 *     defined AND its `source === 'manual'` AND `setAt` is within the
 *     7-day recency window (Q3 lock) AND the `subObjectiveKey` belongs
 *     to a phase in `enginePhases` (Q6 lock — orphan keys derive
 *     normally), return that phase with `reason = 'operator_override'`.
 *   - Derived path: iterate `enginePhases` sorted by `priority` ascending;
 *     return the FIRST phase where any sub-objective has state ∈
 *     {unknown, partial}. When all sub-objectives across all phases are
 *     filled (state ∈ {known, not_applicable}), return the LAST phase
 *     (Closing) per Q7 sticky-at-closing lock.
 *
 * The operator-detection discriminator is `source === 'manual'` per
 * KAN-1042 PR A2's structured SubObjectiveSource enum, NOT pattern-matching
 * on `setBy` string (which is brittle to actor-naming drift — operator
 * emails, system actor email-shaped names, etc.). Q2 of the Phase 1 trace
 * surfaced this gap in the original spec and locked the structural fix.
 *
 * Pure builder — no Prisma I/O, no LLM, no side effects. Caller (PR III)
 * loads gap state via `computeGapState` + EnginePhase config via
 * `resolveEnginePhases` and threads both into this helper.
 *
 * @param input.gapState  Contact's full sub-objective gap state rows
 *   (already loaded upstream — typically from `computeGapState`'s
 *   internal fetch). The helper reads `subObjectiveKey` + `state` only;
 *   other columns are ignored.
 * @param input.enginePhases  Resolved EnginePhase config for the tenant
 *   (typically from `resolveEnginePhases`). Iterated by `priority`
 *   ascending for the derived path.
 * @param input.contactRecentSetBy  Optional most-recent manual touch
 *   marker for the operator-override path. When undefined, pure-derived
 *   path is taken.
 */
// KAN-1067-fixfwd 2026-06-03 — re-export resolveEnginePhases so the
// subscriber's variable-specifier dynamic-import loader at
// lead-received-push.ts:460 (which resolves './brain-service.js') can
// resolve the symbol at runtime. The function lives in
// `blueprint-engine-phases-resolver.ts` (KAN-1064 PR II), but unit tests
// vi.mock('./brain-service.js', () => ({ resolveEnginePhases: ... }))
// FAKED the export — masking the test-vs-runtime divergence across
// 3 merged PRs (III/IV/V). Gated empirical smoke caught it on the first
// real publish post-KAN-1067 deploy. See memo
// `feedback_loader_vs_canonical_test_divergence` for full discipline.
export { resolveEnginePhases } from './blueprint-engine-phases-resolver.js';

// KAN-1080 (Cluster III PR I) — re-export resolveEnginePhaseStageMap at the
// canonical loader path. Subscribers load via variable-specifier dynamic
// import of `brain-service.js`; the symbol MUST be exposed here OR the
// KAN-1067 loader-vs-canonical-test divergence recurs. The vi.importActual
// integration guard in brain-service.test.ts asserts this contract at
// test time (extended from 5 to 6 symbols in this PR).
export { resolveEnginePhaseStageMap } from './engine-phase-stage-map-resolver.js';

export function computeCurrentEnginePhase(input: {
  gapState: ContactSubObjectiveGapState[];
  enginePhases: BlueprintEnginePhase[];
  contactRecentSetBy?: {
    setBy: string;
    setAt: Date;
    subObjectiveKey: string;
    // KAN-1064 Q2 lock — structured discriminator over pattern-matching.
    source: SubObjectiveSource;
  };
}): CurrentEnginePhase {
  const { gapState, enginePhases, contactRecentSetBy } = input;

  // Sort by priority ascending so iteration order matches phase progression.
  // Defensive `.slice()` to avoid mutating the caller's array.
  const sortedPhases = enginePhases.slice().sort((a, b) => a.priority - b.priority);

  // ── Operator-override path (Q2 + Q3 + Q6 locks) ──────────────────────
  if (contactRecentSetBy && contactRecentSetBy.source === 'manual') {
    const recencyMs = Date.now() - contactRecentSetBy.setAt.getTime();
    const recencyDays = recencyMs / (1000 * 60 * 60 * 24);

    // Q3 lock — 7-day recency window. Negative recency (clock skew) also
    // accepted as "very recent" (defensive against test fixtures with
    // future timestamps).
    if (recencyDays <= 7) {
      // Q6 lock — orphan subObjectiveKey (not in any configured phase)
      // → derive normally. Defensive against vocab-extension drift where
      // a row exists for a key that the current Blueprint config doesn't
      // bucket into any phase yet.
      const overridePhase = sortedPhases.find((phase) =>
        phase.subObjectives.includes(contactRecentSetBy.subObjectiveKey),
      );
      if (overridePhase) {
        return {
          currentPhase: overridePhase,
          reason: 'operator_override',
          operatorOverrideRecencyDays: recencyDays,
        };
      }
      // Orphan key → fall through to derived path. Audit-row pin for the
      // orphan case is a Phase 2.5 follow-up candidate if empirical
      // signal warrants.
    }
  }

  // ── Derived path ─────────────────────────────────────────────────────
  // Build O(1) lookup from subObjectiveKey → row.state for the loop below.
  const stateByKey = new Map<string, ContactSubObjectiveGapState['state']>();
  for (const row of gapState) {
    stateByKey.set(row.subObjectiveKey, row.state);
  }

  // Iterate phases in priority order; return the first phase with any
  // unfilled sub-objective. "Unfilled" = state ∈ {unknown, partial};
  // "filled" = state ∈ {known, not_applicable}. Missing rows (no entry in
  // gapState for a configured key) treat as unfilled (`unknown` default).
  for (const phase of sortedPhases) {
    const hasUnfilled = phase.subObjectives.some((key) => {
      const state = stateByKey.get(key);
      return state !== 'known' && state !== 'not_applicable';
    });
    if (hasUnfilled) {
      return { currentPhase: phase, reason: 'derived' };
    }
  }

  // Q7 lock — all sub-objectives filled across all phases. Sticky at
  // closing (LAST phase by priority order). Engine continues operating
  // in closing; emits `advance_stage` / `close_deal_lost` /
  // `wait_for_response` / `escalate_to_human` via the existing action
  // vocabulary at the closing boundary per Lock 4.
  //
  // Defensive: if enginePhases is empty (config edge case), fall back to
  // the first DEFAULT phase (qualify). This shouldn't happen in practice
  // because `resolveEnginePhases` fail-safes to DEFAULT, but guards
  // against caller misuse.
  const lastPhase = sortedPhases[sortedPhases.length - 1];
  if (!lastPhase) {
    // Unreachable in practice; defensive only.
    throw new Error(
      '[brain-service] computeCurrentEnginePhase: enginePhases array is empty — caller must supply at least one phase',
    );
  }
  return { currentPhase: lastPhase, reason: 'derived' };
}

// ─────────────────────────────────────────────
// KAN-1057 (Phase B PR II) — Multi-turn thread context
// ─────────────────────────────────────────────

/**
 * KAN-1057 — depth cap for prior-turn rendering. Locked at 5 turn-pairs
 * per Phase B Phase 1 design trace (2026-06-02):
 *   - PROD thread-depth distribution (11 Deals): p50=1, p90=4, max=5
 *   - Token budget at full-stack ship: ~3500-4500 input tokens (0.45% of
 *     Claude Sonnet 4.6's 1M context window)
 *
 * Hardcoded constant rather than tenant-config because no empirical signal
 * yet that tenants need different depths. Revisit if cohort latency or
 * cognitive-degradation signal warrants per-tenant tuning.
 *
 * The findMany take limit is `THREAD_DEPTH_CAP * 2` (10 engagements) to
 * capture a fully-paired 5-turn conversation. In a pathological all-outbound
 * stretch the helper still returns up to 10 ThreadTurns; the engine prompt
 * gracefully handles any non-empty array.
 */
export const THREAD_DEPTH_CAP = 5;

/**
 * KAN-1057 — single rendered turn in a thread. Direction signals whether the
 * line came from us or the contact; (subjectLine, bodyText) carry the
 * verbatim content the engine prompt will splice into the `### Prior
 * conversation context` sub-section in PR III.
 *
 * Both subjectLine and bodyText default to empty string when the source
 * Engagement row has missing/malformed metadata (Q1 lock: empty string
 * preserves accurate turn-count correspondence with PR I's threadDepth
 * derivation; omitting the turn would silently desync them).
 */
export interface ThreadTurn {
  direction: 'outbound' | 'inbound';
  /** ISO 8601 of the source Engagement.occurredAt. */
  occurredAt: string;
  /** Subject line from Engagement.metadata.subject; '' when missing/malformed. */
  subjectLine: string;
  /** Body from Engagement.metadata.bodyPreview, ≤2000 chars; '' when missing/malformed. */
  bodyText: string;
}

/**
 * KAN-1057 — chronological-by-deal walk of prior email engagements on a Deal.
 *
 * Returns up to `THREAD_DEPTH_CAP * 2` (10) most-recent prior-turn
 * Engagements ordered **oldest-first** (chronological), excluding the
 * just-received row. PR III splices the result into the engine prompt's
 * `### Prior conversation context` sub-section between the latest body
 * blockquote and the `### Stop-condition guidance` block.
 *
 * Phase B Phase 1 design-trace locks (2026-06-02):
 *   - Q1 (empty-string defensive default): missing metadata.subject /
 *     bodyPreview → empty string, NOT row omission. Preserves
 *     priorTurns.length = threadDepth - 1 correspondence with PR I.
 *   - Q2 (runtime type guard): `metadata` is Prisma Json → JsonValue at
 *     runtime; bare casts silently propagate malformed shapes. Inline
 *     `typeof === 'string'` guards extract safely.
 *   - Q3 (oldest-first internal): caller (PR III) iterates forward for
 *     render; helper returns render-ready shape. Internal `.reverse()`
 *     converts the findMany DESC sort.
 *   - Q4 (email-only scope): filter `engagementType: { in: ['email_send',
 *     'email_received'] }` — opens/clicks/bounces/replies are passive
 *     interaction signals without renderable subject/body content;
 *     including them would pollute the prompt.
 *
 * **Fail-safe contract**: any throw from `prisma.engagement.findMany` is
 * caught + warn-logged + returns `[]`. The PR III prompt section is then
 * omitted via the existing `priorTurns.length === 0` gating rule rather
 * than blocking the engine call.
 *
 * **Query shape**: single indexed roundtrip on
 * `@@index([tenantId, dealId, occurredAt])` (schema.prisma:1978). DESC
 * orderBy + take 10 + post-reverse → expected single-digit-ms cost.
 *
 * @param prisma  PrismaClient instance (caller-injected; brain-service.ts
 *                imports PrismaClient directly from @prisma/client per the
 *                same-rootDir packages/api convention).
 * @param input.tenantId            Deal's tenantId — index leading edge.
 * @param input.dealId              Deal to walk. Required (no contact-level
 *                                  fallback in PR II; multi-deal-per-contact
 *                                  is a Phase B+ extension).
 * @param input.excludeEngagementId The just-received inbound row's id; the
 *                                  publish IIFE commits it before this
 *                                  helper fires, so it would otherwise
 *                                  appear in the walk.
 */
export async function buildThreadContext(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    dealId: string;
    excludeEngagementId: string;
  },
): Promise<ThreadTurn[]> {
  try {
    const rows = await prisma.engagement.findMany({
      where: {
        tenantId: input.tenantId,
        dealId: input.dealId,
        engagementType: { in: ['email_send', 'email_received'] },
        id: { not: input.excludeEngagementId },
      },
      orderBy: { occurredAt: 'desc' },
      take: THREAD_DEPTH_CAP * 2,
      select: {
        engagementType: true,
        occurredAt: true,
        metadata: true,
      },
    });

    const turns: ThreadTurn[] = rows.map((row) => {
      // Q2 lock: runtime type guards. `metadata` is Prisma Json → JsonValue
      // at runtime; the Engagement.metadata column has `@default("{}")` but
      // historical rows pre-KAN-839 may have missing subject/bodyPreview.
      // Inline `typeof === 'string'` is the cheapest safe extraction; no
      // zod dependency needed for two fields.
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      const subjectRaw = metadata['subject'];
      const bodyRaw = metadata['bodyPreview'];
      const subjectLine = typeof subjectRaw === 'string' ? subjectRaw : '';
      // Belt-and-suspenders 2000-char cap. Inbound writes already slice
      // upstream (lead-received-push.ts:1218 — KAN-839); outbound writes
      // pass through whatever the send-side publisher provided. Defensive
      // re-slice catches any pre-KAN-839 outbound rows that may exceed
      // the cap without re-deploy migration.
      const bodyText = typeof bodyRaw === 'string' ? bodyRaw.slice(0, 2000) : '';
      return {
        direction: row.engagementType === 'email_send' ? 'outbound' : 'inbound',
        occurredAt: row.occurredAt.toISOString(),
        subjectLine,
        bodyText,
      };
    });

    // Q3 lock: helper returns oldest-first so PR III's render loop iterates
    // forward without remembering to reverse. findMany returned DESC; flip.
    return turns.reverse();
  } catch (err) {
    // Fail-safe: any prisma throw → empty array. The PR III prompt section
    // is then gated off via `priorTurns.length === 0` rather than blocking
    // the engine call. Same posture as computeGapState's contract (L37-42).
    console.warn(
      `[brain-service] buildThreadContext error tenantId=${input.tenantId} dealId=${input.dealId} err=${(err as Error)?.message ?? String(err)}`,
    );
    return [];
  }
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

  // 4a-bis. KAN-1042 PR B — sub-objective gap-state fetch. When caller
  // provided a pre-computed value via options.subObjectiveGapState (per
  // EvaluateOptions docstring), use it verbatim. Otherwise compute it
  // here. computeGapState is fail-safe (returns empty
  // prioritizedGaps/resolvedGaps + writes audit on DB error) — the new
  // `## Sub-objective gap state for this contact` prompt section omits
  // gracefully when both arrays are empty.
  const gapState: SubObjectiveGapState =
    options.subObjectiveGapState ??
    (await computeGapState(prisma, deal.tenantId, deal.contactId, {
      currentStageName: snapshot.currentStageName,
    }));

  // 4b. Build prompt. KAN-825 threads the triggerContext through so chained
  // post-stage-advance calls render a directive prompt block that biases
  // Brain toward send_follow_up (default 'inbound' renders the legacy
  // prompt unchanged). KAN-828 threads the retrieval result into the new
  // `## Company knowledge` section. KAN-1042 PR B threads the gap state
  // into the new `## Sub-objective gap state for this contact` section.
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
    // KAN-1042 PR B — BANT-5 gap state for the new prompt section.
    // Conditional render gated on prioritizedGaps.length > 0 ||
    // resolvedGaps.length > 0; legacy callers with no gap data see the
    // section omitted.
    subObjectiveGapState: gapState,
    // KAN-1066 (Cluster II PR IV) — Engine phase focus for the new
    // prompt section. Conditional render gated on currentEnginePhase
    // !== undefined; legacy callers (pre-KAN-1065 sites) see the
    // section omitted. PR III threaded the field through EvaluateOptions
    // ahead of this PR.
    currentEnginePhase: options.currentEnginePhase,
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
- advance_engine_phase: all sub-objectives in the current Engine phase are resolved — advance to the next sequential phase per qualify → problem → proof → closing (specify fromPhase + toPhase via the enginePhaseAdvance payload). Cannot emit FROM \`closing\` (terminal).

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
    },
    "enginePhaseAdvance": {
      "fromPhase": "<qualify|problem|proof>",
      "toPhase": "<problem|proof|closing>"
    }
  },
  "confidence": <0.0-1.0>
}

\`subObjectiveTransition\` is required ONLY when \`type === "transition_sub_objective"\`; omit or set null on all other action types.
\`enginePhaseAdvance\` is required ONLY when \`type === "advance_engine_phase"\`; omit or set null on all other action types.

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
   *
   * KAN-1042 PR B (Half B) extends the rendering: when `latestInbound !==
   * undefined`, the block also appends a `### Stop-condition guidance`
   * sub-section that instructs the engine to prefer `close_deal_lost` on
   * clear rejection signals and `escalate_to_human` on opt-out signals.
   */
  latestInbound?: BrainLatestInbound;
  /**
   * KAN-1042 PR B (Half A) — BANT-5 sub-objective gap state for this
   * contact. When provided AND either `prioritizedGaps` or `resolvedGaps`
   * is non-empty, renders a `## Sub-objective gap state for this contact`
   * section between `## Latest inbound` and `## Recent stage transitions`.
   * Each of the 5 BANT keys renders one line in canonical priority order
   * (timeline → budget → authority → need → motivation per
   * DEFAULT_SUB_OBJECTIVES_GENERIC_B2B). Section is OMITTED when undefined
   * OR when both arrays are empty (e.g., transient compute failure;
   * sub-objective-gap-tracker fail-safes to empty per its own contract).
   */
  subObjectiveGapState?: SubObjectiveGapState;
  /**
   * KAN-1066 (Cluster II PR IV) — current EnginePhase focus computed by
   * the caller (PR III wiring). When defined, renders a
   * `## Engine phase focus` section BETWEEN `## Latest inbound` and
   * `## Sub-objective gap state for this contact`. Header alone carries
   * the derived signal (Q4 lock); an operator-override snippet renders
   * inline when `reason === 'operator_override'` (Q3 lock). A sibling
   * `### Phase-transition guidance` sub-section teaches the engine WHEN
   * to emit `advance_engine_phase` (Q5 lock — PR IV scope).
   *
   * Section is OMITTED when undefined — every legacy caller (pre-KAN-1065
   * sites + the in-process trpc paths) flows through this branch
   * unchanged.
   */
  currentEnginePhase?: CurrentEnginePhase;
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
    subObjectiveGapState,
    currentEnginePhase,
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
  // KAN-1042 PR B (Half B) — `### Stop-condition guidance` sub-section
  // appended to the `## Latest inbound` block. Conditional on `latestInbound
  // !== undefined` via the parent ternary; the sub-section renders only
  // when there's an actual inbound to interpret. Backtick-escaped
  // action-type identifiers prevent template-literal interpolation in JS.
  // Phase 2.5 A/B iteration may refine phrasing.
  const latestInboundBlock = latestInbound
    ? `

## Latest inbound

The contact ${latestInbound.threadDepth === 0 ? 'reached out for the first time' : 'replied'} on ${latestInbound.receivedAt} (thread depth: ${latestInbound.threadDepth}).
From: ${latestInbound.senderEmail}
Subject: ${latestInbound.subjectLine}

> ${latestInbound.bodyText.replace(/\n/g, '\n> ')}
${renderPriorTurnsSection(latestInbound.priorTurns)}
### Stop-condition guidance

If the contact's reply expresses CLEAR disinterest, explicit rejection, or stated decision to go elsewhere ("we've decided to go with another vendor", "not a fit for us", "not interested"), prefer \`close_deal_lost\` over \`send_follow_up\`. Do NOT attempt to overcome stated objections via follow-up messaging — it erodes trust. \`send_follow_up\` is reserved for engaged contacts where the conversation needs continuation.

If the contact's reply expresses opt-out intent ("please stop emailing me", "remove me from your list", "unsubscribe"), emit \`escalate_to_human\` so an operator can apply suppression. Cite the specific opt-out phrasing in your reasoning.
`
    : '';

  // KAN-1066 (Cluster II PR IV) — `## Engine phase focus` section.
  // Renders ONLY when currentEnginePhase is provided. Slot per Phase 1
  // trace + Q1-Q5 locks: BETWEEN `## Latest inbound` and `## Sub-objective
  // gap state for this contact`. Ordering invariant: "what just happened
  // (signal + body) → where the engine should focus (phase) → what we
  // know about this contact (gap state) → where we are (stage state)".
  //
  // Header alone carries derived signal (Q4: no "derived from gap-state"
  // line). Operator-override snippet renders inline when reason ===
  // 'operator_override' (Q3). Sibling `### Phase-transition guidance`
  // sub-section teaches WHEN to emit advance_engine_phase (Q5: PR IV
  // scope; PR V handles post-emission dispatcher flow).
  const enginePhaseFocusBlock = currentEnginePhase
    ? renderEnginePhaseFocusSection(currentEnginePhase)
    : '';

  // KAN-1042 PR B (Half A) — `## Sub-objective gap state for this contact`
  // section. Renders ONLY when subObjectiveGapState is provided AND has
  // non-empty arrays (prioritizedGaps OR resolvedGaps). Legacy callers
  // without gap data + transient compute failures (empty fail-safe) BOTH
  // route through omit so the prompt stays clean.
  //
  // Slot per Phase 1 Q3: BETWEEN `## Latest inbound` and `## Recent stage
  // transitions`. Ordering invariant: "what just happened (signal + body)
  // → what we know about this contact (gap state) → where we are (stage
  // state)".
  //
  // Instruction phrasing teaches the engine WHEN to emit
  // `transition_sub_objective`: clear factual signal in reply matching an
  // unfilled key → emit transition; ambiguous → prefer send_follow_up to
  // clarify. Backtick-escaped action-type identifiers.
  const hasGapData =
    subObjectiveGapState !== undefined &&
    (subObjectiveGapState.prioritizedGaps.length > 0 ||
      subObjectiveGapState.resolvedGaps.length > 0);
  const gapStateBlock = hasGapData
    ? `

## Sub-objective gap state for this contact

The following BANT-style sub-objectives track what we've learned about this contact. When the contact's reply provides CLEAR, FACTUAL information that fills an unknown row, emit a \`transition_sub_objective\` action with the matching \`subObjectiveKey\`, \`toState: "known"\`, and the relevant value. Cite the specific reply text in your reasoning. If the reply is ambiguous, prefer \`send_follow_up\` to clarify rather than guess.

${formatGapStateForContact(subObjectiveGapState!)}
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
${latestInboundBlock}${enginePhaseFocusBlock}${gapStateBlock}
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

/**
 * KAN-1042 PR B — renderer for the CONTACT-LEVEL gap state (sibling to
 * formatSubObjectives above, NOT an extension: different data source —
 * ContactSubObjectiveGapState rather than Objective.subObjectives JSON).
 *
 * Walks DEFAULT_SUB_OBJECTIVES_GENERIC_B2B in canonical priority order
 * (timeline → budget → authority → need → motivation) for stable output
 * regardless of how prioritizedGaps/resolvedGaps were ordered upstream.
 * Per-key state lookup: resolvedGaps wins for known/not_applicable;
 * prioritizedGaps for unknown/partial; absent → 'unknown' (engine sees
 * the gap as fillable).
 *
 * Value annotation `(value: "<value>")` only on known rows from
 * resolvedGaps. Partial rows from prioritizedGaps render their
 * valueIfPartial when present. not_applicable renders bare.
 *
 * Caller already gates rendering on
 * `prioritizedGaps.length > 0 || resolvedGaps.length > 0` so this helper
 * is only invoked when at least one row exists; defensive fallback for
 * "all 5 keys missing across both arrays" returns each as `unknown` for
 * graceful degradation.
 */
function formatGapStateForContact(gapState: SubObjectiveGapState): string {
  // Build a key → resolved-gap map for O(1) lookup.
  const resolvedByKey = new Map<string, (typeof gapState.resolvedGaps)[number]>();
  for (const r of gapState.resolvedGaps) resolvedByKey.set(r.key, r);
  const prioritizedByKey = new Map<string, (typeof gapState.prioritizedGaps)[number]>();
  for (const p of gapState.prioritizedGaps) prioritizedByKey.set(p.key, p);

  return DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((def) => {
    const resolved = resolvedByKey.get(def.key);
    if (resolved) {
      // 'known' → render value annotation; 'not_applicable' → bare.
      if (resolved.state === 'known' && resolved.value !== null) {
        return `- ${def.key}: known (value: "${resolved.value}")`;
      }
      return `- ${def.key}: ${resolved.state}`;
    }
    const prioritized = prioritizedByKey.get(def.key);
    if (prioritized) {
      if (prioritized.state === 'partial' && prioritized.valueIfPartial) {
        return `- ${def.key}: partial (value: "${prioritized.valueIfPartial}")`;
      }
      return `- ${def.key}: ${prioritized.state}`;
    }
    // Defensive fallback — neither array carried this key. Render as
    // unknown so the engine treats it as fillable.
    return `- ${def.key}: unknown`;
  }).join('\n');
}

/**
 * KAN-1058 (Phase B PR III) — render the `### Prior conversation context`
 * sub-section that slots between the `## Latest inbound` body blockquote
 * and `### Stop-condition guidance`. Q4 gating lock: empty turns array
 * → empty string return so the parent template literal omits the whole
 * sub-section. Q3 ordering lock: turns array arrives oldest-first from
 * `buildThreadContext` (PR II); render iterates forward without
 * re-reversing.
 *
 * Direction labels per ticket body: `outbound` → "We sent"; `inbound`
 * → "Contact replied". Body uses the same blockquote-prefix pattern as
 * the latest-inbound body (L1124 — `> ` + `\n> ` multi-line handling)
 * so the engine sees a structurally consistent rendering across both
 * sections.
 *
 * Pure-function module-private helper — sibling to
 * `formatGapStateForContact` above. No persistence, no LLM, no DB; the
 * caller (`buildEvaluationPrompt`) supplies validated input shape.
 */
function renderPriorTurnsSection(turns: ThreadTurn[]): string {
  if (turns.length === 0) return '';
  const turnsRendered = turns
    .map((turn) => {
      const header =
        turn.direction === 'outbound'
          ? `**We sent** on ${turn.occurredAt}`
          : `**Contact replied** on ${turn.occurredAt}`;
      return `${header}
Subject: ${turn.subjectLine}

> ${turn.bodyText.replace(/\n/g, '\n> ')}`;
    })
    .join('\n\n---\n\n');
  return `
### Prior conversation context

The following prior outbound + reply pairs led to this latest inbound, ordered oldest-first. Use them to understand the contact's evolving state across the thread.

${turnsRendered}
`;
}

/**
 * KAN-1066 (Cluster II PR IV) — render the `## Engine phase focus`
 * section. Slot per Q2 lock (after `renderPriorTurnsSection`,
 * chronological-by-PR convention).
 *
 * Q1: Header is `## Engine phase focus` (matches `## X` convention).
 * Q3: When `reason === 'operator_override'`, prepend a snippet that
 *   tells the engine an operator manually set this focus; engine treats
 *   the override as authoritative regardless of derived gap-state. TTL
 *   detail (7-day recency window) is implementation detail and is NOT
 *   surfaced in the prompt (engine doesn't need to know the window;
 *   it just needs to know "respect the override now").
 * Q4: Derived path renders ONLY the header line — no "derived from
 *   gap-state" annotation. Engine infers "derived" by absence of override
 *   snippet. Saves tokens; if empirical signal shows engine confusion
 *   about derivation source, add a follow-up via Phase 2.5.
 * Q5: Phase-transition guidance sub-section teaches WHEN to emit
 *   `advance_engine_phase`. Mirrors `### Stop-condition guidance` shape
 *   (action-type identifiers backtick-escaped to prevent template-literal
 *   interpolation). PR V handles WHAT HAPPENS post-emission via dispatcher
 *   docstrings; the prompt-side guidance lives here.
 *
 * Pure-function module-private helper — sibling to
 * `renderPriorTurnsSection` above. No persistence, no LLM, no DB; caller
 * (`buildEvaluationPrompt`) supplies validated input shape.
 */
function renderEnginePhaseFocusSection(currentEnginePhase: CurrentEnginePhase): string {
  const { currentPhase, reason } = currentEnginePhase;
  const overrideSnippet =
    reason === 'operator_override'
      ? `An operator manually set this contact's phase focus to \`${currentPhase.key}\` (${currentPhase.label}). Treat this as the authoritative current phase regardless of derived gap-state.

`
      : '';
  return `

## Engine phase focus

Current phase: \`${currentPhase.key}\` (${currentPhase.label}). Sub-objectives in scope for this phase: ${currentPhase.subObjectives.map((k) => `\`${k}\``).join(', ') || '(none)'}.

${overrideSnippet}### Phase-transition guidance

When ALL sub-objectives listed for the current phase are resolved (state ∈ {known, not_applicable} in the gap state below), emit \`advance_engine_phase\` with \`fromPhase\` set to the current phase and \`toPhase\` set to the next sequential phase per qualify → problem → proof → closing. Cite the resolved sub-objectives in your reasoning.

Do NOT skip phases (e.g., qualify → proof) — the validator rejects non-sequential advances. Do NOT emit \`advance_engine_phase\` FROM \`closing\` (terminal phase; use \`advance_stage\`, \`close_deal_lost\`, \`wait_for_response\`, or \`escalate_to_human\` instead). When sub-objectives in the current phase remain unresolved, prefer \`send_follow_up\` or \`transition_sub_objective\` over premature phase advance.
`;
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
  // KAN-1063 (Cluster II PR I) — parser accepts the action type; PR IV
  // wires the `enginePhaseAdvance` payload extraction.
  'advance_engine_phase',
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
// `apps/api/src/router.ts:6617`. KAN-1063 (Cluster II PR I) folds in
// KAN-1050 vocab extension — adds `cost_of_problem`, `roi_metrics`,
// `committed_amount` for the 4-phase EnginePhase model (Problem / Proof /
// Closing). Sub-objective KEYS stay framework-agnostic; the phase
// grouping lives in `Blueprint.enginePhases` (per-vertical config).
const VALID_SUB_OBJECTIVE_KEYS: ReadonlySet<SubObjectiveTransitionKey> =
  new Set<SubObjectiveTransitionKey>([
    'timeline',
    'budget',
    'authority',
    'need',
    'motivation',
    // KAN-1063 (Cluster II PR I) — vocab extension folding in KAN-1050.
    'cost_of_problem',
    'roi_metrics',
    'committed_amount',
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

  // KAN-1066 (Cluster II PR IV) — enginePhaseAdvance payload validation.
  // The field is REQUIRED when type === 'advance_engine_phase' and dropped
  // otherwise. Validation layers:
  //   1. Payload presence (mirrors transition_sub_objective shape)
  //   2. Both phases are members of VALID_ENGINE_PHASES (PR I @ L166)
  //   3. isValidPhaseAdvance(fromPhase, toPhase) enforces strict-sequential
  //      contract (PR I @ L203 — rejects skips, reverses, same-phase, and
  //      Lock 4 closing-exit attempts)
  // Malformed payload on an advance_engine_phase emission → reject the
  // whole response; caller falls back to graceful escalation.
  if (a.type === 'advance_engine_phase') {
    const adv = a.enginePhaseAdvance;
    if (!adv || typeof adv !== 'object') {
      return { ok: false, error: 'enginePhaseAdvance payload missing for advance_engine_phase action' };
    }
    const payload = adv as Record<string, unknown>;
    if (
      typeof payload.fromPhase !== 'string' ||
      !VALID_ENGINE_PHASES.has(payload.fromPhase as EnginePhaseKey)
    ) {
      return {
        ok: false,
        error: `invalid enginePhaseAdvance.fromPhase: ${String(payload.fromPhase)} (must be one of qualify|problem|proof|closing)`,
      };
    }
    if (
      typeof payload.toPhase !== 'string' ||
      !VALID_ENGINE_PHASES.has(payload.toPhase as EnginePhaseKey)
    ) {
      return {
        ok: false,
        error: `invalid enginePhaseAdvance.toPhase: ${String(payload.toPhase)} (must be one of qualify|problem|proof|closing)`,
      };
    }
    const fromPhase = payload.fromPhase as EnginePhaseKey;
    const toPhase = payload.toPhase as EnginePhaseKey;
    if (!isValidPhaseAdvance(fromPhase, toPhase)) {
      return {
        ok: false,
        error: `invalid enginePhaseAdvance: ${fromPhase} → ${toPhase} violates strict-sequential contract (qualify → problem → proof → closing; no skips, no reverses, no exit from closing)`,
      };
    }
    nextBestAction.enginePhaseAdvance = { fromPhase, toPhase };
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
