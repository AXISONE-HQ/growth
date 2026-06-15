/**
 * KAN-1166 PR 2b — Feasibility Analyzer.
 *
 * AI honest counsel on operator-stated outcome goals. Pure orchestrator that
 * consumes FeasibilityContextService (PR 2a-core) + llm-client + delivers a
 * FeasibilityCounselResult discriminated union to the operator-facing
 * campaigns.analyzeFeasibility tRPC procedure.
 *
 * # Boundary doctrine (Q-ADD A from Phase 1 trace)
 *
 * Brain stays Deal-centric. Feasibility counsel runs BEFORE Deals exist for
 * new outcome-Campaign. PR 2b consumes Brain at ZERO callsites. Brief's
 * "analyzer combines both peers" framing applies to PR 4+ scope (per-Deal
 * counsel within active Campaign).
 *
 * # Three-state branching (Q4 architect resolution)
 *
 *   dataReadiness.overall:
 *     'insufficient' → ColdStartCounsel (NO LLM call — deterministic template
 *                       per Q-ADD-E hardcoded substrate-specific messages)
 *     'partial'      → FeasibilityCounsel with low-confidence framing in prompt
 *     'sufficient'   → FeasibilityCounsel with full counsel
 *
 * # LLM contract (Q1 + Q2 + Q3 architect resolutions)
 *
 *   Tier:       'reasoning' (Claude Sonnet 4.6 — matches Brain's quality bar)
 *   Structure:  system + user prompt; jsonMode for structured FeasibilityCounsel
 *               shape; direct generation (no tool-use loop — deferred to PR 4+)
 *   Retries:    delegated to llm-client (handles 429/5xx with backoff)
 *   On error:   graceful degradation to 'analyzer_unavailable' discriminated
 *               variant. NEVER throws — never blocks operator workflow.
 *
 * # Fail-safe convention
 *
 * Mirrors sub-objective-gap-tracker.ts:56 pattern. Any orchestrator-level DB
 * transient or LLM error returns 'analyzer_unavailable' instead of throwing.
 *
 * # Idempotent re-run (Phase 1 Decision 4 Refinement 1)
 *
 * `persistCampaignFeasibility` overwrites Campaign.feasibilityAnalysis with
 * the new computedAt. (Per KAN-1185 NEW-1 layer separation, .proposedPlan
 * is owned by action-plan-generator, not this analyzer.) The tRPC procedure
 * layer emits writeAuditBestEffort with `action: 'campaign.feasibility_analyzed'`
 * + payload includes BOTH the new counsel AND the prior counsel snapshot
 * for forensic-chain preservation (Q5 override-with-logging substrate).
 */
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type {
  FeasibilityCounselResult,
  FeasibilityCounsel,
  ColdStartCounsel,
  AchievabilityVerdict,
  AchievablePath,
  DataAcquisitionRecommendation,
  GoalShape,
  TenantHistoricalContext,
  RequiredDataType,
} from "@growth/shared";
import {
  getTenantHistoricalContext,
  hashGoalShape,
  type FeasibilityRedis,
} from "./feasibility-context-service.js";
import type { LLMCompleteInput, LLMCompleteResult } from "./llm-client.js";
// KAN-1185 NEW-3 — projection math hoisted to single-workspace module;
// both this analyzer and action-plan-generator import from there to
// prevent algorithm drift between two services with the same math.
import {
  projectOrganicCount,
  dominantConfidence,
} from "./projection-math.js";

// ─────────────────────────────────────────────
// Public params + types
// ─────────────────────────────────────────────

export interface AnalyzeFeasibilityParams {
  tenantId: string;
  goalShape: GoalShape;
  /** The operator-stated numeric target (e.g. 50 units, 100k USD revenue). */
  goalTarget: number;
  /** Operator-provided free-text goal context — passed verbatim to the
   *  LLM as the operator's stated intent. */
  goalDescription: string;
  /** Default 365. Minimum 90 (enforced by FeasibilityContextService). */
  goalWindowDays?: number;
}

/** Minimal LLM client interface — injectable for testing. Production passes
 *  llm-client.complete; tests pass a stub returning recorded fixtures. */
