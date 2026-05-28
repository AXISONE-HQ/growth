/**
 * M3-1a — discovery candidate score-wire-up + behavior tests.
 *
 * Pins the property S4 (KAN-1005 M2-4) taught us matters: not the
 * magnitudes themselves, but the behavior they produce. Tests evidence
 * the contract from the score-scale survey:
 *
 *   - Hard trigger reliably wins over realistic routine candidates (≤85)
 *   - Hard trigger LOSES to human-override sentinels (100) — doctrine
 *     "human override beats discovery" preserved by construction
 *   - Soft trigger at max gap-score (1.0) loses to message-aligned
 *     routine 85 — "exceptionally-high routine wins" PRD requirement
 *   - Soft trigger at max gap-score beats baseline routine 70
 *   - Below soft threshold: no discovery candidate fires at all
 *   - No gap-state input → engine behavior unchanged (no discoveryTarget
 *     on payload, no discovery directive in reasoning)
 */
import { describe, it, expect } from 'vitest';
import { determineAction, type ActionDeterminerInput } from '../action-determiner.js';
import type { SubObjectiveGapState } from '@growth/shared';

function baseInput(overrides: Partial<ActionDeterminerInput> = {}): ActionDeterminerInput {
  return {
    contactId: 'c-1',
    tenantId: 't-1',
    objectiveId: 'o-1',
    selectedStrategy: 'direct',
    strategyConfidence: 80,
    strategyReasoning: 'baseline',
    primaryGap: null,
    contactContext: { name: 'Sarah' },
    ...overrides,
  };
}

function hardTriggerGapState(): SubObjectiveGapState {
  return {
    prioritizedGaps: [
      {
        key: 'timeline',
        label: 'When are they looking to start?',
        valueType: 'text',
        state: 'unknown',
        priorityWeight: 0.9,
        requiredAtStage: 'qualified',
        recencyDaysSinceLastEval: 0,
        score: 0.9,
        hardTrigger: true,
      },
    ],
    topCandidate: { key: 'timeline', label: 'When are they looking to start?', score: 0.9, hardTrigger: true },
  };
}

function softTriggerGapState(score: number): SubObjectiveGapState {
  return {
    prioritizedGaps: [
      {
        key: 'budget',
        label: "What's their budget range?",
        valueType: 'enum',
        state: 'unknown',
        priorityWeight: 0.85,
        recencyDaysSinceLastEval: 0,
        score,
        hardTrigger: false,
      },
    ],
    topCandidate: { key: 'budget', label: "What's their budget range?", score, hardTrigger: false },
  };
}

describe('M3-1a — hard trigger reliably wins over routine candidates', () => {
  it('hard trigger discovery beats baseline send_message (70)', () => {
    const result = determineAction(baseInput({ subObjectiveGapState: hardTriggerGapState() }));
    expect(result.actionType).toBe('send_message');
    expect(result.actionPayload.discoveryTarget?.subObjectiveKey).toBe('timeline');
    expect(result.actionPayload.discoveryTarget?.triggerType).toBe('hard');
    expect(result.reasoning).toMatch(/Discovery target: ask about/);
    expect(result.reasoning).toMatch(/Trigger: hard/);
  });

  it('hard trigger discovery beats message-aligned routine (85)', () => {
    // primaryGap.suggestedActions with 'email' boosts the routine send_message
    // to 85 (70 baseline + 15 alignment). Hard discovery at 95 still wins.
    const result = determineAction(
      baseInput({
        primaryGap: {
          subObjectiveId: 'sub-1',
          subObjectiveName: 'placeholder',
          category: 'general',
          severity: 'medium',
          reason: 'not_started',
          suggestedActions: ['send email follow-up'],
        },
        subObjectiveGapState: hardTriggerGapState(),
      }),
    );
    expect(result.actionType).toBe('send_message');
    expect(result.actionPayload.discoveryTarget?.subObjectiveKey).toBe('timeline');
  });
});

