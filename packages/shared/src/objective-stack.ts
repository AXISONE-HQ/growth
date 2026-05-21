/**
 * KAN-959 — Objective Stack shared types (slice 1 of Objectives → AI Pipeline).
 *
 * The "stack" is the prioritized, combinable list of objectives an entity
 * (Contact for slice 1; Order / Company in slice 5) is pursuing concurrently.
 * Architecture is narrow per-entity tables (`ContactObjectiveStack` today;
 * `OrderObjectiveStack` / `CompanyObjectiveStack` later) — NOT polymorphic.
 *
 * This file owns the entity-agnostic shape so cross-entity logic (priority,
 * fallback, gap roll-up) lives in `objective-stack-repo.ts` and can be reused
 * by future per-entity repos without a logic rewrite.
 */

/**
 * Status of a single stack entry. Transitions are reversible — `blocked` can
 * return to `active` after re-evaluation, which is the whole point of the
 * stack model (try primary → drop to secondary when blocked → reactivate when
 * unblocked).
 */
export type ObjectiveStackStatus =
  | "active"
  | "paused"
  | "blocked"
  | "achieved"
  | "abandoned"
  | "superseded";

/**
 * Entity-agnostic shape of a single objective on an entity's stack. The
 * `entityType` discriminator is set by the repo when reading; the underlying
 * row lives in `contact_objective_stack` (or future `order_/company_…`).
 */
export interface ObjectiveStackEntry {
  id: string;
  tenantId: string;
  entityType: "contact" | "order" | "company";
  entityId: string;
  objectiveId: string;
  /** Lower priority = higher rank. 1 = primary, 2 = secondary, … */
  priority: number;
  status: ObjectiveStackStatus;
  /** Per-entity sub-objective progress map. Free-shape JSON; reader-defined. */
  subObjectives: unknown;
  strategyCurrent: string | null;
  confidenceScore: number | null;
  achievedAt: Date | null;
  blockedReason: string | null;
  blockedSinceAt: Date | null;
  activatedAt: Date;
  lastEvaluatedAt: Date;
}
