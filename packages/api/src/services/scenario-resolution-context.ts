/**
 * Shared scenario + persona + phase + trigger resolution for
 * Cluster IV-B message construction.
 *
 * Callers (ENUMERATED — KAN-1098 phase-1-enumeration-discipline):
 * - apps/api/src/subscribers/action-decided-push.ts:~414 (KAN-1094
 *   composer path, recommendations-accept + KAN-1037-PR4.5 replay)
 * - apps/api/src/subscribers/lead-received-push.ts:~2562 (KAN-1098
 *   shaper path, autonomy-mode dispatchPhase2Send)
 *
 * When adding a new caller, append to this list. When changing the
 * helper's surface, audit all listed callers.
 *
 * v1 channel scope (KAN-1098 Phase 1 item 6 lock): scenario lookup
 * applies to email channel only. sms / meta_messenger callers receive
 * `{ scenario: null }` — composer/shaper falls through to free-form
 * prompt construction. KAN-1099 expands the registry to multi-channel.
 *
 * Best-effort posture (mirrors `blueprint-persona-resolver.ts` Q3 audit
 * pattern + `scenario-resolver.ts` null-fallthrough discipline): any
 * sub-resolver failure (Prisma throw, malformed Json, missing tenant)
 * falls back to safe defaults (DEFAULT_PERSONA_GENERIC_B2B + phase=null
 * + scenario=null) plus a best-effort `scenario_resolution_context.failed`
 * audit row. Scenario injection is a quality enhancement, NOT a
 * correctness gate — failures must NEVER block the send.
 *
 * Telemetry note: this helper does NOT emit `scenario-matched` /
 * `scenario-resolution-failed` log lines. Each caller emits its own
 * `kan-1094`-prefixed (composer path) or `kan-1098`-prefixed (shaper
 * path) log line so the Tier 2 cognitive-metrics dashboard can
 * disaggregate emission rates per call-site. The helper returns the
 * resolved context; the subscriber owns observability.
 */
import type { PrismaClient } from '@prisma/client';
import {
  DEFAULT_SCENARIOS_GENERIC_B2B,
  DEFAULT_PERSONA_GENERIC_B2B,
  type BlueprintPersona,
  type Scenario,
  type ScenarioTrigger,
  type EnginePhaseKey,
} from '@growth/shared';
import { resolveBlueprintPersona } from './blueprint-persona-resolver.js';
import { resolveEnginePhases } from './blueprint-engine-phases-resolver.js';
import { computeCurrentEnginePhase } from './brain-service.js';
import { resolveScenario } from './scenario-resolver.js';

export interface ScenarioContextInput {
  tenantId: string;
  contactId: string;
  /**
   * Threaded for future trace correlation + helper-internal Deal lookups
   * (no consumer today — the helper resolves persona + scenario from
   * tenantId + contactId alone). Keep in the surface so caller change
   * isn't required when a future scenario rule keys off Deal state.
   */
  dealId: string;
  /**
   * Channel the dispatcher will send on. v1 scope: only `'email'`
   * triggers a scenario lookup; other channels short-circuit to
   * `scenario: null`. Duck-typed string — sender-side enums vary
   * across composer (`ChannelType`) and shaper (`ShapedMessageChannel`).
   */
  channel: string;
  /**
   * BrainActionType the engine emitted (e.g. `'send_follow_up'`).
   * Duck-typed string per the Cluster III strike #3 type-duplication
   * memo — scenario tuple keys on actionType string match against
   * registered scenarios in `DEFAULT_SCENARIOS_GENERIC_B2B`.
   */
  actionType: string;
}

