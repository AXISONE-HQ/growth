/**
 * KAN-1185 — Action Plan Generator (Campaign Module Reset PR 4).
 *
 * Reads the 4 Confirmed dimensions from a draft Campaign (persisted by the
 * KAN-1184 conversational orchestrator), derives a multi-pipeline split
 * deterministically (Q-ADD D1 lock), then asks the LLM to fill per-Pipeline
 * strategy + stage names + first-actions within bounded shape (Q-ADD D2 lock).
 * Persists the resulting ActionPlan to Campaign.proposedPlan.
 *
 * # Layer separation (Q-ADD-NEW-1)
 *
 *   Campaign.feasibilityAnalysis  ← KAN-1166 analyzer (counsel — is goal achievable?)
 *   Campaign.proposedPlan         ← KAN-1185 generator (plan — how do we execute?)
 *   Campaign.committedPlan        ← KAN-1190 commit (live execution shape)
 *
 * # Operator-initiated dispatch (Q-ADD-NEW-2)
 *
 * This generator is NEVER invoked from conversational-orchestrator. The tRPC
 * procedure `campaigns.generateActionPlan` is operator-callable (UI surfaces
 * affordance after `all_dimensions_confirmed` turn). Auto-chain would:
 *   - Block chat UX during 10-30s multi-LLM round-trip
 *   - Defeat edit affordance after a dimension is Confirmed
 *   - Create ambiguous re-run semantics on dimension edits
 *
 * # Confidence (Q-ADD D5)
 *
 * ONE tenant-level confidence (from dominantConfidence in projection-math).
 * Per-Pipeline output carries projectedContribution + shareOfGoal — math, NOT
 * fabricated specificity. Surfacing per-Pipeline confidence derived from a
 * uniform tenant signal would invent granularity the AI does not have.
 *
 * # Fail-safe
 *
 * Mirrors feasibility-analyzer.ts pattern: any DB/LLM transient returns
 * 'analyzer_unavailable'; insufficient/missing dimensions return
 * 'insufficient_dimensions'. NEVER throws to caller.
 */
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type {
  ActionPlan,
  ActionPlanConfidence,
  ActionPlanGapAnalysis,
  ActionPlanPipeline,
  ActionPlanResult,
  AudienceConditions,
  CampaignStrategy,
  FirstAction,
  GoalShape,
  PipelineSegment,
  ProposedStage,
  TenantHistoricalContext,
} from "@growth/shared";
import {
  AudienceConditionsSchema,
  STRATEGY_STAGE_BOUNDS,
} from "@growth/shared";
import {
  getTenantHistoricalContext,
  type FeasibilityRedis,
} from "./feasibility-context-service.js";
import {
  computeGapPercent,
  dominantConfidence,
  projectOrganicCount,
  projectPerCohortContribution,
} from "./projection-math.js";
import type { LLMCompleteInput, LLMCompleteResult } from "./llm-client.js";

// ─────────────────────────────────────────────
// Public params + types
// ─────────────────────────────────────────────

export interface GenerateActionPlanParams {
  campaignId: string;
  tenantId: string;
  /** Default new Date(). Tests inject for deterministic timestamps. */
  todayUtc?: Date;
}

export type LLMCompleteFn = (
  input: LLMCompleteInput,
) => Promise<LLMCompleteResult>;

/** Minimal Prisma surface the generator needs. Loose subset so tests can
 *  satisfy with a partial mock. */
