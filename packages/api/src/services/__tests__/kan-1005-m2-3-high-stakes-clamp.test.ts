/**
 * KAN-1005 M2-3 — System-level high-stakes clamp + unified tri-value
 * permission model.
 *
 * The central M2 safety property: no tenant configuration — not a typo,
 * not a bad default, not a re-introduced wildcard — can make a
 * high-stakes action autonomous. Even when the matrix would route to
 * auto (e.g. transition_to_closed_won at threshold 0.9), the clamp
 * escalates.
 *
 * Test matrix:
 *   - Each of the 6 high-stakes types × { auto, escalate, blocked, unset } tenant config
 *   - Clamp fires via the matrix-default-'auto' path (not just aiPermissions path)
 *   - Cross-vocab: Semantic (send_quote), Determiner (close_objective), Brain (close_deal_lost)
 *   - SAFE types: send_message, send_email → auto permits, unset escalates
 *   - Tri-value: blocked + escalate + auto + unset semantics on a safe type
 *   - 'blocked' overrides clamp escalation (tenant stricter than system)
 *   - Unknown action types → default-deny (no slip-to-auto)
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateThreshold,
  resolveAiPermission,
  HIGH_STAKES_ACTION_TYPES,
  type ThresholdGateInput,
  type AutoApproveMatrix,
} from '../threshold-gate.js';

const BASE_INPUT: ThresholdGateInput = {
  contactId: 'c1',
  tenantId: 't1',
  objectiveId: 'o1',
  overallConfidence: 95, // very high — only the clamp / tri-value can stop us
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
    requireHumanApproval: false,
    autoApproveEnabled: true,
    aiPermissions: {},
  },
  stageMatrix: null,
  pipelineMatrix: null,
  dailyAutoActionCount: 0,
};

// ─────────────────────────────────────────────
// Test matrix: 6 high-stakes types × 4 tenant config states
// ─────────────────────────────────────────────
const HIGH_STAKES_TYPES = [
  // Semantic vocab
  'send_quote',
  'reply_to_complaint',
  'transition_to_closed_won',
  'transition_to_closed_lost',
  // Determiner vocab
  'close_objective',
  // Brain vocab (defensive)
  'close_deal_lost',
];

describe('KAN-1005 M2-3 — high-stakes clamp matrix (6 types × 4 tenant configs)', () => {
  for (const actionType of HIGH_STAKES_TYPES) {
    describe(`actionType="${actionType}"`, () => {
      it(`tenant 'auto' → CLAMPED to human_review (clamp overrides aiPermissions=auto)`, () => {
        const out = evaluateThreshold({
          ...BASE_INPUT,
          actionType,
          tenantConfig: {
            ...BASE_INPUT.tenantConfig,
            aiPermissions: { actionTypes: { [actionType]: 'auto' } },
          },
        });
        expect(out.decision).toBe('human_review');
        expect(out.reasoning).toMatch(/high-stakes/);
        expect(out.reasoning).toMatch(/system clamp/);
      });

      it(`tenant 'escalate' → human_review (honored — same effect as clamp)`, () => {
        const out = evaluateThreshold({
          ...BASE_INPUT,
          actionType,
          tenantConfig: {
            ...BASE_INPUT.tenantConfig,
            aiPermissions: { actionTypes: { [actionType]: 'escalate' } },
          },
        });
        expect(out.decision).toBe('human_review');
      });

      it(`tenant 'blocked' → blocked (HONORED — stricter than clamp)`, () => {
        const out = evaluateThreshold({
          ...BASE_INPUT,
          actionType,
          tenantConfig: {
            ...BASE_INPUT.tenantConfig,
            aiPermissions: { actionTypes: { [actionType]: 'blocked' } },
          },
        });
        expect(out.decision).toBe('blocked');
        // Reasoning should signal the tenant override (not just generic clamp).
        expect(out.reasoning).toMatch(/blocked/);
      });

      it(`tenant unset → human_review (default-deny + clamp both fire — same outcome)`, () => {
        const out = evaluateThreshold({
          ...BASE_INPUT,
          actionType,
          // No aiPermissions entry — default-deny escalates AND clamp also would.
        });
        expect(out.decision).toBe('human_review');
      });
    });
  }
});

// ─────────────────────────────────────────────
// Clamp via matrix-auto path — the user's specific catch
// ─────────────────────────────────────────────
describe('KAN-1005 M2-3 — clamp via matrix-auto path (the third auto-route)', () => {
  it('transition_to_closed_won matrix default is "auto" at threshold 0.9 (pre-clamp) — clamp escalates regardless', () => {
    // Pre-M2-3: matrix entry says { threshold: 0.9, default: 'auto' }.
    // High confidence (95) would have cleared 0.9*100=90 → approved.
    // Post-M2-3: clamp fires BEFORE matrix-auto can resolve.
    // Tenant explicitly sets 'auto' to make sure ONLY the clamp can save us.
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'transition_to_closed_won',
      overallConfidence: 95,
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { transition_to_closed_won: 'auto' } },
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/high-stakes/);
    expect(out.reasoning).toMatch(/system clamp/);
  });

  it('transition_to_closed_lost matrix default is "auto" at threshold 0.8 — clamp escalates', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'transition_to_closed_lost',
      overallConfidence: 95,
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { transition_to_closed_lost: 'auto' } },
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/system clamp/);
  });

  it('clamp fires even with custom stage matrix that says "auto" at threshold 0', () => {
    // Stage matrix authors could in theory set threshold:0 default:'auto' —
    // clamp must still win. Pin this hard so a tenant-tier matrix author
    // can't bypass the system invariant.
    const adversarialStageMatrix: AutoApproveMatrix = {
      send_quote: { threshold: 0, default: 'auto', rationale: 'adversarial — should be clamped' },
    };
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_quote',
      overallConfidence: 100,
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { send_quote: 'auto' } },
      },
      stageMatrix: adversarialStageMatrix,
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/high-stakes/);
  });
});

// ─────────────────────────────────────────────
// SAFE types: tri-value passthrough
// ─────────────────────────────────────────────
describe('KAN-1005 M2-3 — safe action types: tri-value passthrough', () => {
  it('send_message + tenant "auto" + high confidence → approved', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_message',
      overallConfidence: 95,
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { send_message: 'auto' } },
      },
    });
    expect(out.decision).toBe('approved');
  });

  it('send_email + tenant "auto" + high confidence → approved', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_email',
      overallConfidence: 95,
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { send_email: 'auto' } },
      },
    });
    expect(out.decision).toBe('approved');
  });

  it('send_message + tenant unset → human_review (M2-1 default-deny preserved)', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_message',
      // No aiPermissions entry
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/default-deny/);
  });

  it('send_message + tenant "escalate" → human_review', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_message',
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { send_message: 'escalate' } },
      },
    });
    expect(out.decision).toBe('human_review');
  });

  it('send_message + tenant "blocked" → blocked (third tri-value)', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_message',
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { send_message: 'blocked' } },
      },
    });
    expect(out.decision).toBe('blocked');
  });
});

// ─────────────────────────────────────────────
// Cross-vocab verification — clamp covers all 3 engine vocabs
// ─────────────────────────────────────────────
describe('KAN-1005 M2-3 — clamp coverage across Transport / Determiner / Semantic / Brain vocabs', () => {
  it('Semantic vocab (send_quote) — clamp fires', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_quote',
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { send_quote: 'auto' } },
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/high-stakes/);
  });

  it('Determiner vocab (close_objective) — clamp fires', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'close_objective',
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { close_objective: 'auto' } },
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/high-stakes/);
  });

  it('Brain vocab (close_deal_lost) — clamp fires (defensive coverage)', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'close_deal_lost',
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { close_deal_lost: 'auto' } },
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/high-stakes/);
  });
});

// ─────────────────────────────────────────────
// Clamp ceiling property — unknown / future / malformed configs fail safe
// ─────────────────────────────────────────────
describe('KAN-1005 M2-3 — clamp unbypassability (the wildcard-would-have-broken-this proof)', () => {
  it('aiPermissions wildcard "*": "auto" — does NOT auto a high-stakes type (clamp authoritative)', () => {
    // M2-1 explicitly rejected a wildcard for default-allow. This test
    // pins that even IF a wildcard were re-introduced (or a future
    // bug effectively wildcards), the clamp still escalates.
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_quote',
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { '*': 'auto', send_quote: 'auto' } },
      },
    });
    expect(out.decision).toBe('human_review');
  });

  it('aiPermissions wildcard "*": "auto" — does NOT grant blanket auto to SAFE types either (M2-1 default-deny preserved)', () => {
    // The M2-1 regression-wearing-a-different-hat pin. The clamp catches
    // wildcards on high-stakes types, but SAFE types aren't in the clamp
    // set, so they'd silently slip to auto if resolveAiPermission ever
    // honored a wildcard. M2-1 killed wildcard support: only an explicit
    // own-key entry can permit. This test proves the rewrite (M2-3
    // resolveAiPermission, replacing M2-1 boolean checkAiPermissions)
    // preserved the no-wildcard property for the non-clamp path.
    //
    // If this test ever turns green by returning "approved" / outcome=
    // "permit", the wildcard has been re-introduced and EVERY safe type
    // is auto for any tenant with one config line — exactly the safety
    // inversion M2-1 rejected.
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_message', // SAFE type, not clamp-protected
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { '*': 'auto' } }, // wildcard only — no own-key
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/default-deny/);
    // Also assert against any wildcard-attribution reasoning, so a future
    // implementation that honors '*' fails this even if outcome happens
    // to be human_review for some other reason.
    expect(out.reasoning).not.toMatch(/wildcard/);
    expect(out.reasoning).not.toMatch(/\*/);
  });

  it('aiPermissions wildcard "*": "auto" + SAFE type at unit level (resolveAiPermission directly)', () => {
    // Belt-and-suspenders: pin the property at the helper level too,
    // so a refactor that changes evaluateThreshold ordering doesn't
    // accidentally mask a regression in resolveAiPermission.
    const r = resolveAiPermission('send_message', {
      actionTypes: { '*': 'auto' },
    });
    expect(r.outcome).toBe('escalate');
    expect(r.reason).toMatch(/default-deny/);
  });

  it('Unknown action type (not in clamp set) → default-deny escalates (M2-1 preserved) — no slip-to-auto', () => {
    // The "future money-moving type someone forgot to add to the clamp"
    // safety net. Default-deny catches it even before classification.
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'execute_wire_transfer_xyz', // fictional future type
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: {}, // no entry
      },
    });
    expect(out.decision).toBe('human_review');
    expect(out.reasoning).toMatch(/default-deny/);
  });

  it('Malformed aiPermissions blob + high-stakes type → escalate (no crash)', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_quote',
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        // Adversarial input — actionTypes is an array instead of object.
        aiPermissions: { actionTypes: ['malformed', 'shape'] as unknown as Record<string, string> },
      },
    });
    expect(out.decision).toBe('human_review');
  });

  it('Unknown permission VALUE on a high-stakes type (typo, future shape) → escalate', () => {
    const out = evaluateThreshold({
      ...BASE_INPUT,
      actionType: 'send_quote',
      tenantConfig: {
        ...BASE_INPUT.tenantConfig,
        aiPermissions: { actionTypes: { send_quote: 'permit_pls' } as Record<string, string> },
      },
    });
    expect(out.decision).toBe('human_review');
  });
});

