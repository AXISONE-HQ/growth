/**
 * KAN-796a — Stage Transition Engine (Phase 2 epic 3 of 5, sub-cohort a).
 *
 * Pure-ish module: writes Deal.currentStageId + DealStageHistory in response
 * to Brain Service decisions to advance or close a Deal. No persistence
 * side-effects beyond the explicit transition write (caller decides WHEN to
 * invoke).
 *
 * **Stage-transition-engine: writes Deal.currentStageId + DealStageHistory in
 * response to Brain Service decisions. ORTHOGONAL to threshold-gate.ts (KAN-39
 * action-approval governance). Sub-cohort (b) wiring will compose them:
 * threshold-gate gates whether a transition action may fire autonomously;
 * stage-transition-engine writes the transition once approved. Neither
 * replaces the other.**
 *
 * Sub-cohort scope:
 *   - (a) THIS PR: pure module + tests. Zero callers wired.
 *   - (b) KAN-813 follow-up: wire into engagement-write path (synchronous
 *     in-line in lead-received-push.ts), composed with threshold-gate
 *     governance.
 *   - (c) KAN-814 follow-up: time-driven cron evaluator (Cloud Scheduler →
 *     scans stalled Deals against Stage.followUpCadence, invokes engine).
 *
 * Decision flow:
 *   1. Load Deal + currentStage + pipeline.stages. If currentStage.outcomeType
 *      is terminal_*, skip (no transitions OUT of terminal Stages — closure
 *      is final by Phase 1 design).
 *   2. Call Brain Service evaluateDealState(prisma, dealId, { tier }).
 *   3. Confidence gate (default 0.5; configurable via options) — below
 *      threshold → no_transition.
 *   4. Action dispatch:
 *        advance_stage    → resolve target Stage (use targetStageId if
 *                           provided AND valid, else next non-terminal
 *                           Stage by order), write transition.
 *        close_deal_lost  → find Pipeline's terminal_lost Stage, write
 *                           transition. (No terminal_lost Stage in
 *                           Pipeline → skipped + warn log.)
 *        send_follow_up / wait_for_response / escalate_to_human / no_action
 *                         → no_transition.
 *
 * Idempotency: same Deal state + same Brain decision → same target Stage
 * chosen. Multiple invocations writing the same transition twice is a
 * separate concern — caller's idempotency (correlationId, advisory locks,
 * Pub/Sub dedup) is sub-cohort (b) wiring scope.
 *
 * Closure model (KAN-791): Deal.closedAt was DROPPED. Closure is signaled
 * by Deal.currentStageId pointing at a Stage with outcomeType IN
 * (terminal_won, terminal_lost). To query "when did this Deal close?",
 * read DealStageHistory.transitionedAt for the transition INTO the
 * terminal Stage.
 */
import type { PrismaClient } from '@prisma/client';
import { evaluateDealState, type BrainDecision } from './brain-service.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type StageTransitionResult =
  | {
      type: 'transitioned';
      dealId: string;
      fromStageId: string;
      toStageId: string;
      // KAN-825 — human-readable stage names for chained Brain prompts.
      // Already in scope inside the engine (DealStageHistory metadata
      // captures them too). Surfacing on the result so callers don't have
      // to re-query the Stage rows just to render a follow-up prompt.
      fromStageName: string;
      toStageName: string;
      brainDecision: BrainDecision;
      /** DealStageHistory row id of the transition write. */
      transitionRowId: string;
    }
  | {
      type: 'no_transition';
      dealId: string;
      reason: string;
      brainDecision: BrainDecision;
    }
  | {
      type: 'skipped';
      dealId: string;
      /** 'already_terminal' | 'no_target_resolved' | 'no_terminal_lost_stage_in_pipeline' */
      reason: string;
      /** Present unless the skip happened pre-Brain (e.g., already_terminal). */
      brainDecision?: BrainDecision;
    };

