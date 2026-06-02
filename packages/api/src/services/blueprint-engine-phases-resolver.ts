/**
 * KAN-1064 (Cluster II PR II) — Blueprint + Tenant EnginePhase config resolver.
 *
 * Resolves the canonical EnginePhase config for a tenant at brain-eval time:
 *
 *   1. Tenant override (`Tenant.enginePhasesOverride`) — wins when non-null
 *   2. Blueprint default (`Tenant.blueprint?.enginePhases`) — per-vertical
 *   3. `DEFAULT_ENGINE_PHASES_GENERIC_B2B` — fallback when both above null
 *
 * Per-tenant override placement is direct on Tenant (engine-config family,
 * sibling to `autoTransitionSubObjectives` + `autoAdvanceEnginePhase` +
 * `sendRedirectEnabled`), NOT on the accountProfile sub-model (which is
 * the content-override family) — per Cluster II Phase 1 Q4 lock.
 *
 * **Fail-safe contract** (Q4 lock): any prisma throw → return DEFAULT +
 * warn-log + best-effort `engine_phases.resolve_failed` audit row.
 * Mirrors `computeGapState`'s fail-safe-to-empty discipline at
 * sub-objective-gap-tracker.ts L70-82. Engine doesn't block on
 * config-fetch failure; downstream rendering uses DEFAULT silently.
 *
 * **Query shape**: single indexed `prisma.tenant.findUnique` with `select`
 * projection — pulls only the two Json fields + the Blueprint relation
 * needed. Avoids over-fetching the full Tenant row.
 */
import type { PrismaClient } from '@prisma/client';
import {
  type BlueprintEnginePhase,
  DEFAULT_ENGINE_PHASES_GENERIC_B2B,
} from '@growth/shared';

/**
 * Best-effort audit row writer for the fail-safe path. Mirrors
 * sub-objective-gap-tracker.ts:writeAuditBestEffort pattern. Defined
 * inline (not exported) because the audit-row schema is specific to this
 * resolver's fail-safe contract.
 */
async function writeResolveFailedAuditBestEffort(
  prisma: PrismaClient,
  tenantId: string,
  err: unknown,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId,
        actor: 'system:blueprint-engine-phases-resolver',
        actionType: 'engine_phases.resolve_failed',
        payload: {
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        },
      },
    });
  } catch (auditErr) {
    // Belt-and-suspenders: even the audit row write can fail under DB
    // outage. Log + swallow; never propagate from the fail-safe path.
    console.warn(
      `[blueprint-engine-phases-resolver] audit write failed for engine_phases.resolve_failed: ${(auditErr as Error)?.message ?? String(auditErr)}`,
    );
  }
}

/**
 * Resolves the EnginePhase config for a tenant. Returns Tenant override
 * if present; else Blueprint default; else `DEFAULT_ENGINE_PHASES_GENERIC_B2B`.
 *
 * Fail-safe: any prisma throw → returns DEFAULT + warn-log + best-effort
 * `engine_phases.resolve_failed` audit row.
 *
 * Json shape validation: the `enginePhasesOverride` + `enginePhases` Json
 * columns are typed as `Prisma.JsonValue` at the schema level. This
 * resolver does a minimal structural cast (`as { phases: ... }`) and
 * falls back to DEFAULT if the shape is unexpected. Stricter validation
 * (zod parse, schema-drift sentinel) is deferred to a Phase 2.5 follow-up
 * if empirical signal warrants — pre-launch Tenant config rows are
 * operator-curated and trusted; runtime defense is sufficient.
 *
 * @param prisma  PrismaClient instance.
 * @param tenantId  Tenant to resolve EnginePhase config for.
 */
export async function resolveEnginePhases(
  prisma: PrismaClient,
  tenantId: string,
): Promise<BlueprintEnginePhase[]> {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        enginePhasesOverride: true,
        blueprint: {
          select: { enginePhases: true },
        },
      },
    });

    // Tenant not found → fail-safe to DEFAULT. The brain-eval call would
    // typically already have failed upstream by this point (tenantId is
    // resolved from authenticated request context), but defense-in-depth.
    if (!tenant) {
      console.warn(
        `[blueprint-engine-phases-resolver] tenant not found tenantId=${tenantId} — using DEFAULT_ENGINE_PHASES_GENERIC_B2B`,
      );
      return [...DEFAULT_ENGINE_PHASES_GENERIC_B2B];
    }

    // Resolution order: Tenant override → Blueprint default → DEFAULT.
    const candidate =
      (tenant.enginePhasesOverride as { phases?: BlueprintEnginePhase[] } | null) ??
      (tenant.blueprint?.enginePhases as { phases?: BlueprintEnginePhase[] } | null);

    // Both null → use DEFAULT.
    if (!candidate) {
      return [...DEFAULT_ENGINE_PHASES_GENERIC_B2B];
    }

    // Structural shape check — `{ phases: [...] }`. Any other shape
    // (e.g., wrong key, non-array, empty) falls back to DEFAULT rather
    // than letting downstream rendering see a broken config. Strict
    // validation deferred to Phase 2.5 (KAN-XXXX zod parse if needed).
    if (!Array.isArray(candidate.phases) || candidate.phases.length === 0) {
      console.warn(
        `[blueprint-engine-phases-resolver] malformed enginePhases config tenantId=${tenantId} — using DEFAULT_ENGINE_PHASES_GENERIC_B2B`,
      );
      return [...DEFAULT_ENGINE_PHASES_GENERIC_B2B];
    }

    return candidate.phases;
  } catch (err) {
    // Q4 lock fail-safe — any prisma throw → DEFAULT + warn-log + audit.
    console.warn(
      `[blueprint-engine-phases-resolver] resolveEnginePhases failed tenantId=${tenantId} err=${(err as Error)?.message ?? String(err)}`,
    );
    await writeResolveFailedAuditBestEffort(prisma, tenantId, err);
    return [...DEFAULT_ENGINE_PHASES_GENERIC_B2B];
  }
}
