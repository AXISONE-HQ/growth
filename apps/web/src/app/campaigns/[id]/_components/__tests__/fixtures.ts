/**
 * KAN-1166 PR 3-tests — Shared fixtures for FeasibilityCounselCard variant
 * RTL coverage.
 *
 * Discriminated union fixture builders keep test files focused on intent
 * rather than fixture plumbing. Defaults match the analyzer's plausible
 * shape for an 8% conversion / 5 deals-per-month tenant baseline.
 */
import type {
  ColdStartCounsel,
  FeasibilityCounsel,
  FeasibilityCounselResult,
  AchievabilityVerdict,
  FeasibilityConfidence,
  ActionPlan,
  CommittedPlanSnapshot,
} from "@growth/shared";

export function feasibilityCounselFixture(
  overrides: Partial<FeasibilityCounsel> = {},
): FeasibilityCounsel {
  return {
    achievability: "stretch",
    confidence: "medium",
    projectedOrganic: { count: 15, unit: "units" },
    goalGap: { absolute: 35, percent: 70 },
    honestAssessment:
      "Based on your 8% conversion rate and 5 deals/month, you'll close ~15 units organically. " +
      "Your goal of 50 is a stretch — 70% short on current trajectory.",
    achievablePaths: [
      {
        label: "Increase Lead Volume",
        description: "Bring more qualified leads into the top of funnel.",
        requiredAction: "Increase weekly acquisition from 5 to 12 leads.",
        estimatedImpact: "Closes ~60% of the gap if conversion holds at 8%.",
      },
      {
        label: "Improve Conversion",
        description: "Convert more of your current leads.",
        requiredAction: "Reduce lead-to-close cycle by 15 days.",
        estimatedImpact: "Closes ~25% of the gap.",
      },
      {
        label: "Extend Window",
        description: "Give the math more time.",
        requiredAction: "Push goal window from 365 to 450 days.",
        estimatedImpact: "Closes the remaining gap on current trajectory.",
      },
    ],
    contextProvenance: {
      hashUsed: "h-test-001",
      modelUsed: "claude-sonnet-4-6",
    },
    ...overrides,
  };
}

export function coldStartCounselFixture(
  overrides: Partial<ColdStartCounsel> = {},
): ColdStartCounsel {
  return {
    missingDataTypes: [
      "sales_history",
      "customer_base",
      "lead_history",
      "engagement_history",
    ],
    acquisitionRecommendations: [
      {
        dataType: "sales_history",
        operatorActions: ["Upload past 12 mo orders"],
        expectedUnlock: "Enables revenue counsel after ≥30 closed deals.",
      },
      {
        dataType: "customer_base",
        operatorActions: ["Sync HubSpot"],
        expectedUnlock: "Enables upsell counsel.",
      },
      {
        dataType: "lead_history",
        operatorActions: ["Connect Meta Lead Ads"],
        expectedUnlock: "Enables conversion projection counsel.",
      },
      {
        dataType: "engagement_history",
        operatorActions: ["Connect email/SMS provider"],
        expectedUnlock: "Enables re-engagement counsel.",
      },
    ],
    message:
      "We need data to give you confident feasibility counsel. Start by uploading your past orders or syncing your CRM.",
    ...overrides,
  };
}

export function counselResultColdStart(
  overrides: Partial<ColdStartCounsel> = {},
): FeasibilityCounselResult {
  return {
    kind: "cold_start_counsel",
    counsel: coldStartCounselFixture(overrides),
    computedAt: "2026-06-12T12:00:00Z",
  };
}

export function counselResultFeasibility(
  overrides: Partial<FeasibilityCounsel> = {},
): FeasibilityCounselResult {
  return {
    kind: "feasibility_counsel",
    counsel: feasibilityCounselFixture(overrides),
    computedAt: "2026-06-12T12:00:00Z",
  };
}

export function counselResultUnavailable(
  message = "Analyzer temporarily unavailable. Try again in a moment.",
): FeasibilityCounselResult {
  return {
    kind: "analyzer_unavailable",
    message,
    computedAt: "2026-06-12T12:00:00Z",
  };
}

export const ALL_VERDICTS: AchievabilityVerdict[] = [
  "feasible",
  "stretch",
  "unrealistic",
];

export const ALL_CONFIDENCES: FeasibilityConfidence[] = [
  "high",
  "medium",
  "low",
  "insufficient_data",
];

// ─────────────────────────────────────────────
// KAN-1191 — ActionPlan + CommittedPlanSnapshot fixtures.
//
// Canonical ActionPlan with `direct` strategy (minStages=2 / maxStages=4 per
// STRATEGY_STAGE_BOUNDS) at 3 stages — avoids the re_engage minStages=3 lower
// bound issue surfaced by KAN-1208 fix-forward. Single-pipeline default; pass
// `overrides.pipelines` to test multi-pipeline rendering. Audience uses the
// simplest valid leaf shape (field + op + values) per AudienceConditionsSchema.
//
// Memos: discriminated_union_rejected_variant_doctrine + surface_completeness_doctrine
// ─────────────────────────────────────────────

export function actionPlanFixture(
  overrides: Partial<ActionPlan> = {},
): ActionPlan {
  return {
    pipelines: [
      {
        name: "Inbound Lead Pipeline",
        segment: "new_leads",
        strategy: "direct",
        audienceConditions: {
          field: "lifecycleStage",
          op: "in",
          values: ["lead"],
        },
        audienceCount: 300,
        proposedStages: [
          { name: "Outreach", order: 0, description: "Day-0 outbound" },
          { name: "Qualify", order: 1, description: "Discovery call" },
          { name: "Close", order: 2, description: "Proposal + close" },
        ],
        firstActions: [
          {
            day: 0,
            channel: "email",
            intent: "outreach",
            description: "Day-0 personalized intro",
          },
        ],
        projectedContribution: 15,
        shareOfGoal: 30,
      },
    ],
    confidence: "high",
    confidenceReason: "200+ closed deals over 365d",
    gapAnalysis: {
      goalTarget: 50,
      projectedOrganic: 15,
      gapAbsolute: 35,
      gapPercent: 70,
      goalWindowDays: 90,
    },
    modelUsed: "claude-sonnet-4-6",
    generatedAt: "2026-06-15T19:00:00.000Z",
    ...overrides,
  };
}

export function committedPlanSnapshotFixture(
  overrides: Partial<CommittedPlanSnapshot> = {},
): CommittedPlanSnapshot {
  const plan = overrides.plan ?? actionPlanFixture();
  return {
    campaignName: "Q3 Push",
    committedAt: "2026-06-15T20:00:00.000Z",
    plan,
    pipelineIds: ["pipeline-1"],
    ...overrides,
  };
}
