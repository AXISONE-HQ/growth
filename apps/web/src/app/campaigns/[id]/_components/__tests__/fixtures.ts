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
