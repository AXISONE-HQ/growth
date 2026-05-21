/**
 * KAN-962 (slice 2a) — shared types for the objective + pipeline proposer.
 *
 * `objectives.propose(entityScope)` returns `Array<ProposedPipeline>` —
 * one row per (objective × segment) tuple that the proposer recommends
 * showing to the tenant. Each row carries deterministic evidence counts
 * (DB queries, not LLM guesses) + LLM-generated name + reason.
 *
 * The Designer's screen renders these directly. The "Adopt" action
 * persists `selections` into TenantObjectiveSelection via `.adopt`.
 */
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────
// Pipeline segment — mirrors Prisma's PipelineSegment enum.
// Keep in lockstep with packages/db/prisma/schema.prisma.
// ─────────────────────────────────────────────────────────────────────

export const PipelineSegmentValues = [
  "new_leads",
  "winback",
  "closed_lost_recovery",
  "cancelled_orders_recovery",
  "inactive_customers_reengagement",
  "other",
] as const;

export const PipelineSegmentSchema = z.enum(PipelineSegmentValues);
export type PipelineSegment = z.infer<typeof PipelineSegmentSchema>;

// ─────────────────────────────────────────────────────────────────────
// Data sufficiency — honest signal about whether the proposer thinks
// there's enough data to operate a pipeline credibly today.
// ─────────────────────────────────────────────────────────────────────

export const DataSufficiencySchema = z.enum(["ready", "needs_more_data"]);
export type DataSufficiency = z.infer<typeof DataSufficiencySchema>;

// ─────────────────────────────────────────────────────────────────────
// Evidence — the deterministic count + the SQL-equivalent description
// that drove the sufficiency verdict. Renders as the "based on" text in
// the UI; passed back to slice-2b's daily discovery for diffing.
// ─────────────────────────────────────────────────────────────────────

export const ProposalEvidenceSchema = z.object({
  /** Deterministic count from a DB query (no LLM guess). */
  count: z.number().int().nonnegative(),
  /** Human-readable description of what was counted, for audit + UI. */
  description: z.string(),
  /** Threshold at which dataSufficiency flips from needs_more_data → ready. */
  threshold: z.number().int().nonnegative(),
});
export type ProposalEvidence = z.infer<typeof ProposalEvidenceSchema>;

// ─────────────────────────────────────────────────────────────────────
// ProposedPipeline — one row per (objective × segment) the proposer
// surfaces. The UI renders ready ones as creatable cards + needs_more_data
// ones as honest gap cards.
// ─────────────────────────────────────────────────────────────────────

export const ProposedPipelineSchema = z.object({
  /** FK target — must be an existing Objective row in the tenant's catalog. */
  objectiveId: z.string().uuid(),
  /** The Objective's `type` (e.g. 'book_appointment'). Echoed for UI rendering. */
  objectiveType: z.string(),
  /** The Objective's display `name` (e.g. 'Book an appointment'). */
  objectiveName: z.string(),
  /** Which audience segment this pipeline is for. */
  segment: PipelineSegmentSchema,
  /** Verdict: can we operate this credibly today? */
  dataSufficiency: DataSufficiencySchema,
  /** Deterministic evidence backing the sufficiency verdict. */
  evidence: ProposalEvidenceSchema,
  /**
   * Honest message when dataSufficiency=needs_more_data. Tells the user
   * WHAT they need to accumulate (e.g., "Need at least 5 closed-lost deals
   * to spin up a winback pipeline; you have 2.")
   * Null when ready.
   */
  needed: z.string().nullable(),
  /**
   * LLM-generated 1-2 sentence "why suggested" reasoning. Falls back to
   * hardcoded strings for `enrich_lead` + `recover_failed_payment` which
   * don't map cleanly onto GENERIC_BLUEPRINT journeys.
   */
  reason: z.string(),
  /**
   * LLM-suggested name for the pipeline (e.g., "Book Demo — New Leads").
   * Falls back to "{objective.name} — {segment}" on LLM failure.
   */
  proposedName: z.string(),
  /**
   * LLM-suggested stage list. The UI shows these in the "Ready-now creatable"
   * card preview. PR B's "Accept" mutation hands them to pipelines.create.
   */
  proposedStages: z.array(
    z.object({
      name: z.string(),
      order: z.number().int().nonnegative(),
      isInitial: z.boolean(),
      isTerminal: z.boolean(),
      outcomeType: z.enum(["open", "terminal_won", "terminal_lost"]),
    }),
  ),
  /**
   * Proposer's suggested priority for this objective on this tenant's
   * declaration. 1 = primary, 2 = secondary, … The user can override in
   * the drag-prioritize UI before adopt.
   */
  suggestedPriority: z.number().int().min(1),
});
export type ProposedPipeline = z.infer<typeof ProposedPipelineSchema>;

// ─────────────────────────────────────────────────────────────────────
// AdoptInput — what the UI sends back when the user clicks "Adopt".
// Replace-all per (tenant, entityScope).
// ─────────────────────────────────────────────────────────────────────

export const AdoptSelectionSchema = z.object({
  objectiveId: z.string().uuid(),
  /** User-chosen priority (1 = primary). May differ from suggestedPriority. */
  priority: z.number().int().min(1),
});
export type AdoptSelection = z.infer<typeof AdoptSelectionSchema>;
