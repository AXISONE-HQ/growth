/**
 * KAN-1005 M2-4 — Circuit breaker: machine-speed auto-pause of autonomy.
 *
 * Pure Redis interaction module. Built on top of per-tenant-daily-counter
 * — does NOT introduce a parallel tracker; reuses the same lib's hourly
 * accessors (`incrementHourly` / `getHourlyCount`) for the action-rate
 * and error-rate signals, and the daily accessor for volume.
 *
 * # Three trip triggers
 *
 *   - **Cost-cap-trip** (hard pause)
 *     Fires when `decision-run-push.ts` cost gate returns
 *     `reason='cost_cap_exceeded'`. TTL = seconds until next UTC
 *     midnight (auto-clears when the daily cost counter resets) +
 *     manual reset via tRPC admin route. The cost gate already audits
 *     its trip (KAN-1009 M1) — M2-4 sets the breaker key BUT does NOT
 *     emit a redundant audit row for this trigger (founder refinement
 *     2026-05-27). The breaker-trip-from-cost-cap signal is reconstructable
 *     by joining cost_cap_exceeded log → breaker_tripped_cost key existence.
 *
 *   - **Action-rate spike** (tunable, auto-clear)
 *     Fires when hourly action count for a tenant exceeds
 *     `DEFAULT_HOURLY_ACTION_RATE` (tunable per-tenant). TTL = 60-min
 *     cooldown. Counter source: hourly `action_count_hourly` scope.
 *     M2-4 also tracks the **daily** volume cap as a slow runaway-
 *     bound — `DEFAULT_DAILY_ACTION_CAP` on the M2-1 `action_count`
 *     daily scope. Either hourly OR daily exceedance trips this scope.
 *
 *   - **Error-rate climb** (tunable, auto-clear)
 *     Fires when hourly error count exceeds `DEFAULT_HOURLY_ERROR_RATE`.
 *     TTL = 60-min cooldown. Counter source: new hourly
 *     `error_count_hourly` scope, written from decision-run-push.ts's
 *     classify-and-route catch block on every persistent/transient
 *     classification (NOTE: counting transient errors means a single
 *     poison message retried N times reads as N error-events — that's
 *     intentional; a retry storm on one stuck message is a runaway
 *     worth pausing on. Ramp calibration done with this interpretation
 *     in mind.)
 *
 * # State model
 *
 * Three trip scopes, each with its own TTL embodying the reset policy:
 *
 *   - `breaker_tripped_cost:tenant:<id>` (or `:global`) — TTL = secondsUntilUtcMidnight()
 *   - `breaker_tripped_rate:tenant:<id>` (or `:global`) — TTL = 3600
 *   - `breaker_tripped_error:tenant:<id>` (or `:global`) — TTL = 3600
 *
 * Tenant is "tripped" if ANY of the three keys exist (tenant OR global
 * variant). `evaluateBreakerState` checks all 6 in parallel.
 *
 * # Fail-safe
 *
 * Redis read error → treat as **tripped** (fail-CLOSED). Consistent with
 * M2-1's `action_count_unavailable` and the cost gate's
 * `cost_signal_unavailable`. The breaker is a safety gate; failed signal
 * = treat as tripped. No fail-open.
 *
 * # Distinct from autoApproveEnabled kill-switch
 *
 * A tripped breaker is machine-speed pause; `autoApproveEnabled=false`
 * is deliberate human pause. Resetting the breaker doesn't re-arm a
 * human-disabled tenant; flipping the kill-switch doesn't reset the
 * breaker. Two separate state vectors, two separate reset paths.
 */

import type { Redis } from 'ioredis';

// ─────────────────────────────────────────────────────────────────────────
// Trip-scope constants (Redis key prefixes)
// ─────────────────────────────────────────────────────────────────────────

export const BREAKER_SCOPE_COST = 'breaker_tripped_cost';
export const BREAKER_SCOPE_RATE = 'breaker_tripped_rate';
export const BREAKER_SCOPE_ERROR = 'breaker_tripped_error';

export type BreakerScope =
  | typeof BREAKER_SCOPE_COST
  | typeof BREAKER_SCOPE_RATE
  | typeof BREAKER_SCOPE_ERROR;

