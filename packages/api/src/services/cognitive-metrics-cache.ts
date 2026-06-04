/**
 * KAN-1086 — In-process cache for Tier 2 cognitive-quality aggregation results.
 *
 * Map-based with per-key TTL. Single-instance scope: the internal
 * /cognitive-metrics dashboard is super-admin only and runs in a single
 * apps/api process. Per Phase 1 Lock 2: 1h TTL + manual refresh button.
 *
 * Template: InMemoryContextCache at packages/api/src/services/context-assembler.ts:705
 * Differences:
 *   - Typed value storage (no JSON serialize/deserialize cost per fetch)
 *   - Explicit single-key delete() — context-assembler only has clear() which
 *     would invalidate ALL contexts; too broad for manual-refresh UX
 *   - Singleton export instead of constructor-instantiated (per-router scope)
 *
 * Cache key shape: `${tenantId ?? 'all'}|${windowStart.toISOString()}|${windowEnd.toISOString()}`
 * One entry holds all 8 metrics for that window (orchestrator runs them in parallel).
 */

export const COGNITIVE_METRICS_CACHE_TTL_SECONDS = 3600;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class CognitiveMetricsCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlSeconds: number = COGNITIVE_METRICS_CACHE_TTL_SECONDS): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  /** Invalidate a single key. Used by the manual refresh button. */
  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

export const cognitiveMetricsCache = new CognitiveMetricsCache();

export function buildCacheKey(input: {
  tenantId: string | null;
  windowStart: Date;
  windowEnd: Date;
}): string {
  return `${input.tenantId ?? 'all'}|${input.windowStart.toISOString()}|${input.windowEnd.toISOString()}`;
}