export type LLMCompleteFn = (
  input: LLMCompleteInput,
) => Promise<LLMCompleteResult>;

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const FEASIBILITY_LLM_TIER: "reasoning" | "cheap" = "reasoning";
const FEASIBILITY_LLM_CALLER_TAG = "feasibility-analyzer:analyze";
const FEASIBILITY_LLM_MAX_TOKENS = 1500;

/** Achievability thresholds — applied to goalGap.percent.
 *
 *  REVISIT 2026-08-12 — per architect calendar-marker discipline. Empirical
 *  thresholds; refine after 8-week PROD signal review. */
const ACHIEVABILITY_FEASIBLE_MAX_GAP_PCT = 20;
const ACHIEVABILITY_STRETCH_MAX_GAP_PCT = 80;

/** Default value-per-deal estimate when avgDealSize is unavailable. Tight
 *  fallback so revenue goals still get rough projection. */
const DEFAULT_AVG_DEAL_USD = 1000;

// ─────────────────────────────────────────────
// FEASIBILITY_SYSTEM_PROMPT — doctrine + role
// ─────────────────────────────────────────────

const FEASIBILITY_SYSTEM_PROMPT = `You are an AI growth feasibility analyst.

Your job: give operators VERIFIABLE, FALSIFIABLE counsel about whether their
stated outcome goal is achievable on current trajectory, and exactly THREE
concrete paths to close any gap.

# Counsel doctrine (non-negotiable)

1. NEVER inflate confidence. If the data is thin, say so honestly.
2. ALWAYS cite the specific historical numbers you used. Operators must be
   able to verify your math against their own records.
3. NEVER promise more than the data supports. "Feasible" means the math works
   on current trajectory; "stretch" means achievable with effort; "unrealistic"
   means the gap exceeds what concrete actions can plausibly close.
4. THREE paths exactly — each must include a CONCRETE operator action, not
   abstract advice. "Increase outreach to 25 new leads per week" — not
   "consider expanding your pipeline".
5. Honest assessment is 200-400 chars. State the goal, the historical baseline
   you derived projection from, and the gap. No fluff.

# Output format

Return STRICT JSON matching this shape (no markdown fences, no prose):

{
  "achievability": "feasible" | "stretch" | "unrealistic",
  "honestAssessment": "<200-400 char honest summary>",
  "achievablePaths": [
    {
      "label": "<short header>",
      "description": "<one-sentence>",
      "requiredAction": "<concrete operator action>",
      "estimatedImpact": "<honest impact estimate>"
    },
    // exactly 3
  ]
}`;

// ─────────────────────────────────────────────
// Cold-start templates (Q-ADD-E hardcoded per-substrate counsel)
// ─────────────────────────────────────────────

const ACQUISITION_TEMPLATES: Record<RequiredDataType, DataAcquisitionRecommendation> = {
  sales_history: {
    dataType: "sales_history",
    operatorActions: [
      "Upload your past 12 months of orders via the CSV import in /imports",
      "Or connect Shopify / Stripe / your billing system via /settings/integrations",
    ],
    expectedUnlock:
      "Enables revenue + units feasibility counsel with high confidence after ≥30 closed deals + ≥90 days of order history.",
  },
  customer_base: {
    dataType: "customer_base",
    operatorActions: [
      "Sync your CRM (HubSpot / Pipedrive) via /settings/integrations",
      "Or upload your customer list via the CSV import in /imports with lifecycle=customer",
    ],
    expectedUnlock:
      "Enables upsell + retention feasibility counsel + lastEngagementDistribution segmentation.",
  },
  lead_history: {
    dataType: "lead_history",
    operatorActions: [
      "Connect your lead-gen ads (Meta Lead Ads) via /settings/integrations",
      "Or import historical leads via /imports with lifecycle=lead",
    ],
    expectedUnlock:
      "Enables conversion-rate projection + new-leads-needed counsel for outcome goals.",
  },
  engagement_history: {
    dataType: "engagement_history",
    operatorActions: [
      "Ship at least one Campaign so the engine starts recording engagement",
      "Or connect email/SMS provider so existing engagement is captured",
    ],
    expectedUnlock:
      "Enables re-engagement feasibility counsel + customer-cohort segmentation by recency.",
  },
};