// ─────────────────────────────────────────────
// HIGH_STAKES_ACTION_TYPES constant — pin the set so a casual delete
// or rename surfaces in CI before reaching PROD.
// ─────────────────────────────────────────────
describe('KAN-1005 M2-3 — HIGH_STAKES_ACTION_TYPES set is pinned', () => {
  it('contains the 6 founder-approved high-stakes action types', () => {
    expect([...HIGH_STAKES_ACTION_TYPES].sort()).toEqual(
      [
        'close_deal_lost',
        'close_objective',
        'reply_to_complaint',
        'send_quote',
        'transition_to_closed_lost',
        'transition_to_closed_won',
      ].sort(),
    );
  });
});

// ─────────────────────────────────────────────
// resolveAiPermission unit-level (the tri-value helper itself)
// ─────────────────────────────────────────────
describe('KAN-1005 M2-3 — resolveAiPermission tri-value helper', () => {
  it('safe + auto → permit', () => {
    const r = resolveAiPermission('send_message', { actionTypes: { send_message: 'auto' } });
    expect(r.outcome).toBe('permit');
  });
  it('safe + escalate → escalate', () => {
    const r = resolveAiPermission('send_message', { actionTypes: { send_message: 'escalate' } });
    expect(r.outcome).toBe('escalate');
  });
  it('safe + blocked → blocked', () => {
    const r = resolveAiPermission('send_message', { actionTypes: { send_message: 'blocked' } });
    expect(r.outcome).toBe('blocked');
  });
  it('safe + unset → escalate (default-deny)', () => {
    const r = resolveAiPermission('send_message', {});
    expect(r.outcome).toBe('escalate');
  });
  it('high-stakes + auto → escalate (clamp)', () => {
    const r = resolveAiPermission('send_quote', { actionTypes: { send_quote: 'auto' } });
    expect(r.outcome).toBe('escalate');
    expect(r.reason).toMatch(/system clamp/);
  });
  it('high-stakes + blocked → blocked (honored, stricter than clamp)', () => {
    const r = resolveAiPermission('send_quote', { actionTypes: { send_quote: 'blocked' } });
    expect(r.outcome).toBe('blocked');
  });
  it('high-stakes + escalate → escalate', () => {
    const r = resolveAiPermission('send_quote', { actionTypes: { send_quote: 'escalate' } });
    expect(r.outcome).toBe('escalate');
  });
  it('high-stakes + unset → escalate', () => {
    const r = resolveAiPermission('send_quote', {});
    expect(r.outcome).toBe('escalate');
  });
});