describe('M3-1a — hard trigger LOSES to human-override sentinel (doctrine preserved)', () => {
  it('tenant requireHumanApproval (score 100) beats hard discovery (95)', () => {
    const result = determineAction(
      baseInput({
        subObjectiveGapState: hardTriggerGapState(),
        tenantPermissions: { requireHumanApproval: true },
      }),
    );
    expect(result.actionType).toBe('escalate_human');
    expect(result.actionPayload.discoveryTarget).toBeUndefined();
    expect(result.reasoning).not.toMatch(/Discovery target/);
  });
});

describe('M3-1a — soft trigger competes fairly', () => {
  it('soft trigger at max gap-score (1.0) → discovery score 80 LOSES to message-aligned routine 85', () => {
    const result = determineAction(
      baseInput({
        primaryGap: {
          subObjectiveId: 'sub-1',
          subObjectiveName: 'placeholder',
          category: 'general',
          severity: 'medium',
          reason: 'not_started',
          suggestedActions: ['send email follow-up'],
        },
        subObjectiveGapState: softTriggerGapState(1.0),
      }),
    );
    expect(result.actionType).toBe('send_message');
    // Winner is the message-aligned routine, NOT the discovery soft candidate.
    expect(result.actionPayload.discoveryTarget).toBeUndefined();
  });

  it('soft trigger at max gap-score (1.0) → discovery score 80 BEATS baseline routine 70', () => {
    const result = determineAction(
      baseInput({ subObjectiveGapState: softTriggerGapState(1.0) }),
    );
    expect(result.actionType).toBe('send_message');
    expect(result.actionPayload.discoveryTarget?.subObjectiveKey).toBe('budget');
    expect(result.actionPayload.discoveryTarget?.triggerType).toBe('soft');
    expect(result.reasoning).toMatch(/Trigger: soft/);
  });

  it('soft trigger BELOW threshold (0.5) → no discovery candidate fires; baseline routine wins', () => {
    const result = determineAction(
      baseInput({ subObjectiveGapState: softTriggerGapState(0.5) }),
    );
    expect(result.actionType).toBe('send_message');
    expect(result.actionPayload.discoveryTarget).toBeUndefined();
    expect(result.reasoning).not.toMatch(/Discovery target/);
  });

  it('soft trigger exactly AT threshold (0.6) → discovery emits + wins over baseline', () => {
    const result = determineAction(
      baseInput({ subObjectiveGapState: softTriggerGapState(0.6) }),
    );
    expect(result.actionType).toBe('send_message');
    expect(result.actionPayload.discoveryTarget?.subObjectiveKey).toBe('budget');
  });
});

describe('M3-1a — no gap-state input → engine behavior unchanged', () => {
  it('no subObjectiveGapState → no discoveryTarget on payload, no directive in reasoning', () => {
    const result = determineAction(baseInput());
    expect(result.actionPayload.discoveryTarget).toBeUndefined();
    expect(result.reasoning).not.toMatch(/Discovery target/);
  });

  it('empty subObjectiveGapState (no topCandidate) → no discoveryTarget on payload', () => {
    const result = determineAction(
      baseInput({ subObjectiveGapState: { prioritizedGaps: [], topCandidate: undefined } }),
    );
    expect(result.actionPayload.discoveryTarget).toBeUndefined();
    expect(result.reasoning).not.toMatch(/Discovery target/);
  });
});

describe('M3-1a — reasoning directive is human-readable (not serialized schema)', () => {
  it('discovery reasoning is operator-facing text, not JSON', () => {
    const result = determineAction(baseInput({ subObjectiveGapState: hardTriggerGapState() }));
    // Operator-readable sentence — phrase, stage context, trigger marker.
    // Specifically NOT a serialized object dump (no {, [, " chars at start).
    expect(result.reasoning).toMatch(/^Discovery target: ask about when are they looking to start\. Engine needs this to advance the contact to qualified\./);
    expect(result.reasoning).not.toMatch(/^[{\[]/);
  });
});
