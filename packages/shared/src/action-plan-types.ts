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

// ─────────────────────────────────────────────
// KAN-1186 — Action Plan Edit (4-family discriminated union)
//
// LLM classifies operator NL refinement into ONE family; refiner dispatches
// to the family-specific handler. E2 lock: NO generic "structural edit"
// path. Families have disjoint semantics + disjoint side effects.
//
//   stage          — rename / reorder / add / remove stages within a Pipeline
//                    (validated against STRATEGY_STAGE_BOUNDS)
//   first_actions  — modify per-Pipeline first-actions (channel / day / intent)
//   audience       — modify Campaign.audienceConditions; re-runs split heuristic
//                    + per-pipeline countAudience
//   dimension      — edit goal/timeline columns ON the Campaign row + emit
//                    separate audit type campaign.dimension_post_confirm_edit;
//                    triggers feasibility re-eval (NOT Action Plan regen)
// ─────────────────────────────────────────────

const StageEditOpEnum = z.enum(['rename', 'reorder', 'add', 'remove']);
const StageEditSchema = z.object({
  axis: z.literal('stage'),
  pipelineIndex: z.number().int().min(0).max(5),
  op: StageEditOpEnum,
  /** Target stage index for rename/remove/reorder. */
  stageIndex: z.number().int().min(0).max(4).optional(),
  /** New name on rename/add; new order index on reorder. */
  newName: z.string().min(1).max(60).optional(),
  newOrder: z.number().int().min(0).max(4).optional(),
  /** One-sentence stage description for add/rename. */
  newDescription: z.string().min(1).max(300).optional(),
});

const FirstActionEditOpEnum = z.enum(['edit', 'add', 'remove']);
const FirstActionEditSchema = z.object({
  axis: z.literal('first_actions'),
  pipelineIndex: z.number().int().min(0).max(5),
  op: FirstActionEditOpEnum,
  actionIndex: z.number().int().min(0).max(4).optional(),
  newDay: z.number().int().min(0).max(90).optional(),
  newChannel: z.enum(['email', 'sms', 'whatsapp']).optional(),
  newIntent: z.string().min(1).max(80).optional(),
  newDescription: z.string().min(1).max(300).optional(),
});

const AudienceEditSchema = z.object({
  axis: z.literal('audience'),
  /** Replacement audience conditions (LLM emits full new tree). */
  newAudienceConditions: AudienceConditionsSchema,
});

const DimensionEditFieldEnum = z.enum([
  'goalType',
  'goalTarget',
  'goalDescription',
  'goalProductId',
  'windowStart',
  'windowEnd',
]);
const DimensionEditSchema = z.object({
  axis: z.literal('dimension'),
  field: DimensionEditFieldEnum,
  newValue: z.union([z.string(), z.number(), z.null()]),
});

export const ActionPlanEditSchema = z.discriminatedUnion('axis', [
  StageEditSchema,
  FirstActionEditSchema,
  AudienceEditSchema,
  DimensionEditSchema,
]);
export type ActionPlanEdit = z.infer<typeof ActionPlanEditSchema>;
export type ActionPlanEditAxis = ActionPlanEdit['axis'];

// ─────────────────────────────────────────────
// RefineActionPlanResult — discriminated union from refineActionPlan()
//
// Mirrors generator's ActionPlanResult shape + refiner-specific variants:
//   - bounds_violation         — stage edit would violate STRATEGY_STAGE_BOUNDS
//   - no_plan_to_refine        — Campaign.proposedPlan is NULL (Q-ADD-NEW-C)
//   - concurrent_edit_conflict — Campaign.updatedAt drifted (Q-ADD-NEW-B)
// ─────────────────────────────────────────────

