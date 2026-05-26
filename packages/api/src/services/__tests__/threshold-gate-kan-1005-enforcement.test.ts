/**
 * KAN-1005 M2-1 — governance gate enforcement matrix.
 *
 * Pins the four PRD outcomes (all evaluated with autoApproveEnabled=true
 * mocked — today's M1 posture has it false, but M2-6b's flip is what
 * makes these gates load-bearing):
 *
 *   1. daily-action-limit exceeded     → human_review
 *   2. autoEscalateFlags match         → auto_escalated
 *   3. aiPermissions denial (default-deny) → human_review
 *   4. under-limit + no flag + permitted   → approved (would-EXECUTE)
 *
 * Plus the defensive parses + tenant-namespacing guard.
 *
 * Today changes ZERO live behavior — autoApproveEnabled stays false
 * PROD-wide; the kill-switch escalates before any of these gates fire.
 * These tests assert the gates ARE load-bearing once M2-6b flips.
 */
import { describe, it, expect } from 'vitest';
import { evaluateThreshold, type ThresholdGateInput } from '../threshold-gate.js';

function baseInput(overrides: Partial<ThresholdGateInput['tenantConfig']> = {}): ThresholdGateInput {
  return {
    contactId: 'contact-1',
    tenantId: 'tenant-A',
    objectiveId: 'objective-1',
    overallConfidence: 90, // well above threshold
    riskFlags: [],
    actionType: 'send_message',
    channel: 'email',
    actionPayload: {},
    actionReasoning: 'test',
    selectedStrategy: 'direct',
    strategyReasoning: 'test',
    tenantConfig: {
      confidenceThreshold: 70,
      autoEscalateFlags: [],
      blockedActionTypes: [],
      requireHumanApproval: false,
      autoApproveEnabled: true, // ← M2-6b posture: flipped on for these tests
      // M2-1 default-permitted shape so the gate doesn't trip on aiPermissions
      // unless the specific test sets it otherwise.
      aiPermissions: { actionTypes: { send_message: 'auto' } },
      ...overrides,
    },
    stageMatrix: null,
    pipelineMatrix: null,
    dailyAutoActionCount: 0,
  };
}

describe('KAN-1005 M2-1 — Outcome 1: daily-action-limit exceeded → human_review', () => {
  it('count >= maxDailyAutoActions → human_review', () => {
    const r = evaluateThreshold({
      ...baseInput({ maxDailyAutoActions: 5 }),
      dailyAutoActionCount: 5,
    });
    expect(r.decision).toBe('human_review');
    expect(r.reasoning).toMatch(/Daily auto-action limit/);
  });

  it('count just under limit → approved (would-EXECUTE)', () => {
    const r = evaluateThreshold({
      ...baseInput({ maxDailyAutoActions: 5 }),
      dailyAutoActionCount: 4,
    });
    expect(r.decision).toBe('approved');
  });

  it('maxDailyAutoActions undefined → gate skipped (no false-trip)', () => {
    const r = evaluateThreshold({ ...baseInput(), dailyAutoActionCount: 9999 });
    expect(r.decision).toBe('approved');
  });
});

describe('KAN-1005 M2-1 — Outcome 2: autoEscalateFlags match → auto_escalated', () => {
  it('riskFlag in tenant autoEscalateFlags → auto_escalated', () => {
    const input = baseInput({ autoEscalateFlags: ['DEAL_VALUE_OVER_10K'] });
    input.riskFlags = ['DEAL_VALUE_OVER_10K'];
    const r = evaluateThreshold(input);
    expect(r.decision).toBe('auto_escalated');
    expect(r.reasoning).toMatch(/DEAL_VALUE_OVER_10K/);
  });

  it('riskFlag NOT in escalate list → not escalated by this gate', () => {
    const input = baseInput({ autoEscalateFlags: ['DEAL_VALUE_OVER_10K'] });
    input.riskFlags = ['MINOR_THING'];
    const r = evaluateThreshold(input);
    expect(r.decision).toBe('approved');
  });

  it('default-escalate flags (CRITICAL_GAP etc.) still trigger when riskFlag matches', () => {
    const input = baseInput();
    input.riskFlags = ['CRITICAL_GAP'];
    const r = evaluateThreshold(input);
    expect(r.decision).toBe('auto_escalated');
  });
});

