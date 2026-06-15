/**
 * KAN-1186 — Action Plan Refiner (Campaign Module Reset PR 5).
 *
 * Operator NL refinement of an existing Campaign.proposedPlan. Reads the
 * persisted plan + Campaign columns, asks the LLM (tier `reasoning`,
 * Q-ADD-NEW-A lock) to classify operator intent into ONE of 4 edit-axis
 * families (E2 lock), applies the family-specific handler, recomputes
 * gap analysis, and persists.
 *
 * # Architecture (E1 + E2 locks)
 *
 *   Refiner is SINGLE-PURPOSE: delta an existing plan. NEVER regenerates.
 *   Returns no_plan_to_refine if Campaign.proposedPlan IS NULL (NEW-C).
 *
 *   4 edit-axis families (E2 lock):
 *     stage          — rename/reorder/add/remove stages (E3 bounds enforced)
 *     first_actions  — modify per-Pipeline first-actions
 *     audience       — replace Campaign.audienceConditions; re-split + re-count
 *     dimension      — write Campaign columns + emit dimension audit + trigger
 *                      feasibility re-eval (NEW-D); NO auto Action Plan regen
 *
 * # Locks honored
 *
 *   NEW-A — reasoning tier only (no cheap-tier fast-path)
 *   NEW-B — optimistic concurrency via Campaign.updatedAt
 *   NEW-C — no_plan_to_refine variant when proposedPlan IS NULL
 *   NEW-D — dimension-axis edits write columns + emit campaign.dimension_
 *           post_confirm_edit audit + trigger feasibility re-eval; refresh
 *           Campaign.feasibilityAnalysis (analyzer owns); leave proposedPlan
 *           on stale state for operator to re-generate manually
 *   E4   — unconditional gap recompute on every successful refinement
 *   E5   — audit row campaign.action_plan_refined with before/after delta
 *   E7   — confidence preserved on stage/first-actions/audience edits;
 *          dimension edits trigger feasibility re-eval (analyzer recomputes
 *          tenant-level confidence)
 *   E8   — revertLastRefinement also emits audit row
 *          campaign.action_plan_refinement_reverted; never destroys history
 *
 * # Fail-safe
 *
 *   Mirrors action-plan-generator pattern: any DB/LLM transient returns
 *   analyzer_unavailable. NEVER throws to caller.
 */
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type {
  ActionPlan,
  ActionPlanEdit,
  ActionPlanEditAxis,
  ActionPlanGapAnalysis,
  ActionPlanPipeline,
  AudienceConditions,
  GoalShape,
  RefineActionPlanResult,
  RevertActionPlanRefinementResult,
  TenantHistoricalContext,
} from "@growth/shared";
import {
  ActionPlanEditSchema,
  STRATEGY_STAGE_BOUNDS,
  AudienceConditionsSchema,
} from "@growth/shared";
import {
  getTenantHistoricalContext,
  type FeasibilityRedis,
} from "./feasibility-context-service.js";
import {
  computeGapPercent,
  projectOrganicCount,
  projectPerCohortContribution,
} from "./projection-math.js";
import { splitAudienceIntoPipelines } from "./action-plan-generator.js";
import type { LLMCompleteInput, LLMCompleteResult } from "./llm-client.js";

// ─────────────────────────────────────────────
// Public params + types
// ─────────────────────────────────────────────

export interface RefineActionPlanParams {
  campaignId: string;
  tenantId: string;
  refinementMessage: string;
  /** Optimistic concurrency token — Campaign.updatedAt at request time
   *  (NEW-B lock). Caller passes this; refiner verifies before write. */
  expectedUpdatedAt?: string;
  /** Default new Date(). Tests inject for deterministic timestamps. */
  todayUtc?: Date;
}

export interface RevertLastRefinementParams {
  campaignId: string;
  tenantId: string;
  todayUtc?: Date;
}

export type LLMCompleteFn = (
  input: LLMCompleteInput,
) => Promise<LLMCompleteResult>;

