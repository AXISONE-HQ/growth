/**
 * KAN-742 — shared ioredis client for the API service. Used by:
 *   - api-rate-limit.ts (per-tenant sliding-window counters)
 *   - api-idempotency.ts (X-AxisOne-Idempotency-Key dedup)
 *
 * Lazy singleton — the client is constructed only when first accessed
 * (test paths can inject a mock via __setRedisClientForTest).
 */
import { Redis } from "ioredis";

let _redis: Redis | null = null;

export function getRedisClient(): Redis {
  if (!_redis) {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    _redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    _redis.on("error", (err: Error) => {
      console.error("[redis-client] error:", err.message);
    });
  }
  return _redis;
}

/** Test seam — replace the singleton with a mock or null. */
export function __setRedisClientForTest(client: Redis | null): void {
  _redis = client;
}
