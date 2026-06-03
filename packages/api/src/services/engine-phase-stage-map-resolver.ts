/**
 * KAN-1080 (Cluster III PR I) — EnginePhase → PipelineStage mapping resolver.
 *
 * Resolves the per-phase Stage target for a given (tenantId, pipelineId)
 * pair. Resolution chain:
 *   1. `Tenant.enginePhaseStageMapOverride` (primary path per Phase 1.5 audit
 *      — 32 idiosyncratic Stage.names in PROD make Blueprint defaults near-useless)
 *   2. `Blueprint.enginePhaseStageMap` (fallback; empty `{}` for generic B2B v1)
 *   3. Empty (all-null entries) — caller falls through to existing
 *      `resolveAdvanceTargetStage` "next by order" logic in PR II
 *
 * Name-to-StageId lookup: query `Pipeline.stages` and match by `name`.
 * Tolerates `Stage.outcomeType='open'` for any phase including closing
 * (Phase 1 empirical finding — 28 of 32 distinct PROD Stage names are open;
 * many pipelines lack terminal markers). Future engineers MUST NOT add a
 * "closing must map to terminal Stage" assertion.
 *
 * Fail-safe posture per `feedback_loader_vs_canonical_test_divergence`:
 * any resolution failure (Prisma throw, malformed Json, missing FK) returns
 * empty result + best-effort `engine_phase_stage_map.resolve_failed` audit
 * row (action_type naming sibling to `sub_objective_gap_state.read_failed`
 * per Phase 1 Q7 lock). Empty result + null entries = backcompat-preserving
 * fall-through; no regression on existing `advance_stage` flow.
 *
 * **Loader contract**: re-exported from `brain-service.ts` per KAN-1067
 * lesson — subscribers load via variable-specifier dynamic import (KAN-689
 * boundary) of `brain-service.js`; the symbol MUST be exposed at the
 * canonical loader path or the test-vs-runtime divergence pattern recurs.
 * See `feedback_loader_vs_canonical_test_divergence` for full discipline.
 */
import type { PrismaClient } from '@prisma/client';
import {
  type EnginePhaseStageMap,
  type EnginePhaseStageMapEntry,
  type EnginePhaseKey,
  DEFAULT_ENGINE_PHASE_STAGE_MAP_GENERIC_B2B,
} from '@growth/shared';

/**
 * Resolved per-phase entry with the looked-up `Stage.id` populated. `null`
 * for any phase that didn't resolve (no mapping config OR name not found
 * in Pipeline OR resolution failed).
 */
export interface ResolvedEnginePhaseStageMapEntry {
  stageId: string;
  stageName: string;
  stageRoleHint?: string;
}

export interface ResolvedEnginePhaseStageMap {
  qualify: ResolvedEnginePhaseStageMapEntry | null;
  problem: ResolvedEnginePhaseStageMapEntry | null;
  proof: ResolvedEnginePhaseStageMapEntry | null;
  closing: ResolvedEnginePhaseStageMapEntry | null;
}

const ALL_PHASE_KEYS: readonly EnginePhaseKey[] = ['qualify', 'problem', 'proof', 'closing'] as const;

function emptyResolution(): ResolvedEnginePhaseStageMap {
  return { qualify: null, problem: null, proof: null, closing: null };
}

/**
 * Type-safe entry extraction from a potentially-malformed Json source.
 * Validates the shape inline rather than throwing — malformed source for
 * any phase produces `null` for that phase, NOT a global failure.
 */
function coerceEntry(raw: unknown): EnginePhaseStageMapEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.stageName !== 'string' || obj.stageName.trim().length === 0) return null;
  const entry: EnginePhaseStageMapEntry = { stageName: obj.stageName };
  if (typeof obj.stageRoleHint === 'string' && obj.stageRoleHint.length > 0) {
    entry.stageRoleHint = obj.stageRoleHint;
  }
  return entry;
}

/**
 * Coerce a raw Json source (DB column value) into a typed EnginePhaseStageMap.
 * `null` and any non-object value coerce to empty.
 */
function coerceMap(raw: unknown): EnginePhaseStageMap {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const out: EnginePhaseStageMap = {};
  for (const key of ALL_PHASE_KEYS) {
    const entry = coerceEntry(obj[key]);
    if (entry) out[key] = entry;
  }
  return out;
}

