/**
 * KAN-1064 (Cluster II PR II) — EnginePhase canonical types + DEFAULT.
 *
 * Lives in @growth/shared (cross-rootDir-clean cohort) so both
 * packages/api (resolveEnginePhases + computeCurrentEnginePhase + engine
 * prompt rendering) and apps/* (operator UI surfaces for phase focus —
 * Cluster III/IV downstream consumers) consume one definition. Same
 * structural-drift discipline as sub-objective-types.ts (M3-1 +
 * KAN-1063 KAN-1050 vocab extension precedent).
 *
 * **Naming**: `EnginePhase` (NOT MicroObjective) per Cluster II Phase 1
 * Lock 1 — existing `MicroObjective` Prisma model at schema.prisma:1061
 * (KAN-700/701 platform-default completion-gate tracking) is a
 * fundamentally different concept; see memo
 * `feedback_cluster_ii_engine_phase_vs_micro_objective_disambiguation.md`.
 *
 * **Note on EnginePhaseKey duplication**: PR I (KAN-1063) shipped an
 * identical declaration at `packages/api/src/services/brain-service.ts:145`
 * alongside the runtime validators (ENGINE_PHASE_ORDER, VALID_ENGINE_PHASES,
 * isValidPhaseAdvance, AdvanceEnginePhasePayload). The two declarations are
 * structurally identical literal unions (TypeScript treats them as the same
 * type at assignment sites). Future consolidation deferred; PR II keeps the
 * parallel-declaration shape to minimize PR I churn. Both declarations MUST
 * stay in lockstep on any vocab extension.
 */

/**
 * Canonical EnginePhase keys — the 4-phase engine workflow model
 * (KAN-1062 parent epic). Strict sequential ordering:
 *   qualify → problem → proof → closing
 *
 * Lock 4 invariant (Cluster II Phase 1): closing is terminal; engine
 * cannot emit `advance_engine_phase` from this phase. Exit paths:
 * `advance_stage`, `close_deal_lost`, `wait_for_response`,
 * `escalate_to_human` (per existing BrainActionType union).
 *
 * Structurally identical to `brain-service.ts:145` PR I declaration; both
 * MUST stay in lockstep on vocab extension.
 */
export type EnginePhaseKey = 'qualify' | 'problem' | 'proof' | 'closing';

/**
 * Per-phase config carried in `Blueprint.enginePhases Json?` (per-vertical
 * default) + `Tenant.enginePhasesOverride Json?` (per-tenant override).
 *
 * Phase 1 Q1 lock — 4 fields only. No `tone` (Cluster IV concern), no
 * `defaultActionType` (Cluster III concern). Future clusters extend
 * additively.
 */
export interface BlueprintEnginePhase {
  /** Canonical EnginePhase key — 'qualify' | 'problem' | 'proof' | 'closing'. */
  key: EnginePhaseKey;
  /** Human-readable label for prompt + UI render. */
  label: string;
  /**
   * Sub-objective KEYS that anchor this phase. Free-form string array
   * (matches `SubObjectiveTransitionKey` union; sub-objective keys are
   * free-form text in the DB per the existing M3-1 + KAN-1063 KAN-1050
   * convention). Engine considers the phase "unfilled" while ANY listed
   * sub-objective has state ∈ {unknown, partial}.
   */
  subObjectives: string[];
  /**
   * Ordering priority for derivation (1 → first phase, ascending). The
   * `computeCurrentEnginePhase` helper iterates phases sorted by this
   * value to find the first phase with any unfilled sub-objective.
   *
   * Canonical values match `ENGINE_PHASE_ORDER` indices + 1:
   *   qualify=1, problem=2, proof=3, closing=4
   *
   * Per-vertical Blueprint config may legitimately re-order if a tenant
   * needs a non-canonical sequence — but strict sequential v1 (Lock 1)
   * means `isValidPhaseAdvance` still enforces adjacent transitions in
   * canonical `ENGINE_PHASE_ORDER`. Custom priority is for derivation
   * tie-breaking only.
   */
  priority: number;
}

/**
 * Generic-B2B 4-phase default config — used as fallback when neither
 * `Blueprint.enginePhases` nor `Tenant.enginePhasesOverride` is set.
 *
 * Sub-objective groupings match the parent epic KAN-1062 lock + the
 * KAN-1063 (PR I) KAN-1050 vocab extension:
 *
 *   - qualify: authority
 *   - problem: need, motivation, budget, cost_of_problem
 *   - proof:   roi_metrics
 *   - closing: timeline, committed_amount
 *
 * Note: `contact_info` (mentioned in strategic roadmap §5) is intentionally
 * absent — empirically-driven addition tracked at KAN-1071 (Phase 2.5).
 */
export const DEFAULT_ENGINE_PHASES_GENERIC_B2B: ReadonlyArray<BlueprintEnginePhase> = [
  {
    key: 'qualify',
    label: 'Qualify',
    subObjectives: ['authority'],
    priority: 1,
  },
  {
    key: 'problem',
    label: 'Problem',
    subObjectives: ['need', 'motivation', 'budget', 'cost_of_problem'],
    priority: 2,
  },
  {
    key: 'proof',
    label: 'Proof',
    subObjectives: ['roi_metrics'],
    priority: 3,
  },
  {
    key: 'closing',
    label: 'Closing',
    subObjectives: ['timeline', 'committed_amount'],
    priority: 4,
  },
];