export const BREAKER_SCOPES: ReadonlyArray<BreakerScope> = [
  BREAKER_SCOPE_COST,
  BREAKER_SCOPE_RATE,
  BREAKER_SCOPE_ERROR,
];

// ─────────────────────────────────────────────────────────────────────────
// Counter-scope constants (the rate/error signal sources)
// ─────────────────────────────────────────────────────────────────────────

/** Action-rate hourly scope. New in M2-4. Sibling to M2-1's `action_count`
 *  daily scope. */
export const ACTION_COUNT_HOURLY_SCOPE = 'action_count_hourly';

/** Error-rate hourly scope. New in M2-4. */
export const ERROR_COUNT_HOURLY_SCOPE = 'error_count_hourly';

// ─────────────────────────────────────────────────────────────────────────
// Default thresholds (per-tenant-tunable via Tenant.settings.circuitBreaker)
// ─────────────────────────────────────────────────────────────────────────

/** Daily action volume cap per tenant. Slow runaway-bound. M2-6b ramp
 *  will likely set tighter values per-tenant for the AxisOne validation
 *  tenant operationally. */
export const DEFAULT_DAILY_ACTION_CAP = 500;

/** Hourly action rate per tenant. Sub-day spike bound. */
export const DEFAULT_HOURLY_ACTION_RATE = 100;

/** Hourly error rate per tenant. Storm bound. NOTE: counts BOTH
 *  persistent + transient error-events (i.e., retries inflate the
 *  count — intentional for runaway containment). */
export const DEFAULT_HOURLY_ERROR_RATE = 20;

// ─────────────────────────────────────────────────────────────────────────
// Cooldown TTLs
// ─────────────────────────────────────────────────────────────────────────

/** Action-rate + error-rate trip cooldown. 60 minutes. After TTL expires,
 *  the breaker clears; if we're still inside a hot clock-hour bucket
 *  whose counter is over threshold, the next action re-trips immediately
 *  (intentional fail-safe direction). */
export const COOLDOWN_SECONDS = 60 * 60;

/** Sentinel target for global (cross-tenant) breaker keys. Reserved
 *  string — tenant IDs are UUIDs so no collision. */
export const GLOBAL_TARGET = '__global__';

// ─────────────────────────────────────────────────────────────────────────
// Key builders
// ─────────────────────────────────────────────────────────────────────────

/** Build the Redis key for a tripped-breaker scope.
 *  @param target — tenant UUID, or `GLOBAL_TARGET` for the global breaker */
