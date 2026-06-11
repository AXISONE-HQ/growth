/**
 * KAN-1166 PR 2a — FeasibilityContextService shared types.
 *
 * GoalShape mirrors Campaign.goalType + goalProductId + segment overlay
 * (the 5-value taxonomy declared inline in schema.prisma:576). Discriminated
 * by `type` so callers exhaustive-switch over the variants.
 *
 * TenantHistoricalContext is the FeasibilityContextService primary-method
 * return type — descriptive interfaces (no runtime validation needed; produced
 * + consumed internally within packages/api by the Feasibility Analyzer in
 * PR 2b + the chat UI surface in PR 3).
 *
 * RequiredDataType is the data-acquisition taxonomy (Q8 chat-UI surfaces
 * "this goal needs X to give confident counsel"; cold-start path surfaces
 * missingDataTypes per Q4 brief).
 *
 * Hoisted to packages/shared per Memo 37: PR 2b consumer + PR 3 chat UI both
 * import these types; cross-workspace single-source-of-truth eliminates
 * algorithm-drift class banked across KAN-1140 + KAN-1097.
 */
import { z } from 'zod';

// ─────────────────────────────────────────────
// GoalShape — operator's outcome target.
//
// 5 variants mirror Campaign.goalType inline taxonomy (schema.prisma:576).
// `productId` is REQUIRED for 'units' (you can't count units without naming
// a product); OPTIONAL for 'revenue' (revenue can be all-product OR scoped).
// `segmentId` is OPTIONAL on all numeric variants (audience overlay).
// 'custom' carries operator free-text — analyzer's LLM interprets at counsel
// synthesis time.
// ─────────────────────────────────────────────

export const GoalShapeRevenueSchema = z.object({
  type: z.literal('revenue'),
  productId: z.string().optional(),
  segmentId: z.string().optional(),
});

export const GoalShapeUnitsSchema = z.object({
  type: z.literal('units'),
  productId: z.string(),
  segmentId: z.string().optional(),
});

export const GoalShapeDealsSchema = z.object({
  type: z.literal('deals'),
  segmentId: z.string().optional(),
});

export const GoalShapeMeetingsSchema = z.object({
  type: z.literal('meetings'),
  segmentId: z.string().optional(),
});

export const GoalShapeCustomSchema = z.object({
  type: z.literal('custom'),
  description: z.string().min(1).max(500),
});

export const GoalShapeSchema = z.discriminatedUnion('type', [
  GoalShapeRevenueSchema,
  GoalShapeUnitsSchema,
  GoalShapeDealsSchema,
  GoalShapeMeetingsSchema,
  GoalShapeCustomSchema,
]);
export type GoalShape = z.infer<typeof GoalShapeSchema>;

// ─────────────────────────────────────────────
// Confidence taxonomy — applied to conversionRate + salesVelocity + (implicitly)
// data-readiness gradient. 4-state per Q4 brief: 'insufficient_data' is the
// cold-start signal; 'low'/'medium'/'high' are the populated-data gradient.
// ─────────────────────────────────────────────

export type FeasibilityConfidence =
  | 'high'
  | 'medium'
  | 'low'
  | 'insufficient_data';

// ─────────────────────────────────────────────
// RequiredDataType — data-acquisition taxonomy (Q4 + Q8).
//
// Mirrors the four authoritative data substrates the analyzer reasons over:
//   sales_history     → Order rows + Deal won/lost transitions
//   customer_base     → Contact rows with lifecycleStage=customer
//   lead_history      → Contact rows with lifecycleStage=lead + acquisitions
//   engagement_history → Engagement rows with signalClass='positive' (Q3 lock)
//
// New data types added here ripple to getRequiredDataTypesForGoal + the
// dataReadiness.missingDataTypes signal + analyzer-side LLM counsel templates.
// ─────────────────────────────────────────────

export type RequiredDataType =
  | 'sales_history'
  | 'customer_base'
  | 'lead_history'
  | 'engagement_history';

