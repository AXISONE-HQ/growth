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
  if (deal.currentStage.outcomeType !== 'open') {
    return {
      type: 'skipped',
      dealId,
      reason: 'already_terminal',
    };
  }

  // 2. Call Brain Service.
  const brainDecision = await evaluateDealState(prisma, dealId, { tier: options.tier });

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
    const targetStage = resolveAdvanceTargetStage(deal, action.targetStageId);
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
 *   2. Otherwise, return the next non-terminal Stage by order (the "natural
 *      next step" in the Pipeline).
 *   3. If no candidate exists (current Stage is the last non-terminal one),
 *      return null → caller emits skipped/no_target_resolved.
 *
 * Exported for test introspection.
 */
export function resolveAdvanceTargetStage(
  deal: LoadedDeal,
  explicitTargetStageId?: string,
): LoadedStage | null {
  if (explicitTargetStageId) {
    const target = deal.pipeline.stages.find((s) => s.id === explicitTargetStageId);
    // Valid: in same Pipeline + greater order (covers both open advance + explicit terminal target).
    if (target && target.order > deal.currentStage.order) {
      return target;
    }
    // Invalid explicit target → fall through to default-by-order.
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

  return prisma.$transaction(async (tx) => {
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
}
