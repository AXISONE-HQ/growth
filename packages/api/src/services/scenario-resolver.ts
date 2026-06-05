/**
 * KAN-1094 (Cluster IV-B PR II) — Scenario tuple resolver.
 *
 * Pure-function tuple matcher; no Prisma, no async. Caller passes a typed
 * Scenario registry (DEFAULT_SCENARIOS_GENERIC_B2B from @growth/shared, OR
 * tenant-override registry from a future Phase 2.5 Blueprint.scenarios slot)
 * + context derived at the composer call site.
 *
 * Resolution precedence:
 *   1. Exact match on all 4 axes (persona × actionType × phase × trigger)
 *   2. Phase-agnostic fallback (scenario.phase === null) — scaffolded for
 *      registry expansion post-v1; no entries in v1
 *   3. Return null → composer falls back to current free-form path
 *
 * Per Phase 1 sparse-data discipline pin (epic): when no scenario matches,
 * returning null is the correct behavior. Composer's existing path is
 * preserved for tuples not yet in the registry.
 */
import type { Scenario, ScenarioTrigger, EnginePhaseKey } from '@growth/shared';

export interface ResolveScenarioContext {
  personaName: string;
  actionType: string;
  phase: EnginePhaseKey | null;
  trigger: ScenarioTrigger | null;
}

export function resolveScenario(
  scenarios: ReadonlyArray<Scenario>,
  context: ResolveScenarioContext,
): Scenario | null {
  if (context.trigger == null) return null;

  // Step 1: exact match on all 4 axes
  const exactMatch = scenarios.find(
    (s) =>
      s.persona === context.personaName &&
      s.actionType === context.actionType &&
      s.phase === context.phase &&
      s.trigger === context.trigger,
  );
  if (exactMatch) return exactMatch;

  // Step 2: phase-agnostic fallback (scenario.phase === null matches any
  // context.phase including null). Scaffolded for v1 expansion; no
  // entries in DEFAULT_SCENARIOS_GENERIC_B2B today.
  const phaseAgnosticMatch = scenarios.find(
    (s) =>
      s.persona === context.personaName &&
      s.actionType === context.actionType &&
      s.phase === null &&
      s.trigger === context.trigger,
  );
  if (phaseAgnosticMatch) return phaseAgnosticMatch;

  // Step 3: no match → composer falls back to free-form path
  return null;
}