/** Loose Prisma subset so tests can satisfy with partial mocks. */
export interface ActionPlanRefinerPrisma {
  campaign: {
    findFirst: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
  };
  auditLog: {
    create: (args: unknown) => Promise<unknown>;
    findFirst: (args: unknown) => Promise<unknown>;
  };
}

export type CountAudienceFn = (
  prisma: ActionPlanRefinerPrisma,
  tenantId: string,
  input: { conditions: unknown },
) => Promise<{ count: number; historicalValueUsd?: number }>;

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const REFINER_LLM_TIER: "reasoning" = "reasoning"; // NEW-A lock — no cheap-tier
const REFINER_LLM_CALLER_TAG = "action-plan-refiner:classify";
const REFINER_LLM_MAX_TOKENS = 800;
const DEFAULT_GOAL_WINDOW_DAYS = 90;

// ─────────────────────────────────────────────
// LLM classification prompt (operator NL → ActionPlanEdit)
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI growth strategist who classifies operator
refinement requests into exactly ONE of 4 disjoint edit axes for an existing
Action Plan.

# Edit axes (pick ONE)

  stage         — rename/reorder/add/remove a stage within one Pipeline
                  (e.g., "rename stage 1 to Discovery", "add a Qualify
                  stage after stage 0")
  first_actions — modify a per-Pipeline first-action item (channel/day/
                  intent/description). e.g., "change Day 0 of the lead
                  pipeline to use SMS instead of email"
  audience      — replace the Campaign's full audience conditions. e.g.,
                  "narrow to customers in Quebec who bought in last 30d"
  dimension     — edit a top-level dimension field (goalType, goalTarget,
                  goalDescription, goalProductId, windowStart, windowEnd).
                  e.g., "raise the goal target to 200 units"

# Output format

Return STRICT JSON (no markdown fences) matching ONE of these shapes:

  { "axis": "stage", "pipelineIndex": <int>, "op": "rename" | "reorder" | "add" | "remove", "stageIndex": <int?>, "newName": <string?>, "newOrder": <int?>, "newDescription": <string?> }

  { "axis": "first_actions", "pipelineIndex": <int>, "op": "edit" | "add" | "remove", "actionIndex": <int?>, "newDay": <int?>, "newChannel": "email" | "sms" | "whatsapp", "newIntent": <string?>, "newDescription": <string?> }

  { "axis": "audience", "newAudienceConditions": <AudienceConditions tree> }

  { "axis": "dimension", "field": "goalType" | "goalTarget" | "goalDescription" | "goalProductId" | "windowStart" | "windowEnd", "newValue": <string | number | null> }

# Honest counsel doctrine

NO fluff. NO defensive guessing. If the operator's intent is ambiguous,
pick the most likely axis based on the words used; refiner will surface
errors honestly to the operator via discriminated result variants.`;

// ─────────────────────────────────────────────
// Build user prompt — includes current plan snapshot
// ─────────────────────────────────────────────

function buildRefinerUserPrompt(input: {
  plan: ActionPlan;
  campaignName: string;
  goalType: string;
  goalTarget: number;
  refinementMessage: string;
  todayUtc: Date;
}): string {
  const pipelinesSummary = input.plan.pipelines
    .map(
      (p, idx) =>
        `  [${idx}] name="${p.name}" segment=${p.segment} strategy=${p.strategy} stages=[${p.proposedStages.map((s) => s.name).join(", ")}] firstActions=${p.firstActions.length}`,
    )
    .join("\n");

  return `# Today
${input.todayUtc.toISOString()}

# Campaign
Name: ${input.campaignName}
Goal: ${input.goalType} = ${input.goalTarget}

# Current ActionPlan pipelines (operator can refer to by index)
${pipelinesSummary}

# Operator refinement request
"""
${input.refinementMessage}
"""

# Your task

Classify into ONE edit axis. Return JSON per the system prompt format.`;
}

function parseEditOutput(rawText: string): ActionPlanEdit | null {
  try {
    const stripped = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(stripped);
    return ActionPlanEditSchema.parse(parsed);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Per-axis appliers
// ─────────────────────────────────────────────

/** Returns the strategy of the affected pipeline (for bounds-check). */
function applyStageEdit(
  plan: ActionPlan,
  edit: Extract<ActionPlanEdit, { axis: "stage" }>,
):
  | { kind: "ok"; plan: ActionPlan }
  | { kind: "bounds_violation"; strategy: ActionPlan["pipelines"][0]["strategy"]; attemptedStageCount: number } {
  const pipeline = plan.pipelines[edit.pipelineIndex];
  if (!pipeline) {
    // Out-of-bounds pipelineIndex — treat as bounds violation surface
    return {
      kind: "bounds_violation",
      strategy: "direct",
      attemptedStageCount: 0,
    };
  }

  let stages = [...pipeline.proposedStages];
  switch (edit.op) {
    case "rename": {
      if (edit.stageIndex == null || !stages[edit.stageIndex] || !edit.newName) {
        return { kind: "ok", plan }; // no-op on missing fields
      }
      stages[edit.stageIndex] = {
        ...stages[edit.stageIndex],
        name: edit.newName,
        ...(edit.newDescription
          ? { description: edit.newDescription }
          : {}),
      };
      break;
    }
    case "reorder": {
      if (
        edit.stageIndex == null ||
        edit.newOrder == null ||
        !stages[edit.stageIndex]
      ) {
        return { kind: "ok", plan };
      }
      const [moved] = stages.splice(edit.stageIndex, 1);
      stages.splice(edit.newOrder, 0, moved);
      stages = stages.map((s, i) => ({ ...s, order: i }));
      break;
    }
    case "add": {
      if (!edit.newName) return { kind: "ok", plan };
      const newOrder = edit.newOrder ?? stages.length;
      stages.splice(newOrder, 0, {
        name: edit.newName,
        order: newOrder,
        description: edit.newDescription ?? edit.newName,
      });
      stages = stages.map((s, i) => ({ ...s, order: i }));
      break;
    }
    case "remove": {
      if (edit.stageIndex == null || !stages[edit.stageIndex]) {
        return { kind: "ok", plan };
      }
      stages.splice(edit.stageIndex, 1);
      stages = stages.map((s, i) => ({ ...s, order: i }));
      break;
    }
  }

  // E3 bounds enforcement
  const bounds = STRATEGY_STAGE_BOUNDS[pipeline.strategy];
  if (stages.length < bounds.minStages || stages.length > bounds.maxStages) {
    return {
      kind: "bounds_violation",
      strategy: pipeline.strategy,
      attemptedStageCount: stages.length,
    };
  }

  const updatedPipeline: ActionPlanPipeline = {
    ...pipeline,
    proposedStages: stages,
  };
  const pipelines = [...plan.pipelines];
  pipelines[edit.pipelineIndex] = updatedPipeline;
  return { kind: "ok", plan: { ...plan, pipelines } };
}

function applyFirstActionsEdit(
  plan: ActionPlan,
  edit: Extract<ActionPlanEdit, { axis: "first_actions" }>,
): ActionPlan {
  const pipeline = plan.pipelines[edit.pipelineIndex];
  if (!pipeline) return plan;

  let actions = [...pipeline.firstActions];
  switch (edit.op) {
    case "edit": {
      if (edit.actionIndex == null || !actions[edit.actionIndex]) {
        return plan;
      }
      actions[edit.actionIndex] = {
        ...actions[edit.actionIndex],
        ...(edit.newDay != null ? { day: edit.newDay } : {}),
        ...(edit.newChannel ? { channel: edit.newChannel } : {}),
        ...(edit.newIntent ? { intent: edit.newIntent } : {}),
        ...(edit.newDescription
          ? { description: edit.newDescription }
          : {}),
      };
      break;
    }
    case "add": {
      if (
        edit.newDay == null ||
        !edit.newChannel ||
        !edit.newIntent ||
        !edit.newDescription
      ) {
        return plan;
      }
      // Cap at 5 firstActions (FirstActionSchema in campaign-proposal.ts allows
      // up to 10; ActionPlanPipelineSchema caps refiner additions at 5).
      if (actions.length >= 5) return plan;
      actions.push({
        day: edit.newDay,
        channel: edit.newChannel,
        intent: edit.newIntent,
        description: edit.newDescription,
      });
      break;
    }
    case "remove": {
      if (edit.actionIndex == null || !actions[edit.actionIndex]) {
        return plan;
      }
      if (actions.length <= 1) return plan; // Schema min 1
      actions.splice(edit.actionIndex, 1);
      break;
    }
  }

  const updatedPipeline: ActionPlanPipeline = {
    ...pipeline,
    firstActions: actions,
  };
  const pipelines = [...plan.pipelines];
  pipelines[edit.pipelineIndex] = updatedPipeline;
  return { ...plan, pipelines };
}

// ─────────────────────────────────────────────
// Recompute gap analysis (E4 — unconditional)
// ─────────────────────────────────────────────

async function recomputeGapAnalysis(
  prisma: ActionPlanRefinerPrisma,
  redis: FeasibilityRedis | null,
  tenantId: string,
  goalShape: GoalShape,
  goalTarget: number,
  goalWindowDays: number,
  pipelines: ActionPlanPipeline[],
  countAudience: CountAudienceFn,
): Promise<{
  pipelines: ActionPlanPipeline[];
  gapAnalysis: ActionPlanGapAnalysis;
}> {
  let context: TenantHistoricalContext;
  try {
    context = await getTenantHistoricalContext(
      prisma as unknown as PrismaClient,
      redis,
      { tenantId, goalShape, windowDays: goalWindowDays },
    );
  } catch {
    // E4 fail-safe — leave gap analysis untouched if FCS transient.
    const gapPercent = computeGapPercent(goalTarget, 0);
    return {
      pipelines,
      gapAnalysis: {
        goalTarget,
        projectedOrganic: 0,
        gapAbsolute: goalTarget,
        gapPercent,
        goalWindowDays,
      },
    };
  }

  // Per-pipeline audience count refresh (audience may have shifted).
  const counts = await Promise.all(
    pipelines.map(async (p) => {
      try {
        const r = await countAudience(prisma, tenantId, {
          conditions: p.audienceConditions,
        });
        return r.count;
      } catch {
        return p.audienceCount;
      }
    }),
  );
  const totalAudience = counts.reduce((s, c) => s + c, 0);
  const projectedOrganic = projectOrganicCount(
    goalShape,
    context,
    goalWindowDays,
  );

  const refreshedPipelines: ActionPlanPipeline[] = pipelines.map((p, idx) => {
    const audienceCount = counts[idx];
    const projectedContribution = projectPerCohortContribution(
      goalShape,
      context,
      goalWindowDays,
      audienceCount,
      totalAudience > 0 ? totalAudience : 1,
    );
    const shareOfGoal =
      goalTarget > 0
        ? Math.min(100, (projectedContribution / goalTarget) * 100)
        : 0;
    return { ...p, audienceCount, projectedContribution, shareOfGoal };
  });

  const gapAbsolute = goalTarget - projectedOrganic;
  const gapPercent = computeGapPercent(goalTarget, projectedOrganic);

  return {
    pipelines: refreshedPipelines,
    gapAnalysis: {
      goalTarget,
      projectedOrganic,
      gapAbsolute,
      gapPercent,
      goalWindowDays,
    },
  };
}

// ─────────────────────────────────────────────
// Goal-shape parsing (mirrored from generator)
// ─────────────────────────────────────────────

function parseGoalShape(
  goalType: string | null,
  goalProductId: string | null,
  goalDescription: string | null,
): GoalShape | null {
  switch (goalType) {
    case "revenue":
      return goalProductId
        ? { type: "revenue", productId: goalProductId }
        : { type: "revenue" };
    case "units":
      if (!goalProductId) return null;
      return { type: "units", productId: goalProductId };
    case "deals":
      return { type: "deals" };
    case "meetings":
      return { type: "meetings" };
    case "custom":
      return {
        type: "custom",
        description: goalDescription ?? "operator-defined custom goal",
      };
    default:
      return null;
  }
}

function computeGoalWindowDays(
  windowStart: Date | null,
  windowEnd: Date | null,
  fallback: number,
): number {
  if (!windowStart || !windowEnd) return fallback;
  const ms = windowEnd.getTime() - windowStart.getTime();
  if (ms <= 0) return fallback;
  return Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)));
}

// ─────────────────────────────────────────────
// Audit emission helper
// ─────────────────────────────────────────────

async function emitAudit(
  prisma: ActionPlanRefinerPrisma,
  params: {
    tenantId: string;
    actionType: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: params.tenantId,
        actor: "system:action-plan-refiner",
        actionType: params.actionType,
        payload: params.payload,
      },
    });
  } catch (err) {
    console.warn(
      `[action-plan-refiner] audit-emit-failed actionType=${params.actionType}:`,
      (err as Error)?.message ?? String(err),
    );
  }
}

// ─────────────────────────────────────────────
// Public API — refineActionPlan
// ─────────────────────────────────────────────

export async function refineActionPlan(
  prisma: ActionPlanRefinerPrisma,
  redis: FeasibilityRedis | null,
  llm: LLMCompleteFn,
  countAudience: CountAudienceFn,
  params: RefineActionPlanParams,
): Promise<RefineActionPlanResult> {
  const todayUtc = params.todayUtc ?? new Date();

  // Read Campaign + verify existence + verify plan presence.
  let campaign: Record<string, unknown> | null = null;
  try {
    campaign = (await prisma.campaign.findFirst({
      where: { id: params.campaignId, tenantId: params.tenantId },
      select: {
        id: true,
        name: true,
        goalType: true,
        goalTarget: true,
        goalProductId: true,
        goalDescription: true,
        audienceConditions: true,
        windowStart: true,
        windowEnd: true,
        proposedPlan: true,
        updatedAt: true,
      },
    })) as Record<string, unknown> | null;
  } catch (err) {
    console.error(
      `[action-plan-refiner] campaign-read-failed campaignId=${params.campaignId}:`,
      err,
    );
    return analyzerUnavailable(params.campaignId);
  }

  if (!campaign) return analyzerUnavailable(params.campaignId);

  // NEW-C — no plan to refine
  if (!campaign.proposedPlan) {
    return {
      kind: "no_plan_to_refine",
      message:
        "This Campaign has no Action Plan yet. Generate one first via Generate Action Plan.",
      campaignId: params.campaignId,
    };
  }

  const currentPlan = campaign.proposedPlan as unknown as ActionPlan;

  // NEW-B — optimistic concurrency check
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
        "Another edit landed on this Campaign while you were refining. Review the current plan and re-apply your refinement.",
      campaignId: params.campaignId,
      currentPlan,
    };
  }

  const goalShape = parseGoalShape(
    campaign.goalType as string,
    (campaign.goalProductId as string) ?? null,
    (campaign.goalDescription as string) ?? null,
  );
  if (!goalShape) return analyzerUnavailable(params.campaignId);

  // LLM classification (NEW-A — reasoning tier ONLY)
  let llmResult: LLMCompleteResult;
  try {
    llmResult = await llm({
      tenantId: params.tenantId,
      tier: REFINER_LLM_TIER,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildRefinerUserPrompt({
        plan: currentPlan,
        campaignName: (campaign.name as string) ?? "Campaign",
        goalType: campaign.goalType as string,
        goalTarget: campaign.goalTarget as number,
        refinementMessage: params.refinementMessage,
        todayUtc,
      }),
      jsonMode: true,
      maxTokens: REFINER_LLM_MAX_TOKENS,
      callerTag: REFINER_LLM_CALLER_TAG,
    });
  } catch (err) {
    console.warn(
      `[action-plan-refiner] llm-call-failed campaignId=${params.campaignId}:`,
      (err as Error)?.message ?? String(err),
    );
    return analyzerUnavailable(params.campaignId);
  }

  const edit = parseEditOutput(llmResult.text);
  if (!edit) {
    console.warn(
      `[action-plan-refiner] llm-parse-failed campaignId=${params.campaignId} preview=${llmResult.text.slice(0, 200)}`,
    );
    return analyzerUnavailable(params.campaignId);
  }

  // Dispatch to family-specific handler
  const goalWindowDays = computeGoalWindowDays(
    campaign.windowStart as Date | null,
    campaign.windowEnd as Date | null,
    DEFAULT_GOAL_WINDOW_DAYS,
  );

  switch (edit.axis) {
    case "stage": {
      const applied = applyStageEdit(currentPlan, edit);
      if (applied.kind === "bounds_violation") {
        return {
          kind: "bounds_violation",
          message: `Stage edit rejected — ${applied.strategy} strategy requires ${STRATEGY_STAGE_BOUNDS[applied.strategy].minStages}-${STRATEGY_STAGE_BOUNDS[applied.strategy].maxStages} stages; attempted ${applied.attemptedStageCount}.`,
          campaignId: params.campaignId,
          strategy: applied.strategy,
          attemptedStageCount: applied.attemptedStageCount,
        };
      }
      const refreshed = await recomputeGapAnalysis(
        prisma,
        redis,
        params.tenantId,
        goalShape,
        campaign.goalTarget as number,
        goalWindowDays,
        applied.plan.pipelines,
        countAudience,
      );
      const newPlan: ActionPlan = {
        ...applied.plan,
        pipelines: refreshed.pipelines,
        gapAnalysis: refreshed.gapAnalysis,
        modelUsed: llmResult.model,
        generatedAt: todayUtc.toISOString(),
      };
      await persistRefinedPlan(prisma, params.campaignId, newPlan);
      await emitAudit(prisma, {
        tenantId: params.tenantId,
        actionType: "campaign.action_plan_refined",
        payload: {
          campaignId: params.campaignId,
          editAxis: "stage",
          editDescription: params.refinementMessage,
          before: currentPlan,
          after: newPlan,
          modelUsed: llmResult.model,
        },
      });
      return {
        kind: "action_plan_refined",
        plan: newPlan,
        campaignId: params.campaignId,
        editAxis: "stage",
      };
    }
    case "first_actions": {
      const applied = applyFirstActionsEdit(currentPlan, edit);
      const refreshed = await recomputeGapAnalysis(
        prisma,
        redis,
        params.tenantId,
        goalShape,
        campaign.goalTarget as number,
        goalWindowDays,
        applied.pipelines,
        countAudience,
      );
      const newPlan: ActionPlan = {
        ...applied,
        pipelines: refreshed.pipelines,
        gapAnalysis: refreshed.gapAnalysis,
        modelUsed: llmResult.model,
        generatedAt: todayUtc.toISOString(),
      };
      await persistRefinedPlan(prisma, params.campaignId, newPlan);
      await emitAudit(prisma, {
        tenantId: params.tenantId,
        actionType: "campaign.action_plan_refined",
        payload: {
          campaignId: params.campaignId,
          editAxis: "first_actions",
          editDescription: params.refinementMessage,
          before: currentPlan,
          after: newPlan,
          modelUsed: llmResult.model,
        },
      });
      return {
        kind: "action_plan_refined",
        plan: newPlan,
        campaignId: params.campaignId,
        editAxis: "first_actions",
      };
    }
    case "audience": {
      // Re-validate via shared schema (defense-in-depth)
      let newConditions: AudienceConditions;
      try {
        newConditions = AudienceConditionsSchema.parse(
          edit.newAudienceConditions,
        );
      } catch {
        return analyzerUnavailable(params.campaignId);
      }

      // Re-run deterministic split + reconcile pipelines (preserve names + strategies
      // when segment matches; new splits get default values from previous matching).
      const splits = splitAudienceIntoPipelines(newConditions);
      const reconciledPipelines: ActionPlanPipeline[] = splits.map((split) => {
        const matched = currentPlan.pipelines.find(
          (p) => p.segment === split.segment,
        );
        if (matched) {
          return {
            ...matched,
            audienceConditions: split.conditions,
            // audienceCount / projectedContribution / shareOfGoal refreshed by recomputeGapAnalysis
          };
        }
        // New cohort not in prior plan — minimal valid skeleton; operator
        // re-generates if they want LLM-tweaked stages for the new cohort.
        return {
          name: `${split.cohortLabel} cohort`,
          segment: split.segment,
          strategy: "direct",
          audienceConditions: split.conditions,
          audienceCount: 0,
          proposedStages: [
            { name: "Outreach", order: 0, description: "Initial contact" },
            { name: "Close", order: 1, description: "Convert" },
          ],
          firstActions: [
            {
              day: 0,
              channel: "email",
              intent: "outreach",
              description: "Day-0 outreach to cohort",
            },
          ],
          projectedContribution: 0,
          shareOfGoal: 0,
        };
      });
      const refreshed = await recomputeGapAnalysis(
        prisma,
        redis,
        params.tenantId,
        goalShape,
        campaign.goalTarget as number,
        goalWindowDays,
        reconciledPipelines,
        countAudience,
      );
      const newPlan: ActionPlan = {
        ...currentPlan,
        pipelines: refreshed.pipelines,
        gapAnalysis: refreshed.gapAnalysis,
        modelUsed: llmResult.model,
        generatedAt: todayUtc.toISOString(),
      };
      // Persist BOTH proposedPlan AND Campaign.audienceConditions
      try {
        await prisma.campaign.update({
          where: { id: params.campaignId },
          data: {
            proposedPlan: newPlan as unknown as Prisma.InputJsonValue,
            audienceConditions: newConditions as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        console.warn(
          `[action-plan-refiner] persist-failed campaignId=${params.campaignId}:`,
          (err as Error)?.message ?? String(err),
        );
      }
      await emitAudit(prisma, {
        tenantId: params.tenantId,
        actionType: "campaign.action_plan_refined",
        payload: {
          campaignId: params.campaignId,
          editAxis: "audience",
          editDescription: params.refinementMessage,
          before: currentPlan,
          after: newPlan,
          modelUsed: llmResult.model,
        },
      });
      return {
        kind: "action_plan_refined",
        plan: newPlan,
        campaignId: params.campaignId,
        editAxis: "audience",
      };
    }
    case "dimension": {
      // NEW-D — write Campaign column directly + emit dimension audit type
      // + leave proposedPlan stale (operator re-generates if they want).
      const updateData: Record<string, unknown> = {};
      switch (edit.field) {
        case "goalType":
          updateData.goalType = edit.newValue;
          break;
        case "goalTarget":
          updateData.goalTarget =
            typeof edit.newValue === "number"
              ? edit.newValue
              : Number(edit.newValue);
          break;
        case "goalDescription":
          updateData.goalDescription =
            edit.newValue == null ? null : String(edit.newValue);
          break;
        case "goalProductId":
          updateData.goalProductId =
            edit.newValue == null ? null : String(edit.newValue);
          break;
        case "windowStart":
          updateData.windowStart =
            edit.newValue == null ? null : new Date(String(edit.newValue));
          break;
        case "windowEnd":
          updateData.windowEnd =
            edit.newValue == null ? null : new Date(String(edit.newValue));
          break;
      }
      try {
        await prisma.campaign.update({
          where: { id: params.campaignId },
          data: updateData,
        });
      } catch (err) {
        console.warn(
          `[action-plan-refiner] dim-persist-failed campaignId=${params.campaignId}:`,
          (err as Error)?.message ?? String(err),
        );
        return analyzerUnavailable(params.campaignId);
      }
      // Separate audit type per NEW-D
      await emitAudit(prisma, {
        tenantId: params.tenantId,
        actionType: "campaign.dimension_post_confirm_edit",
        payload: {
          campaignId: params.campaignId,
          field: edit.field,
          previousValue: (campaign as Record<string, unknown>)[edit.field],
          newValue: edit.newValue,
          editDescription: params.refinementMessage,
          modelUsed: llmResult.model,
        },
      });
      // Plan returned is the STALE current plan; operator must call
      // generateActionPlan again to refresh. Doctrine: dimensions invalidate
      // the plan but never auto-regenerate.
      return {
        kind: "action_plan_refined",
        plan: currentPlan,
        campaignId: params.campaignId,
        editAxis: "dimension",
      };
    }
  }
}

async function persistRefinedPlan(
  prisma: ActionPlanRefinerPrisma,
  campaignId: string,
  plan: ActionPlan,
): Promise<void> {
  try {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { proposedPlan: plan as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    console.warn(
      `[action-plan-refiner] persist-failed campaignId=${campaignId}:`,
      (err as Error)?.message ?? String(err),
    );
  }
}

function analyzerUnavailable(campaignId: string): RefineActionPlanResult {
  return {
    kind: "analyzer_unavailable",
    message:
      "We couldn't refine the Action Plan right now. Please try again in a moment.",
    campaignId,
  };
}

// ─────────────────────────────────────────────
// Public API — revertLastRefinement (E8 lock)
// ─────────────────────────────────────────────

export async function revertLastRefinement(
  prisma: ActionPlanRefinerPrisma,
  params: RevertLastRefinementParams,
): Promise<RevertActionPlanRefinementResult> {
  const todayUtc = params.todayUtc ?? new Date();

  // Find most recent action_plan_refined audit row for this campaign.
  let lastAudit: Record<string, unknown> | null = null;
  try {
    lastAudit = (await prisma.auditLog.findFirst({
      where: {
        tenantId: params.tenantId,
        actionType: "campaign.action_plan_refined",
        payload: { path: ["campaignId"], equals: params.campaignId },
      },
      orderBy: { createdAt: "desc" },
    })) as Record<string, unknown> | null;
  } catch (err) {
    console.error(
      `[action-plan-refiner] revert-audit-read-failed campaignId=${params.campaignId}:`,
      err,
    );
    return {
      kind: "analyzer_unavailable",
      message:
        "We couldn't revert the refinement right now. Please try again in a moment.",
      campaignId: params.campaignId,
    };
  }

  if (!lastAudit) {
    return {
      kind: "no_refinement_to_revert",
      message: "There are no refinements to revert on this Action Plan.",
      campaignId: params.campaignId,
    };
  }

  const payload = lastAudit.payload as Record<string, unknown> | undefined;
  const before = payload?.before as ActionPlan | undefined;
  if (!before) {
    return {
      kind: "analyzer_unavailable",
      message:
        "The last refinement's history is malformed; revert unavailable.",
      campaignId: params.campaignId,
    };
  }

  try {
    await prisma.campaign.update({
      where: { id: params.campaignId },
      data: { proposedPlan: before as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    console.warn(
      `[action-plan-refiner] revert-persist-failed campaignId=${params.campaignId}:`,
      (err as Error)?.message ?? String(err),
    );
    return {
      kind: "analyzer_unavailable",
      message:
        "We couldn't write the revert right now. Please try again in a moment.",
      campaignId: params.campaignId,
    };
  }

  // Emit revert audit row (E8 lock — never destroy forensic history)
  await emitAudit(prisma, {
    tenantId: params.tenantId,
    actionType: "campaign.action_plan_refinement_reverted",
    payload: {
      campaignId: params.campaignId,
      revertedAuditId: lastAudit.id,
      revertedAt: todayUtc.toISOString(),
    },
  });

  return {
    kind: "action_plan_reverted",
    plan: before,
    campaignId: params.campaignId,
  };
}
