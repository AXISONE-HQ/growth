/**
 * KAN-1005 M2-4 — Circuit breaker unit matrix.
 *
 * Tests cover the three trip triggers (cost-cap / action-rate / error-rate),
 * the state read (3 scopes × 2 targets = 6 keys), the fail-CLOSED posture,
 * trip + reset operations, the per-tenant threshold tunability, and the
 * UTC-midnight TTL for cost-cap.
 *
 * Integration-level breaker-vs-gate tests live in the threshold-gate test
 * file (the gate is sync; caller passes breakerState as input).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  evaluateBreakerState,
  tripBreaker,
  resetBreaker,
  resolveBreakerThresholds,
  breakerKey,
  secondsUntilUtcMidnight,
  BREAKER_SCOPE_COST,
  BREAKER_SCOPE_RATE,
  BREAKER_SCOPE_ERROR,
  GLOBAL_TARGET,
  DEFAULT_DAILY_ACTION_CAP,
  DEFAULT_HOURLY_ACTION_RATE,
  DEFAULT_HOURLY_ERROR_RATE,
  COOLDOWN_SECONDS,
} from '../lib/circuit-breaker.js';

const TENANT_A = 'tenant-a-uuid';
const TENANT_B = 'tenant-b-uuid';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('KAN-1005 M2-4 — key construction', () => {
  it('per-tenant key format', () => {
    expect(breakerKey(BREAKER_SCOPE_COST, TENANT_A)).toBe(
      'breaker_tripped_cost:tenant:tenant-a-uuid',
    );
    expect(breakerKey(BREAKER_SCOPE_RATE, TENANT_A)).toBe(
      'breaker_tripped_rate:tenant:tenant-a-uuid',
    );
    expect(breakerKey(BREAKER_SCOPE_ERROR, TENANT_A)).toBe(
      'breaker_tripped_error:tenant:tenant-a-uuid',
    );
  });

  it('global key format (sentinel)', () => {
    expect(breakerKey(BREAKER_SCOPE_COST, GLOBAL_TARGET)).toBe(
      'breaker_tripped_cost:__global__',
    );
  });
});

describe('KAN-1005 M2-4 — evaluateBreakerState (3 scopes × 2 targets)', () => {
  it('all 6 keys unset → tripped=false', async () => {
    const mget = vi.fn(async () => [null, null, null, null, null, null]);
    const state = await evaluateBreakerState({ mget }, TENANT_A);
    expect(state.tripped).toBe(false);
    expect(mget).toHaveBeenCalledTimes(1);
    // 6 keys requested in single MGET round-trip.
    const firstCall = mget.mock.calls[0] as unknown as [string[]];
    expect(firstCall[0].length).toBe(6);
  });

  it('per-tenant cost key set → tripped, scope=cost, isGlobal=false', async () => {
    // Key order in evaluateBreakerState: for each scope, [global, tenant].
    // Scopes iterate in BREAKER_SCOPES order: cost, rate, error.
    // So index 1 = cost:tenant. Set just that.
    const mget = vi.fn(async () => [null, 'cost_cap_exceeded: $11/$10', null, null, null, null]);
    const state = await evaluateBreakerState({ mget }, TENANT_A);
    expect(state.tripped).toBe(true);
    expect(state.scope).toBe(BREAKER_SCOPE_COST);
    expect(state.isGlobal).toBe(false);
    expect(state.reason).toBe('cost_cap_exceeded: $11/$10');
  });

  it('global cost key set → tripped, scope=cost, isGlobal=true', async () => {
    // Index 0 = cost:global.
    const mget = vi.fn(async () => ['ops_global_pause', null, null, null, null, null]);
    const state = await evaluateBreakerState({ mget }, TENANT_A);
    expect(state.tripped).toBe(true);
    expect(state.scope).toBe(BREAKER_SCOPE_COST);
    expect(state.isGlobal).toBe(true);
  });

  it('per-tenant rate key set → tripped, scope=rate', async () => {
    // Index 3 = rate:tenant.
    const mget = vi.fn(async () => [
      null, null,
      null, 'hourly_action_rate: 150/100',
      null, null,
    ]);
    const state = await evaluateBreakerState({ mget }, TENANT_A);
    expect(state.tripped).toBe(true);
    expect(state.scope).toBe(BREAKER_SCOPE_RATE);
  });

  it('per-tenant error key set → tripped, scope=error', async () => {
    // Index 5 = error:tenant.
    const mget = vi.fn(async () => [
      null, null, null, null,
      null, 'hourly_error_rate: 25/20',
    ]);
    const state = await evaluateBreakerState({ mget }, TENANT_A);
    expect(state.tripped).toBe(true);
    expect(state.scope).toBe(BREAKER_SCOPE_ERROR);
  });

  it('Redis throws → tripped=true with failClosed=true (fail-CLOSED)', async () => {
    const mget = vi.fn(async () => {
      throw new Error('Redis connection refused');
    });
    const state = await evaluateBreakerState({ mget }, TENANT_A);
    expect(state.tripped).toBe(true);
    expect(state.failClosed).toBe(true);
    expect(state.reason).toMatch(/unavailable/);
  });

  it('per-tenant key for tenant A does NOT trip tenant B (multi-tenant isolation)', async () => {
    // Build the actual key list for tenant A (rate key set) and verify that
    // checking tenant B with the same Redis would see different keys.
    const tenantAKeys = [
      breakerKey(BREAKER_SCOPE_COST, GLOBAL_TARGET),
      breakerKey(BREAKER_SCOPE_COST, TENANT_A),
      breakerKey(BREAKER_SCOPE_RATE, GLOBAL_TARGET),
      breakerKey(BREAKER_SCOPE_RATE, TENANT_A),
      breakerKey(BREAKER_SCOPE_ERROR, GLOBAL_TARGET),
      breakerKey(BREAKER_SCOPE_ERROR, TENANT_A),
    ];
    const tenantBKeys = [
      breakerKey(BREAKER_SCOPE_COST, GLOBAL_TARGET),
      breakerKey(BREAKER_SCOPE_COST, TENANT_B),
      breakerKey(BREAKER_SCOPE_RATE, GLOBAL_TARGET),
      breakerKey(BREAKER_SCOPE_RATE, TENANT_B),
      breakerKey(BREAKER_SCOPE_ERROR, GLOBAL_TARGET),
      breakerKey(BREAKER_SCOPE_ERROR, TENANT_B),
    ];
    expect(tenantAKeys[1]).not.toBe(tenantBKeys[1]); // cost:tenant
    expect(tenantAKeys[3]).not.toBe(tenantBKeys[3]); // rate:tenant
    expect(tenantAKeys[5]).not.toBe(tenantBKeys[5]); // error:tenant
    // The global keys are shared.
    expect(tenantAKeys[0]).toBe(tenantBKeys[0]);
    expect(tenantAKeys[2]).toBe(tenantBKeys[2]);
    expect(tenantAKeys[4]).toBe(tenantBKeys[4]);
  });
});

describe('KAN-1005 M2-4 — tripBreaker / resetBreaker', () => {
  it('tripBreaker calls SET with EX TTL', async () => {
    const set = vi.fn(async () => 'OK');
    // Mock has a simpler signature than Redis.set's overloads; cast
    // through unknown to satisfy the Pick<Redis, 'set'> shape.
    await tripBreaker(
      { set } as unknown as Parameters<typeof tripBreaker>[0],
      BREAKER_SCOPE_RATE,
      TENANT_A,
      3600,
      'spike',
    );
    expect(set).toHaveBeenCalledWith(
      'breaker_tripped_rate:tenant:tenant-a-uuid',
      'spike',
      'EX',
      3600,
    );
  });

  it('tripBreaker on global target uses sentinel in key', async () => {
    const set = vi.fn(async () => 'OK');
    await tripBreaker(
      { set } as unknown as Parameters<typeof tripBreaker>[0],
      BREAKER_SCOPE_COST,
      GLOBAL_TARGET,
      1000,
      'ops',
    );
    expect(set).toHaveBeenCalledWith(
      'breaker_tripped_cost:__global__',
      'ops',
      'EX',
      1000,
    );
  });

  it('resetBreaker calls DEL and returns true when key existed', async () => {
    const del = vi.fn(async () => 1);
    const wasTripped = await resetBreaker({ del }, BREAKER_SCOPE_RATE, TENANT_A);
    expect(wasTripped).toBe(true);
    expect(del).toHaveBeenCalledWith('breaker_tripped_rate:tenant:tenant-a-uuid');
  });

  it('resetBreaker returns false when key did not exist', async () => {
    const del = vi.fn(async () => 0);
    const wasTripped = await resetBreaker({ del }, BREAKER_SCOPE_RATE, TENANT_A);
    expect(wasTripped).toBe(false);
  });
});

describe('KAN-1005 M2-4 — resolveBreakerThresholds (per-tenant tunable)', () => {
  it('null settings → defaults', () => {
    const t = resolveBreakerThresholds(null);
    expect(t.dailyActionCap).toBe(DEFAULT_DAILY_ACTION_CAP);
    expect(t.hourlyActionRate).toBe(DEFAULT_HOURLY_ACTION_RATE);
    expect(t.hourlyErrorRate).toBe(DEFAULT_HOURLY_ERROR_RATE);
  });

  it('empty settings → defaults', () => {
    const t = resolveBreakerThresholds({});
    expect(t.dailyActionCap).toBe(DEFAULT_DAILY_ACTION_CAP);
  });

  it('settings.circuitBreaker missing → defaults', () => {
    const t = resolveBreakerThresholds({ timezone: 'America/New_York' });
    expect(t.dailyActionCap).toBe(DEFAULT_DAILY_ACTION_CAP);
  });

  it('per-tenant override honored (tighter values for ramp)', () => {
    const t = resolveBreakerThresholds({
      circuitBreaker: {
        dailyActionCap: 50,
        hourlyActionRate: 10,
        hourlyErrorRate: 3,
      },
    });
    expect(t.dailyActionCap).toBe(50);
    expect(t.hourlyActionRate).toBe(10);
    expect(t.hourlyErrorRate).toBe(3);
  });

  it('malformed values (negative, zero, NaN) → defaults (fail-safe)', () => {
    const t = resolveBreakerThresholds({
      circuitBreaker: {
        dailyActionCap: -5,
        hourlyActionRate: 0,
        hourlyErrorRate: 'not a number',
      },
    });
    expect(t.dailyActionCap).toBe(DEFAULT_DAILY_ACTION_CAP);
    expect(t.hourlyActionRate).toBe(DEFAULT_HOURLY_ACTION_RATE);
    expect(t.hourlyErrorRate).toBe(DEFAULT_HOURLY_ERROR_RATE);
  });

  it('floats rounded down to integers', () => {
    const t = resolveBreakerThresholds({
      circuitBreaker: { dailyActionCap: 100.7 },
    });
    expect(t.dailyActionCap).toBe(100);
  });
});

describe('KAN-1005 M2-4 — secondsUntilUtcMidnight (cost-cap TTL)', () => {
  it('returns positive seconds until next UTC midnight', () => {
    // Set to 23:00 UTC on a fixed day → expect ~3600 seconds.
    const at23utc = new Date(Date.UTC(2026, 4, 26, 23, 0, 0));
    const secs = secondsUntilUtcMidnight(at23utc);
    expect(secs).toBe(3600);
  });

  it('returns 24h-ish when called just after midnight UTC', () => {
    const justAfterMidnight = new Date(Date.UTC(2026, 4, 26, 0, 0, 1));
    const secs = secondsUntilUtcMidnight(justAfterMidnight);
    // 23:59:59 = 86399 seconds.
    expect(secs).toBeGreaterThanOrEqual(86399);
    expect(secs).toBeLessThanOrEqual(86400);
  });

  it('returns at least 1 second (clamps)', () => {
    // Microsecond before next midnight: still at least 1 second.
    const justBefore = new Date(Date.UTC(2026, 4, 26, 23, 59, 59, 999));
    const secs = secondsUntilUtcMidnight(justBefore);
    expect(secs).toBeGreaterThanOrEqual(1);
  });
});

describe('KAN-1005 M2-4 — default thresholds (founder-approved 2026-05-27)', () => {
  it('matches confirmed defaults', () => {
    expect(DEFAULT_DAILY_ACTION_CAP).toBe(500);
    expect(DEFAULT_HOURLY_ACTION_RATE).toBe(100);
    expect(DEFAULT_HOURLY_ERROR_RATE).toBe(20);
    expect(COOLDOWN_SECONDS).toBe(3600);
  });
});
