/**
 * KAN-1190 — Commit multi-Pipeline (Campaign Module Reset PR 9).
 *
 * Sibling to the legacy KAN-1001 `commitCampaign()` at campaign-commit.ts.
 * The two services exist side-by-side because their input shapes diverge
 * fundamentally:
 *
 *   commitCampaign      ← legacy CampaignProposal (Slice 2 propose-preview)
 *                         single Pipeline + audience snapshot materialization
 *   commitActionPlan    ← KAN-1185 ActionPlan (multi-pipeline Action Plan)
 *                         N Pipelines × M Stages from per-Pipeline shape
 *
 * Re-wiring legacy to consume ActionPlan would erase load-bearing audience-
 * snapshot semantics; sibling preserves both code paths until KAN-1001's
 * propose-preview consumers (none in active surfaces post-KAN-1183) retire.
 *
 * # What this does
 *
 *   1. Read Campaign (verify exists + capture proposedPlan + updatedAt).
 *   2. Idempotency check (J8): status==='committed' returns already_committed
 *      with persisted Pipeline IDs read back from Campaign.committedPlan.
 *   3. Optimistic concurrency check (J11): if caller passed
 *      expectedUpdatedAt and it differs from Campaign.updatedAt, return
 *      concurrent_edit_conflict (matches refiner NEW-B variant shape).
 *   4. Re-validate ActionPlanSchema.parse (J3 defense-in-depth) — plan was
 *      validated at refine time, but column drift / manual psql edits /
 *      bad migrations could land malformed JSON.
 *   5. Re-validate STRATEGY_STAGE_BOUNDS per pipeline (J3) — same rationale.
 *   6. Single prisma.$transaction (J2):
 *      a. Campaign.update: status='draft' → 'committed' + committedPlan
 *         snapshot + activatedAt=now (mirrors KAN-1001 commit semantics).
 *      b. N tx.pipeline.create() — one per ActionPlanPipeline.
 *      c. Stages nested under each pipeline via Prisma's create.stages.create.
 *   7. Best-effort audit row (J7) — actionType='campaign.action_plan_committed'
 *      distinct from legacy 'campaign.commit'. Dual-audit-type discipline.
 *
 * # What this DOES NOT do (INERT — J4 + J6 locks)
 *
 *   - status flips to 'committed' NOT 'active' (J4 — preserves KAN-1001
 *     INERT-post-commit doctrine; 'active' reserved for engine-active state)
 *   - NO CampaignMembership writes — Action Plan commit is structural;
 *     audience snapshot is the legacy commit's concern
 *   - NO Action / Decision row writes for first-actions (J6) — declarative
 *     plan only. First-actions enqueue execution substrate lands in
 *     KAN-1199 follow-up (V1 lock).
 *   - NO ContactObjectiveStack writes
 *   - NO Pipeline.objectiveId set (V3 lock — Pipelines under the ActionPlan
 *     are NOT bound to an Objective row; Campaign owns goal semantics now)
 *
 * # Pipeline.objectiveType (legacy column still required)
 *
 * The Pipeline schema enforces objectiveType non-null (legacy enum). Until
 * the column retires, we derive a strategy-based default per V3 lock:
 *   direct      → book_appointment
 *   re_engage   → warm_up_lead
 *   trust_build → warm_up_lead
 *   guided      → warm_up_lead
 * Same fallback shape as legacy commitCampaign's derivePipelineObjectiveType
 * when Objective.type doesn't match enum verbatim. Forward-safe since
 * engine routing reads Campaign.id, not Pipeline.objectiveType.
 *
 * # Fail-safe
 *
 * Mirrors action-plan-refiner pattern: any DB transient returns
 * analyzer_unavailable. NEVER throws to caller.
 */
import {
  ActionPlanSchema,
  STRATEGY_STAGE_BOUNDS,
  type ActionPlan,
  type ActionPlanPipeline,
  type CampaignStrategy,
  type CommitActionPlanResult,
  type CommittedPlanSnapshot,
} from "@growth/shared";