export interface EvaluateTransitionOptions {
  /** Forwarded to Brain Service. Default: 'reasoning' (Sonnet) — same posture as KAN-794/795 (consequential calls use Sonnet). */
  tier?: 'cheap' | 'reasoning';
  /**
   * Minimum Brain confidence required to fire a transition. Default 0.5.
   * Below threshold → no_transition. Caller can override per-invocation
   * for higher-stakes paths (e.g., Stage Evolution cron may use 0.7+).
   */
  minConfidenceForTransition?: number;
  /**
   * Semantic descriptor for DealStageHistory.triggeredBy. Bounded vocab
   * per schema comment: 'normalizer' | 'agent' | 'human' | 'system' | 'rule'.
   *
   * triggeredBy default: 'agent' — Brain Service is an AI agent in the
   * bounded vocab (per decision_kan_749_mvp_shape_rationale). KAN-796b/c
   * callers can override: 'system' for cron-driven re-eval; 'human' for
   * manual override (post-MVP per KAN-810).
   */
  triggeredBy?: 'normalizer' | 'agent' | 'human' | 'system' | 'rule';
  /**
   * KAN-834 — pre-computed Brain decision from the dispatcher. When
   * provided, the engine SKIPS its internal `evaluateDealState` call and
   * uses the passed decision verbatim.
   *
   * Cures the LLM-non-determinism double-eval disagreement class
   * (Sprint 11-pre Gmail smoke 2026-05-05 16:10:54-16:11:01 UTC: dispatcher
   * Brain returned `advance_stage`, engine's internal Brain re-eval
   * returned `send_follow_up`, engine emitted `no_transition`, KAN-825
   * chain skipped, customer silence). Single Brain call per inbound;
   * downstream consumers see exactly one decision.
   *
   * Terminal-stage short-circuit still runs first (pre-Brain, unchanged) —
   * the pre-computed decision doesn't bypass closure-state safety.
   *
   * Backwards-compat: when absent, the engine falls back to its existing
   * internal Brain call. Future cron/operator callers without a
   * dispatcher-side Brain call still work unchanged.
   */
  brainDecision?: BrainDecision;
  /**
   * KAN-1081 (Cluster III PR II) — EnginePhase → PipelineStage mapping entry
   * resolved by the dispatcher (lead-received-push.ts) via
   * `resolveEnginePhaseStageMap` from KAN-1080 PR I. When provided AND
   * `mapEntry.stageId` exists in the Deal's Pipeline, `resolveAdvanceTargetStage`
   * uses it BEFORE falling back to the "next non-terminal Stage by order"
   * default.
   *
   * **Resolution priority** (preserves backcompat):
   *   1. Brain's explicit `targetStageId` (if provided AND valid order)
   *   2. NEW: `mapEntry.stageId` (if provided AND exists in Pipeline) — bypasses
   *      the `order > current.order` constraint so mappings can point to
   *      terminal stages OR earlier stages without artificial blocks
   *   3. Default: next non-terminal Stage by order (existing behavior)
   *
   * Optional. Existing callers (cron, operator paths, pre-Cluster-III paths)
   * pass nothing → existing resolution preserved → zero regression.
   *
   * **Outcome-type tolerance**: PR II accepts mapping resolution to any Stage
   * in the Pipeline regardless of `outcomeType` (Phase 1.5 audit empirical
   * finding — 28 of 32 distinct PROD Stage names are `outcomeType='open'`;
   * many pipelines lack terminal markers; mappings to "Closed (open)" stages
   * are legitimate operator semantics).
   */
  mapEntry?: { stageId: string };
}

export class StageTransitionDealNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageTransitionDealNotFoundError';
  }
}

// ─────────────────────────────────────────────
// Internal — loaded Deal shape
// ─────────────────────────────────────────────

interface LoadedStage {
  id: string;
  name: string;
  order: number;
  outcomeType: 'open' | 'terminal_won' | 'terminal_lost';
}

interface LoadedDeal {
  id: string;
  tenantId: string;
  // KAN-963 (slice 2a PR B) — needed for the CustomerLifecycleEvent writer
  // hook on terminal_won (upsert Customer + log eventType='created').
  contactId: string;
  pipelineId: string;
  currentStageId: string;
  currentStage: LoadedStage;
  pipeline: { id: string; stages: LoadedStage[] };
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Evaluate whether a Deal should transition to a different Stage based on
 * a Brain Service decision.
 *
 * Throws StageTransitionDealNotFoundError when dealId doesn't exist (or
 * BrainServiceNotFoundError if the Deal load succeeds but Brain Service
 * fails to find it — should not happen but propagated upward).
 *
 * Writes (when type='transitioned'): one Deal.update + one
 * DealStageHistory.create, both inside a single prisma.$transaction.
 */
