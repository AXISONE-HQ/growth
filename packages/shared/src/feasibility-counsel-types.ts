/**
 * KAN-1166 PR 2b — Feasibility Analyzer shared types.
 *
 * Output contract for the analyzer (packages/api/src/services/feasibility-
 * analyzer.ts). Consumed by:
 *   - apps/api campaigns.analyzeFeasibility tRPC procedure (writes to
 *     Campaign.feasibilityAnalysis + Campaign.proposedPlan JSON fields)
 *   - apps/web PR 3 chat UI (renders counsel + paths to operator)
 *
 * Discriminated union over the three branching states:
 *   - cold_start_counsel — dataReadiness.overall === 'insufficient' →
 *     deterministic template counsel; NO LLM call (PR 2b lock)
 *   - feasibility_counsel — partial/sufficient → LLM-synthesized counsel
 *     with achievability verdict + projected organic + three-paths math
 *   - analyzer_unavailable — LLM transient post-retry-exhaustion;
 *     graceful degradation; client surfaces try-again message
 *
 * Hoisted to packages/shared per Memo 37 — PR 3 chat UI consumes
 * cross-workspace; algorithm-drift class eliminated.
 */
import type { FeasibilityConfidence, RequiredDataType } from "./feasibility-context-types.js";

// ─────────────────────────────────────────────
// FeasibilityCounselResult — discriminated return shape
// ─────────────────────────────────────────────

export type FeasibilityCounselResult =
  | {
      kind: "cold_start_counsel";
      counsel: ColdStartCounsel;
      /** ISO timestamp. Operator UI shows "computed N minutes ago". */
      computedAt: string;
    }
  | {
      kind: "feasibility_counsel";
      counsel: FeasibilityCounsel;
      computedAt: string;
    }
  | {
      kind: "analyzer_unavailable";
      /** Operator-facing message — chat UI surfaces this verbatim. */
      message: string;
      computedAt: string;
    };

// ─────────────────────────────────────────────
// FeasibilityCounsel — the "we ran the analysis" shape
// ─────────────────────────────────────────────

export type AchievabilityVerdict = "feasible" | "stretch" | "unrealistic";

export interface ProjectedOrganic {
  /** Numeric projection (e.g. 15 for "you'll close ~15 units"). */
  count: number;
  /** Operator-readable unit ("units", "deals", "meetings", "USD"). */
  unit: string;
}

export interface GoalGap {
  /** Absolute gap (goalTarget - projectedOrganic). Negative when goal is
   *  surpassable on current trajectory (achievability='feasible' likely). */
  absolute: number;
  /** Percent of goalTarget the gap represents. 0 = already on track;
   *  100+ = unrealistic. */
  percent: number;
}

export interface AchievablePath {
  /** Short label for the chat UI's path card header. */
  label: string;
  /** One-sentence description of what this path does. */
  description: string;
  /** Concrete operator action ("Increase weekly lead acquisition from 12 to 25"). */
  requiredAction: string;
  /** Honest estimate of impact ("Closes ~60% of the gap in 90 days"). */
  estimatedImpact: string;
}

export interface ContextProvenance {
  /** Cache-key hash from getTenantHistoricalContext (audit + reproducibility). */
  hashUsed: string;
  /** LLM model identifier used for this counsel (e.g. "claude-sonnet-4-6"). */
  modelUsed: string;
}

export interface FeasibilityCounsel {
  achievability: AchievabilityVerdict;
  /** Mirrors the dominant signal's confidence (e.g. conversionRate.confidence). */
  confidence: FeasibilityConfidence;
  projectedOrganic: ProjectedOrganic;
  goalGap: GoalGap;
  /** 200-400 char operator-facing summary. e.g. "Based on your 8% historical
   *  ABC conversion rate and 200 active leads, you'll close ~15 units organically
   *  by Q1. Your goal of 50 units is a stretch — 70% short on current trajectory." */
  honestAssessment: string;
  /** Exactly 3 paths per Q10 v0.1 lock. LLM-generated; format-stable. */
  achievablePaths: AchievablePath[];
  contextProvenance: ContextProvenance;
}

// ─────────────────────────────────────────────
// ColdStartCounsel — the "we need data first" shape (NO LLM)
// ─────────────────────────────────────────────

export interface DataAcquisitionRecommendation {
  /** Which substrate the operator should populate to unlock counsel. */
  dataType: RequiredDataType;
  /** Concrete operator actions per Q-ADD-E template. e.g.
   *  ["Upload your past 12 months of orders via CSV", "Connect your Shopify
   *   account"] */
  operatorActions: string[];
  /** Honest expected-unlock framing. e.g. "Enables revenue feasibility counsel
   *  with high confidence after ≥30 closed orders." */
  expectedUnlock: string;
}

export interface ColdStartCounsel {
  /** Mirrors dataReadiness.missingDataTypes from FeasibilityContextService. */
  missingDataTypes: RequiredDataType[];
  /** Per-substrate operator-actionable counsel (Q-ADD-E hardcoded templates). */
  acquisitionRecommendations: DataAcquisitionRecommendation[];
  /** Operator-facing summary message. Hardcoded per template. */
  message: string;
}