export async function resolveEnginePhaseStageMap(
  prisma: PrismaClient,
  tenantId: string,
  pipelineId: string,
): Promise<ResolvedEnginePhaseStageMap> {
  try {
    // Step 1: load Tenant.enginePhaseStageMapOverride + Blueprint.enginePhaseStageMap
    // via a single Tenant query with Blueprint relation include. Single round-trip;
    // mirrors `blueprint-engine-phases-resolver.ts` (Cluster II PR II) pattern.
    const tenant = await (prisma as unknown as {
      tenant: {
        findUnique: (args: {
          where: { id: string };
          select: {
            enginePhaseStageMapOverride: true;
            blueprint: { select: { enginePhaseStageMap: true } };
          };
        }) => Promise<{
          enginePhaseStageMapOverride: unknown;
          blueprint: { enginePhaseStageMap: unknown } | null;
        } | null>;
      };
    }).tenant.findUnique({
      where: { id: tenantId },
      select: {
        enginePhaseStageMapOverride: true,
        blueprint: { select: { enginePhaseStageMap: true } },
      },
    });

    if (!tenant) {
      return emptyResolution();
    }

    // Step 2: pick the active map. Override wins; Blueprint fallback; empty default.
    const activeMap: EnginePhaseStageMap =
      coerceMap(tenant.enginePhaseStageMapOverride) ??
      DEFAULT_ENGINE_PHASE_STAGE_MAP_GENERIC_B2B;
    const blueprintMap = tenant.blueprint
      ? coerceMap(tenant.blueprint.enginePhaseStageMap)
      : {};

    // Merge: override entries take precedence per-phase. Empty override
    // entries do NOT shadow Blueprint entries (per-phase resolution).
    const resolvedMap: EnginePhaseStageMap = {};
    for (const key of ALL_PHASE_KEYS) {
      const overrideEntry = activeMap[key];
      const blueprintEntry = blueprintMap[key];
      const chosen = overrideEntry ?? blueprintEntry;
      if (chosen) resolvedMap[key] = chosen;
    }

    // Step 3: short-circuit if no phases have a mapping — saves a Pipeline
    // query entirely.
    if (Object.keys(resolvedMap).length === 0) {
      return emptyResolution();
    }

    // Step 4: load Pipeline.stages for name-to-id lookup. Single query.
    const pipeline = await (prisma as unknown as {
      pipeline: {
        findUnique: (args: {
          where: { id: string };
          select: { stages: { select: { id: true; name: true } } };
        }) => Promise<{ stages: Array<{ id: string; name: string }> } | null>;
      };
    }).pipeline.findUnique({
      where: { id: pipelineId },
      select: { stages: { select: { id: true, name: true } } },
    });

    if (!pipeline) {
      // Pipeline missing is a data-integrity issue, but fail-safe: empty
      // resolution + audit hook.
      await writeResolveFailedAudit(prisma, tenantId, pipelineId, 'pipeline_not_found');
      return emptyResolution();
    }

    // Step 5: resolve each per-phase entry by name lookup.
    const stagesByName = new Map<string, string>();
    for (const stage of pipeline.stages) {
      stagesByName.set(stage.name, stage.id);
    }

    const result: ResolvedEnginePhaseStageMap = emptyResolution();
    for (const key of ALL_PHASE_KEYS) {
      const entry = resolvedMap[key];
      if (!entry) continue;
      const stageId = stagesByName.get(entry.stageName);
      if (!stageId) continue; // name not found in Pipeline → null entry (fail-safe)
      const resolved: ResolvedEnginePhaseStageMapEntry = {
        stageId,
        stageName: entry.stageName,
      };
      if (entry.stageRoleHint) resolved.stageRoleHint = entry.stageRoleHint;
      // TypeScript can't narrow Record<EnginePhaseKey, ...> via for-of over
      // a readonly tuple of keys; explicit per-key assignment instead.
      if (key === 'qualify') result.qualify = resolved;
      else if (key === 'problem') result.problem = resolved;
      else if (key === 'proof') result.proof = resolved;
      else if (key === 'closing') result.closing = resolved;
    }

    return result;
  } catch (err) {
    // Best-effort audit + empty result. Per Phase 1 Q7 lock: audit action_type
    // is `engine_phase_stage_map.resolve_failed` (sibling to
    // `sub_objective_gap_state.read_failed`).
    await writeResolveFailedAudit(
      prisma,
      tenantId,
      pipelineId,
      (err as Error)?.message ?? String(err),
    );
    return emptyResolution();
  }
}

/**
 * Best-effort audit row writer. If the audit write itself fails (DB down,
 * etc.), swallow + warn — the caller already gets an empty result and
 * falls through to existing logic.
 */
async function writeResolveFailedAudit(
  prisma: PrismaClient,
  tenantId: string,
  pipelineId: string,
  reason: string,
): Promise<void> {
  try {
    await (prisma as unknown as {
      auditLog: {
        create: (args: {
          data: {
            tenantId: string;
            actor: string;
            actionType: string;
            reasoning: string;
            payload: Record<string, unknown>;
          };
        }) => Promise<unknown>;
      };
    }).auditLog.create({
      data: {
        tenantId,
        actor: 'system:engine-phase-stage-map-resolver',
        actionType: 'engine_phase_stage_map.resolve_failed',
        reasoning: reason,
        payload: {
          tenantId,
          pipelineId,
          reason,
        },
      },
    });
  } catch (auditErr) {
    console.warn(
      `[engine-phase-stage-map-resolver] audit write failed (best-effort): ${
        (auditErr as Error)?.message ?? String(auditErr)
      }`,
    );
  }
}
