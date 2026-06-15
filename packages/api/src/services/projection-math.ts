/**
 * KAN-1185 — Pure projection math shared between feasibility-analyzer
 * (KAN-1166 PR 2b) and action-plan-generator (this PR).
 *
 * Q-ADD-NEW-3 hoist: single-workspace extract-on-second-consumer discipline.
 * Both callers consume the same projection math; deduplicating here prevents
 * algorithm drift across the two services.
 *
 * Pure functions only — zero IO, fully testable in isolation. All inputs
 * are read-model objects (GoalShape + TenantHistoricalContext + windowDays);
 * no Prisma, no Redis, no LLM client touches this module.
 */
import type {
  GoalShape,
  TenantHistoricalContext,
  FeasibilityConfidence,
} from "@growth/shared";

// ─────────────────────────────────────────────
// Constants — internal to projection math
// ─────────────────────────────────────────────

/** Rough "meetings per lead" proxy when no conversion-rate signal is keyed
 *  to meetings (v0.1 limitation). Mirrors the analyzer's prior heuristic. */
const MEETINGS_PER_LEAD_PROXY = 0.1;

/** Confidence ordering — used by `dominantConfidence` to pick the lower
 *  (more honest) of the candidate signals. */
const CONFIDENCE_ORDER: FeasibilityConfidence[] = [
  "insufficient_data",
  "low",
  "medium",
  "high",
];

// ─────────────────────────────────────────────
// projectOrganicCount — extracted from feasibility-analyzer.ts
//
// Estimate organic projection over goalWindowDays based on the historical
// signal that best matches the GoalShape type. v0.1 simple math; the
// LLM refines narrative on top. NO behavioral drift from analyzer's prior
// implementation (verified by feasibility-analyzer.test.ts staying green).
// ─────────────────────────────────────────────

export function projectOrganicCount(
  goalShape: GoalShape,
  context: TenantHistoricalContext,
  goalWindowDays: number,
): number {
  const months = goalWindowDays / 30;

  switch (goalShape.type) {
    case "revenue": {
      const monthly = context.salesVelocity.revenuePerMonth ?? 0;
      return Math.round(monthly * months);
    }
    case "units": {
      const monthly = context.salesVelocity.unitsPerMonth ?? 0;
      return Math.round(monthly * months);
    }
    case "deals": {
      const leadsPerMonth =
        (context.leadPipeline.weeklyAcquisitionRate ?? 0) * (52 / 12);
      const conv = context.conversionRate.value ?? 0;
      return Math.round(leadsPerMonth * conv * months);
    }
    case "meetings":
    case "custom": {
      const leadsPerMonth =
        (context.leadPipeline.weeklyAcquisitionRate ?? 0) * (52 / 12);
      return Math.round(leadsPerMonth * MEETINGS_PER_LEAD_PROXY * months);
    }
  }
}

// ─────────────────────────────────────────────
// projectPerCohortContribution — KAN-1185 NEW
//
// Per-Pipeline projection: weight organic projection by the pipeline's
// share of the parent Campaign audience. Used by action-plan-generator to
// compute per-Pipeline projectedContribution for the ActionPlan output.
//
// D5 lock: the math is per-Pipeline; CONFIDENCE remains tenant-level
// (we never derive a per-Pipeline confidence from a single tenant signal).
// ─────────────────────────────────────────────

export function projectPerCohortContribution(
  goalShape: GoalShape,
  context: TenantHistoricalContext,
  goalWindowDays: number,
  cohortAudienceCount: number,
  totalAudienceCount: number,
): number {
  if (totalAudienceCount <= 0) return 0;
  const organic = projectOrganicCount(goalShape, context, goalWindowDays);
  const share = cohortAudienceCount / totalAudienceCount;
  return Math.round(organic * share);
}

// ─────────────────────────────────────────────
// dominantConfidence — extracted from feasibility-analyzer.ts
//
// Pick the lower of salesVelocity vs conversionRate confidence; the more
// honest framing per KAN-1166 doctrine. Tenant-level (D5 lock for KAN-1185).
// ─────────────────────────────────────────────

export function dominantConfidence(
  context: TenantHistoricalContext,
): FeasibilityConfidence {
  const a = context.salesVelocity.confidence;
  const b = context.conversionRate.confidence;
  return CONFIDENCE_ORDER.indexOf(a) < CONFIDENCE_ORDER.indexOf(b) ? a : b;
}

// ─────────────────────────────────────────────
// computeGapPercent — pure gap-math helper
//
// goalTarget − projectedOrganic = absolute gap; percent normalized to
// goalTarget. Clamps to 0 when projection meets-or-exceeds goal (surplus
// is not "negative gap" in operator-readable terms).
// ─────────────────────────────────────────────

export function computeGapPercent(
  goalTarget: number,
  projectedOrganic: number,
): number {
  if (goalTarget <= 0) return 0;
  const absolute = goalTarget - projectedOrganic;
  return Math.max(0, (absolute / goalTarget) * 100);
}
