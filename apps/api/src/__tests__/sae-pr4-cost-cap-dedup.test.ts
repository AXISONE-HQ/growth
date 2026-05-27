/**
 * KAN-1009 — SAE PR4 cost-cap + dedup gate tests.
 *
 * Three layers of coverage:
 *
 *   1. per-tenant-daily-counter lib — pure unit tests of the Redis-key
 *      contract, USD↔integer conversions, get/increment/TTL semantics.
 *
 *   2. evaluateCostCapAndDedupGates — pure function with mocked Redis +
 *      Prisma stubs. Pins every guard outcome including the fail-safe
 *      'cost_signal_unavailable' path.
 *
 *   3. End-to-end decision-run-push handler — extends the PR3 test
 *      surface with the new gates so the slot-in ordering is also
 *      pinned (cap + dedup fire AFTER the 3 PR3 guards, BEFORE
 *      runDecisionForContact).
 *
 * Live positive verification (cap actually blocks an eval on real
 * traffic) rides on PR5 smoke per the brief — PR4 ships the
 * unit-test matrix that proves the gate logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  counterKey,
  utcDateString,
  usdToIntegerUnits,
  integerUnitsToUsd,
  getTodayCount,
  incrementToday,
  getTodayCostUsd,
  incrementTodayCostUsd,
} from '../lib/per-tenant-daily-counter.js';

// ─────────────────────────────────────────────
// Layer 1 — per-tenant-daily-counter lib
// ─────────────────────────────────────────────

describe('per-tenant-daily-counter — key contract', () => {
  it('counterKey produces <scope>:tenant:<id>:<YYYYMMDD>', () => {
    const date = new Date('2026-05-24T15:30:00Z');
    expect(counterKey('cost_cap_usd', 'tenant-A', date)).toBe(
      'cost_cap_usd:tenant:tenant-A:20260524',
    );
  });

  it('utcDateString uses UTC, not local TZ', () => {
    // Same instant, two timezone interpretations:
    // 2026-05-24T23:30:00-05:00 = 2026-05-25T04:30:00Z (next UTC day)
    expect(utcDateString(new Date('2026-05-24T23:30:00-05:00'))).toBe('20260525');
    expect(utcDateString(new Date('2026-05-25T00:30:00Z'))).toBe('20260525');
  });

  it('utcDateString pads month + day with leading zeros', () => {
    expect(utcDateString(new Date('2026-01-05T12:00:00Z'))).toBe('20260105');
  });
});

describe('per-tenant-daily-counter — USD ↔ integer units', () => {
  it('roundtrips $1.00 cleanly', () => {
    expect(usdToIntegerUnits(1.0)).toBe(100_000);
    expect(integerUnitsToUsd(100_000)).toBe(1.0);
  });

  it('handles $0.10 (one decimal place)', () => {
    expect(usdToIntegerUnits(0.1)).toBe(10_000);
  });

  it('handles sub-cent costs ($0.001)', () => {
    expect(usdToIntegerUnits(0.001)).toBe(100);
    expect(integerUnitsToUsd(100)).toBe(0.001);
  });

  it('rounds to nearest millidollar (sub-millidollar precision dropped)', () => {
    expect(usdToIntegerUnits(0.0001)).toBe(10); // $0.0001 = 10 millidollars
    expect(usdToIntegerUnits(0.00001)).toBe(1); // $0.00001 = 1 millidollar
    expect(usdToIntegerUnits(0.000004)).toBe(0); // below precision → 0
  });
});

describe('per-tenant-daily-counter — Redis ops', () => {
  it('getTodayCount returns 0 when key absent', async () => {
    const fakeRedis = { get: vi.fn().mockResolvedValue(null) };
    const result = await getTodayCount(fakeRedis, 'cost_cap_usd', 'tenant-A');
    expect(result).toBe(0);
    expect(fakeRedis.get).toHaveBeenCalledTimes(1);
  });

  it('getTodayCount parses integer string', async () => {
    const fakeRedis = { get: vi.fn().mockResolvedValue('1234567') };
    const result = await getTodayCount(fakeRedis, 'cost_cap_usd', 'tenant-A');
    expect(result).toBe(1234567);
  });

  it('incrementToday calls INCRBY + EXPIRE on first increment (newTotal === delta)', async () => {
    const incrby = vi.fn().mockResolvedValue(100); // first inc, total = delta
    const expire = vi.fn().mockResolvedValue(1);
    const result = await incrementToday(
      { incrby, expire },
      'cost_cap_usd',
      'tenant-A',
      100,
    );
    expect(result).toBe(100);
    expect(incrby).toHaveBeenCalledWith('cost_cap_usd:tenant:tenant-A:' + utcDateString(new Date()), 100);
    expect(expire).toHaveBeenCalledTimes(1);
    expect(expire.mock.calls[0]?.[1]).toBe(32 * 60 * 60); // TTL constant
  });

  it('incrementToday skips EXPIRE on subsequent increments', async () => {
    const incrby = vi.fn().mockResolvedValue(200); // total > delta → key existed
    const expire = vi.fn();
    await incrementToday(
      { incrby, expire },
      'cost_cap_usd',
      'tenant-A',
      100,
    );
    expect(expire).not.toHaveBeenCalled();
  });

  it('getTodayCostUsd converts stored integer to USD', async () => {
    // 1500_000 millidollars = $15.00
    const fakeRedis = { get: vi.fn().mockResolvedValue('1500000') };
    const result = await getTodayCostUsd(fakeRedis, 'cost_cap_usd', 'tenant-A');
    expect(result).toBe(15.0);
  });

  it('incrementTodayCostUsd converts USD to integer + returns USD', async () => {
    // First call: increment by $0.10 → 10_000 units → newTotal in units = 10_000 → USD = $0.10
    const incrby = vi.fn().mockResolvedValue(10_000);
    const expire = vi.fn().mockResolvedValue(1);
    const result = await incrementTodayCostUsd(
      { incrby, expire },
      'cost_cap_usd',
      'tenant-A',
      0.1,
    );
    expect(incrby).toHaveBeenCalledWith(expect.any(String), 10_000);
    expect(result).toBe(0.1);
    expect(expire).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// Layer 2 — evaluateCostCapAndDedupGates (mocked Redis + Prisma)
// ─────────────────────────────────────────────

const verifyPubsubOidcMock = vi.fn();
const runDecisionForContactMock = vi.fn();
const campaignFindFirstMock = vi.fn();
const stackFindFirstMock = vi.fn();
const stackUpdateMock = vi.fn();
const tenantFindUniqueMock = vi.fn();

vi.mock('../lib/oidc-pubsub-verify.js', () => ({
  verifyPubsubOidc: verifyPubsubOidcMock,
}));

vi.mock('../prisma.js', () => ({
  prisma: {
    campaign: { findFirst: campaignFindFirstMock },
    contactObjectiveStack: {
      findFirst: stackFindFirstMock,
      update: stackUpdateMock,
    },
    tenant: { findUnique: tenantFindUniqueMock },
  },
}));

vi.mock('../../../../packages/api/src/services/run-decision-for-contact.js', () => ({
  runDecisionForContact: runDecisionForContactMock,
}));

// KAN-1009 — mock the shared Redis client. Tests inject per-spec mocks
// for the get/incrby/expire calls the cost-cap gate uses.
const redisGetMock = vi.fn();
const redisIncrbyMock = vi.fn();
const redisExpireMock = vi.fn();
vi.mock('../services/redis-client.js', () => ({
  getRedisClient: () => ({
    get: redisGetMock,
    incrby: redisIncrbyMock,
    expire: redisExpireMock,
  }),
}));

const {
  decisionRunPushApp,
  evaluateCostCapAndDedupGates,
  resolveDailyCostCapUsd,
  DEFAULT_DAILY_COST_CAP_USD,
  DEDUP_WINDOW_MINUTES,
  ESTIMATED_COST_PER_EVAL_USD,
  COST_CAP_COUNTER_SCOPE,
} = await import('../subscribers/decision-run-push.js');

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const CONTACT_A = '22222222-2222-2222-2222-222222222222';
const CAMPAIGN_A = '33333333-3333-3333-3333-333333333333';
const STACK_A = '44444444-4444-4444-4444-444444444444';
// KAN-1005 M2-6b — fixture decisionId uses real-UUID format (FK-shape).
const DECISION_A = '55555555-5555-5555-5555-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
  verifyPubsubOidcMock.mockResolvedValue(true);
  delete process.env.DECISION_RUN_DAILY_COST_CAP_USD_DEFAULT;
});

describe('resolveDailyCostCapUsd — cap resolution chain', () => {
  it('uses tenant override when set', () => {
    expect(resolveDailyCostCapUsd(25.5)).toBe(25.5);
  });

  it('falls back to env var when tenant is NULL', () => {
    process.env.DECISION_RUN_DAILY_COST_CAP_USD_DEFAULT = '7.5';
    expect(resolveDailyCostCapUsd(null)).toBe(7.5);
  });

  it('falls back to DEFAULT constant when both NULL + env unset', () => {
    expect(resolveDailyCostCapUsd(null)).toBe(DEFAULT_DAILY_COST_CAP_USD);
    expect(resolveDailyCostCapUsd(undefined)).toBe(DEFAULT_DAILY_COST_CAP_USD);
  });

  it('rejects non-positive env values, falls back to DEFAULT', () => {
    process.env.DECISION_RUN_DAILY_COST_CAP_USD_DEFAULT = '0';
    expect(resolveDailyCostCapUsd(null)).toBe(DEFAULT_DAILY_COST_CAP_USD);
    process.env.DECISION_RUN_DAILY_COST_CAP_USD_DEFAULT = 'bogus';
    expect(resolveDailyCostCapUsd(null)).toBe(DEFAULT_DAILY_COST_CAP_USD);
  });
});

describe('evaluateCostCapAndDedupGates — pure function', () => {
  const NOW = new Date('2026-05-24T15:00:00Z');

  const prismaWithTenant = (cap: number | null) => ({
    tenant: {
      findUnique: vi.fn().mockResolvedValue(
        cap === null ? { dailyLlmCostCapUsd: null } : { dailyLlmCostCapUsd: cap },
      ),
    },
  });

  it('DEDUP rejection — lastEvaluatedAt within window → rejects without touching Redis', async () => {
    const recentEval = new Date(NOW.getTime() - 5 * 60_000); // 5 min ago
    const redis = { get: vi.fn() };
    const result = await evaluateCostCapAndDedupGates(
      prismaWithTenant(null),
      redis,
      {
        tenantId: TENANT_A,
        stack: { id: STACK_A, lastEvaluatedAt: recentEval },
        now: NOW,
      },
    );
    expect(result).toEqual({
      ok: false,
      reason: 'dedup_recent_eval',
      lastEvaluatedAt: recentEval,
      windowMinutes: DEDUP_WINDOW_MINUTES,
    });
    // Redis untouched — dedup short-circuits before the cost check
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('DEDUP rejection — boundary case: exactly at window edge (< window) rejects', async () => {
    const justInside = new Date(NOW.getTime() - (DEDUP_WINDOW_MINUTES - 1) * 60_000);
    const result = await evaluateCostCapAndDedupGates(
      prismaWithTenant(null),
      { get: vi.fn() },
      { tenantId: TENANT_A, stack: { id: STACK_A, lastEvaluatedAt: justInside }, now: NOW },
    );
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('dedup_recent_eval');
  });

  it('DEDUP passes when lastEvaluatedAt exactly at window boundary', async () => {
    const atBoundary = new Date(NOW.getTime() - DEDUP_WINDOW_MINUTES * 60_000);
    const redis = { get: vi.fn().mockResolvedValue('0') };
    const result = await evaluateCostCapAndDedupGates(
      prismaWithTenant(null),
      redis,
      { tenantId: TENANT_A, stack: { id: STACK_A, lastEvaluatedAt: atBoundary }, now: NOW },
    );
    expect(result.ok).toBe(true);
  });

  it('COST CAP rejection — spend ≥ cap (tenant override)', async () => {
    const oldEval = new Date(NOW.getTime() - 60 * 60_000);
    const redis = {
      get: vi.fn().mockResolvedValue(String(usdToIntegerUnits(25.0))), // $25 spent
    };
    const result = await evaluateCostCapAndDedupGates(
      prismaWithTenant(20.0), // cap = $20 (per-tenant override)
      redis,
      { tenantId: TENANT_A, stack: { id: STACK_A, lastEvaluatedAt: oldEval }, now: NOW },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'cost_cap_exceeded',
      resolvedCapUsd: 20.0,
      spendTodayUsd: 25.0,
    });
  });

  it('COST CAP rejection — uses DEFAULT cap when tenant + env unset', async () => {
    const oldEval = new Date(NOW.getTime() - 60 * 60_000);
    const redis = {
      get: vi.fn().mockResolvedValue(String(usdToIntegerUnits(15.0))), // > $10 default
    };
    const result = await evaluateCostCapAndDedupGates(
      prismaWithTenant(null),
      redis,
      { tenantId: TENANT_A, stack: { id: STACK_A, lastEvaluatedAt: oldEval }, now: NOW },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'cost_cap_exceeded',
      resolvedCapUsd: DEFAULT_DAILY_COST_CAP_USD,
      spendTodayUsd: 15.0,
    });
  });

  it('COST CAP boundary — spend === cap rejects (≥ semantics)', async () => {
    const oldEval = new Date(NOW.getTime() - 60 * 60_000);
    const redis = {
      get: vi.fn().mockResolvedValue(String(usdToIntegerUnits(10.0))),
    };
    const result = await evaluateCostCapAndDedupGates(
      prismaWithTenant(null),
      redis,
      { tenantId: TENANT_A, stack: { id: STACK_A, lastEvaluatedAt: oldEval }, now: NOW },
    );
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('cost_cap_exceeded');
  });

  it('COST CAP passes when spend < cap', async () => {
    const oldEval = new Date(NOW.getTime() - 60 * 60_000);
    const redis = {
      get: vi.fn().mockResolvedValue(String(usdToIntegerUnits(2.5))),
    };
    const result = await evaluateCostCapAndDedupGates(
      prismaWithTenant(null),
      redis,
      { tenantId: TENANT_A, stack: { id: STACK_A, lastEvaluatedAt: oldEval }, now: NOW },
    );
    expect(result.ok).toBe(true);
    expect((result as { resolvedCapUsd: number }).resolvedCapUsd).toBe(DEFAULT_DAILY_COST_CAP_USD);
    expect((result as { spendTodayUsd: number }).spendTodayUsd).toBe(2.5);
  });

  it('FAIL-SAFE — Redis error → cost_signal_unavailable (NOT a pass-through)', async () => {
    const oldEval = new Date(NOW.getTime() - 60 * 60_000);
    const redis = {
      get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379')),
    };
    const result = await evaluateCostCapAndDedupGates(
      prismaWithTenant(null),
      redis,
      { tenantId: TENANT_A, stack: { id: STACK_A, lastEvaluatedAt: oldEval }, now: NOW },
    );
    expect(result).toMatchObject({
      ok: false,
      reason: 'cost_signal_unavailable',
      resolvedCapUsd: DEFAULT_DAILY_COST_CAP_USD,
    });
    expect((result as { counterError: string }).counterError).toContain('ECONNREFUSED');
  });

  it('CAP uses correct Redis key (scope:tenant:UTCYYYYMMDD)', async () => {
    const oldEval = new Date(NOW.getTime() - 60 * 60_000);
    const redis = { get: vi.fn().mockResolvedValue('0') };
    await evaluateCostCapAndDedupGates(
      prismaWithTenant(null),
      redis,
      { tenantId: TENANT_A, stack: { id: STACK_A, lastEvaluatedAt: oldEval }, now: NOW },
    );
    expect(redis.get).toHaveBeenCalledWith(`${COST_CAP_COUNTER_SCOPE}:tenant:${TENANT_A}:20260524`);
  });
});

// ─────────────────────────────────────────────
// Layer 3 — end-to-end decision-run-push handler (cap + dedup wired)
// ─────────────────────────────────────────────

function buildEnvelope(
  overrides: Partial<{ tenantId: string; contactId: string; campaignId: string }> = {},
) {
  const event = {
    tenantId: overrides.tenantId ?? TENANT_A,
    contactId: overrides.contactId ?? CONTACT_A,
    campaignId: overrides.campaignId ?? CAMPAIGN_A,
    source: 'activate',
  };
  return {
    message: {
      data: Buffer.from(JSON.stringify(event)).toString('base64'),
      messageId: 'msg-test',
    },
    subscription: 'projects/test/subscriptions/growth-api-decision-run',
  };
}

async function postEnvelope(envelope: unknown) {
  return decisionRunPushApp.request('/decision-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
}

describe('decision-run-push end-to-end — PR4 gates wired in correct ORDER', () => {
  beforeEach(() => {
    // Default: all PR3 guards pass (campaign active, audience evaluated, stack active)
    campaignFindFirstMock.mockResolvedValue({
      id: CAMPAIGN_A,
      status: 'active',
      audienceEvaluatedAt: new Date(),
    });
    stackFindFirstMock.mockResolvedValue({
      id: STACK_A,
      status: 'active',
      lastEvaluatedAt: new Date('2026-01-01T00:00:00Z'), // very old → passes dedup
    });
    tenantFindUniqueMock.mockResolvedValue({ dailyLlmCostCapUsd: null });
    redisGetMock.mockResolvedValue('0'); // counter empty → cap passes
    redisIncrbyMock.mockResolvedValue(10_000); // $0.10 in millidollars
    redisExpireMock.mockResolvedValue(1);
    runDecisionForContactMock.mockResolvedValue({
      decisionId: DECISION_A,
      strategy: 'direct',
      outcome: 'ESCALATED',
    });
  });

  it('ORDERING: PR3 guards run BEFORE PR4 gates (campaign committed → guard rejects, cap+dedup never run)', async () => {
    campaignFindFirstMock.mockResolvedValue({
      id: CAMPAIGN_A,
      status: 'committed', // guard 1 fails
      audienceEvaluatedAt: new Date(),
    });
    const res = await postEnvelope(buildEnvelope());
    expect(res.status).toBe(200);
    // PR4 gates short-circuited — tenant + redis lookups never happened
    expect(tenantFindUniqueMock).not.toHaveBeenCalled();
    expect(redisGetMock).not.toHaveBeenCalled();
    expect(runDecisionForContactMock).not.toHaveBeenCalled();
  });

  it('ORDERING: PR4 gates run BEFORE runDecisionForContact (cap exceeded → no call)', async () => {
    redisGetMock.mockResolvedValue(String(usdToIntegerUnits(25.0))); // > $10 default cap
    const res = await postEnvelope(buildEnvelope());
    expect(res.status).toBe(200);
    expect(redisGetMock).toHaveBeenCalledTimes(1);
    expect(runDecisionForContactMock).not.toHaveBeenCalled();
    expect(stackUpdateMock).not.toHaveBeenCalled();
    expect(redisIncrbyMock).not.toHaveBeenCalled();
  });

  it('DEDUP gate fires — recent lastEvaluatedAt → 200 ack, no DE call', async () => {
    stackFindFirstMock.mockResolvedValue({
      id: STACK_A,
      status: 'active',
      lastEvaluatedAt: new Date(), // just now → within dedup window
    });
    const res = await postEnvelope(buildEnvelope());
    expect(res.status).toBe(200);
    expect(runDecisionForContactMock).not.toHaveBeenCalled();
    expect(stackUpdateMock).not.toHaveBeenCalled();
  });

  it('ALL PASSED → runDecisionForContact called + cost counter incremented + lastEvaluatedAt updated', async () => {
    const res = await postEnvelope(buildEnvelope());
    expect(res.status).toBe(200);
    expect(runDecisionForContactMock).toHaveBeenCalledTimes(1);
    // Post-success counter increment (fire-and-forget) — await microtasks
    await new Promise((resolve) => setImmediate(resolve));
    expect(redisIncrbyMock).toHaveBeenCalledWith(
      expect.stringContaining(`${COST_CAP_COUNTER_SCOPE}:tenant:${TENANT_A}:`),
      usdToIntegerUnits(ESTIMATED_COST_PER_EVAL_USD),
    );
    // lastEvaluatedAt update (also fire-and-forget)
    expect(stackUpdateMock).toHaveBeenCalledWith({
      where: { id: STACK_A },
      data: { lastEvaluatedAt: expect.any(Date) },
    });
  });

  it('FAIL-SAFE: Redis down → cost_signal_unavailable → 200 ack, NO DE call (bias toward inaction)', async () => {
    redisGetMock.mockRejectedValue(new Error('Connection refused'));
    const res = await postEnvelope(buildEnvelope());
    expect(res.status).toBe(200);
    expect(runDecisionForContactMock).not.toHaveBeenCalled();
  });

  it('runDecisionForContact transient throw → 500 nack, counter IS incremented (KAN-1018 A2 — bounds retry-storm cost)', async () => {
    runDecisionForContactMock.mockRejectedValue(new Error('LLM timeout'));
    const res = await postEnvelope(buildEnvelope());
    expect(res.status).toBe(500);
    // KAN-1018 A2 (replaces prior assertion that the counter did NOT
    // increment on throw): the counter MUST increment on engine throws —
    // success or failure — so a transient-error retry storm is bounded
    // by the daily cost cap. The engine may have spent LLM tokens before
    // throwing (especially when shadow flips on in M2); not counting
    // throw-spend was the original Gate-4 bypass that motivated this
    // ticket. See decision-run-push.ts finally block (engineStarted flag).
    await new Promise((resolve) => setImmediate(resolve));
    expect(redisIncrbyMock).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// Layer 4 — INERTNESS source grep regression (extends PR3's source-grep)
// ─────────────────────────────────────────────

describe('decision-run-push — INERTNESS source grep (PR4 extension)', () => {
  it('decision-run-push.ts STILL contains no imports of send-path modules (PR4 must not regress PR3 boundary)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, '..', 'subscribers', 'decision-run-push.ts'),
      'utf-8',
    );
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*action-decided-publisher/);
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*agent-dispatcher/);
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*send-policy/);
    expect(codeOnly).not.toMatch(/from\s+['"][^'"]*message-composer/);
    expect(codeOnly).not.toMatch(/\bpublishActionSend\b/);
    expect(codeOnly).not.toMatch(/\bpublishActionDecided\b/);
  });

  it('cost-cap + dedup gate REASON names present in source', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, '..', 'subscribers', 'decision-run-push.ts'),
      'utf-8',
    );
    expect(src).toMatch(/cost_cap_exceeded/);
    expect(src).toMatch(/dedup_recent_eval/);
    expect(src).toMatch(/cost_signal_unavailable/);
    expect(src).toMatch(/decision_run_gate_rejected/); // new log type
  });
});
