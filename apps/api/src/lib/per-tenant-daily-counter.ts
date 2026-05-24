/**
 * KAN-1009 — SAE PR4 per-tenant daily counter (Redis-backed).
 *
 * Reusable per-tenant daily counter primitive. Built for SAE PR4's
 * cost-cap gate on the decision-run-push subscriber, but designed to be
 * the shared counter substrate that KAN-1005's dormant
 * daily-action-limit gate (Finding 4 of Slice 3b Phase 1) will also use.
 *
 * # Semantics
 *
 *   - Counter is keyed `<scope>:tenant:<tenantId>:<YYYYMMDD>` where YYYYMMDD
 *     is the UTC date. The TTL is set to ~32 hours on first increment so
 *     yesterday's keys auto-expire (Redis reaps; no manual sweep needed).
 *
 *   - **UTC date boundary** — tenant-tz reset deferred. Rationale:
 *     LlmCostRollup hour_bucket is UTC; KAN-745 cost-tracking is UTC;
 *     keeping the counter on the same boundary makes ops reconciliation
 *     straightforward. Per-tenant-tz reset is a future enhancement when
 *     a tenant in a late-day TZ complains that their counter rolls over
 *     mid-business-day. Document this on every consumer so the trade-off
 *     is visible at smoke time.
 *
 *   - `getToday(scope, tenantId)` returns the current accumulated value
 *     (0 if no key exists yet today).
 *
 *   - `incrementToday(scope, tenantId, delta)` atomically increments
 *     and returns the new total. Sets TTL on first increment.
 *
 *   - Float values are stored as fixed-precision integers (millidollars
 *     for USD; configurable via the caller's unit). Reason: Redis INCR
 *     is integer-only; `INCRBYFLOAT` exists but rounds at the 17-digit
 *     boundary which compounds across many increments. Integer math is
 *     cleaner.
 *
 * # Fail-safe posture
 *
 * When Redis is unavailable (connection error / timeout), the counter
 * functions throw. **Callers MUST decide their fail-safe posture per
 * use-case** — see decision-run-push's wrapping which fail-CLOSED (skip
 * the eval rather than run unbounded). This module doesn't impose a
 * default because different gates want different behaviors (cost cap
 * wants fail-closed; an idempotency cache could want fail-open).
 *
 * # KAN-1005 future shared use
 *
 * KAN-1005 (dormant governance gates) will reuse this for the daily
 * action-count limit. Same pattern: `incrementToday('action_count',
 * tenantId, 1)` per action; gate compares against `Tenant.dailyActionLimit`.
 * The `scope` parameter keeps the keys segregated.
 */

import type { Redis } from 'ioredis';

/**
 * 32 hours: covers 24h + worst-case timezone offset + retry slack. After
 * this Redis evicts the key; a fresh increment the next UTC day starts
 * from zero with a new TTL.
 */
const COUNTER_KEY_TTL_SECONDS = 32 * 60 * 60;

/**
 * USD precision unit. We store cents-per-thousand (millidollars) so
 * 1 USD == 100_000 units. Allows tracking sub-cent costs accurately
 * (e.g., a $0.001 LLM call is 100 units; we don't lose it to rounding).
 */
const USD_TO_INTEGER_UNITS = 100_000;

/**
 * Build the Redis key for a given scope, tenant, and UTC date.
 * Exported for tests to mirror the exact key format.
 */
export function counterKey(
  scope: string,
  tenantId: string,
  today: Date = new Date(),
): string {
  const yyyymmdd = utcDateString(today);
  return `${scope}:tenant:${tenantId}:${yyyymmdd}`;
}

/**
 * UTC date string in `YYYYMMDD` form. Stable across timezones; matches
 * the LlmCostRollup hour_bucket UTC convention.
 */
export function utcDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Convert USD float to integer storage units (millidollars). Rounds to
 * the nearest cent-per-thousand; sub-millidollar fractions discarded.
 */
export function usdToIntegerUnits(usd: number): number {
  return Math.round(usd * USD_TO_INTEGER_UNITS);
}

/**
 * Inverse: integer storage units → USD float.
 */
export function integerUnitsToUsd(units: number): number {
  return units / USD_TO_INTEGER_UNITS;
}

// ─────────────────────────────────────────────────────────────────────────
// Counter operations
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read today's accumulated counter value for a tenant. Returns 0 when
 * no key exists yet today (counter hasn't been touched).
 *
 * @throws Error if Redis is unreachable (caller decides fail-safe posture)
 */
export async function getTodayCount(
  redis: Pick<Redis, 'get'>,
  scope: string,
  tenantId: string,
  now: Date = new Date(),
): Promise<number> {
  const key = counterKey(scope, tenantId, now);
  const raw = await redis.get(key);
  if (raw == null) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Atomically increment today's counter by `delta` (integer units) and
 * return the new total. Sets the TTL on first increment so yesterday's
 * keys auto-expire.
 *
 * @throws Error if Redis is unreachable
 */
export async function incrementToday(
  redis: Pick<Redis, 'incrby' | 'expire'>,
  scope: string,
  tenantId: string,
  delta: number,
  now: Date = new Date(),
): Promise<number> {
  const key = counterKey(scope, tenantId, now);
  const newTotal = await redis.incrby(key, delta);
  // Set TTL on first increment (newTotal === delta means the key was
  // just created OR was expired). Re-applying EXPIRE on subsequent
  // increments is harmless but extra round-trip — skip when not needed.
  if (newTotal === delta) {
    await redis.expire(key, COUNTER_KEY_TTL_SECONDS);
  }
  return newTotal;
}

/**
 * USD-typed convenience wrapper around getTodayCount. Returns the
 * accumulated USD value (float) for today.
 */
export async function getTodayCostUsd(
  redis: Pick<Redis, 'get'>,
  scope: string,
  tenantId: string,
  now: Date = new Date(),
): Promise<number> {
  const units = await getTodayCount(redis, scope, tenantId, now);
  return integerUnitsToUsd(units);
}

/**
 * USD-typed convenience wrapper around incrementToday. Increments by
 * `costUsd` and returns the new total in USD.
 */
export async function incrementTodayCostUsd(
  redis: Pick<Redis, 'incrby' | 'expire'>,
  scope: string,
  tenantId: string,
  costUsd: number,
  now: Date = new Date(),
): Promise<number> {
  const delta = usdToIntegerUnits(costUsd);
  const newTotalUnits = await incrementToday(redis, scope, tenantId, delta, now);
  return integerUnitsToUsd(newTotalUnits);
}