export type RefineActionPlanResult =
  | {
      kind: 'action_plan_refined';
      plan: ActionPlan;
      campaignId: string;
      editAxis: ActionPlanEditAxis;
    }
  | {
      kind: 'analyzer_unavailable';
      message: string;
      campaignId: string;
    }
  | {
      kind: 'no_plan_to_refine';
      message: string;
      campaignId: string;
    }
  | {
      kind: 'bounds_violation';
      message: string;
      campaignId: string;
      /** Which strategy bound was violated. */
      strategy: z.infer<typeof CampaignStrategyEnum>;
      attemptedStageCount: number;
    }
  | {
      kind: 'concurrent_edit_conflict';
      message: string;
      campaignId: string;
      /** Current persisted plan operator should re-apply on top of. */
      currentPlan: ActionPlan;
    };

export type RevertActionPlanRefinementResult =
  | {
      kind: 'action_plan_reverted';
      plan: ActionPlan;
      campaignId: string;
    }
  | {
      kind: 'no_refinement_to_revert';
      message: string;
      campaignId: string;
    }
  | {
      kind: 'analyzer_unavailable';
      message: string;
      campaignId: string;
    };

// ─────────────────────────────────────────────
// KAN-1190 — Commit multi-Pipeline result (J8 lock — discriminated)
//
// Commit flips Campaign.status draft → committed (J4 lock — NOT → active;
// preserves KAN-1001 INERT-post-commit doctrine) + materializes N Pipelines
// + N×M Stages in a single prisma.$transaction (J2 lock). First-actions
// are persisted ONLY as ActionPlanPipeline.firstActions on
// Campaign.committedPlan — no Action row writes this PR (J6 INERT lock;
// enqueue execution substrate tracked in KAN-1199 V1 follow-up).
//
// Discriminated variants:
//   committed                 — happy path; N pipelines + status flipped
//   already_committed         — idempotent re-commit (J8); same IDs
//   bounds_violation          — STRATEGY_STAGE_BOUNDS re-check failed
//                               at commit time (J3 defense-in-depth — plan
//                               was valid at refine time but drifted)
//   concurrent_edit_conflict  — Campaign.updatedAt drifted (J11 lock —
//                               matches refiner NEW-B variant shape)
//   analyzer_unavailable      — transient DB/tx failure; UI surfaces retry
// ─────────────────────────────────────────────

/** Snapshot of what got committed — mirrored to Campaign.committedPlan
 *  (Json column) so audit + future UI can replay the commit-time shape
 *  without joining N Pipeline/Stage rows. */
export interface CommittedPlanSnapshot {
  /** Operator-readable Campaign name at commit time. */
  campaignName: string;
  /** ISO-8601 commit timestamp (also written to audit_log.payload). */
  committedAt: string;
  /** The ActionPlan that was committed (deep copy of proposedPlan). */
  plan: ActionPlan;
  /** Per-Pipeline persisted IDs (parallel to plan.pipelines). */
  pipelineIds: string[];
}

export type CommitActionPlanResult =
  | {
      kind: 'committed';
      campaignId: string;
      /** Persisted Pipeline IDs in plan.pipelines order. */
      pipelineIds: string[];
      /** Per-Pipeline Stage IDs (parallel to pipelineIds × proposedStages). */
      stageIds: string[][];
      /** Snapshot persisted to Campaign.committedPlan. */
      committedPlan: CommittedPlanSnapshot;
    }
  | {
      kind: 'already_committed';
      campaignId: string;
      pipelineIds: string[];
      /** Snapshot read back from Campaign.committedPlan. */
      committedPlan: CommittedPlanSnapshot;
    }
  | {
      kind: 'bounds_violation';
      message: string;
      campaignId: string;
      strategy: z.infer<typeof CampaignStrategyEnum>;
      attemptedStageCount: number;
    }
  | {
      kind: 'concurrent_edit_conflict';
      message: string;
      campaignId: string;
      /** Current persisted plan operator should re-apply on top of. */
      currentPlan: ActionPlan;
    }
  | {
      kind: 'analyzer_unavailable';
      message: string;
      campaignId: string;
    };
