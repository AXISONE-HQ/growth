/**
 * KAN-1000 Campaign Layer Slice 2 — full campaign proposal shape.
 *
 * Slice 1 (KAN-997) shipped audience-only NL → conditions + count.
 * Slice 2 extends with the "AI proposes, human validates" full draft:
 * audience + inferred objective + strategy + proposed stages + first-
 * actions plan. Still 100% read-only; this shape is the LLM emission
 * contract + the wire format for /campaigns proposal preview.
 *
 * Persistence/activation arrives in Slice 3 (architect-gated on
 * Slice 0 schema). This proposal type lives WITHOUT a corresponding
 * Campaign DB model — fully transient.
 */
import { z } from 'zod';
import { AudienceConditionsSchema } from './audience-conditions.js';

// ─────────────────────────────────────────────
// Strategy — user-facing 4-value subset.
//
// The full backend StrategyType enum has 6 values:
//   direct / re_engage / trust_build / guided / escalate / wait
// The last 2 (escalate, wait) are control-flow primitives for the
// Decision engine, NOT campaign strategies. Slice 2 LLM picks
// exclusively from the 4 user-facing strategies.
// ─────────────────────────────────────────────
export const CampaignStrategyEnum = z.enum([
  'direct',       // "Direct Conversion" — push toward conversion for high-intent contacts
  're_engage',    // "Re-engagement" — win-back dormant/churned contacts
  'trust_build',  // "Trust Building" — relationship-building for early-stage/at-risk
  'guided',       // "Guided Assistance" — educational approach for evaluating contacts
]);
export type CampaignStrategy = z.infer<typeof CampaignStrategyEnum>;

/**
 * Human-readable strategy labels matching the AI Configuration tab
 * copy in /settings (KAN-990 D.6). Single source of truth for any
 * surface rendering the proposal.
 */
export const CAMPAIGN_STRATEGY_LABELS: Record<CampaignStrategy, string> = {
  direct: 'Direct Conversion',
  re_engage: 'Re-engagement',
  trust_build: 'Trust Building',
  guided: 'Guided Assistance',
};

// ─────────────────────────────────────────────
// First-action — described, NEVER dispatched
// ─────────────────────────────────────────────

const FirstActionChannelEnum = z.enum(['email', 'sms', 'whatsapp']);

export const FirstActionSchema = z.object({
  /** Days from campaign start (Day 0 = launch). */
  day: z.number().int().min(0).max(90),
  channel: FirstActionChannelEnum,
  /** Short intent label (e.g., "re-engagement opener", "value reminder"). */
  intent: z.string().min(1).max(80),
  /** One-sentence human-readable description of what the action does. */
  description: z.string().min(1).max(300),
});
export type FirstAction = z.infer<typeof FirstActionSchema>;

// ─────────────────────────────────────────────
// Proposed stage — described, no Stage row created
// ─────────────────────────────────────────────

export const ProposedStageSchema = z.object({
  name: z.string().min(1).max(60),
  /** 0-indexed display order. */
  order: z.number().int().min(0),
  /** One-sentence description of what happens in this stage. */
  description: z.string().min(1).max(300),
});
export type ProposedStage = z.infer<typeof ProposedStageSchema>;

// ─────────────────────────────────────────────
// Inferred objective — MUST map to an existing catalog row by id.
// LLM picks from a catalog injected into the system prompt; never
// invents a new one.
// ─────────────────────────────────────────────

export const InferredObjectiveSchema = z.object({
  /** Objective.id from the tenant catalog (LLM-selected). */
  id: z.string().min(1),
  /** Mirror of Objective.name for surface rendering. */
  name: z.string().min(1),
  /** Mirror of Objective.type (free-form catalog key, e.g., 'reactivate'). */
  type: z.string().min(1),
});
export type InferredObjective = z.infer<typeof InferredObjectiveSchema>;

// ─────────────────────────────────────────────
// Audience block — reuses Slice 1 conditions + adds count +
// historicalValueUsd from the same query path
// ─────────────────────────────────────────────

export const ProposalAudienceSchema = z.object({
  conditions: AudienceConditionsSchema,
  count: z.number().int().min(0),
  /** SUM(Order.grandTotal) where Order.contact matches the audience + Order.currency='USD'.
   *  Labeled "Past USD revenue in this audience" on the surface; NOT a forecast. */
  historicalValueUsd: z.number().min(0),
});
export type ProposalAudience = z.infer<typeof ProposalAudienceSchema>;

// ─────────────────────────────────────────────
// Full proposal — what audience.propose returns
// ─────────────────────────────────────────────

export const CampaignProposalSchema = z.object({
  /** Suggested campaign name derived from the NL goal. User can edit
   *  in the preview (Slice 2 Story 2.3). */
  name: z.string().min(1).max(120),
  /** Optional date window for the campaign. LLM may extract from NL
   *  ("over the next 30 days"); user can edit in the preview. Both
   *  optional — no window = open-ended. */
  windowStartUtc: z.string().datetime().nullable(),
  windowEndUtc: z.string().datetime().nullable(),
  audience: ProposalAudienceSchema,
  objective: InferredObjectiveSchema,
  strategy: CampaignStrategyEnum,
  proposedStages: z.array(ProposedStageSchema).min(1).max(8),
  firstActions: z.array(FirstActionSchema).min(1).max(10),
});
export type CampaignProposal = z.infer<typeof CampaignProposalSchema>;

// ─────────────────────────────────────────────
// Discriminated propose-result — mirrors textToSegment's shape.
// "thin" + "ambiguous" propagate honestly through the proposal layer.
// ─────────────────────────────────────────────

export type ProposeResult =
  | { kind: 'proposal'; proposal: CampaignProposal; message: string }
  | { kind: 'thin'; proposal: CampaignProposal; message: string }
  | { kind: 'ambiguous'; clarifyingQuestion: string };