export interface ActionPlanGeneratorPrisma {
  campaign: {
    findFirst: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
  };
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const GENERATOR_LLM_TIER: "reasoning" = "reasoning";
const GENERATOR_LLM_CALLER_TAG = "action-plan-generator:per-pipeline";
const GENERATOR_LLM_MAX_TOKENS = 1200;
const DEFAULT_GOAL_WINDOW_DAYS = 90;

/** Lower-bound on pipelines after deterministic split. Single-pipeline =
 *  one entry with segment='other'. */
const MIN_PIPELINES = 1;

// ─────────────────────────────────────────────
// Deterministic multi-pipeline split (Q-ADD D1 lock)
//
// Walk the AudienceConditions tree, collect all lifecycleStage leaves,
// project to PipelineSegment via fixed map. If no lifecycleStage leaf
// present → single 'other' pipeline carrying full conditions.
// ─────────────────────────────────────────────

// Map LifecycleStageEnum (enums.ts: lead/mql/sql/customer/lost) →
// PipelineSegment (schema.prisma:1179). MQL + SQL roll into new_leads
// since they're stages within the new-lead lifecycle, not separate cohorts
// at the Pipeline level. `lost` → closed_lost_recovery is the canonical
// winback target.
const LIFECYCLE_TO_SEGMENT: Record<string, PipelineSegment> = {
  lead: "new_leads",
  mql: "new_leads",
  sql: "new_leads",
  customer: "inactive_customers_reengagement",
  lost: "closed_lost_recovery",
};

interface PipelineSplit {
  segment: PipelineSegment;
  conditions: AudienceConditions;
  /** Cohort stages this pipeline serves (operator-readable). */
  cohortLabel: string;
}

/** Walk the conditions tree and collect all lifecycleStage values. Returns
 *  a flat list — duplicates allowed (callers de-dupe). */
function collectLifecycleStages(conditions: AudienceConditions): string[] {
  const out: string[] = [];
  const walk = (node: AudienceConditions): void => {
    if ("allOf" in node) {
      node.allOf.forEach(walk);
      return;
    }
    if ("anyOf" in node) {
      node.anyOf.forEach(walk);
      return;
    }
    // Leaf
    if (node.field === "lifecycleStage" && "values" in node) {
      const values = node.values as unknown;
      if (Array.isArray(values)) {
        for (const v of values) if (typeof v === "string") out.push(v);
      }
    }
  };
  walk(conditions);
  return out;
}

/** Build a per-pipeline AudienceConditions that scopes the parent conditions
 *  to a single lifecycleStage cohort. Wraps the parent in allOf with an
 *  added lifecycleStage filter. */
function scopeConditionsToCohort(
  parent: AudienceConditions,
  cohort: string,
): AudienceConditions {
  return {
    allOf: [
      parent,
      {
        field: "lifecycleStage",
        op: "in",
        values: [cohort],
      },
    ],
  } as AudienceConditions;
}

/**
 * KAN-1227 — Vehicle-mode default audience.
 *
 * Vehicle campaigns skip the operator audience step (KAN-1219 Q3 lock:
 * vehicles target a fixed inventory set selected at TargetEntityPanel
 * confirm time, NOT a lead-filter tree). The Action Plan generator still
 * needs a parseable AudienceConditions to drive the deterministic split +
 * per-pipeline count, so vehicle mode substitutes this canonical "all
 * leads" tree at READ time rather than persisting fabricated operator
 * intent into Campaign.audienceConditions (the column stays the honest
 * createDraftCampaign `{}` placeholder).
 *
 * `orders.exists ∈ {true, false}` is provably universal (every contact
 * either has orders or doesn't) and cardinality-stable — it does NOT
 * couple to the LifecycleStage enum size (see memo vocab_extension_
 * fixture_sweep — absolute-count assumptions break on enum growth).
 * splitAudienceIntoPipelines collapses it to a single `full_audience`
 * pipeline; countAudience returns the true tenant contact count, so the
 * gap-analysis projections stay meaningful for the vehicle plan.
 */
export const VEHICLE_FULL_AUDIENCE: AudienceConditions = {
  anyOf: [
    { field: "orders.exists", op: "eq", value: true },
    { field: "orders.exists", op: "eq", value: false },
  ],
};

export function splitAudienceIntoPipelines(
  conditions: AudienceConditions,
): PipelineSplit[] {
  const stages = collectLifecycleStages(conditions);
  const uniqueStages = Array.from(new Set(stages));

  // No lifecycleStage leaf OR exactly one lifecycleStage → single pipeline.
  if (uniqueStages.length <= 1) {
    const segment: PipelineSegment =
      uniqueStages.length === 1
        ? (LIFECYCLE_TO_SEGMENT[uniqueStages[0]] ?? "other")
        : "other";
    const cohortLabel =
      uniqueStages.length === 1 ? uniqueStages[0] : "full_audience";
    return [{ segment, conditions, cohortLabel }];
  }

  // Multi-cohort audience → one pipeline per cohort.
  return uniqueStages.map((cohort) => ({
    segment: LIFECYCLE_TO_SEGMENT[cohort] ?? "other",
    conditions: scopeConditionsToCohort(conditions, cohort),
    cohortLabel: cohort,
  }));
}

// ─────────────────────────────────────────────
// Audience-count helper (per-pipeline)
//
// Generator reuses the countAudience function the orchestrator already
// uses; injected as a callback to keep this module testable without
// pulling the full audience-router substrate into the test sandbox.
// ─────────────────────────────────────────────

export type CountAudienceFn = (
  prisma: ActionPlanGeneratorPrisma,
  tenantId: string,
  input: { conditions: unknown },
) => Promise<{ count: number; historicalValueUsd?: number }>;

// ─────────────────────────────────────────────
// Per-pipeline LLM prompt (Q-ADD D2 bounded template)
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an AI growth strategist generating per-Pipeline
execution shape for a multi-pipeline Campaign.

# Your task

Given ONE pipeline's audience cohort + the parent Campaign's goal + tenant
historical context, output the pipeline's execution shape:
  - name             — short operator-readable pipeline name (3-80 chars)
  - strategy         — pick ONE from {direct, re_engage, trust_build, guided}
  - proposedStages   — 2-5 stages matching strategy bounds; each {name, order, description}
  - firstActions     — 1-5 declarative actions; each {day, channel, intent, description}

# Strategy → stage bounds (do NOT exceed)

