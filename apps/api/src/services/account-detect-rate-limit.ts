/**
 * KAN-862 — Account Page Cohort 5: per-tenant rate limit for the
 * detect-from-website mutation. 1 scan per tenant per 60 seconds,
 * fail-open on Redis outage (mirrors the KAN-742 api-rate-limit posture).
 *
 * Sliding-window via INCR on a 60s-bucketed key. The key is distinct
 * from KAN-742's `rate:tenant:{tenantId}:{bucket}` so the two limits
 * don't share a counter — `rl:account-detect:{tenantId}:{bucket}`.
 *
 * Why not the existing `checkRateLimit` helper: it defaults to 1000
 * calls/min and the constants aren't ergonomic to reuse for limit=1.
 * Thin variant + clear naming wins over parameterizing the original.
 */
import { getRedisClient } from "./redis-client.js";

const WINDOW_SECONDS = 60;
const TTL_SECONDS = WINDOW_SECONDS * 2; // 2× window so stale buckets reap automatically
const LIMIT = 1; // 1 scan / tenant / 60s

export interface DetectRateLimitResult {
  allowed: boolean;
  /** Unix seconds when the current bucket rolls over — fed back to the
   * tRPC client so the UI can render an accurate "retry after" toast. */
  resetAt: number;
  /** Always 1 in V1; surfaced for future-proofing. */
  limit: number;
}

export async function checkAccountDetectRateLimit(
  tenantId: string,
): Promise<DetectRateLimitResult> {
  const bucket = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
  const resetAt = (bucket + 1) * WINDOW_SECONDS;
  const key = `rl:account-detect:${tenantId}:${bucket}`;

  let count: number;
  try {
    count = await getRedisClient().incr(key);
    if (count === 1) {
      await getRedisClient().expire(key, TTL_SECONDS);
    }
  } catch (err) {
    // Fail-open per KAN-742 precedent: a Redis outage shouldn't punish
    // tenants. The 60s window means even a perma-outage caps abuse to
    // human-typing rates.
    console.error("[account-detect-rate-limit] redis incr failed — fail-open:", err);
    return { allowed: true, limit: LIMIT, resetAt };
  }

  return {
    allowed: count <= LIMIT,
    limit: LIMIT,
    resetAt,
  };
}
