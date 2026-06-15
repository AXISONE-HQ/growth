/**
 * KAN-1185 — Action Plan generator shared types (Campaign Module Reset PR 4).
 *
 * Action Plan = the structured execution shape derived from the 4 Confirmed
 * dimensions (Product → Objectives → Timeline → Audience) plus tenant
 * historical context. Persisted to `Campaign.proposedPlan` (Json column).
 *
 * Layer separation locked by Q-ADD-NEW-1 (KAN-1185 Phase 1):
 *   - `Campaign.feasibilityAnalysis` ← analyzer counsel (achievability + paths)
 *   - `Campaign.proposedPlan`        ← Action Plan generator (this contract)
 *   - `Campaign.committedPlan`       ← KAN-1190 commit flip (not this PR)
 *
 * Honest counsel doctrine (D5 lock): ONE tenant-level confidence — never
 * per-Pipeline. Per-Pipeline structurally carries `projectedContribution`
 * + `shareOfGoal` (math, not fabricated specificity).
 */
import { z } from 'zod';
import { AudienceConditionsSchema } from './audience-conditions.js';
import {
  CampaignStrategyEnum,
  FirstActionSchema,
  ProposedStageSchema,
} from './campaign-proposal.js';
// Reuse the existing PipelineSegment substrate from objective-proposal.ts —
// keep one source of truth for the Prisma enum mirror (lockstep with
// packages/db/prisma/schema.prisma:1179).
import { PipelineSegmentSchema } from './objective-proposal.js';
import type { PipelineSegment } from './objective-proposal.js';

// ─────────────────────────────────────────────
// Per-Pipeline slice
//
// One per Pipeline the multi-pipeline split produced. NO confidence field
// (D5 lock): tenant-level confidence lives on the parent ActionPlan.
// ─────────────────────────────────────────────

export const ActionPlanPipelineSchema = z.object({
  /** Operator-readable pipeline name (LLM-generated, bounded 3-80 chars). */
  name: z.string().min(3).max(80),
  /** Cohort bucket from the deterministic split. */
  segment: PipelineSegmentSchema,
  /** Strategy picked for this pipeline (LLM-selected per per-strategy bounds). */
  strategy: CampaignStrategyEnum,
  /** Audience subset for this pipeline (subset of Campaign.audienceConditions). */
  audienceConditions: AudienceConditionsSchema,
  /** Count of contacts in this pipeline's audience at generation time. */
  audienceCount: z.number().int().min(0),
  /** LLM-generated stages (2-5 per strategy bounds, names within strategy bounds). */
  proposedStages: z.array(ProposedStageSchema).min(2).max(5),
  /** LLM-generated first actions (1-5, declarative — KAN-1190 commit enqueues). */
  firstActions: z.array(FirstActionSchema).min(1).max(5),
  /** Projected count toward Campaign.goalTarget from this pipeline.
   *  Math: audienceCount × tenant-level conversionRate × goalWindow weight. */
  projectedContribution: z.number().int().min(0),
  /** Pipeline's share of Campaign goal (0-100). Sums across pipelines ≤ 100. */
  shareOfGoal: z.number().min(0).max(100),
});
export type ActionPlanPipeline = z.infer<typeof ActionPlanPipelineSchema>;

// ─────────────────────────────────────────────
// Gap analysis — Campaign-level math from FeasibilityContextService
// ─────────────────────────────────────────────

export const ActionPlanGapAnalysisSchema = z.object({
  /** Operator-stated target from Campaign.goalTarget. */
  goalTarget: z.number().int().min(0),
  /** Sum of per-pipeline projectedContribution. */
  projectedOrganic: z.number().int().min(0),
  /** goalTarget − projectedOrganic (negative if surplus). */
  gapAbsolute: z.number().int(),
  /** Gap as percent of goalTarget (0-100). 0 = at-or-above goal. */
  gapPercent: z.number().min(0).max(100),
  /** Goal window in days (mirror of Campaign.windowEnd − windowStart). */
  goalWindowDays: z.number().int().min(1),
});
export type ActionPlanGapAnalysis = z.infer<typeof ActionPlanGapAnalysisSchema>;

// ─────────────────────────────────────────────
// ActionPlan — top-level shape persisted to Campaign.proposedPlan
//
// D5 lock: single `confidence` field — tenant-level, NOT per-Pipeline.
// D7 lock: this shape is also what `audit_log.payload` carries on
// action_type='action_plan_generated' for the forensic chain.
// ─────────────────────────────────────────────

export const ActionPlanConfidenceEnum = z.enum(['high', 'medium', 'low']);
export type ActionPlanConfidence = z.infer<typeof ActionPlanConfidenceEnum>;

export const ActionPlanSchema = z.object({
  /** Multi-pipeline split — 1-N pipelines. Single-pipeline = `other` segment. */
  pipelines: z.array(ActionPlanPipelineSchema).min(1).max(6),
  /** Tenant-level confidence (D5 lock — single source from FCS dominantConfidence). */
  confidence: ActionPlanConfidenceEnum,
  /** Human-readable confidence reason (e.g., "30+ closed deals over 90d"). */
  confidenceReason: z.string().min(1).max(200),
  /** Campaign-level gap math (NOT per-pipeline; weighted by audience share). */
  gapAnalysis: ActionPlanGapAnalysisSchema,
  /** Model fingerprint for forensic chain. */
  modelUsed: z.string().min(1),
  /** ISO-8601 generation timestamp. */
  generatedAt: z.string().datetime(),
});
export type ActionPlan = z.infer<typeof ActionPlanSchema>;

// ─────────────────────────────────────────────
// ActionPlanResult — discriminated union from generateActionPlan()
//
// Mirrors FeasibilityCounselResult pattern: fail-safe analyzer_unavailable
// variant when transient errors hit, so chat UI is never blocked.
// ─────────────────────────────────────────────

export type ActionPlanResult =
  | {
      kind: 'action_plan';
      plan: ActionPlan;
      campaignId: string;
    }
  | {
      kind: 'analyzer_unavailable';
      message: string;
      campaignId: string;
    }
  | {
      kind: 'insufficient_dimensions';
      message: string;
      campaignId: string;
      missing: string[];
    };

// ─────────────────────────────────────────────
// Per-strategy stage bounds (D2 lock — LLM picks within bounds)
//
// Exposed for the generator's system prompt + unit tests. NOT hardcoded
// stage names — the LLM generates names within the count + role bounds.
// ─────────────────────────────────────────────

export interface StrategyStageBounds {
  /** Minimum stage count (LLM may not go below). */
  minStages: number;
  /** Maximum stage count (LLM may not go above). */
  maxStages: number;
  /** Role hints — LLM uses these as soft anchors for stage purposes. */
  roleHints: string[];
}

export const STRATEGY_STAGE_BOUNDS: Record<
  z.infer<typeof CampaignStrategyEnum>,
  StrategyStageBounds
> = {
  direct: {
    minStages: 2,
    maxStages: 4,
    roleHints: ['outreach', 'qualify', 'demo_or_proposal', 'close'],
  },
  re_engage: {
    minStages: 3,
    maxStages: 5,
    roleHints: ['re_open', 'pain_check', 'value_remind', 'qualify', 'close'],
  },
  trust_build: {
    minStages: 3,
    maxStages: 5,
    roleHints: ['introduce', 'educate', 'social_proof', 'qualify', 'soft_close'],
  },
  guided: {
    minStages: 2,
    maxStages: 4,
    roleHints: ['educate', 'compare', 'recommend', 'close'],
  },
};
