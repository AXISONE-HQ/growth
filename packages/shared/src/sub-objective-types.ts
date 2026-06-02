/**
 * M3-1 Sub-Objective Framework + Gap Tracker MVP — shared types.
 *
 * Lives in @growth/shared (cross-rootDir-clean cohort) so both
 * packages/api (computeGapState + engine threading) and apps/web
 * (Discovery state panel — slice 1c) consume one definition. Same
 * structural-drift discipline as @growth/shared/run-decision-types.ts
 * (M2-4 follow-up).
 */

// ─────────────────────────────────────────────
// Constants — canonical key set
// ─────────────────────────────────────────────

/**
 * MVP default sub-objective keys (Generic-B2B BANT-style).
 *
 * Doctrine: configuration is a failure mode — hardcoded for MVP; future
 * Blueprint loader (M3 slice #5) ships per-vertical sets without
 * schema migration (sub_objective_key is free-form TEXT in the DB).
 *
 * KAN-1063 (Cluster II PR I, folds in KAN-1050) — extended with 3 keys
 * for the EnginePhase Workflow Architecture (KAN-1062):
 *   - `cost_of_problem` — Problem phase (joins need + motivation + budget)
 *   - `roi_metrics`     — Proof phase
 *   - `committed_amount` — Closing phase
 * Slot positioning + priorityWeight values locked at Phase 1 trace.
 * EnginePhase grouping lives in `Blueprint.enginePhases` (per-vertical
 * config) + `Tenant.enginePhasesOverride` (per-tenant override). The
 * sub-objective keys themselves stay framework-agnostic; the phase
 * grouping is a config concern, not a key concern.
 */
export const SUB_OBJECTIVE_KEYS = [
  'timeline',
  'budget',
  'authority',
  'need',
  'motivation',
  // KAN-1063 (Cluster II PR I) — vocab extension folding in KAN-1050.
  'cost_of_problem',
  'roi_metrics',
  'committed_amount',
] as const;

export type SubObjectiveKey = (typeof SUB_OBJECTIVE_KEYS)[number];

/**
 * Default Generic-B2B sub-objective definitions. Sourced from the M3-1
 * PRD §"Hardcoded Generic-B2B default set" table — priorityWeight +
 * requiredAtStage values are the PRD-pinned numbers, not arbitrary.
 *
 * `requiredAtStage` is a stage NAME match against the contact's current
 * or next pipeline stage; when matched AND state is unknown/partial,
 * the engine produces a HARD-trigger discovery candidate (forces
 * send_message to score 95).
 */
export interface SubObjectiveDefault {
  key: SubObjectiveKey;
  label: string;
  valueType: 'text' | 'date' | 'numeric' | 'enum';
  priorityWeight: number;          // 0..1, PRD-pinned
  /**
   * @deprecated since 2026-06-02 (Cluster II Phase 1 trace, KAN-1063) —
   * the 2-bucket stage grouping (`'qualified' | 'proposal-ready'`) doesn't
   * align with the 4-phase EnginePhase model introduced by KAN-1062
   * (Qualify / Problem / Proof / Closing). Disposition + repurpose tracked
   * at KAN-1068; do NOT drop unilaterally pending consumer migration plan.
   *
   * Verified consumers at Phase 1 trace (2026-06-02):
   *   - `apps/web/src/components/contacts/discovery-state-panel.tsx:172` (UI surface)
   *   - `packages/api/src/services/sub-objective-gap-tracker.ts:162, 214, 219, 242` (composite scoring + hard-trigger logic)
   *   - `packages/api/src/services/action-determiner.ts:349, 353` (engine prompt context render)
   *   - `apps/api/src/subscribers/decision-run-push.ts:672` (next-stage matching)
   *   - `apps/web/src/lib/api.ts:2167` (frontend type surface)
   *   - 4 test files (brain-service.test.ts + m3-1a + m3-1b + others)
   */
  requiredAtStage?: string;        // stage name OR undefined (soft-only)
}

