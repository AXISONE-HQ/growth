/**
 * KAN-1093 (Cluster IV-B PR I) — Blueprint Persona resolver.
 *
 * Resolves the active Persona for a given tenant. Resolution chain:
 *   1. `Tenant.personaOverride` (per-tenant override; primary path)
 *   2. `Blueprint.persona` (per-vertical default)
 *   3. `DEFAULT_PERSONA_GENERIC_B2B` (final fallback; empty toneDefaults +
 *      brandAttributes + voiceExamples per Phase 1 discipline-pin-1)
 *
 * Mirrors `engine-phase-stage-map-resolver.ts` (Cluster III PR I) +
 * `blueprint-engine-phases-resolver.ts` (Cluster II PR II) structurally.
 * Cluster IV-B PR I differs from Cluster III by ONE param — no pipelineId
 * needed (Persona is tenant-scoped only).
 *
 * Fail-safe posture per `feedback_loader_vs_canonical_test_divergence`:
 * any resolution failure (Prisma throw, malformed Json) returns
 * DEFAULT_PERSONA_GENERIC_B2B + best-effort `blueprint_persona.resolve_failed`
 * audit row (sibling naming to `engine_phases.resolve_failed` +
 * `engine_phase_stage_map.resolve_failed` per Q3 lock).
 *
 * Cluster IV-A consumers (composer's tone resolution chain in IV-A PR I;
 * composer's userPrompt brand-voice line in IV-A PR I) will read from this
 * resolver. PR I (this file) ships the foundation; consumers wire in
 * Cluster IV-A activation per the ≥50-decisions gate (KAN-1096).
 */
import type { PrismaClient } from '@prisma/client';
import {
  type BlueprintPersona,
  type BrainSuggestedTone,
  type EnginePhaseKey,
  DEFAULT_PERSONA_GENERIC_B2B,
} from '@growth/shared';

const ALL_PHASE_KEYS: readonly EnginePhaseKey[] = ['qualify', 'problem', 'proof', 'closing'] as const;

const VALID_TONES: ReadonlySet<BrainSuggestedTone> = new Set<BrainSuggestedTone>([
  'curious',
  'professional',
  'urgent',
  'closing',
]);

/**
 * Type-safe Persona coercion from a potentially-malformed Json source.
 * Per-field fail-safe: each field validates independently; invalid fields
 * drop to DEFAULT_PERSONA_GENERIC_B2B values rather than producing a global
 * throw. Operator-uploaded malformed Json that breaks one field doesn't
 * destroy the entire persona resolution.
 *
 * Returns null when the raw value is null/undefined/non-object (caller
 * uses null to drive the resolution chain — null → next source).
 */
function coercePersona(raw: unknown): BlueprintPersona | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  return {
    name:
      typeof obj.name === 'string' && obj.name.length > 0
        ? obj.name
        : DEFAULT_PERSONA_GENERIC_B2B.name,
    voice:
      typeof obj.voice === 'string' && obj.voice.length > 0
        ? obj.voice
        : DEFAULT_PERSONA_GENERIC_B2B.voice,
    toneDefaults: coerceToneDefaults(obj.toneDefaults),
    brandAttributes: coerceStringArray(obj.brandAttributes),
    voiceExamples: coerceStringArray(obj.voiceExamples),
  };
}

/**
 * Per-phase tone coercion. Each entry validated independently:
 *   - Key must be one of the 4 EnginePhaseKey values
 *   - Value must be one of the 4 BrainSuggestedTone values
 * Invalid entries dropped silently (per Phase 1 Risk 2 — operator-uploaded
 * malformed Json drops invalid entries rather than throwing globally).
 */
function coerceToneDefaults(raw: unknown): Partial<Record<EnginePhaseKey, BrainSuggestedTone>> {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const result: Partial<Record<EnginePhaseKey, BrainSuggestedTone>> = {};
  for (const key of ALL_PHASE_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && VALID_TONES.has(value as BrainSuggestedTone)) {
      result[key] = value as BrainSuggestedTone;
    }
  }
  return result;
}

function coerceStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export async function resolveBlueprintPersona(
  prisma: PrismaClient,
  tenantId: string,
): Promise<BlueprintPersona> {
  try {
    // Step 1: load Tenant.personaOverride + Blueprint.persona via a single
    // Tenant query with Blueprint relation include. Mirrors Cluster III pattern.
    const tenant = await (prisma as unknown as {
      tenant: {
        findUnique: (args: {
          where: { id: string };
          select: {
            personaOverride: true;
            blueprint: { select: { persona: true } };
          };
        }) => Promise<{
          personaOverride: unknown;
          blueprint: { persona: unknown } | null;
        } | null>;
      };
    }).tenant.findUnique({
      where: { id: tenantId },
      select: {
        personaOverride: true,
        blueprint: { select: { persona: true } },
      },
    });

    if (!tenant) {
      return DEFAULT_PERSONA_GENERIC_B2B;
    }

    // Step 2: resolution chain. Override wins; Blueprint fallback; DEFAULT.
    // coercePersona returns null on malformed → next source.
    const override = coercePersona(tenant.personaOverride);
    if (override) return override;

    const blueprintPersona = tenant.blueprint ? coercePersona(tenant.blueprint.persona) : null;
    if (blueprintPersona) return blueprintPersona;

    return DEFAULT_PERSONA_GENERIC_B2B;
  } catch (err) {
    // Best-effort audit + DEFAULT result. Sibling naming to
    // engine_phases.resolve_failed + engine_phase_stage_map.resolve_failed.
    await writeResolveFailedAudit(prisma, tenantId, (err as Error)?.message ?? String(err));
    return DEFAULT_PERSONA_GENERIC_B2B;
  }
}

/**
 * Best-effort audit row writer. If the audit write itself fails (DB down,
 * etc.), swallow + warn — the caller already gets DEFAULT_PERSONA_GENERIC_B2B
 * and falls through to existing composer logic.
 *
 * action_type naming per Q3 lock: `blueprint_persona.resolve_failed`
 * (sibling to `engine_phases.resolve_failed` from Cluster II PR II +
 * `engine_phase_stage_map.resolve_failed` from Cluster III PR I).
 * Future Tier 2 aggregator can surface "resolver failure rate" as
 * cognitive-quality signal via the shared `*.resolve_failed` action_type prefix.
 */
async function writeResolveFailedAudit(
  prisma: PrismaClient,
  tenantId: string,
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
        actor: 'system:blueprint-persona-resolver',
        actionType: 'blueprint_persona.resolve_failed',
        reasoning: reason,
        payload: {
          tenantId,
          reason,
        },
      },
    });
  } catch (auditErr) {
    console.warn(
      `[blueprint-persona-resolver] audit write failed (best-effort): ${
        (auditErr as Error)?.message ?? String(auditErr)
      }`,
    );
  }
}