export interface ScenarioContext {
  /** Resolved persona (override → blueprint → DEFAULT). Always populated. */
  persona: BlueprintPersona;
  /**
   * Derived current engine phase key. `null` ONLY on resolver failure
   * (defensive — `computeCurrentEnginePhase` always returns a phase given
   * non-empty `enginePhases`, which `resolveEnginePhases` fail-safes to
   * DEFAULT).
   */
  currentEnginePhase: EnginePhaseKey | null;
  /**
   * Derived scenario trigger. `null` when neither `initial_inbound` nor
   * `reply` matches the engagement state (v1 scope per Phase 1 Q4 lock —
   * `operator_initiated` + `no_touch_followup` deferred to v2 / KAN-1099).
   */
  trigger: ScenarioTrigger | null;
  /**
   * Matched scenario (or `null` for: non-email channel, no trigger,
   * unmatched tuple, OR resolver failure). When `null`, caller falls
   * through to free-form composer/shaper prompt construction.
   */
  scenario: Scenario | null;
}

export async function resolveScenarioContext(
  prisma: PrismaClient,
  input: ScenarioContextInput,
): Promise<ScenarioContext> {
  try {
    // Step 1: persona resolution (override → blueprint → DEFAULT).
    const persona = await resolveBlueprintPersona(prisma, input.tenantId);

    // Step 2: trigger derivation via engagement groupBy (Phase 1 Q4 lock).
    // v1 derives only `initial_inbound` + `reply`; other triggers null.
    const counts = await prisma.engagement.groupBy({
      by: ['engagementType'],
      where: { contactId: input.contactId },
      _count: true,
    });
    const inboundCount =
      counts.find((c) => c.engagementType === 'email_received')?._count ?? 0;
    const outboundCount =
      counts.find((c) => c.engagementType === 'email_send')?._count ?? 0;
    const trigger: ScenarioTrigger | null =
      outboundCount === 0 && inboundCount > 0
        ? 'initial_inbound'
        : outboundCount > 0 && inboundCount > 0
          ? 'reply'
          : null;

    // Step 3: current engine phase derivation (gap state + phase config).
    const gapState = await prisma.contactSubObjectiveGapState.findMany({
      where: { contactId: input.contactId },
    });
    const enginePhases = await resolveEnginePhases(prisma, input.tenantId);
    const phaseSnapshot = computeCurrentEnginePhase({
      gapState,
      enginePhases,
    });
    const currentEnginePhase = phaseSnapshot.currentPhase.key;

    // Step 4: channel filter (Phase 1 item 6 lock — email-only in v1).
    // Non-email channels receive { scenario: null } regardless of tuple
    // match; KAN-1099 will register multi-channel scenarios.
    if (input.channel !== 'email') {
      return { persona, currentEnginePhase, trigger, scenario: null };
    }

    // Step 5: scenario lookup. `resolveScenario` returns null on no
    // trigger OR unmatched tuple; caller treats null as fall-through.
    const scenario = resolveScenario(DEFAULT_SCENARIOS_GENERIC_B2B, {
      personaName: persona.name,
      actionType: input.actionType,
      phase: currentEnginePhase,
      trigger,
    });

    return { persona, currentEnginePhase, trigger, scenario };
  } catch (err) {
    await writeResolveFailedAudit(prisma, input, (err as Error)?.message ?? String(err));
    return {
      persona: DEFAULT_PERSONA_GENERIC_B2B,
      currentEnginePhase: null,
      trigger: null,
      scenario: null,
    };
  }
}

/**
 * Best-effort audit row (sibling naming to `blueprint_persona.resolve_failed`,
 * `engine_phases.resolve_failed`, `engine_phase_stage_map.resolve_failed`).
 * If the audit write itself fails, swallow + warn — the caller already
 * receives safe defaults.
 */
async function writeResolveFailedAudit(
  prisma: PrismaClient,
  input: ScenarioContextInput,
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
        tenantId: input.tenantId,
        actor: 'system:scenario-resolution-context',
        actionType: 'scenario_resolution_context.failed',
        reasoning: reason,
        payload: {
          tenantId: input.tenantId,
          contactId: input.contactId,
          dealId: input.dealId,
          channel: input.channel,
          actionType: input.actionType,
          reason,
        },
      },
    });
  } catch (auditErr) {
    console.warn(
      `[scenario-resolution-context] audit write failed (best-effort): ${
        (auditErr as Error)?.message ?? String(auditErr)
      }`,
    );
  }
}
