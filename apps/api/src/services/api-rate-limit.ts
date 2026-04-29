/**
 * KAN-742 — per-tenant sliding-window rate limiter for /api/v1/leads.
 *
 * Default budget: 1000 requests/min/tenant. All API keys for a tenant
 * share the budget — simpler quota model + matches typical SaaS patterns.
 * Per-key throttling is a future enhancement (separate ticket if a tenant
 * ever asks for it).
 *
 * Implementation: Redis INCR + EXPIRE on a minute-bucketed key. Counter
 * reset is automatic on the bucket roll-over. The 2× window TTL ensures
 * stale buckets are reaped without manual cleanup.
 *
 * Failure posture (Redis unavailable): fail-open. Returning 429 on Redis
 * outage would punish all tenants for a transient infra issue. The
 * trade-off is ~minute-scale exposure during an outage; acceptable for V1.
 */
import { getRedisClient } from "./redis-client.js";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the current bucket rolls over. */
  resetAt: number;
}

const DEFAULT_LIMIT = 1000;
const WINDOW_SECONDS = 60;
const TTL_SECONDS = WINDOW_SECONDS * 2;

export async function checkRateLimit(tenantId: string, limit: number = DEFAULT_LIMIT): Promise<RateLimitResult> {
  const bucket = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
  const resetAt = (bucket + 1) * WINDOW_SECONDS;
  const key = `rate:tenant:${tenantId}:${bucket}`;

  let count: number;
  try {
    count = await getRedisClient().incr(key);
    if (count === 1) {
      await getRedisClient().expire(key, TTL_SECONDS);
    }
  } catch (err) {
    // Fail-open: Redis outage shouldn't lock all tenants out.
    console.error("[api-rate-limit] redis incr failed — fail-open:", err);
    return { allowed: true, limit, remaining: limit, resetAt };
  }

  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt,
  };
}
