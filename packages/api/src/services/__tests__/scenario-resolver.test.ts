/**
 * KAN-1094 (Cluster IV-B PR II) — scenario-resolver tests.
 *
 * Coverage:
 *   - Exact match on all 4 axes (persona × actionType × phase × trigger)
 *   - Phase-agnostic fallback (scenario.phase === null)
 *   - No match → null (composer falls back to free-form path)
 *   - Null trigger → null (operator_initiated / no_touch_followup v2 scope)
 *   - SENTINEL: 8-tuple grid coverage for send_follow_up × {4 phases} × {2 triggers}
 *   - Persona mismatch → no fallback (persona is exact-match required)
 *   - actionType mismatch → no match for non-send_follow_up in v1 registry
 */
import { describe, it, expect } from 'vitest';
import {
  resolveScenario,
  type ResolveScenarioContext,
} from '../scenario-resolver.js';
import {
  DEFAULT_SCENARIOS_GENERIC_B2B,
  type Scenario,
  type EnginePhaseKey,
  type ScenarioTrigger,
} from '@growth/shared';

const PERSONA = 'Generic B2B SaaS';

function ctx(overrides: Partial<ResolveScenarioContext> = {}): ResolveScenarioContext {
  return {
    personaName: PERSONA,
    actionType: 'send_follow_up',
    phase: 'qualify',
    trigger: 'initial_inbound',
    ...overrides,
  };
}

describe('resolveScenario — exact match', () => {
  it('returns matching scenario when all 4 axes align', () => {
    const result = resolveScenario(DEFAULT_SCENARIOS_GENERIC_B2B, ctx({ phase: 'qualify', trigger: 'reply' }));
    expect(result).not.toBeNull();
    expect(result!.phase).toBe('qualify');
    expect(result!.trigger).toBe('reply');
    expect(result!.promptBlock).toContain('contact replied');
  });

  it('different phase → different scenario returned', () => {
    const qualify = resolveScenario(DEFAULT_SCENARIOS_GENERIC_B2B, ctx({ phase: 'qualify', trigger: 'initial_inbound' }));
    const closing = resolveScenario(DEFAULT_SCENARIOS_GENERIC_B2B, ctx({ phase: 'closing', trigger: 'initial_inbound' }));
    expect(qualify!.promptBlock).not.toBe(closing!.promptBlock);
    expect(closing!.promptBlock).toMatch(/decisive|assumptive/i);
  });
});

describe('resolveScenario — null fallback paths', () => {
  it('null trigger → null (operator_initiated / no_touch_followup v2 scope)', () => {
    expect(resolveScenario(DEFAULT_SCENARIOS_GENERIC_B2B, ctx({ trigger: null }))).toBeNull();
  });

  it('non-matching trigger (operator_initiated) → null in v1 registry', () => {
    expect(
      resolveScenario(DEFAULT_SCENARIOS_GENERIC_B2B, ctx({ trigger: 'operator_initiated' })),
    ).toBeNull();
  });

  it('non-matching trigger (no_touch_followup) → null in v1 registry', () => {
    expect(
      resolveScenario(DEFAULT_SCENARIOS_GENERIC_B2B, ctx({ trigger: 'no_touch_followup' })),
    ).toBeNull();
  });

  it('non-matching actionType (transition_sub_objective) → null', () => {
    expect(
      resolveScenario(DEFAULT_SCENARIOS_GENERIC_B2B, ctx({ actionType: 'transition_sub_objective' })),
    ).toBeNull();
  });

  it('persona mismatch → null (persona is exact-match required)', () => {
    expect(
      resolveScenario(DEFAULT_SCENARIOS_GENERIC_B2B, ctx({ personaName: 'Acme Vertical' })),
    ).toBeNull();
  });

  it('null phase context with no phase-agnostic scenarios → null', () => {
    expect(resolveScenario(DEFAULT_SCENARIOS_GENERIC_B2B, ctx({ phase: null }))).toBeNull();
  });
});

describe('resolveScenario — phase-agnostic fallback (registry expansion scaffolding)', () => {
  it('phase=null scenario in registry matches any context.phase for same persona/action/trigger', () => {
    const phaseAgnosticScenario: Scenario = {
      persona: PERSONA,
      actionType: 'send_follow_up',
      phase: null,
      trigger: 'operator_initiated',
      promptBlock: 'Phase-agnostic operator-accept template',
    };
    const expanded = [...DEFAULT_SCENARIOS_GENERIC_B2B, phaseAgnosticScenario];

    const result = resolveScenario(expanded, ctx({ phase: 'qualify', trigger: 'operator_initiated' }));
    expect(result).not.toBeNull();
    expect(result!.promptBlock).toBe('Phase-agnostic operator-accept template');
  });

  it('exact match precedence over phase-agnostic when both present', () => {
    const phaseAgnostic: Scenario = {
      persona: PERSONA,
      actionType: 'send_follow_up',
      phase: null,
      trigger: 'initial_inbound',
      promptBlock: 'PHASE_AGNOSTIC',
    };
    const expanded = [...DEFAULT_SCENARIOS_GENERIC_B2B, phaseAgnostic];

    const result = resolveScenario(expanded, ctx({ phase: 'qualify', trigger: 'initial_inbound' }));
    expect(result!.promptBlock).not.toBe('PHASE_AGNOSTIC');
    expect(result!.promptBlock).toMatch(/CURIOUS open-ended question/);
  });
});

describe('SENTINEL — 8-tuple grid coverage', () => {
  it('every (send_follow_up × {4 phases} × {initial_inbound, reply}) tuple finds a scenario in DEFAULT registry', () => {
    const phases: EnginePhaseKey[] = ['qualify', 'problem', 'proof', 'closing'];
    const triggers: ScenarioTrigger[] = ['initial_inbound', 'reply'];

    const missing: string[] = [];
    for (const phase of phases) {
      for (const trigger of triggers) {
        const result = resolveScenario(DEFAULT_SCENARIOS_GENERIC_B2B, ctx({ phase, trigger }));
        if (!result) {
          missing.push(`${phase}/${trigger}`);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(DEFAULT_SCENARIOS_GENERIC_B2B.length).toBe(8);
  });

  it('Q2 (ii) lock — PROOF scenarios use generic "proof point" phrasing, NOT specific "case study" references', () => {
    const proofScenarios = DEFAULT_SCENARIOS_GENERIC_B2B.filter((s) => s.phase === 'proof');
    expect(proofScenarios.length).toBe(2);
    for (const scenario of proofScenarios) {
      expect(scenario.promptBlock).toContain('proof point');
      expect(scenario.promptBlock).not.toMatch(/case stud(y|ies)/i);
    }
  });

  it('PROOF scenarios reference proof-point without specific corpus content (KAN-828 empty)', () => {
    const proofScenarios = DEFAULT_SCENARIOS_GENERIC_B2B.filter((s) => s.phase === 'proof');
    for (const scenario of proofScenarios) {
      // Hallucination guard: scenarios should not name specific evidence
      // types the engine can't access (case_studies, customer_logos, etc.)
      expect(scenario.promptBlock).not.toMatch(/specific case|named customer/i);
    }
  });
});