export async function evaluateStageTransition(
  prisma: PrismaClient,
  dealId: string,
  options: EvaluateTransitionOptions = {},
): Promise<StageTransitionResult> {
  // 1. Load Deal + currentStage + pipeline.stages (need stages for target
  //    resolution + terminal_lost lookup).
  const dealRaw = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      currentStage: { select: { id: true, name: true, order: true, outcomeType: true } },
      pipeline: {
        select: {
          id: true,
          stages: {
            orderBy: { order: 'asc' },
            select: { id: true, name: true, order: true, outcomeType: true },
          },
        },
      },
    },
  });

  if (!dealRaw) {
    throw new StageTransitionDealNotFoundError(`Deal not found: ${dealId}`);
  }

  const deal: LoadedDeal = {
    id: dealRaw.id,
    tenantId: dealRaw.tenantId,
    contactId: dealRaw.contactId,
    pipelineId: dealRaw.pipelineId,
    currentStageId: dealRaw.currentStageId,
    currentStage: {
      id: dealRaw.currentStage.id,
      name: dealRaw.currentStage.name,
      order: dealRaw.currentStage.order,
      outcomeType: dealRaw.currentStage.outcomeType as LoadedStage['outcomeType'],
    },
    pipeline: {
      id: dealRaw.pipeline.id,
      stages: dealRaw.pipeline.stages.map((s) => ({
        id: s.id,
        name: s.name,
        order: s.order,
        outcomeType: s.outcomeType as LoadedStage['outcomeType'],
      })),
    },
  };

  // ── Short-circuit: already terminal. No transitions out of terminal Stages.
  // Runs BEFORE Brain regardless of whether a pre-computed decision is
  // supplied — closure-state safety is structural, not Brain-judged.
  if (deal.currentStage.outcomeType !== 'open') {
    return {
      type: 'skipped',
      dealId,
      reason: 'already_terminal',
    };
  }

  // 2. Brain decision: KAN-834 — use the dispatcher's pre-computed decision
  //    when supplied; otherwise fall back to the internal call (backwards-
  //    compat for cron / operator callers that don't have a prior decision).
  //    Single-source-of-truth eliminates the LLM-non-determinism class
  //    bug surfaced 2026-05-05 (dispatcher → advance_stage; engine →
  //    send_follow_up; chain silently skipped on no_transition).
  const brainDecision =
    options.brainDecision ??
    (await evaluateDealState(prisma, dealId, { tier: options.tier }));

  // 3. Confidence gate.
  const minConfidence = options.minConfidenceForTransition ?? 0.5;
  if (brainDecision.confidence < minConfidence) {
    return {
      type: 'no_transition',
      dealId,
      reason: `Brain confidence ${brainDecision.confidence.toFixed(2)} below threshold ${minConfidence}`,
      brainDecision,
    };
  }

  // 4. Action dispatch.
  const action = brainDecision.nextBestAction;

  if (action.type === 'advance_stage') {
    const targetStage = resolveAdvanceTargetStage(deal, action.targetStageId, options.mapEntry);
    if (!targetStage) {
      return {
        type: 'skipped',
        dealId,
        reason: 'no_target_resolved',
        brainDecision,
      };
    }
    return writeTransition(prisma, deal, targetStage, brainDecision, options);
  }

  if (action.type === 'close_deal_lost') {
    const terminalLostStage = deal.pipeline.stages.find((s) => s.outcomeType === 'terminal_lost');
    if (!terminalLostStage) {
      console.warn(
        `[stage-transition-engine] no_terminal_lost_stage_in_pipeline dealId=${dealId} pipelineId=${deal.pipelineId} — close_deal_lost action cannot land`,
      );
      return {
        type: 'skipped',
        dealId,
        reason: 'no_terminal_lost_stage_in_pipeline',
        brainDecision,
      };
    }
    return writeTransition(prisma, deal, terminalLostStage, brainDecision, options);
  }

  // send_follow_up / wait_for_response / escalate_to_human / no_action: no transition.
  return {
    type: 'no_transition',
    dealId,
    reason: `Brain decision type=${action.type} does not require a Stage transition`,
    brainDecision,
  };
}

