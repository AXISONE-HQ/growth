/**
 * KAN-749 MVP — vocabulary fall-through behavior in the threshold gate.
 *
 * Under MVP shape, callers (runFreeform / runAgentic) emit `actionType` AS-IS:
 *   - runFreeform → determiner vocab (send_message, schedule_follow_up, etc.)
 *   - runAgentic → transport vocab (send_email, send_sms, no_op, escalate)
 *   - runPlaybookStep → transport vocab
 *
 * The matrix (Stage.autoApproveMatrix / Pipeline.defaultAutoApproveMatrix /
 * PLATFORM_AUTO_APPROVE_DEFAULTS) is keyed on the SEMANTIC vocab
 * (AutoApproveActionType in threshold-gate.ts: send_warm_up_email,
 * send_followup_email, etc. — 9 values, ZERO intersection with transport
 * or determiner).
 *
 * Result on miss: resolveAutoApproveEntry() returns null → evaluateThreshold
 * falls back to tenantConfig.confidenceThreshold (legacy flat path) — KAN-450
 * baseline.
 *
 * KAN-763 (Phase C) will unify the 3 vocabs. KAN-768 will add typed telemetry
 * on the fall-through. PR3 ships symmetric governance with vocab fall-through
 * tolerated.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateThreshold,
  type ThresholdGateInput,
  type AutoApproveMatrix,
} from '../threshold-gate.js';

const BASE_INPUT: ThresholdGateInput = {
  contactId: 'c1',
  tenantId: 't1',
  objectiveId: 'o1',
  overallConfidence: 80,
  riskFlags: [],
  actionType: 'send_followup_email', // semantic — overridden per test
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
    autoApproveEnabled: true,
    // KAN-1005 M2-1 — default-deny permits-all opt-in for action types
    // this vocab fall-through file exercises. Tests use diverse action
    // types (transport, determiner, sentinel, unknown vocab) — wildcard
    // '*' is cleaner than enumerating each. Default-deny enforcement
    // matrix lives in threshold-gate-kan-1005-enforcement.test.ts; here
    // we want the M2-1 gate to pass through so matrix-vs-legacy fall-
    // through behavior is what gets tested.
    aiPermissions: {
      actionTypes: {
        '*': 'auto',
      },
    },
  },
  stageMatrix: null,
  pipelineMatrix: null,
  dailyAutoActionCount: 0,
};

describe('KAN-749 — vocabulary fall-through (MVP shape)', () => {
  it('positive control: semantic actionType matched in stage matrix → matrix decision wins', () => {
    const stageMatrix: AutoApproveMatrix = {
      send_followup_email: { threshold: 0.5, default: 'auto', rationale: 'stage override' },
    };
    const result = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_followup_email',
      overallConfidence: 60, // 0.5 → 50 in 0..100; 60 ≥ 50 → approved
      stageMatrix,
    });
    expect(result.decision).toBe('approved');
    expect(result.reasoning).toContain('auto-approve matrix threshold 50');
  });

  it('determiner vocab + semantic-keyed stage matrix → matrix MISS → legacy threshold path', () => {
    const stageMatrix: AutoApproveMatrix = {
      send_followup_email: { threshold: 0.5, default: 'auto', rationale: 'stage' },
    };
    // runFreeform emits determiner vocab. Matrix is keyed on semantic. Lookup
    // returns null. Gate falls through to tenantConfig.confidenceThreshold.
    const result = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_message', // determiner vocab — not in any matrix
      overallConfidence: 80, // tenant.confidenceThreshold = 70; 80 ≥ 70 → approved
      stageMatrix,
    });
    expect(result.decision).toBe('approved');
    // Reasoning string distinguishes legacy vs matrix path. Until KAN-768,
    // this is the only telemetry signal that the fall-through fired.
    expect(result.reasoning).toContain('legacy threshold');
    expect(result.reasoning).not.toContain('auto-approve matrix threshold');
  });

  it('transport vocab + semantic-keyed pipeline matrix → matrix MISS → legacy threshold path', () => {
    const pipelineMatrix: AutoApproveMatrix = {
      send_quote: { threshold: 1.0, default: 'human_review', rationale: 'sentinel' },
    };
    const result = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_email', // transport vocab — not in any matrix
      overallConfidence: 80,
      pipelineMatrix,
    });
    expect(result.decision).toBe('approved');
    expect(result.reasoning).toContain('legacy threshold');
  });

  it('completely unknown vocab + no matrices → PLATFORM_AUTO_APPROVE_DEFAULTS miss → legacy path', () => {
    // resolveAutoApproveEntry returns null at all 3 tiers.
    // Gate uses tenantConfig.confidenceThreshold (legacy KAN-450 path).
    const result = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'unknown_action_v9_nonexistent',
      overallConfidence: 60, // < 70 → human_review under legacy
    });
    expect(result.decision).toBe('human_review');
    expect(result.reasoning).toContain('legacy threshold 70');
  });

  it('vocab fall-through + low confidence + tenant.autoApproveEnabled=true → human_review (legacy)', () => {
    // Defensive baseline: vocab miss alone doesn't bypass governance — confidence
    // still has to clear the legacy bar. Tenant kill-switch is checked separately.
    const result = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'schedule_follow_up', // determiner
      overallConfidence: 50, // < 70
    });
    expect(result.decision).toBe('human_review');
    expect(result.reasoning).toContain('legacy threshold');
  });
});

describe('KAN-749 — vocab fall-through telemetry signal (proxy until KAN-768)', () => {
  it('reasoning string contains "legacy threshold" when fall-through fires (filterable signal)', () => {
    // Until KAN-768 ships typed `vocab_fallthrough` audit events, the only
    // observable signal that the fall-through happened is the reasoning text.
    // This test pins the contract: any vocab-mismatch path produces a
    // greppable "legacy threshold" substring. Operators / KAN-763 audit can
    // grep on this in the interim.
    const result = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_message',
      overallConfidence: 80,
    });
    expect(result.reasoning).toMatch(/legacy threshold/);
  });
});
