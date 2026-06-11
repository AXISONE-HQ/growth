/**
 * KAN-1166 PR 2a-core Step 4 — FeasibilityContextService cache invalidation hooks.
 *
 * Inline-hook invalidation. Pragmatic v0.1 choice over a dedicated Pub/Sub
 * subscriber app:
 *   - No new topic / subscription infrastructure
 *   - Synchronous invalidation — no race window between mutation + invalidate
 *   - One-file callsite addition in each existing publisher (deal-close path,
 *     order-place path, contact-create path, campaign-activate path)
 *
 * The hook surface is event-named (hookOnDealClosed / hookOnOrderPlaced / ...)
 * so callers self-document WHY they invalidate. v0.1 implementation: all four
 * hooks share `invalidateAllContextForTenant` because the cache stores the
 * whole `TenantHistoricalContext` blob per (tenantId, goalShape-hash, windowDays);
 * any signal change makes the whole blob stale. Per-signal invalidation
 * granularity becomes meaningful when per-signal TTLs split the cache; revisit
 * during PR 2b analyzer integration or when the cache key shape is refined.
 *
 * Tenant-id discipline: every hook takes `tenantId` as typed first parameter
 * after the Redis injection. Cache-key pattern includes `tenantId` directly
 * (per buildContextCacheKey in feasibility-context-service.ts) so bulk
 * invalidation by tenant pattern is structurally cross-tenant-safe.
 *
 * Fail-safe convention (per sub-objective-gap-tracker.ts:56 pattern): any
 * Redis transient is logged + swallowed. Invalidation failure must NEVER
 * block the originating mutation (deal close, order place, etc.). Eventual
 * consistency falls back to the hard TTL.
 */
import type { FeasibilityRedis } from "./feasibility-context-service.js";

// Match buildContextCacheKey prefix verbatim. Diverging here silently breaks
// invalidation — kept as a module-local literal mirror; future cleanup to
// hoist to a shared constant module if a 3rd consumer emerges.
const CACHE_KEY_PREFIX = "feasibility:context";

/** SCAN batch size. Small enough to keep each iteration cheap; large enough
 *  that tenants with many goalShape variants drain in 1-2 iterations. */
const SCAN_COUNT = 100;

/** ioredis extension surface needed for invalidation. `scan` returns
 *  `[nextCursor, keys]`; `del` accepts variadic keys. Kept as a narrow
 *  interface so tests can mock without dragging the full ioredis surface. */
export interface FeasibilityRedisInvalidator extends FeasibilityRedis {
  scan(cursor: string, matchToken: "MATCH", pattern: string, countToken: "COUNT", count: number):
    Promise<[string, string[]]>;
  del(...keys: string[]): Promise<number>;
}

/**
 * Bulk-invalidate every cached TenantHistoricalContext entry for a tenant.
 *
 * Uses Redis SCAN (cursor-based, non-blocking) over the
 * `feasibility:context:<tenantId>:*` pattern. Safe under concurrent reads —
 * a reader that lands between SCAN + DEL gets the stale value once, then a
 * cache-miss on the next request triggers fresh compute.
 *
 * Fail-safe: Redis transient or scan-iteration failure is logged + swallowed.
 * Returns the count of keys deleted (0 on any failure path).
 */
async function invalidateAllContextForTenant(
  redis: FeasibilityRedisInvalidator | null,
  tenantId: string,
): Promise<number> {
  if (!redis) return 0;
  const pattern = `${CACHE_KEY_PREFIX}:${tenantId}:*`;
  const keysToDelete: string[] = [];
  let cursor = "0";
  try {
    do {
      const [nextCursor, batchKeys] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        SCAN_COUNT,
      );
      if (batchKeys.length > 0) {
        keysToDelete.push(...batchKeys);
      }
      cursor = nextCursor;
    } while (cursor !== "0");

    if (keysToDelete.length === 0) return 0;
    await redis.del(...keysToDelete);
    return keysToDelete.length;
  } catch (err) {
    console.warn(
      `[feasibility-context-invalidation] tenant-bulk-invalidation-failed tenantId=${tenantId} err=${(err as Error)?.message ?? String(err)}`,
    );
    return 0;
  }
}

// ─────────────────────────────────────────────
// Public hook surface — caller-facing entry points.
//
// Each hook documents the WHY at the callsite. Callers add a single
// `await hookOnXClosed(redis, tenantId);` line in their mutation path.
// Hooks are best-effort + fail-safe — invalidation failure NEVER blocks
// the originating mutation.
// ─────────────────────────────────────────────

/** Call after a Deal transitions to status='won' or 'lost' (closedAt is set).
 *  Invalidates conversionRate + sales-velocity-adjacent cached signals. */
export async function hookOnDealClosed(
  redis: FeasibilityRedisInvalidator | null,
  tenantId: string,
): Promise<number> {
  return invalidateAllContextForTenant(redis, tenantId);
}

/** Call after an Order is created/paid. Invalidates salesVelocity signals. */
export async function hookOnOrderPlaced(
  redis: FeasibilityRedisInvalidator | null,
  tenantId: string,
): Promise<number> {
  return invalidateAllContextForTenant(redis, tenantId);
}

/** Call after a new Contact is created. Invalidates customerBase + leadPipeline
 *  signals depending on the contact's lifecycleStage. */
export async function hookOnContactCreated(
  redis: FeasibilityRedisInvalidator | null,
  tenantId: string,
): Promise<number> {
  return invalidateAllContextForTenant(redis, tenantId);
}

/** Call after a Campaign transitions to status='active' (campaigns.activate
 *  tRPC mutation). The brief explicitly calls this out as an invalidation
 *  trigger — the AI's counsel about feasibility should re-derive when an
 *  operator commits to an outcome campaign. */
export async function hookOnCampaignActivated(
  redis: FeasibilityRedisInvalidator | null,
  tenantId: string,
): Promise<number> {
  return invalidateAllContextForTenant(redis, tenantId);
}

/** Operator-facing bulk invalidation. Surfaced for the chat UI's "refresh
 *  context" affordance + any future operator-driven explicit-invalidate flow
 *  (KAN-XXXX: data acquisition completion in the data acquisition flow). */
export async function invalidateTenantContext(
  redis: FeasibilityRedisInvalidator | null,
  tenantId: string,
): Promise<number> {
  return invalidateAllContextForTenant(redis, tenantId);
}
