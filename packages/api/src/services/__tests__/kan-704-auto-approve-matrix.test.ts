/**
 * Tests for KAN-704 — auto-approve threshold matrix.
 *
 * Coverage matches the AC's resolution-order contract:
 *
 *   1. Tenant.autoApproveEnabled === false  → human_review (kill-switch)
 *   2. Stage.autoApproveMatrix[actionType]  → most specific tier wins
 *   3. Pipeline.defaultAutoApproveMatrix[…] → second tier when stage entry null
 *   4. PLATFORM_AUTO_APPROVE_DEFAULTS[…]    → fallback for known action types
 *   5. Legacy tenantConfig.confidenceThreshold (KAN-450) → fallback for unknown
 *
 * Plus: per-action-type sentinel routing (threshold=1.0 + default=human_review
 * → ALWAYS human_review regardless of confidence), platform-default
 * conservativeness (send_quote / reply_to_complaint never auto), and the
 * resolveAutoApproveEntry pure function on its own.
 */
import { describe, it, expect } from 'vitest';
import {
  PLATFORM_AUTO_APPROVE_DEFAULTS,
  resolveAutoApproveEntry,
  evaluateThreshold,
  type AutoApproveMatrix,
  type ThresholdGateInput,
} from '../threshold-gate.js';

const BASE_INPUT: ThresholdGateInput = {
  contactId: 'c1',
  tenantId: 't1',
  objectiveId: 'o1',
  overallConfidence: 80, // matrix-tier threshold 0.7 → 70 in 0..100 scale → 80 ≥ 70
  riskFlags: [],
  actionType: 'send_followup_email',
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
    // KAN-1005 M2-1 — default-deny aiPermissions: this pre-existing
    // KAN-704 matrix-integration test set is about matrix-vs-legacy
    // threshold resolution, not aiPermissions enforcement. Permit all
    // the action types this file exercises so the M2-1 gate doesn't
    // pre-empt the matrix-tier assertions. The actual aiPermissions
    // enforcement matrix lives in threshold-gate-kan-1005-enforcement.test.ts.
    aiPermissions: {
      actionTypes: {
        send_followup_email: 'auto',
        send_warm_up_email: 'auto',
        send_quote: 'auto',
        reply_to_complaint: 'auto',
        totally_unknown_action_xyz: 'auto',
        send_message: 'auto',
      },
    },
  },
  stageMatrix: null,
  pipelineMatrix: null,
  dailyAutoActionCount: 0,
};

// ─────────────────────────────────────────────
// Resolution order — pure helper
// ─────────────────────────────────────────────

describe('resolveAutoApproveEntry resolution order', () => {
  it('Stage tier wins over Pipeline + Platform default', () => {
    const stage: AutoApproveMatrix = {
      send_followup_email: { threshold: 0.5, default: 'auto', rationale: 'stage override' },
    };
    const pipeline: AutoApproveMatrix = {
      send_followup_email: { threshold: 0.8, default: 'auto', rationale: 'pipeline override' },
    };
    const out = resolveAutoApproveEntry('send_followup_email', stage, pipeline);
    expect(out?.threshold).toBe(0.5);
    expect(out?.rationale).toBe('stage override');
  });

  it('Pipeline tier wins over Platform default when Stage entry missing', () => {
    const pipeline: AutoApproveMatrix = {
      send_followup_email: { threshold: 0.85, default: 'auto', rationale: 'pipeline override' },
    };
    const out = resolveAutoApproveEntry('send_followup_email', null, pipeline);
    expect(out?.threshold).toBe(0.85);
    expect(out?.rationale).toBe('pipeline override');
  });

  it('Platform default fires when Stage + Pipeline both null', () => {
    const out = resolveAutoApproveEntry('send_followup_email', null, null);
    expect(out?.threshold).toBe(0.7);
    expect(out?.default).toBe('auto');
    expect(out?.rationale).toMatch(/follow-?up/i);
  });

  it('Returns null for unknown action types (caller defaults to human_review)', () => {
    expect(resolveAutoApproveEntry('weird_unknown_action', null, null)).toBeNull();
  });

  it('Empty matrix objects fall through to next tier (not treated as "explicit no")', () => {
    const stage: AutoApproveMatrix = {}; // present but no entry for the action type
    const pipeline: AutoApproveMatrix = {
      send_quote: { threshold: 0.9, default: 'auto', rationale: 'tenant override' },
    };
    const out = resolveAutoApproveEntry('send_quote', stage, pipeline);
    expect(out?.threshold).toBe(0.9);
    expect(out?.rationale).toBe('tenant override');
  });
});

// ─────────────────────────────────────────────
// Platform default catalog — V1 conservativeness
// ─────────────────────────────────────────────