export function breakerKey(scope: BreakerScope, target: string): string {
  return `${scope}:${target === GLOBAL_TARGET ? GLOBAL_TARGET : `tenant:${target}`}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Trip / reset operations
// ─────────────────────────────────────────────────────────────────────────

/**
 * Set the trip key with the given TTL. Idempotent (re-tripping refreshes
 * the TTL — useful when a still-hot tenant re-trips during cooldown
 * decay). Throws on Redis error so the caller can log loudly; not
 * fail-safe at this layer because trip-write failure is operator-visible.
 */
export async function tripBreaker(
  redis: Pick<Redis, 'set'>,
  scope: BreakerScope,
  target: string,
  ttlSeconds: number,
  reason: string,
): Promise<void> {
  const key = breakerKey(scope, target);
  // Store the reason as the value so a quick `GET breaker_tripped_cost:tenant:X`
  // returns "exceeded $10.50/$10 cap" instead of just "1". Reads use EXISTS
  // (we only need to know if it's set), but the value aids ops debugging.
  await redis.set(key, reason, 'EX', Math.max(1, Math.floor(ttlSeconds)));
}

/**
 * Clear the trip key. Returns true if the key was deleted (was tripped),
 * false if it didn't exist (was already clear).
 */
export async function resetBreaker(
  redis: Pick<Redis, 'del'>,
  scope: BreakerScope,
  target: string,
): Promise<boolean> {
  const key = breakerKey(scope, target);
  const deleted = await redis.del(key);
  return deleted > 0;
}

// ─────────────────────────────────────────────────────────────────────────
// State read — used by evaluateThreshold's step 3
// ─────────────────────────────────────────────────────────────────────────

export interface BreakerState {
  /** True if any trip key (3 scopes × 2 targets = 6 keys) exists. */
  tripped: boolean;
  /** Which scope tripped, when tripped. Reported in audit / reasoning. */
  scope?: BreakerScope;
  /** Whether the trip is global (true) or per-tenant (false). */
  isGlobal?: boolean;
  /** The stored reason string from the trip-write site, when available. */
  reason?: string;
  /** True if the state read failed (Redis error) — caller treats tripped
   *  with this signal so audit can distinguish "actually tripped" from
   *  "fail-closed because we couldn't tell". */
  failClosed?: boolean;
}

/**
 * Read the breaker state for a tenant. Checks 3 scopes × 2 targets
 * (per-tenant + global) = 6 keys. Returns the FIRST trip found in
 * priority order (cost > rate > error; global > tenant within a scope).
 *
 * Fail-CLOSED on Redis error: returns `{ tripped: true, failClosed: true }`
 * so the gate routes to escalate.
 *
 * Used by:
 *   - evaluateThresholdWithMatrix (read just before evaluateThreshold call)
 */
export async function evaluateBreakerState(
  redis: Pick<Redis, 'mget'>,
  tenantId: string,
): Promise<BreakerState> {
  try {
    // Build all 6 keys; MGET in one round-trip.
    const keys: Array<{ key: string; scope: BreakerScope; isGlobal: boolean }> = [];
    for (const scope of BREAKER_SCOPES) {
      keys.push({ key: breakerKey(scope, GLOBAL_TARGET), scope, isGlobal: true });
      keys.push({ key: breakerKey(scope, tenantId), scope, isGlobal: false });
    }
    const values = await redis.mget(keys.map((k) => k.key));
    for (let i = 0; i < keys.length; i++) {
      const v = values[i];
      if (v != null) {
        return {
          tripped: true,
          scope: keys[i]!.scope,
          isGlobal: keys[i]!.isGlobal,
          reason: v,
        };
      }
    }
    return { tripped: false };
  } catch (err) {
    // Fail-CLOSED. The gate routes to escalate; ops investigates.
    console.error(
      JSON.stringify({
        type: 'circuit_breaker_state_read_failed',
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return {
      tripped: true,
      failClosed: true,
      reason: 'circuit_breaker_state_unavailable',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Seconds until the next UTC midnight. Used as TTL for cost-cap trip:
 *  the breaker auto-clears at the same moment the daily cost counter
 *  resets, so the gate state and the cost signal stay in sync. */
export function secondsUntilUtcMidnight(now: Date = new Date()): number {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
}

// ─────────────────────────────────────────────────────────────────────────
// Threshold resolution (per-tenant tunable defaults)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve per-tenant breaker thresholds from `Tenant.settings.circuitBreaker`
 * JSON path, falling back to the DEFAULT_* constants. Tunable per-tenant
 * without a code deploy — the M2-6b ramp uses this to dial AxisOne's
 * validation tenant to tighter values.
 *
 * Expected shape inside Tenant.settings.circuitBreaker:
 *   {
 *     dailyActionCap?: number,
 *     hourlyActionRate?: number,
 *     hourlyErrorRate?: number,
 *   }
 *
 * Malformed values silently fall back to defaults (KAN-1029 lesson).
 */
export function resolveBreakerThresholds(
  tenantSettings: unknown,
): { dailyActionCap: number; hourlyActionRate: number; hourlyErrorRate: number } {
  const settings =
    tenantSettings && typeof tenantSettings === 'object' && !Array.isArray(tenantSettings)
      ? (tenantSettings as Record<string, unknown>)
      : {};
  const breakerConfig =
    settings.circuitBreaker &&
    typeof settings.circuitBreaker === 'object' &&
    !Array.isArray(settings.circuitBreaker)
      ? (settings.circuitBreaker as Record<string, unknown>)
      : {};

  const safeInt = (raw: unknown, fallback: number): number => {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return fallback;
    return Math.floor(raw);
  };

  return {
    dailyActionCap: safeInt(breakerConfig.dailyActionCap, DEFAULT_DAILY_ACTION_CAP),
    hourlyActionRate: safeInt(breakerConfig.hourlyActionRate, DEFAULT_HOURLY_ACTION_RATE),
    hourlyErrorRate: safeInt(breakerConfig.hourlyErrorRate, DEFAULT_HOURLY_ERROR_RATE),
  };
}
