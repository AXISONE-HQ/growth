/**
 * KAN-1080 (Cluster III PR I) — EnginePhase → PipelineStage mapping type contract.
 *
 * Per Phase 1 Q4 lock: hybrid shape carrying `stageName` (used for runtime
 * resolution against `Pipeline.stages[].name`) AND `stageRoleHint?` (forensic
 * metadata, v1 not consumed; activates via Phase 2.5 if name-resolution
 * brittleness empirically surfaces).
 *
 * Per Phase 1.5 stage-name audit (2026-06-03 on PROD):
 *   - 32 distinct Stage.name values across AxisOne's 10 pipelines
 *   - Wildly idiosyncratic naming; same name at different orders; long-tail
 *   - 28 of 32 distinct names have `outcomeType='open'` (no terminal markers)
 *
 * Verdict: Blueprint defaults are near-useless. Per-tenant override
 * (`Tenant.enginePhaseStageMapOverride`) is the PRIMARY config path.
 * `DEFAULT_ENGINE_PHASE_STAGE_MAP_GENERIC_B2B` ships as `{}` empty — the
 * resolver treats both `null` (DB column) and `{}` (TS empty) equivalently
 * as "no mapping" → null entries → caller (PR II's dispatcher arm) falls
 * back to existing `resolveAdvanceTargetStage` "next by order" logic.
 *
 * Co-resident with `engine-phase-types.ts` (KAN-1063 Cluster II PR I).
 * Imports `EnginePhaseKey` from there for type-safety on map keys.
 */
import type { EnginePhaseKey } from './engine-phase-types.js';

/**
 * A single mapping entry — which Pipeline Stage corresponds to a given
 * EnginePhase. `stageName` matches against `Stage.name` per-tenant (Blueprint
 * is per-vertical / shared across tenants, so name-based resolution is the
 * canonical path; `stageId` would not resolve across tenants).
 *
 * `stageRoleHint` is v1 forensic-only — captures semantic intent so an
 * operator inspecting the config sees what each mapped Stage represents
 * (e.g., `"qualified"` for the qualify-phase target, `"proof_demonstrated"`
 * for the proof-phase target). Future Phase 2.5 work (KAN-XXXX-name-resolver)
 * may activate `stageRoleHint`-based fallback when `stageName` resolution
 * fails (e.g., after operator stage rename); v1 ignores it at runtime.
 */
export interface EnginePhaseStageMapEntry {
  stageName: string;
  stageRoleHint?: string;
}

/**
 * Per-phase mapping. Optional entries: a phase with `null` or absent entry
 * means "no mapping" — resolver returns `null` for that phase and caller
 * falls through to existing target-resolution logic.
 */
export type EnginePhaseStageMap = Partial<Record<EnginePhaseKey, EnginePhaseStageMapEntry | null>>;

/**
 * Default mapping for the generic B2B blueprint. EMPTY by intentional design.
 *
 * Rationale (Phase 1.5 audit): PROD stage naming is too idiosyncratic for
 * universal Blueprint defaults to be useful. Operators configure per-tenant
 * overrides via `Tenant.enginePhaseStageMapOverride`; this empty default
 * exists only as the bottom of the resolution chain so callers see a
 * consistent `ResolvedEnginePhaseStageMap` shape (all-null entries) when
 * no override exists.
 *
 * Future Phase 2.5 work may populate this with a vertical-specific default
 * once a canonical Stage-name vocabulary emerges; for now, keep empty.
 */
export const DEFAULT_ENGINE_PHASE_STAGE_MAP_GENERIC_B2B: EnginePhaseStageMap = {};