// ─────────────────────────────────────────────
// TenantHistoricalContext — primary FeasibilityContextService return type.
//
// Sub-interfaces match the brief Section "Return type" verbatim, with two
// Q-resolved refinements:
//   - lastEngagementDistribution cohort: signalClass='positive' only (Q3)
//   - confidence reasoning: operator-readable string per signal (Q4)
// ─────────────────────────────────────────────

export interface ConversionRateSignal {
  /** e.g. 0.082 for 8.2%. NULL when insufficient_data. */
  value: number | null;
  /** Number of leads/deals that went into the calculation. */
  sampleSize: number;
  confidence: FeasibilityConfidence;
  /** Operator-readable explanation for the confidence level.
   *  e.g. "Based on 47 closed deals in the last 12 months." */
  confidenceReason: string;
}

export interface SalesVelocitySignal {
  /** NULL when insufficient_data. */
  unitsPerMonth: number | null;
  /** NULL when insufficient_data. */
  revenuePerMonth: number | null;
  /** Window-function comparison: recent half-window vs prior half-window
   *  per Q2 resolution. 'insufficient_data' when either half has < 5 rows. */
  trendDirection: 'up' | 'stable' | 'down' | 'insufficient_data';
  confidence: FeasibilityConfidence;
}

export interface EngagementDistribution {
  /** Customers whose most recent positive engagement is < 30 days ago. */
  lt30days: number;
  /** Customers whose most recent positive engagement is 30 – 89 days ago. */
  lt90days: number;
  /** Customers whose most recent positive engagement is 90 – 179 days ago. */
  lt180days: number;
  /** Customers whose most recent positive engagement is 180 – 364 days ago. */
  lt365days: number;
  /** Customers with no positive engagement in 365+ days (or never). */
  stale: number;
}

export interface CustomerBaseSignal {
  totalCustomers: number;
  /** Customers matching the goalShape's audience overlay (productId / segmentId).
   *  Equal to totalCustomers when goalShape carries no overlay. */
  matchingGoalShape: number;
  /** NULL when sample is too small (< 5 deals). */
  avgDealSize: number | null;
  /** Per Q3 resolution: cohort gated to Engagement.signalClass='positive'. */
  lastEngagementDistribution: EngagementDistribution;
}

export interface LeadPipelineSignal {
  totalActiveLeads: number;
  matchingGoalShape: number;
  /** Free-form source labels from Contact.source enum (e.g., 'email_inbox',
   *  'facebook', 'referral'). Counts per source over the window. */
  bySource: Record<string, number>;
  /** Average new leads per week over the window. NULL when no leads. */
  weeklyAcquisitionRate: number | null;
}

export interface DataReadinessSignal {
  /** Q4 3-state gradient:
   *   'sufficient'   = ≥30 closed deals AND ≥90 days Order history AND ≥90 days Contact history
   *   'partial'      = ≥10 closed deals OR ≥30 days Order/Contact history
   *   'insufficient' = below 'partial' → analyzer activates cold-start path */
  overall: 'sufficient' | 'partial' | 'insufficient';
  /** Data types the tenant is missing — drives Q8 data-acquisition counsel. */
  missingDataTypes: RequiredDataType[];
  /** Earliest data point across Orders + Contacts + Engagements. Helps the
   *  analyzer reason about whether the requested windowDays is achievable. */
  earliestDataDate: Date | null;
}

export interface WindowMeta {
  windowStart: Date;
  windowEnd: Date;
  /** Milliseconds since the cache entry was written. 0 on cache-miss compute
   *  (a freshly-computed value has zero staleness by definition). */
  cacheAge: number;
}

export interface TenantHistoricalContext {
  conversionRate: ConversionRateSignal;
  salesVelocity: SalesVelocitySignal;
  customerBase: CustomerBaseSignal;
  leadPipeline: LeadPipelineSignal;
  dataReadiness: DataReadinessSignal;
  windowMeta: WindowMeta;
}