describe('PLATFORM_AUTO_APPROVE_DEFAULTS conservative bias', () => {
  it('send_quote is sentinel — threshold 1.0 + human_review (never auto)', () => {
    const e = PLATFORM_AUTO_APPROVE_DEFAULTS.send_quote;
    expect(e.threshold).toBe(1.0);
    expect(e.default).toBe('human_review');
    expect(e.rationale).toMatch(/money/i);
  });

  it('reply_to_complaint is sentinel — threshold 1.0 + human_review (never auto)', () => {
    const e = PLATFORM_AUTO_APPROVE_DEFAULTS.reply_to_complaint;
    expect(e.threshold).toBe(1.0);
    expect(e.default).toBe('human_review');
    expect(e.rationale).toMatch(/reputation|complaint/i);
  });

  it('all 9 action types have a rationale (institutional memory preserved)', () => {
    const actions = Object.keys(PLATFORM_AUTO_APPROVE_DEFAULTS);
    expect(actions).toHaveLength(9);
    for (const a of actions) {
      const e = PLATFORM_AUTO_APPROVE_DEFAULTS[a as keyof typeof PLATFORM_AUTO_APPROVE_DEFAULTS];
      expect(e.rationale.length).toBeGreaterThan(20); // not empty / not placeholder
    }
  });

  it('all entries have threshold in [0, 1] and a valid default', () => {
    for (const e of Object.values(PLATFORM_AUTO_APPROVE_DEFAULTS)) {
      expect(e.threshold).toBeGreaterThanOrEqual(0);
      expect(e.threshold).toBeLessThanOrEqual(1);
      expect(['auto', 'human_review']).toContain(e.default);
    }
  });

  it('warm-up email has the lowest auto threshold (encourages outbound velocity)', () => {
    const warmUp = PLATFORM_AUTO_APPROVE_DEFAULTS.send_warm_up_email;
    const others = Object.values(PLATFORM_AUTO_APPROVE_DEFAULTS).filter(
      (e) => e.default === 'auto' && e !== warmUp,
    );
    for (const e of others) {
      expect(e.threshold).toBeGreaterThanOrEqual(warmUp.threshold);
    }
  });
});

// ─────────────────────────────────────────────
// evaluateThreshold — full integration
// ─────────────────────────────────────────────

describe('evaluateThreshold matrix integration', () => {
  it('approves when matrix threshold is met (stage tier)', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      overallConfidence: 75,
      stageMatrix: {
        send_followup_email: { threshold: 0.7, default: 'auto', rationale: 't' },
      },
    });
    expect(out.decision).toBe('approved');
    expect(out.threshold).toBe(70); // 0.7 normalized → 70
    expect(out.reasoning).toMatch(/auto-approve matrix/);
  });

  it('routes to human_review when matrix threshold is NOT met (stage tier)', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      overallConfidence: 65,
      stageMatrix: {
        send_followup_email: { threshold: 0.7, default: 'auto', rationale: 't' },
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.threshold).toBe(70);
  });

  it('falls through to Pipeline tier when Stage entry missing', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      overallConfidence: 90,
      stageMatrix: null,
      pipelineMatrix: {
        send_followup_email: { threshold: 0.85, default: 'auto', rationale: 'pipeline' },
      },
    });
    expect(out.decision).toBe('approved');
    expect(out.threshold).toBe(85);
  });

  it('falls through to Platform default when Stage + Pipeline both null', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_warm_up_email',
      overallConfidence: 65,
      stageMatrix: null,
      pipelineMatrix: null,
    });
    expect(out.decision).toBe('approved');
    expect(out.threshold).toBe(60); // platform default 0.6 → 60
  });

  it('legacy tenantConfig.confidenceThreshold fires for unknown action types', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'totally_unknown_action_xyz',
      overallConfidence: 75,
      tenantConfig: { ...BASE_INPUT.tenantConfig, confidenceThreshold: 70 },
    });
    expect(out.decision).toBe('approved');
    expect(out.threshold).toBe(70);
    expect(out.reasoning).toMatch(/legacy threshold/);
  });

  // ─────────────────────────────────────────────
  // Sentinel routing — never auto
  // ─────────────────────────────────────────────

  it('send_quote ALWAYS routes to human_review even at confidence 100 (sentinel)', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_quote',
      overallConfidence: 100,
      stageMatrix: null,
      pipelineMatrix: null,
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/configured for human review/);
  });

  it('reply_to_complaint ALWAYS routes to human_review (sentinel)', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'reply_to_complaint',
      overallConfidence: 100,
      stageMatrix: null,
      pipelineMatrix: null,
    });
    expect(out.decision).toBe('human_review');
  });

  // ─────────────────────────────────────────────
  // Kill-switch
  // ─────────────────────────────────────────────

  it('kill-switch (autoApproveEnabled=false) overrides ALL matrix configuration', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      overallConfidence: 100,
      tenantConfig: { ...BASE_INPUT.tenantConfig, autoApproveEnabled: false },
      stageMatrix: {
        send_followup_email: { threshold: 0.0, default: 'auto', rationale: 'permissive' },
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/kill-switch/);
  });

  it('kill-switch fires BEFORE matrix resolution (no rationale leak)', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_quote', // would be sentinel-human_review anyway
      tenantConfig: { ...BASE_INPUT.tenantConfig, autoApproveEnabled: false },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/kill-switch/);
    expect(out.reasoning).not.toMatch(/sentinel|matrix/i);
  });

  // ─────────────────────────────────────────────
  // Existing checks still fire
  // ─────────────────────────────────────────────

  it('blocked action types still get blocked (matrix does not bypass blocklist)', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        blockedActionTypes: ['send_followup_email'],
      },
    });
    expect(out.decision).toBe('blocked');
  });

  it('requireHumanApproval still routes to human_review (legacy KAN-39 surface)', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      overallConfidence: 100,
      tenantConfig: { ...BASE_INPUT.tenantConfig, requireHumanApproval: true },
    });
    expect(out.decision).toBe('human_review');
  });

  it('auto-escalation flags still escalate even when matrix would auto-approve', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      overallConfidence: 100,
      riskFlags: ['CRITICAL_GAP'],
      stageMatrix: {
        send_followup_email: { threshold: 0.0, default: 'auto', rationale: 'permissive' },
      },
    });
    expect(out.decision).toBe('auto_escalated');
  });
});