function buildColdStartMessage(missingDataTypes: RequiredDataType[]): string {
  if (missingDataTypes.length === 0) {
    return "We don't have enough recent activity to give you confident feasibility counsel yet. Ship a Campaign and check back after the engine records a few weeks of signal.";
  }
  if (missingDataTypes.length === 4) {
    return "We need data to give you confident feasibility counsel. Start by uploading your past orders or syncing your CRM — even partial history dramatically improves the AI's read.";
  }
  const labels = missingDataTypes.map((t) => t.replace(/_/g, " ")).join(", ");
  return `We can't project feasibility yet because we're missing: ${labels}. The recommendations below tell you exactly which data sources to populate.`;
}

function buildColdStartCounsel(
  missingDataTypes: RequiredDataType[],
): ColdStartCounsel {
  return {
    missingDataTypes,
    acquisitionRecommendations: missingDataTypes.map(
      (t) => ACQUISITION_TEMPLATES[t],
    ),
    message: buildColdStartMessage(missingDataTypes),
  };
}

// ─────────────────────────────────────────────
// Projection math — pure helpers
// ─────────────────────────────────────────────

/** Operator-readable unit for the goal type. */
function unitForGoalShape(goalShape: GoalShape): string {
  switch (goalShape.type) {
    case "revenue":
      return "USD";
    case "units":
      return "units";
    case "deals":
      return "deals";
    case "meetings":
      return "meetings";
    case "custom":
      return "outcomes";
  }
}

// KAN-1185 NEW-3 — projectOrganicCount + dominantConfidence extracted to
// ./projection-math.ts. Imports above. Both helpers preserved verbatim
// (analyzer's behavior unchanged).

function classifyAchievability(goalGapPercent: number): AchievabilityVerdict {
  if (goalGapPercent <= ACHIEVABILITY_FEASIBLE_MAX_GAP_PCT) return "feasible";
  if (goalGapPercent <= ACHIEVABILITY_STRETCH_MAX_GAP_PCT) return "stretch";
  return "unrealistic";
}

// ─────────────────────────────────────────────
// LLM prompt builder + response parser
// ─────────────────────────────────────────────

function buildFeasibilityPrompt(input: {
  goalShape: GoalShape;
  goalTarget: number;
  goalDescription: string;
  goalWindowDays: number;
  context: TenantHistoricalContext;
  projectedOrganic: number;
  goalGapPercent: number;
  unit: string;
  lowConfidenceFraming: boolean;
}): string {
  const c = input.context;
  const confidenceFrame = input.lowConfidenceFraming
    ? "\n\n# LOW CONFIDENCE FRAMING\n\nThe historical data is THIN. Surface this honestly in honestAssessment — operators must know the projection is rough."
    : "";

  return `# Operator's goal

Type: ${input.goalShape.type}
Target: ${input.goalTarget} ${input.unit}
Window: ${input.goalWindowDays} days
Operator's stated intent: ${input.goalDescription}

${"productId" in input.goalShape && input.goalShape.productId ? `Product: ${input.goalShape.productId}\n` : ""}${"segmentId" in input.goalShape && input.goalShape.segmentId ? `Segment: ${input.goalShape.segmentId}\n` : ""}

# Tenant historical context

Conversion rate: ${
    c.conversionRate.value != null
      ? `${(c.conversionRate.value * 100).toFixed(1)}%`
      : "(insufficient data)"
  } (${c.conversionRate.confidence}; ${c.conversionRate.confidenceReason})

Sales velocity:
  - Units/month: ${c.salesVelocity.unitsPerMonth ?? "(n/a)"}
  - Revenue/month: ${c.salesVelocity.revenuePerMonth ?? "(n/a)"} USD
  - Trend: ${c.salesVelocity.trendDirection}
  - Confidence: ${c.salesVelocity.confidence}

Customer base:
  - Total customers: ${c.customerBase.totalCustomers}
  - Matching goal: ${c.customerBase.matchingGoalShape}
  - Avg deal size: ${c.customerBase.avgDealSize ?? "(n/a)"} USD
  - Engagement distribution: ${JSON.stringify(c.customerBase.lastEngagementDistribution)}

Lead pipeline:
  - Active leads: ${c.leadPipeline.totalActiveLeads}
  - Matching goal: ${c.leadPipeline.matchingGoalShape}
  - Weekly acquisition rate: ${c.leadPipeline.weeklyAcquisitionRate ?? "(n/a)"}
  - Sources: ${JSON.stringify(c.leadPipeline.bySource)}

Data readiness: ${c.dataReadiness.overall}
${c.dataReadiness.earliestDataDate ? `Earliest data: ${c.dataReadiness.earliestDataDate.toISOString().slice(0, 10)}` : ""}

# Computed projection

Projected organic ${input.unit} in window: ~${input.projectedOrganic}
Gap to goal: ${input.goalGapPercent.toFixed(0)}%${confidenceFrame}

# Your task

Produce strict JSON per the system-prompt format. Cite the historical numbers
above in honestAssessment. Each of the three paths must include a CONCRETE
operator action keyed to this tenant's actual data shape.`;
}