describe('KAN-1005 M2-1 — Outcome 3: aiPermissions denial (default-deny) → human_review', () => {
  it('aiPermissions = {} → escalates (default-deny on missing actionTypes)', () => {
    const r = evaluateThreshold(baseInput({ aiPermissions: {} }));
    expect(r.decision).toBe('human_review');
    expect(r.reasoning).toMatch(/not permitted for autonomous execution/);
  });

  it('aiPermissions.actionTypes has no entry for actionType → escalates', () => {
    const r = evaluateThreshold(
      baseInput({ aiPermissions: { actionTypes: { other_action: 'auto' } } }),
    );
    expect(r.decision).toBe('human_review');
    expect(r.reasoning).toMatch(/no entry for "send_message"/);
  });

  it('aiPermissions.actionTypes.send_message = "escalate" → escalates', () => {
    const r = evaluateThreshold(
      baseInput({ aiPermissions: { actionTypes: { send_message: 'escalate' } } }),
    );
    expect(r.decision).toBe('human_review');
    expect(r.reasoning).toMatch(/= "escalate"/);
  });

  it('aiPermissions.actionTypes.send_message = "auto" → approved', () => {
    const r = evaluateThreshold(
      baseInput({ aiPermissions: { actionTypes: { send_message: 'auto' } } }),
    );
    expect(r.decision).toBe('approved');
  });

  it('Malformed aiPermissions (actionTypes is a string, not record) → escalates safely (no crash)', () => {
    const r = evaluateThreshold(
      baseInput({ aiPermissions: { actionTypes: 'garbage' as unknown as Record<string, string> } }),
    );
    expect(r.decision).toBe('human_review');
  });

  it('aiPermissions with passthrough non-M2 keys (dataQualityThreshold etc.) preserved + still escalates', () => {
    // Real PROD shape: aiPermissions has unrelated keys from other consumers
    // (data-quality, company-truth). The .passthrough() should allow them.
    const r = evaluateThreshold(
      baseInput({
        aiPermissions: {
          dataQualityThreshold: 0.7,
          truthInferenceThreshold: 70,
          // actionTypes intentionally absent → default-deny
        },
      }),
    );
    expect(r.decision).toBe('human_review');
    expect(r.reasoning).toMatch(/no entry for "send_message"/);
  });
});

describe('KAN-1005 M2-1 — Outcome 4: all-clear → approved (would-EXECUTE)', () => {
  it('autoApproveEnabled=true + under-limit + no escalate-flag + action permitted → approved', () => {
    const r = evaluateThreshold({
      ...baseInput({
        maxDailyAutoActions: 100,
        autoEscalateFlags: ['DEAL_VALUE_OVER_10K'], // not in risk flags below
      }),
      dailyAutoActionCount: 50,
    });
    expect(r.decision).toBe('approved');
    expect(r.reasoning).toMatch(/Action approved for execution/);
  });
});

describe('KAN-1005 M2-1 — kill-switch precedence (M1 posture)', () => {
  it('autoApproveEnabled=false (today PROD) overrides everything → human_review', () => {
    // Even with limits permissive + action permitted + no flags, the
    // M1 kill-switch routes to human_review. This is what made M2-1
    // safe to ship without flipping behavior: gates are moot under M1.
    const r = evaluateThreshold(baseInput({ autoApproveEnabled: false }));
    expect(r.decision).toBe('human_review');
    expect(r.reasoning).toMatch(/auto-approve is disabled/);
  });
});