// ─────────────────────────────────────────────
// Public params
// ─────────────────────────────────────────────

export interface CommitActionPlanParams {
  campaignId: string;
  tenantId: string;
  /** Optimistic concurrency token — Campaign.updatedAt at request time
   *  (J11 lock). Caller passes this; commit verifies before write. */
  expectedUpdatedAt?: string;
  /** Acting user — written to audit_log.actor. Optional for system-
   *  initiated commits (none in PR 9, reserved for future surfaces). */
  userId?: string;
  /** Default new Date(). Tests inject for deterministic timestamps. */
  todayUtc?: Date;
}

// ─────────────────────────────────────────────
// Loose Prisma surface (matches refiner/generator pattern)
// ─────────────────────────────────────────────

export interface CommitActionPlanPrisma {
  $transaction: <T>(fn: (tx: CommitActionPlanTx) => Promise<T>) => Promise<T>;
  campaign: {
    findFirst: (args: unknown) => Promise<unknown>;
  };
  auditLog: {
    create: (args: unknown) => Promise<unknown>;
  };
}

export interface CommitActionPlanTx {
  campaign: {
    update: (args: unknown) => Promise<unknown>;
  };
  pipeline: {
    create: (args: unknown) => Promise<{
      id: string;
      stages: Array<{ id: string; order: number }>;
    }>;
  };
}

// ─────────────────────────────────────────────
// Pipeline.objectiveType strategy-default (V3 lock)
// ─────────────────────────────────────────────

type PipelineObjectiveTypeValue =
  | "warm_up_lead"
  | "book_appointment"
  | "buy_online"
  | "send_quote";

function pipelineObjectiveTypeFromStrategy(
  strategy: CampaignStrategy,
): PipelineObjectiveTypeValue {
  switch (strategy) {
    case "direct":
      return "book_appointment";
    case "re_engage":
      return "warm_up_lead";
    case "trust_build":
      return "warm_up_lead";
    case "guided":
      return "warm_up_lead";
  }
}

// ─────────────────────────────────────────────
// Bounds re-check (J3 defense-in-depth)
// ─────────────────────────────────────────────

function checkBounds(
  plan: ActionPlan,
):
  | { kind: "ok" }
  | {
      kind: "bounds_violation";
      strategy: CampaignStrategy;
      attemptedStageCount: number;
    } {
  for (const p of plan.pipelines) {
    const bounds = STRATEGY_STAGE_BOUNDS[p.strategy];
    if (
      p.proposedStages.length < bounds.minStages ||
      p.proposedStages.length > bounds.maxStages
    ) {
      return {
        kind: "bounds_violation",
        strategy: p.strategy,
        attemptedStageCount: p.proposedStages.length,
      };
    }
  }
  return { kind: "ok" };
}

// ─────────────────────────────────────────────
// Audit emission (best-effort post-tx)
// ─────────────────────────────────────────────

async function emitCommitAudit(
  prisma: CommitActionPlanPrisma,
  params: {
    tenantId: string;
    campaignId: string;
    actor: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: params.tenantId,
        actor: params.actor,
        // J7 lock — distinct actionType from legacy 'campaign.commit'.
        // Dual-audit-type discipline: never collapse the two commit surfaces
        // into one row type; queryability of "which commit path materialized
        // this Campaign" matters for retrospective debugging.
        actionType: "campaign.action_plan_committed",
        payload: params.payload,
      },
    });
  } catch (err) {
    console.warn(
      `[commit-action-plan] audit-emit-failed campaignId=${params.campaignId}:`,
      (err as Error)?.message ?? String(err),
    );
  }
}

// ─────────────────────────────────────────────
// Public API — commitActionPlan
// ─────────────────────────────────────────────

function analyzerUnavailable(campaignId: string): CommitActionPlanResult {
  return {
    kind: "analyzer_unavailable",
    message:
      "We couldn't commit this Action Plan right now. Please try again in a moment.",
    campaignId,
  };
}