// ─────────────────────────────────────────────
// Target Stage resolution
// ─────────────────────────────────────────────

/**
 * Resolve the target Stage for an `advance_stage` Brain decision.
 *
 * Order of preference:
 *   1. If Brain provided a specific `targetStageId` AND it's a valid
 *      advance (Stage in same Pipeline + outcomeType=open + order > current
 *      OR a terminal Stage at greater order — Brain may explicitly target
 *      a terminal Stage to signal closure on the advance path), return it.
 *   2. KAN-1081 (Cluster III PR II) — if `mapEntry.stageId` provided AND
 *      exists in Pipeline, use it. **Bypasses the `order > current.order`
 *      constraint** so mappings can point to terminal stages OR earlier
 *      stages without artificial blocks. Outcome-type tolerance per Phase
 *      1.5 audit: many PROD pipelines lack terminal markers; mappings
 *      to "Closed (outcomeType='open')" stages are legitimate operator
 *      semantics.
 *   3. Otherwise, return the next non-terminal Stage by order (the "natural
 *      next step" in the Pipeline).
 *   4. If no candidate exists (current Stage is the last non-terminal one),
 *      return null → caller emits skipped/no_target_resolved.
 *
 * Exported for test introspection.
 */
export function resolveAdvanceTargetStage(
  deal: LoadedDeal,
  explicitTargetStageId?: string,
  mapEntry?: { stageId: string },
): LoadedStage | null {
  if (explicitTargetStageId) {
    const target = deal.pipeline.stages.find((s) => s.id === explicitTargetStageId);
    // Valid: in same Pipeline + greater order (covers both open advance + explicit terminal target).
    if (target && target.order > deal.currentStage.order) {
      return target;
    }
    // Invalid explicit target → fall through to mapEntry → default-by-order.
  }

  // KAN-1081 — mapping consult (KAN-1080 resolver output). Bypasses order
  // constraint per outcome-type tolerance.
  if (mapEntry?.stageId) {
    const mapped = deal.pipeline.stages.find((s) => s.id === mapEntry.stageId);
    if (mapped) {
      return mapped;
    }
    // Invalid mapEntry (stageId not in Pipeline) → fall through to default-by-order.
  }

  // Default: next open Stage by order.
  const candidates = deal.pipeline.stages.filter(
    (s) => s.order > deal.currentStage.order && s.outcomeType === 'open',
  );
  return candidates.length > 0 ? candidates[0] : null;
}

// ─────────────────────────────────────────────
// Transition write (single tx — Deal.update + DealStageHistory.create)
// ─────────────────────────────────────────────