export const DEFAULT_SUB_OBJECTIVES_GENERIC_B2B: ReadonlyArray<SubObjectiveDefault> = [
  { key: 'timeline',         label: 'When are they looking to start?',        valueType: 'text',    priorityWeight: 0.90, requiredAtStage: 'qualified'      },
  { key: 'budget',           label: "What's their budget range?",              valueType: 'enum',    priorityWeight: 0.85, requiredAtStage: 'proposal-ready' },
  { key: 'authority',        label: 'Are they the decision maker?',            valueType: 'enum',    priorityWeight: 0.80, requiredAtStage: 'proposal-ready' },
  { key: 'need',              label: 'What problem are they solving?',          valueType: 'text',    priorityWeight: 0.75, requiredAtStage: 'qualified'      },
  { key: 'motivation',       label: "Why now? What's driving this?",           valueType: 'text',    priorityWeight: 0.70, requiredAtStage: 'qualified'      },
  // KAN-1063 (Cluster II PR I, folds in KAN-1050) — vocab extension. New
  // entries omit `requiredAtStage` (the @deprecated field above) — the
  // 4-phase EnginePhase grouping in Blueprint.enginePhases is the canonical
  // ordering for these. priorityWeight values per Phase 1 trace lock:
  // cost_of_problem (0.65) > roi_metrics (0.60) > committed_amount (0.55),
  // matching their typical conversational order (problem → proof → close).
  { key: 'cost_of_problem',  label: "What's the cost of not solving this?",    valueType: 'text',    priorityWeight: 0.65 },
  { key: 'roi_metrics',      label: 'What return are they expecting?',         valueType: 'text',    priorityWeight: 0.60 },
  { key: 'committed_amount', label: 'What amount are they committing?',        valueType: 'numeric', priorityWeight: 0.55 },
];

// ─────────────────────────────────────────────
// Per-contact gap-state shape
// ─────────────────────────────────────────────

export type SubObjectiveState = 'unknown' | 'partial' | 'known' | 'not_applicable';
export type SubObjectiveValueType = 'text' | 'date' | 'numeric' | 'enum';
export type SubObjectiveSource =
  | 'decision_initialize'
  | 'manual'
  | 'extraction'
  | 'enrichment'
  // KAN-1042 PR A2 — engine-driven transitions via wirePhase2Consumers'
  // transition_sub_objective dispatcher arm. Dispatcher gates on
  // Tenant.autoTransitionSubObjectives (Phase 1 Q6 finding — dispatcher-
  // level governance, NOT a HIGH_STAKES_ACTION_TYPES clamp).
  | 'engine';

/**
 * One prioritized gap entry — head of the list is the highest-priority
 * unfilled discovery target.
 */
export interface PrioritizedGap {
  key: string;                            // free-form, MVP uses SubObjectiveKey values
  label: string;
  valueType: SubObjectiveValueType;
  state: SubObjectiveState;
  valueIfPartial?: string;                // partial signal if any
  priorityWeight: number;                 // 0..1 from definition
  requiredAtStage?: string;
  recencyDaysSinceLastEval: number;       // starvation prevention input
  /** Composite score = priorityWeight × stage-weight × recency-factor.
   *  Range [0..1]. Soft-trigger fires when score ≥ SOFT_TRIGGER_THRESHOLD. */
  score: number;
  /** True when `requiredAtStage` matches contact's current/next pipeline
   *  stage AND state is unknown|partial → forces discovery candidate. */
  hardTrigger: boolean;
}

/**
 * M3-1c-followup — what the engine has learned about this contact.
 * Carries the value + provenance so the operator UI can show "✓ Timeline:
 * Q3 2026 — set by you, just now." The engine itself ignores this list
 * (it only consumes `prioritizedGaps` for scoring). Additive to the
 * SubObjectiveGapState contract.
 */