  direct       — 2-4 stages; roleHints: outreach → qualify → demo_or_proposal → close
  re_engage    — 3-5 stages; roleHints: re_open → pain_check → value_remind → qualify → close
  trust_build  — 3-5 stages; roleHints: introduce → educate → social_proof → qualify → soft_close
  guided       — 2-4 stages; roleHints: educate → compare → recommend → close

# Channels (firstActions.channel)

  email | sms | whatsapp

# Output format

Return STRICT JSON (no markdown fences):

{
  "name": "<3-80 chars>",
  "strategy": "direct" | "re_engage" | "trust_build" | "guided",
  "proposedStages": [
    { "name": "<short>", "order": 0, "description": "<one-sentence>" },
    ...
  ],
  "firstActions": [
    { "day": 0, "channel": "email", "intent": "<short>", "description": "<one-sentence>" },
    ...
  ]
}

Honest counsel doctrine: NO fluff. Stage descriptions concrete. Action
descriptions cite the cohort (e.g., "Day-0 outbound to lead cohort with...").`;

interface PerPipelineLlmInput {
  campaignName: string;
  goalShape: GoalShape;
  goalTarget: number;
  goalDescription: string;
  goalWindowDays: number;
  cohortLabel: string;
  segment: PipelineSegment;
  audienceCount: number;
  projectedContribution: number;
  shareOfGoal: number;
  todayUtc: Date;
}

function buildPerPipelinePrompt(input: PerPipelineLlmInput): string {
  return `# Today
${input.todayUtc.toISOString()}

# Campaign
Name: ${input.campaignName}
Goal: ${input.goalShape.type} = ${input.goalTarget}
Description: ${input.goalDescription}
Window: ${input.goalWindowDays} days

# This pipeline
Segment: ${input.segment}
Cohort: ${input.cohortLabel}
Audience count: ${input.audienceCount}
Projected contribution: ${input.projectedContribution} ${input.goalShape.type}
Share of Campaign goal: ${input.shareOfGoal.toFixed(1)}%

# Your task

Produce JSON per the system-prompt format. Pick the strategy that best fits
THIS cohort. Stage count must respect strategy bounds. Action descriptions
cite the cohort + segment by name.`;
}

interface PerPipelineLlmOutput {
  name: string;
  strategy: CampaignStrategy;
  proposedStages: ProposedStage[];
  firstActions: FirstAction[];
}

function parsePerPipelineOutput(rawText: string): PerPipelineLlmOutput | null {
  try {
    const stripped = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(stripped) as Partial<PerPipelineLlmOutput>;
    if (
      typeof parsed.name !== "string" ||
      typeof parsed.strategy !== "string" ||
      !Array.isArray(parsed.proposedStages) ||
      !Array.isArray(parsed.firstActions)
    ) {
      return null;
    }
    const strategy = parsed.strategy as CampaignStrategy;
    if (!(strategy in STRATEGY_STAGE_BOUNDS)) return null;
    const bounds = STRATEGY_STAGE_BOUNDS[strategy];
    if (
      parsed.proposedStages.length < bounds.minStages ||
      parsed.proposedStages.length > bounds.maxStages
    ) {
      return null;
    }
    if (parsed.firstActions.length < 1 || parsed.firstActions.length > 5) {
      return null;
    }
    return {
      name: parsed.name.slice(0, 80),
      strategy,
      proposedStages: parsed.proposedStages.slice(0, bounds.maxStages),
      firstActions: parsed.firstActions.slice(0, 5),
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Confidence projection (tenant-level → ActionPlanConfidence)
// ─────────────────────────────────────────────

function projectConfidence(
  context: TenantHistoricalContext,
): { confidence: ActionPlanConfidence; reason: string } {
  const dominant = dominantConfidence(context);
  switch (dominant) {
    case "high":
      return {
        confidence: "high",
        reason: `${context.salesVelocity.confidence}/${context.conversionRate.confidence} signal density across ≥30 closed deals`,
      };
    case "medium":
      return {
        confidence: "medium",
        reason: `partial signal density (${context.dataReadiness.overall} dataReadiness)`,
      };
    case "low":
      return {
        confidence: "low",
        reason: `thin signal (${context.dataReadiness.overall} dataReadiness)`,
      };
    case "insufficient_data":
      return {
        confidence: "low",
        reason: "insufficient historical data — projection is best-effort",
      };
  }
}

// ─────────────────────────────────────────────
// Goal-shape parsing from Campaign columns
//
// Campaign stores goalType + goalProductId + goalTarget as separate
// columns; GoalShape is the discriminated union from KAN-1166 PR 2a.
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
      // GoalShape units variant requires productId — without it the
      // projection math has no anchor; treat as insufficient_dimensions.
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

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Generate a multi-pipeline Action Plan for a draft Campaign.
 *
 * Operator-triggered (NOT auto-chained from chat). Reads dimensions from
 * the persisted Campaign row; runs deterministic audience split; calls
 * LLM once per pipeline to fill strategy + stages + first-actions.
 *
 * Returns ActionPlanResult discriminated union — fail-safe.
 */
export async function generateActionPlan(
  prisma: ActionPlanGeneratorPrisma,
  redis: FeasibilityRedis | null,
  llm: LLMCompleteFn,
  countAudience: CountAudienceFn,
  params: GenerateActionPlanParams,
): Promise<ActionPlanResult> {
  const todayUtc = params.todayUtc ?? new Date();

  // Read Campaign row + validate the 4 dimensions are populated.
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
        // KAN-1227 — polymorphic target discriminator drives the vehicle-mode
        // audience branch below.
        targetEntityType: true,
        windowStart: true,
        windowEnd: true,
      },
    })) as Record<string, unknown> | null;
  } catch (err) {
    console.error(
      `[action-plan-generator] campaign-read-failed campaignId=${params.campaignId}:`,
      err,
    );
    return {
      kind: "analyzer_unavailable",
      message:
        "We couldn't read the Campaign right now. Please try again in a moment.",
      campaignId: params.campaignId,
    };
  }

  if (!campaign) {
    return {
      kind: "analyzer_unavailable",
      message: "Campaign not found.",
      campaignId: params.campaignId,
    };
  }

  // KAN-1227 — vehicle campaigns skip the operator audience dimension
  // (KAN-1219 Q3 lock). Audience is NOT a required dimension in that mode
  // and defaults to VEHICLE_FULL_AUDIENCE at the parse step below. Product
  // campaigns continue to require a populated, schema-valid audience tree.
  const isVehicleMode = campaign.targetEntityType === "vehicle";

  // Validate the dimensions are populated.
  const missing: string[] = [];
  if (!campaign.goalType) missing.push("product/objectives");
  if (campaign.goalTarget == null) missing.push("objectives.target");
  if (!campaign.goalDescription) missing.push("objectives.description");
  if (!isVehicleMode && !campaign.audienceConditions) missing.push("audience");
  if (missing.length > 0) {
    return {
      kind: "insufficient_dimensions",
      message: `Cannot generate plan — missing: ${missing.join(", ")}. Complete the chat dimensions first.`,
      campaignId: params.campaignId,
      missing,
    };
  }

  const goalShape = parseGoalShape(
    campaign.goalType as string,
    (campaign.goalProductId as string) ?? null,
    (campaign.goalDescription as string) ?? null,
  );
  if (!goalShape) {
    return {
      kind: "insufficient_dimensions",
      message: `Unrecognized goalType: ${String(campaign.goalType)}`,
      campaignId: params.campaignId,
      missing: ["product/objectives"],
    };
  }

  // Derive goalWindowDays from windowStart/windowEnd (or default).
  const goalWindowDays = computeGoalWindowDays(
    campaign.windowStart as Date | null,
    campaign.windowEnd as Date | null,
    DEFAULT_GOAL_WINDOW_DAYS,
  );

  // Validate audienceConditions shape via the shared Zod schema.
  let parsedConditions: AudienceConditions;
  try {
    parsedConditions = AudienceConditionsSchema.parse(
      campaign.audienceConditions,
    );
  } catch (err) {
    // KAN-1227 — vehicle campaigns reach here with the createDraftCampaign
    // `{}` placeholder (the audience step is skipped, so the column is never
    // populated). Substitute the canonical full-audience tree instead of
    // failing the operator at the Generate Action Plan gate. Product
    // campaigns keep the hard schema-validation gate (regression-protected).
    if (isVehicleMode) {
      parsedConditions = VEHICLE_FULL_AUDIENCE;
    } else {
      const message =
        err instanceof Error ? err.message : String(err);
      console.warn(
        `[action-plan-generator] audience-parse-failed campaignId=${params.campaignId}: ${message.slice(0, 200)}`,
      );
      return {
        kind: "insufficient_dimensions",
        message: "Campaign audienceConditions failed schema validation.",
        campaignId: params.campaignId,
        missing: ["audience"],
      };
    }
  }

  // Pull tenant historical context — fail-safe per FCS contract.
  let context: TenantHistoricalContext;
  try {
    context = await getTenantHistoricalContext(prisma as unknown as PrismaClient, redis, {
      tenantId: params.tenantId,
      goalShape,
      windowDays: goalWindowDays,
    });
  } catch (err) {
    console.error(
      `[action-plan-generator] fcs-read-failed campaignId=${params.campaignId}:`,
      err,
    );
    return {
      kind: "analyzer_unavailable",
      message:
        "We couldn't read tenant historical context. Please try again in a moment.",
      campaignId: params.campaignId,
    };
  }

  // Deterministic split.
  const splits = splitAudienceIntoPipelines(parsedConditions);

  // Count audience per split (in parallel).
  const splitCounts = await Promise.all(
    splits.map(async (split) => {
      try {
        const r = await countAudience(prisma, params.tenantId, {
          conditions: split.conditions,
        });
        return r.count;
      } catch {
        return 0;
      }
    }),
  );
  const totalAudience = splitCounts.reduce((sum, c) => sum + c, 0);

  // Top-level projection (used by gapAnalysis).
  const projectedOrganic = projectOrganicCount(
    goalShape,
    context,
    goalWindowDays,
  );
  const goalTarget = campaign.goalTarget as number;
  const gapPercent = computeGapPercent(goalTarget, projectedOrganic);

  // Build per-Pipeline slices via LLM (in parallel).
  const llmResults = await Promise.all(
    splits.map(async (split, idx) => {
      const audienceCount = splitCounts[idx];
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

      const prompt = buildPerPipelinePrompt({
        campaignName: (campaign.name as string) ?? "Campaign",
        goalShape,
        goalTarget,
        goalDescription: campaign.goalDescription as string,
        goalWindowDays,
        cohortLabel: split.cohortLabel,
        segment: split.segment,
        audienceCount,
        projectedContribution,
        shareOfGoal,
        todayUtc,
      });

      let llmResult: LLMCompleteResult;
      try {
        llmResult = await llm({
          tenantId: params.tenantId,
          tier: GENERATOR_LLM_TIER,
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: prompt,
          jsonMode: true,
          maxTokens: GENERATOR_LLM_MAX_TOKENS,
          callerTag: GENERATOR_LLM_CALLER_TAG,
        });
      } catch (err) {
        console.warn(
          `[action-plan-generator] llm-call-failed split=${split.cohortLabel}:`,
          (err as Error)?.message ?? String(err),
        );
        return null;
      }

      const parsed = parsePerPipelineOutput(llmResult.text);
      if (!parsed) {
        console.warn(
          `[action-plan-generator] llm-parse-failed split=${split.cohortLabel} preview=${llmResult.text.slice(0, 200)}`,
        );
        return null;
      }

      const pipeline: ActionPlanPipeline = {
        name: parsed.name,
        segment: split.segment,
        strategy: parsed.strategy,
        audienceConditions: split.conditions,
        audienceCount,
        proposedStages: parsed.proposedStages,
        firstActions: parsed.firstActions,
        projectedContribution,
        shareOfGoal,
      };
      return { pipeline, modelUsed: llmResult.model };
    }),
  );

  const successful = llmResults.filter(
    (r): r is { pipeline: ActionPlanPipeline; modelUsed: string } => r !== null,
  );
  if (successful.length < MIN_PIPELINES) {
    return {
      kind: "analyzer_unavailable",
      message:
        "We couldn't generate a plan right now. Please try again in a moment.",
      campaignId: params.campaignId,
    };
  }

  // Aggregate confidence — tenant-level (D5 lock).
  const { confidence, reason } = projectConfidence(context);

  const gapAnalysis: ActionPlanGapAnalysis = {
    goalTarget,
    projectedOrganic,
    gapAbsolute: goalTarget - projectedOrganic,
    gapPercent,
    goalWindowDays,
  };

  const plan: ActionPlan = {
    pipelines: successful.map((s) => s.pipeline),
    confidence,
    confidenceReason: reason,
    gapAnalysis,
    modelUsed: successful[0].modelUsed,
    generatedAt: todayUtc.toISOString(),
  };

  // Persist (fail-safe — log + continue if write fails).
  await persistActionPlan(prisma, params.campaignId, plan);

  return {
    kind: "action_plan",
    plan,
    campaignId: params.campaignId,
  };
}

/**
 * Persist the generated ActionPlan to Campaign.proposedPlan. Mirrors
 * persistCampaignFeasibility fail-safe (log + swallow).
 *
 * Per Q-ADD-NEW-1 layer separation, this generator owns proposedPlan;
 * feasibility-analyzer.persistCampaignFeasibility owns feasibilityAnalysis.
 */
export async function persistActionPlan(
  prisma: ActionPlanGeneratorPrisma,
  campaignId: string,
  plan: ActionPlan,
): Promise<void> {
  try {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        proposedPlan: plan as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.warn(
      `[action-plan-generator] persist-failed campaignId=${campaignId}:`,
      (err as Error)?.message ?? String(err),
    );
  }
}

// ─────────────────────────────────────────────
// Helpers — exported for tests
// ─────────────────────────────────────────────

export function computeGoalWindowDays(
  windowStart: Date | null,
  windowEnd: Date | null,
  fallback: number,
): number {
  if (!windowStart || !windowEnd) return fallback;
  const ms = windowEnd.getTime() - windowStart.getTime();
  if (ms <= 0) return fallback;
  return Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)));
}