interface ParsedLLMCounsel {
  achievability: AchievabilityVerdict;
  honestAssessment: string;
  achievablePaths: AchievablePath[];
}

function parseLLMCounsel(rawText: string): ParsedLLMCounsel | null {
  try {
    // Strip optional markdown fences (LLM occasionally returns them despite
    // jsonMode hint — defense-in-depth).
    const stripped = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(stripped) as Partial<ParsedLLMCounsel>;
    if (
      !parsed.achievability ||
      typeof parsed.honestAssessment !== "string" ||
      !Array.isArray(parsed.achievablePaths)
    ) {
      return null;
    }
    if (
      parsed.achievability !== "feasible" &&
      parsed.achievability !== "stretch" &&
      parsed.achievability !== "unrealistic"
    ) {
      return null;
    }
    return {
      achievability: parsed.achievability,
      honestAssessment: parsed.honestAssessment,
      achievablePaths: parsed.achievablePaths.slice(0, 3) as AchievablePath[],
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Run the analyzer for an operator-stated goal. Pure compute — does NOT write
 * to Campaign fields (the tRPC procedure layer handles persistence + audit
 * log per Phase 1 Decision 4 Refinement 1).
 *
 * Fail-safe convention: any DB/LLM transient returns 'analyzer_unavailable'
 * variant. NEVER throws to caller. Mirrors sub-objective-gap-tracker.ts:56.
 */
export async function analyzeFeasibility(
  prisma: PrismaClient,
  redis: FeasibilityRedis | null,
  llm: LLMCompleteFn,
  params: AnalyzeFeasibilityParams,
): Promise<FeasibilityCounselResult> {
  const computedAt = new Date().toISOString();
  const windowDays = params.goalWindowDays ?? 365;

  try {
    const context = await getTenantHistoricalContext(prisma, redis, {
      tenantId: params.tenantId,
      goalShape: params.goalShape,
      windowDays,
    });

    // Cold-start path — Q4 lock + Q-ADD-E hardcoded templates. NO LLM call.
    if (context.dataReadiness.overall === "insufficient") {
      return {
        kind: "cold_start_counsel",
        counsel: buildColdStartCounsel(context.dataReadiness.missingDataTypes),
        computedAt,
      };
    }

    const projectedOrganic = projectOrganicCount(
      params.goalShape,
      context,
      windowDays,
    );
    const goalGapAbsolute = params.goalTarget - projectedOrganic;
    const goalGapPercent =
      params.goalTarget > 0
        ? Math.max(0, (goalGapAbsolute / params.goalTarget) * 100)
        : 0;
    const unit = unitForGoalShape(params.goalShape);
    const confidence = dominantConfidence(context);
    const lowConfidenceFraming = context.dataReadiness.overall === "partial";

    const userPrompt = buildFeasibilityPrompt({
      goalShape: params.goalShape,
      goalTarget: params.goalTarget,
      goalDescription: params.goalDescription,
      goalWindowDays: windowDays,
      context,
      projectedOrganic,
      goalGapPercent,
      unit,
      lowConfidenceFraming,
    });

    let llmResult: LLMCompleteResult;
    try {
      llmResult = await llm({
        tenantId: params.tenantId,
        tier: FEASIBILITY_LLM_TIER,
        systemPrompt: FEASIBILITY_SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: FEASIBILITY_LLM_MAX_TOKENS,
        callerTag: FEASIBILITY_LLM_CALLER_TAG,
      });
    } catch (err) {
      console.warn(
        `[feasibility-analyzer] llm-call-failed tenantId=${params.tenantId}:`,
        (err as Error)?.message ?? String(err),
      );
      return {
        kind: "analyzer_unavailable",
        message:
          "We couldn't analyze right now. Please try again in a moment, or proceed without counsel.",
        computedAt,
      };
    }

    const parsed = parseLLMCounsel(llmResult.text);
    if (!parsed) {
      console.warn(
        `[feasibility-analyzer] llm-parse-failed tenantId=${params.tenantId} preview=${llmResult.text.slice(0, 200)}`,
      );
      return {
        kind: "analyzer_unavailable",
        message:
          "We received an unexpected response from the analysis engine. Please try again.",
        computedAt,
      };
    }

    // Honor architect-classified achievability when LLM and math disagree
    // beyond a tolerance — math wins on the categorical bucket; LLM's
    // honestAssessment narrative still informs the operator.
    const mathClassification = classifyAchievability(goalGapPercent);
    const achievability =
      parsed.achievability === mathClassification
        ? parsed.achievability
        : mathClassification;

    const counsel: FeasibilityCounsel = {
      achievability,
      confidence,
      projectedOrganic: { count: projectedOrganic, unit },
      goalGap: { absolute: goalGapAbsolute, percent: goalGapPercent },
      honestAssessment: parsed.honestAssessment,
      achievablePaths: parsed.achievablePaths,
      contextProvenance: {
        hashUsed: hashGoalShape(params.goalShape),
        modelUsed: llmResult.model,
      },
    };
    return { kind: "feasibility_counsel", counsel, computedAt };
  } catch (err) {
    console.error(
      `[feasibility-analyzer] analyze-failed tenantId=${params.tenantId}:`,
      err,
    );
    return {
      kind: "analyzer_unavailable",
      message:
        "We couldn't analyze right now. Please try again in a moment, or proceed without counsel.",
      computedAt,
    };
  }
}

/**
 * Persist the analyzer result to Campaign.feasibilityAnalysis ONLY.
 * Called by the tRPC procedure layer after analyzeFeasibility. Idempotent
 * (overwrites prior result). The audit log emission lives in the tRPC layer
 * so prior-counsel snapshot is captured before overwrite.
 *
 * KAN-1185 NEW-1 layer separation — analyzer owns Campaign.feasibilityAnalysis;
 * generator (action-plan-generator.ts) owns Campaign.proposedPlan. Prior to
 * KAN-1185, this function wrote BOTH (analyzer's achievablePaths slice as a
 * proto-plan placeholder). The proposedPlan write was removed to establish
 * clean ownership — two writers on one column = ownership ambiguity.
 *
 * Layer responsibilities:
 *   Campaign.feasibilityAnalysis  ← "is the goal achievable?" (this analyzer)
 *   Campaign.proposedPlan         ← "how do we execute it?" (action-plan-generator)
 *   Campaign.committedPlan        ← "the live execution shape" (KAN-1190 commit)
 *
 * Fail-safe: write failures are logged + swallowed. Counsel result still
 * returns to operator; persistence is a side effect.
 */
export async function persistCampaignFeasibility(
  prisma: PrismaClient,
  campaignId: string,
  result: FeasibilityCounselResult,
): Promise<void> {
  try {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: {
        feasibilityAnalysis: result as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.warn(
      `[feasibility-analyzer] persist-failed campaignId=${campaignId}:`,
      (err as Error)?.message ?? String(err),
    );
  }
}
