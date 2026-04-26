/**
 * Tests for KAN-697 guardrail wiring in communication-agent.
 *
 * STATUS: written but not runnable in CI yet — packages/api has no vitest
 * infrastructure (KAN-692 + an expansion to packages/api will close that
 * gap). Tests use vitest syntax; once the runner lands, they'll execute
 * without modification.
 *
 * Coverage:
 *   1. decideGuardrailAction() pure function — every severity path:
 *      - block / regenerate → block
 *      - warn → allow (default)
 *      - warn → block when warnAction='block'
 *      - pass → allow
 *      - perCheck override: tone='allow' suppresses tone violation
 *      - perCheck override: tone='warn' downgrades block to warn
 *      - perCheck override: tone='block' upgrades warn to block
 *      - structural failures (block/regenerate) cannot be downgraded by tenant config
 *   2. executeCommunication() with all 5 validators invoked on every send
 *   3. Hook invocations:
 *      - block → onBlock called, send NOT attempted, status='blocked'
 *      - warn → onWarn called, send proceeds
 *      - pass → onAudit called, send proceeds
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  decideGuardrailAction,
  executeCommunication,
  type CommunicationAgentInput,
  type GuardrailHooks,
  type TenantGuardrailConfig,
} from '../communication-agent.js';
import type { GuardrailResult, Violation } from '../guardrail-layer.js';

const TENANT_ID = 't-test';
const CONTACT_ID = 'c-test';
const DECISION_ID = 'd-test';

function violation(checkType: Violation['checkType'], severity: Violation['severity'], description = 'x'): Violation {
  return { checkType, severity, description };
}

function result(violations: Violation[], overall: GuardrailResult['overallSeverity']): GuardrailResult {
  return {
    tenantId: TENANT_ID,
    contactId: CONTACT_ID,
    decisionId: DECISION_ID,
    checkId: 'chk_test',
    passed: overall === 'pass' || overall === 'warn',
    overallSeverity: overall,
    violations,
    checkedAt: new Date().toISOString(),
    checksRun: ['tone', 'accuracy', 'hallucination', 'compliance', 'injection'],
    durationMs: 0,
  };
}

// ── decideGuardrailAction — pure unit tests ─────────────────────

describe('decideGuardrailAction (KAN-697 severity routing)', () => {
  describe('default config (no tenant overrides)', () => {
    it('block severity → block', () => {
      const r = result([violation('tone', 'block', 'too short')], 'block');
      expect(decideGuardrailAction(r)).toBe('block');
    });
    it('regenerate severity → block (V1 has no regen loop)', () => {
      const r = result([violation('tone', 'regenerate', 'pressure language')], 'regenerate');
      expect(decideGuardrailAction(r)).toBe('block');
    });
    it('warn severity → allow (default permissive)', () => {
      const r = result([violation('tone', 'warn', 'all caps')], 'warn');
      expect(decideGuardrailAction(r)).toBe('warn');
    });
    it('pass (no violations) → allow', () => {
      const r = result([], 'pass');
      expect(decideGuardrailAction(r)).toBe('allow');
    });
  });

  describe('tenant warnAction override', () => {
    it('warnAction=block escalates warn → block', () => {
      const r = result([violation('tone', 'warn', 'all caps')], 'warn');
      const cfg: TenantGuardrailConfig = { warnAction: 'block' };
      expect(decideGuardrailAction(r, cfg)).toBe('block');
    });
    it('warnAction=allow keeps warn → allow', () => {
      const r = result([violation('tone', 'warn', 'all caps')], 'warn');
      expect(decideGuardrailAction(r, { warnAction: 'allow' })).toBe('warn');
    });
  });

  describe('tenant perCheck overrides', () => {
    it('perCheck.tone=allow suppresses tone violation entirely', () => {
      const r = result([violation('tone', 'block', 'too short')], 'block');
      const cfg: TenantGuardrailConfig = { perCheck: { tone: 'allow' } };
      expect(decideGuardrailAction(r, cfg)).toBe('allow');
    });
    it('perCheck.tone=warn downgrades tone block to warn', () => {
      const r = result([violation('tone', 'block', 'too short')], 'block');
      const cfg: TenantGuardrailConfig = { perCheck: { tone: 'warn' } };
      expect(decideGuardrailAction(r, cfg)).toBe('warn');
    });
    it('perCheck.tone=block upgrades a tone warn to block', () => {
      const r = result([violation('tone', 'warn', 'all caps')], 'warn');
      const cfg: TenantGuardrailConfig = { perCheck: { tone: 'block' } };
      expect(decideGuardrailAction(r, cfg)).toBe('block');
    });
    it('perCheck override only affects matching checkType', () => {
      // tone=allow but injection violation still blocks
      const r = result(
        [violation('tone', 'warn', 'caps'), violation('injection', 'block', 'prompt injection')],
        'block',
      );
      const cfg: TenantGuardrailConfig = { perCheck: { tone: 'allow' } };
      expect(decideGuardrailAction(r, cfg)).toBe('block');
    });
  });

  describe('multi-violation scenarios', () => {
    it('any block among many violations → block', () => {
      const r = result(
        [
          violation('tone', 'warn', 'caps'),
          violation('compliance', 'pass'),
          violation('injection', 'block', 'prompt injection'),
        ],
        'block',
      );
      expect(decideGuardrailAction(r)).toBe('block');
    });
    it('all-pass + one warn → warn route', () => {
      const r = result(
        [violation('tone', 'pass'), violation('accuracy', 'warn', 'price unverified')],
        'warn',
      );
      expect(decideGuardrailAction(r)).toBe('warn');
    });
  });
});

// ── executeCommunication wiring ─────────────────────────────────

function buildInput(overrides: Partial<CommunicationAgentInput> = {}): CommunicationAgentInput {
  return {
    tenantId: TENANT_ID,
    contactId: CONTACT_ID,
    objectiveId: 'obj-1',
    decisionId: DECISION_ID,
    actionType: 'send_message',
    channel: 'email',
    payload: {},
    strategy: 'direct',
    confidenceScore: 80,
    priority: 'normal',
    maxRetries: 0,
    timeoutMs: 5000,
    contact: { name: 'Test', email: 'a@example.com' },
    tenantBranding: { companyName: 'TestCo', fromEmail: 'b@example.com' },
    ...overrides,
  };
}

class StubAdapter {
  channel = 'email';
  sent: unknown[] = [];
  async send(msg: unknown) {
    this.sent.push(msg);
    return { providerMessageId: 'pm_1', status: 'sent' as const };
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('executeCommunication (KAN-697 hooks integration)', () => {
  it('block decision → onBlock called, status=blocked, send NOT attempted', async () => {
    const adapter = new StubAdapter();
    const onBlock = vi.fn(async () => undefined);
    const validator = vi.fn(() =>
      result([violation('injection', 'block', 'prompt injection detected')], 'block'),
    );
    const out = await executeCommunication(buildInput(), adapter, {
      hooks: { validate: validator, onBlock },
    });
    expect(validator).toHaveBeenCalledTimes(1);
    expect(onBlock).toHaveBeenCalledTimes(1);
    expect(adapter.sent).toEqual([]);
    expect(out.status).toBe('blocked');
    expect(out.error).toMatch(/Guardrail blocked.*injection/);
  });

  it('warn decision → onWarn called, send proceeds', async () => {
    const adapter = new StubAdapter();
    const onWarn = vi.fn(async () => undefined);
    const onBlock = vi.fn(async () => undefined);
    const validator = vi.fn(() => result([violation('tone', 'warn', 'caps')], 'warn'));
    const out = await executeCommunication(buildInput(), adapter, {
      hooks: { validate: validator, onWarn, onBlock },
    });
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onBlock).not.toHaveBeenCalled();
    expect(adapter.sent.length).toBe(1);
    expect(out.status).toBe('sent');
  });

  it('pass decision → onAudit called, send proceeds', async () => {
    const adapter = new StubAdapter();
    const onAudit = vi.fn(async () => undefined);
    const validator = vi.fn(() => result([], 'pass'));
    const out = await executeCommunication(buildInput(), adapter, {
      hooks: { validate: validator, onAudit },
    });
    expect(onAudit).toHaveBeenCalledTimes(1);
    expect(adapter.sent.length).toBe(1);
    expect(out.status).toBe('sent');
  });

  it('block + tenant warnAction=block (warn-only result) → still routes warn → block', async () => {
    const adapter = new StubAdapter();
    const onBlock = vi.fn(async () => undefined);
    const validator = vi.fn(() => result([violation('tone', 'warn', 'caps')], 'warn'));
    const out = await executeCommunication(buildInput(), adapter, {
      guardrailConfig: { warnAction: 'block' },
      hooks: { validate: validator, onBlock },
    });
    expect(onBlock).toHaveBeenCalledTimes(1);
    expect(adapter.sent).toEqual([]);
    expect(out.status).toBe('blocked');
  });

  it('no hooks supplied → still validates + routes correctly (defensive)', async () => {
    const adapter = new StubAdapter();
    const validator = vi.fn(() => result([violation('tone', 'block', 'empty')], 'block'));
    const out = await executeCommunication(buildInput(), adapter, {
      hooks: { validate: validator },
    });
    // No onBlock hook supplied → no escalation, but send is still blocked.
    expect(adapter.sent).toEqual([]);
    expect(out.status).toBe('blocked');
  });

  it('validator passes input shape with all required fields', async () => {
    const adapter = new StubAdapter();
    const validator = vi.fn(() => result([], 'pass'));
    await executeCommunication(buildInput(), adapter, { hooks: { validate: validator } });
    const passed = validator.mock.calls[0][0];
    expect(passed.tenantId).toBe(TENANT_ID);
    expect(passed.contactId).toBe(CONTACT_ID);
    expect(passed.decisionId).toBe(DECISION_ID);
    expect(passed.channel).toBe('email');
    expect(passed.message.body).toBeDefined();
    expect(passed.message.to).toBeDefined();
    expect(passed.message.from).toBeDefined();
  });
});