async function writeTransition(
  prisma: PrismaClient,
  deal: LoadedDeal,
  targetStage: LoadedStage,
  brainDecision: BrainDecision,
  options: EvaluateTransitionOptions,
): Promise<StageTransitionResult> {
  const triggeredBy = options.triggeredBy ?? 'agent';
  const transitionedAt = new Date();

  const result = await prisma.$transaction(async (tx) => {
    // Deal.closedAt was dropped in KAN-791 pivot. Closure is signaled by
    // Deal.currentStageId pointing at a Stage with outcomeType IN
    // (terminal_won, terminal_lost). To query "when did this Deal close?",
    // read DealStageHistory.transitionedAt for the transition INTO the
    // terminal Stage. No separate timestamp column to drift.
    await tx.deal.update({
      where: { id: deal.id },
      data: {
        currentStageId: targetStage.id,
        enteredStageAt: transitionedAt,
      },
    });

    const historyRow = await tx.dealStageHistory.create({
      data: {
        dealId: deal.id,
        fromStageId: deal.currentStageId,
        toStageId: targetStage.id,
        triggeredBy,
        // decisionId left null in KAN-796a MVP — KAN-796b can wire if Phase 2
        // introduces persistent Decision rows for Brain evaluations.
        metadata: {
          brainConfidence: brainDecision.confidence,
          brainReasoning: brainDecision.nextBestAction.reasoning,
          brainModelTier: brainDecision.modelTier,
          brainEvaluatedAt: brainDecision.evaluatedAt.toISOString(),
          fromStageName: deal.currentStage.name,
          toStageName: targetStage.name,
          targetStageOutcomeType: targetStage.outcomeType,
        },
      },
      select: { id: true },
    });

    return {
      type: 'transitioned' as const,
      dealId: deal.id,
      fromStageId: deal.currentStageId,
      toStageId: targetStage.id,
      // KAN-825 — surface human-readable stage names for chained Brain
      // prompts (avoids the caller re-querying Stage rows).
      fromStageName: deal.currentStage.name,
      toStageName: targetStage.name,
      brainDecision,
      transitionRowId: historyRow.id,
    };
  });

  // ─────────────────────────────────────────────────────────────────────
  // KAN-963 (slice 2a PR B) — CustomerLifecycleEvent post-commit writer.
  //
  // DECOUPLED from the stage-transition transaction (Fred's PR B review
  // gate, 2026-05-21). The audit-recording layer must NEVER block a
  // legitimate deal-won event from persisting. If the Customer upsert
  // or CustomerLifecycleEvent insert fails (FK violation, transient DB
  // issue, schema drift, anything), the stage transition is already
  // committed; the lifecycle write is best-effort + WARN-logged.
  //
  // Trade-off accepted: lifecycle audit can be missing a row on the
  // rare failure path (preferable to a Deal stuck mid-transition). The
  // gap is detectable via downstream counts; slice-2b's daily scheduled
  // discovery can identify Deals at terminal_won without a corresponding
  // CustomerLifecycleEvent and surface them for backfill if/when needed.
  //
  // Phase-1 Q3 Option β: append-only recording. No status-automation,
  // no standards engine. Just log what naturally happens — best-effort.
  // ─────────────────────────────────────────────────────────────────────

  if (result.type === 'transitioned' && targetStage.outcomeType === 'terminal_won') {
    void recordCustomerLifecycleOnWin(prisma, deal, targetStage, brainDecision, result);
  }

  return result;
}

/**
 * KAN-963 — best-effort Customer + CustomerLifecycleEvent writer. Runs
 * POST-commit; failures never roll back the stage transition. Awaited
 * by caller only via `void` (fire-and-forget) so the response path
 * doesn't block on the audit write either.
 *
 * Note: although failures don't roll back, we DO await internally so the
 * upsert's customer.id is available for the CustomerLifecycleEvent row's
 * customerId FK. If the upsert succeeds + the event fails, the Customer
 * row stays in place — that's the right shape (Customer is the canonical
 * state; the event is the audit trail).
 */
async function recordCustomerLifecycleOnWin(
  prisma: PrismaClient,
  deal: LoadedDeal,
  targetStage: LoadedStage,
  brainDecision: BrainDecision,
  transition: Extract<StageTransitionResult, { type: 'transitioned' }>,
): Promise<void> {
  try {
    const customer = await prisma.customer.upsert({
      where: { contactId: deal.contactId },
      create: {
        tenantId: deal.tenantId,
        contactId: deal.contactId,
        status: 'active',
        since: new Date(),
      },
      update: {
        // Existing Customer (prior win or sync): bump status back to
        // active if previously churned. No-op if already active.
        status: 'active',
      },
      select: { id: true, status: true },
    });

    await prisma.customerLifecycleEvent.create({
      data: {
        tenantId: deal.tenantId,
        contactId: deal.contactId,
        customerId: customer.id,
        eventType: 'created',
        toStatus: 'active',
        source: 'deal_won',
        metadata: {
          dealId: deal.id,
          dealStageHistoryId: transition.transitionRowId,
          fromStageName: deal.currentStage.name,
          toStageName: targetStage.name,
          brainEvaluatedAt: brainDecision.evaluatedAt.toISOString(),
        },
      },
    });
  } catch (err) {
    console.warn(
      `[stage-transition-engine] kan-963 customer-lifecycle-write-failed-post-commit dealId=${deal.id} contactId=${deal.contactId} err=${(err as Error)?.message ?? String(err)}`,
    );
    // Intentionally swallowed: the stage transition is committed; audit
    // gap is acceptable per the decoupling decision (Fred PR B review).
  }
}