export interface ResolvedGap {
  key: string;
  label: string;
  valueType: SubObjectiveValueType;
  state: 'known' | 'not_applicable';
  /** Single-string rendering of the typed value column for the UI.
   *  null for not_applicable rows. */
  value: string | null;
  source: SubObjectiveSource;
  /** Whatever the writer recorded — Firebase email when available,
   *  uid fallback, or 'system:gap-tracker' for engine-side seeds. */
  setBy: string | null;
  /** ISO timestamp string for stable client-side relative-time render. */
  setAt: string;
}

/**
 * Engine input — caller computes via computeGapState() and threads
 * through RunForContactInput.subObjectiveGapState.
 */
export interface SubObjectiveGapState {
  /** Prioritized list of unfilled sub-objectives.
   *  Empty when (a) no gaps unfilled, (b) compute failed (fail-safe). */
  prioritizedGaps: PrioritizedGap[];
  /** Head of prioritizedGaps, pre-computed for cheap engine access.
   *  Undefined when prioritizedGaps is empty. */
  topCandidate?: {
    key: string;
    label: string;
    score: number;
    hardTrigger: boolean;
  };
  /**
   * M3-1c-followup — known + not_applicable rows for UI rendering.
   * Engine ignores this list (only consumes prioritizedGaps). Allows the
   * Discovery state panel to show "what the engine has learned" alongside
   * the unfilled list per PRD §AC "Contact view UI shows gap-state per
   * sub-objective". Empty when no resolved rows.
   */
  resolvedGaps: ResolvedGap[];
}

// ─────────────────────────────────────────────
// Score-scale constants (evidence-pinned)
// ─────────────────────────────────────────────
//
// scoreActions() in packages/api/src/services/action-determiner.ts emits
// candidates on these literal scores (surveyed 2026-05-28):
//   - 100  → sentinels (unknown_strategy_escalate, require_human_approval)
//   - 85   → primary send_message (70) + L254 message-aligned gap boost (+15)
//   - 80   → defer-path replacement (rare)
//   - 70   → primary candidate for any strategy
//   - 60   → gap-suggests-escalation candidate
//   - 55   → gap-suggests-meeting candidate
//
// M3-1a discovery candidates are scored AGAINST this scale:
//   - HARD trigger: 95 (above realistic routine max 85, below sentinel 100 —
//     "human override beats discovery" doctrine preserved by construction)
//   - SOFT trigger: 60 + (score × 20) → 72..80 for score ∈ [0.6, 1.0]
//     (max soft = 80 LOSES to message-aligned routine 85; beats baseline 70 —
//     proves the "high-priority gap can lose to exceptionally-high routine"
//     PRD requirement)

/** Score the engine assigns a HARD-trigger discovery candidate. Above
 *  routine max (85), below human-override sentinels (100). */
export const DISCOVERY_HARD_TRIGGER_SCORE = 95;

/** Score base for SOFT-trigger discovery candidates. Final score =
 *  this + (gap.score × DISCOVERY_SOFT_TRIGGER_MULTIPLIER). */
export const DISCOVERY_SOFT_TRIGGER_BASE = 60;
export const DISCOVERY_SOFT_TRIGGER_MULTIPLIER = 20;

/** Minimum composite gap score for soft-trigger emission. Below this,
 *  no discovery candidate fires (the gap is too low-priority to compete). */
export const SOFT_TRIGGER_THRESHOLD = 0.6;

// ─────────────────────────────────────────────
// Decision metadata shape — discovery target audit
// ─────────────────────────────────────────────

/**
 * Written into Decision.metadata.discoveryTarget when a discovery
 * candidate wins; surfaces in audit log + the M1 escalation review
 * queue (slice 1c renders this in the drawer marker).
 */
export interface DiscoveryTargetMetadata {
  subObjectiveKey: string;
  label: string;
  triggerType: 'hard' | 'soft';
  priorityWeight: number;
  requiredAtStage?: string;
}
