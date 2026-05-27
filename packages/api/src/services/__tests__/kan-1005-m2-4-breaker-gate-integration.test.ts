/**
 * KAN-1005 M2-4 — Circuit breaker × evaluateThreshold integration.
 *
 * Pins the step-3 placement: a tripped breaker forces human_review
 * BEFORE any per-action-type gate (aiPerm / matrix sentinel / confidence)
 * gets to authorize. This is the "no-bypass" property for the breaker:
 * tripped → escalate regardless of high confidence, safe action type
 * permitted as 'auto', or matrix-auto-default.
 *
 * Routes to `human_review`, not `blocked` — the queue keeps filling so
 * humans see the runaway during an incident.
 *
 * Distinct from autoApproveEnabled=false: both produce human_review but
 * different reasoning strings (audit-distinguishable).
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateThreshold,
  type ThresholdGateInput,
} from '../threshold-gate.js';

const BASE_INPUT: ThresholdGateInput = {
  contactId: 'c1',
  tenantId: 't1',
  objectiveId: 'o1',
  overallConfidence: 95, // very high
  riskFlags: [],
  actionType: 'send_message', // SAFE type
  channel: 'email',
  actionPayload: {},
  actionReasoning: 'test',
  selectedStrategy: 'direct',
  strategyReasoning: 'test',
  tenantConfig: {
    confidenceThreshold: 70,
    autoEscalateFlags: [],
    requireHumanApproval: false,
    autoApproveEnabled: true,
    aiPermissions: {
      actionTypes: { send_message: 'auto' }, // explicitly permitted
    },
  },
  stageMatrix: null,
  pipelineMatrix: null,
  dailyAutoActionCount: 0,
  breakerState: { tripped: false },
};

describe('KAN-1005 M2-4 — breaker tripped forces human_review regardless of permissions', () => {
  it('breaker tripped (rate) + aiPerm=auto + confidence=95 → human_review', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      breakerState: {
        tripped: true,
        scope: 'breaker_tripped_rate',
        isGlobal: false,
        reason: 'hourly_action_rate: 105/100',
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/circuit_breaker_tripped/);
    expect(out.reasoning).toMatch(/breaker_tripped_rate/);
    expect(out.reasoning).toMatch(/105\/100/);
  });

  it('breaker tripped (cost) → human_review with cost reason in attribution', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      breakerState: {
        tripped: true,
        scope: 'breaker_tripped_cost',
        isGlobal: false,
        reason: 'cost_cap_exceeded: $11/$10',
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/circuit_breaker_tripped/);
    expect(out.reasoning).toMatch(/breaker_tripped_cost/);
  });

  it('breaker tripped (error) → human_review', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      breakerState: {
        tripped: true,
        scope: 'breaker_tripped_error',
        isGlobal: false,
        reason: 'hourly_error_rate: 25/20',
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/breaker_tripped_error/);
  });

  it('global breaker tripped → human_review with [GLOBAL] marker', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      breakerState: {
        tripped: true,
        scope: 'breaker_tripped_cost',
        isGlobal: true,
        reason: 'ops_emergency_pause',
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/\[GLOBAL\]/);
  });

  it('fail-closed (Redis state unavailable) → human_review with failClosed marker', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      breakerState: {
        tripped: true,
        failClosed: true,
        reason: 'circuit_breaker_state_unavailable',
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/fail-closed/);
  });
});

describe('KAN-1005 M2-4 — blocked vs breaker precedence (founder call 2026-05-27)', () => {
  it('breaker tripped + aiPerm="blocked" → blocked (NOT human_review) — blocked is more restrictive', () => {
    // Founder precedence call 2026-05-27: 'blocked' is M2-3's hard-off
    // ("AI never does this action type at all, not even escalated").
    // A blocked action has no autonomy to pause, so the breaker can't
    // usefully convert it; converting blocked → human_review would
    // (a) violate the "not even escalated" semantic and (b) move in
    // the LESS-restrictive direction. blocked wins.
    //
    // Ladder ordering: aiPerm 'blocked' (step 3) is evaluated BEFORE
    // breaker (step 4) for exactly this property. The breaker still
    // catches everything that IS autonomy-eligible — permit and
    // escalate actions reach step 4 and get paused.
    const out = evaluateThreshold({
      ...BASE_INPUT,
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { send_message: 'blocked' } },
      },
      breakerState: {
        tripped: true,
        scope: 'breaker_tripped_rate',
        reason: 'spike',
      },
    });
    expect(out.decision).toBe('blocked');
    expect(out.decision).not.toBe('human_review');
    // Reasoning attribution shows the blocked path, not the breaker.
    expect(out.reasoning).toMatch(/blocked/);
    expect(out.reasoning).not.toMatch(/circuit_breaker_tripped/);
  });

  it('not breaker tripped + aiPerm=blocked → blocked (per-action-type override honored)', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { send_message: 'blocked' } },
      },
      breakerState: { tripped: false },
    });
    expect(out.decision).toBe('blocked');
  });

  it('breaker tripped + aiPerm="auto" (autonomy-eligible) → human_review (breaker catches autonomy-eligible paths)', () => {
    // Coverage anchor for the "breaker still catches everything that's
    // actually autonomy-eligible" half of the precedence call. Permit
    // (and escalate) reach the breaker; only blocked pre-empts it.
    const out = evaluateThreshold({
      ...BASE_INPUT,
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { send_message: 'auto' } },
      },
      breakerState: {
        tripped: true,
        scope: 'breaker_tripped_rate',
        reason: 'spike',
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/circuit_breaker_tripped/);
  });
});

describe('KAN-1005 M2-4 — breaker vs kill-switch distinction', () => {
  it('kill-switch (autoApproveEnabled=false) → kill-switch reasoning (NOT circuit_breaker)', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        autoApproveEnabled: false,
      },
      breakerState: { tripped: false },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/kill-switch/);
    expect(out.reasoning).not.toMatch(/circuit_breaker/);
  });

  it('kill-switch + breaker both tripped → kill-switch wins in attribution (deliberate human pause cited first)', () => {
    // Ordering: kill-switch (step 2) is checked BEFORE breaker (step 3).
    // When both are active, the kill-switch reasoning is shown; that's
    // the right attribution because the human pause is the operator's
    // explicit intent, regardless of whether the breaker would have
    // tripped anyway.
    const out = evaluateThreshold({
      ...BASE_INPUT,
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        autoApproveEnabled: false,
      },
      breakerState: {
        tripped: true,
        scope: 'breaker_tripped_rate',
        reason: 'spike',
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/kill-switch/);
  });
});

describe('KAN-1005 M2-4 — breaker NOT tripped + permitted action → approved (no false positive)', () => {
  it('default breakerState (untripped) + permitted action + high confidence → approved', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      // breakerState: { tripped: false } via default
    });
    expect(out.decision).toBe('approved');
  });

  it('breakerState omitted entirely → defaults to untripped → approved (back-compat)', () => {
    const { breakerState: _unused, ...inputNoBreaker } = BASE_INPUT;
    void _unused; // satisfy unused-var lint
    const out = evaluateThreshold(inputNoBreaker as ThresholdGateInput);
    expect(out.decision).toBe('approved');
  });
});