export async function commitActionPlan(
  prisma: CommitActionPlanPrisma,
  params: CommitActionPlanParams,
): Promise<CommitActionPlanResult> {
  const todayUtc = params.todayUtc ?? new Date();

  // Read Campaign + verify existence + capture current state.
  let campaign: Record<string, unknown> | null = null;
  try {
    campaign = (await prisma.campaign.findFirst({
      where: { id: params.campaignId, tenantId: params.tenantId },
      select: {
        id: true,
        name: true,
        status: true,
        proposedPlan: true,
        committedPlan: true,
        updatedAt: true,
      },
    })) as Record<string, unknown> | null;
  } catch (err) {
    console.error(
      `[commit-action-plan] campaign-read-failed campaignId=${params.campaignId}:`,
      err,
    );
    return analyzerUnavailable(params.campaignId);
  }

  if (!campaign) return analyzerUnavailable(params.campaignId);

  // J8 — idempotent re-commit. Read back committedPlan snapshot to return
  // the same Pipeline IDs the original commit minted. Double-click protection
  // + retry semantics + UI re-mount safety all converge on this branch.
  if (campaign.status === "committed" && campaign.committedPlan) {
    const snapshot = campaign.committedPlan as CommittedPlanSnapshot;
    return {
      kind: "already_committed",
      campaignId: params.campaignId,
      pipelineIds: snapshot.pipelineIds,
      committedPlan: snapshot,
    };
  }

  // No proposed plan → cannot commit. Surface as analyzer_unavailable since
  // the UI shouldn't have rendered Commit without a plan; this is a defensive
  // backstop, not an operator-visible flow.
  if (!campaign.proposedPlan) return analyzerUnavailable(params.campaignId);

  // J3 — defense-in-depth re-parse. Plan was validated at refine time but
  // column drift / manual SQL / migration bugs could leave malformed JSON.
  let plan: ActionPlan;
  try {
    plan = ActionPlanSchema.parse(campaign.proposedPlan);
  } catch (err) {
    console.warn(
      `[commit-action-plan] schema-parse-failed campaignId=${params.campaignId}:`,
      (err as Error)?.message ?? String(err),
    );
    return analyzerUnavailable(params.campaignId);
  }

  // J11 — optimistic concurrency check (matches refiner NEW-B shape).
  const currentUpdatedAtIso =
    campaign.updatedAt instanceof Date
      ? campaign.updatedAt.toISOString()
      : typeof campaign.updatedAt === "string"
        ? campaign.updatedAt
        : null;
  if (
    params.expectedUpdatedAt &&
    currentUpdatedAtIso &&
    params.expectedUpdatedAt !== currentUpdatedAtIso
  ) {
    return {
      kind: "concurrent_edit_conflict",
      message:
        "Another edit landed on this Campaign while you were committing. Review the current plan and re-confirm.",
      campaignId: params.campaignId,
      currentPlan: plan,
    };
  }

  // J3 — STRATEGY_STAGE_BOUNDS re-check at commit time. Refiner enforced
  // this on every edit, but the proposedPlan column on disk is the source
  // of truth; bound-violating writes from any other code path would fail
  // here before mutating Campaign.
  const boundsCheck = checkBounds(plan);
  if (boundsCheck.kind === "bounds_violation") {
    return {
      kind: "bounds_violation",
      message: `Commit rejected — ${boundsCheck.strategy} strategy requires ${STRATEGY_STAGE_BOUNDS[boundsCheck.strategy].minStages}-${STRATEGY_STAGE_BOUNDS[boundsCheck.strategy].maxStages} stages; pipeline has ${boundsCheck.attemptedStageCount}.`,
      campaignId: params.campaignId,
      strategy: boundsCheck.strategy,
      attemptedStageCount: boundsCheck.attemptedStageCount,
    };
  }

  const campaignName = (campaign.name as string) ?? "Campaign";

  // J2 — single transaction wrapping Campaign.update + N Pipeline.create.
  // Stages nested per Pipeline via Prisma's create.stages.create relation.
  // Audit row written best-effort POST-tx so a logging hiccup never rolls
  // back a successful commit (mirrors refiner emitAudit posture).
  let txResult: {
    pipelineIds: string[];
    stageIds: string[][];
    committedPlan: CommittedPlanSnapshot;
  };
  try {
    txResult = await prisma.$transaction(async (tx) => {
      const createdPipelines: Array<{
        id: string;
        stages: Array<{ id: string; order: number }>;
      }> = [];

      for (const p of plan.pipelines) {
        const pipelineRow = await tx.pipeline.create({
          data: {
            tenantId: params.tenantId,
            name: p.name,
            description: `Pipeline owned by Campaign ${params.campaignId}`,
            isActive: true,
            // V3 lock — objectiveId NULL; Pipeline strategy-defaulted only
            // for the legacy required column. Engine routing reads
            // Campaign.id post-KAN-1190.
            objectiveType: pipelineObjectiveTypeFromStrategy(p.strategy),
            objectiveDescription: p.name,
            objectiveId: null,
            campaignId: params.campaignId,
            // J5 — per-Pipeline strategy from ActionPlanPipeline.strategy
            // (preserves the LLM-selected strategy at generation time;
            // Campaign.strategy may have been set at refine time but the
            // per-Pipeline shape is authoritative for Action Plan commits).
            strategy: p.strategy,
            // V3 — segment captured for cohort routing; objectiveId stays NULL.
            segment: p.segment,
            // Projected contribution snapshot for retrospective gap reports.
            projectedContribution: p.projectedContribution,
            stages: {
              create: p.proposedStages.map((s, idx) => ({
                name: s.name,
                order: s.order,
                isInitial: idx === 0,
                isTerminal: false,
                outcomeType: "open" as const,
              })),
            },
          },
          include: { stages: true },
        });
        createdPipelines.push({
          id: pipelineRow.id,
          stages: pipelineRow.stages,
        });
      }

      const pipelineIds = createdPipelines.map((p) => p.id);
      const stageIds = createdPipelines.map((p) =>
        p.stages.sort((a, b) => a.order - b.order).map((s) => s.id),
      );

      const committedPlan: CommittedPlanSnapshot = {
        campaignName,
        committedAt: todayUtc.toISOString(),
        plan,
        pipelineIds,
      };

      // J4 — flip status to 'committed' NOT 'active'. Preserves KAN-1001
      // INERT-post-commit doctrine: a committed Campaign is observable but
      // no autonomous consumer evaluates it. 'active' reserved for the
      // engine-active state set by a separate activation transition.
      await tx.campaign.update({
        where: { id: params.campaignId },
        data: {
          status: "committed",
          activatedAt: todayUtc,
          committedPlan: committedPlan as unknown as object,
        },
      });

      return { pipelineIds, stageIds, committedPlan };
    });
  } catch (err) {
    console.error(
      `[commit-action-plan] tx-failed campaignId=${params.campaignId}:`,
      err,
    );
    return analyzerUnavailable(params.campaignId);
  }

  // J7 — dual-audit-type discipline. Best-effort post-tx; logging failure
  // never rolls back a successful commit.
  await emitCommitAudit(prisma, {
    tenantId: params.tenantId,
    campaignId: params.campaignId,
    actor: params.userId ?? "system:commit-action-plan",
    payload: {
      campaignId: params.campaignId,
      pipelineIds: txResult.pipelineIds,
      stageIds: txResult.stageIds,
      pipelineCount: plan.pipelines.length,
      committedAt: txResult.committedPlan.committedAt,
      plan,
    },
  });

  return {
    kind: "committed",
    campaignId: params.campaignId,
    pipelineIds: txResult.pipelineIds,
    stageIds: txResult.stageIds,
    committedPlan: txResult.committedPlan,
  };
}
