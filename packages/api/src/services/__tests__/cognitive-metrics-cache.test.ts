/**
 * KAN-1086 — Cache layer unit tests.
 *
 * Pure unit tests; no Prisma. Validates the Map-based TTL cache used by the
 * cognitive-metrics aggregator orchestrator. Template: InMemoryContextCache
 * tests at packages/api/src/services/__tests__/ (sibling pattern).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  CognitiveMetricsCache,
  COGNITIVE_METRICS_CACHE_TTL_SECONDS,
  buildCacheKey,
} from '../cognitive-metrics-cache.js';

describe('CognitiveMetricsCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('get returns null for missing key', () => {
    const cache = new CognitiveMetricsCache();
    expect(cache.get('missing')).toBeNull();
  });

  it('set then get returns the stored value within TTL', () => {
    const cache = new CognitiveMetricsCache();
    cache.set('k', { foo: 'bar' });
    expect(cache.get<{ foo: string }>('k')).toEqual({ foo: 'bar' });
  });

  it('returns null after TTL expires + deletes the expired entry', () => {
    const cache = new CognitiveMetricsCache();
    cache.set('k', 'value', 1);
    expect(cache.get('k')).toBe('value');
    vi.advanceTimersByTime(1001);
    expect(cache.get('k')).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('delete invalidates a single key without clearing others', () => {
    const cache = new CognitiveMetricsCache();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.delete('b');
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeNull();
    expect(cache.get('c')).toBe(3);
    expect(cache.size()).toBe(2);
  });

  it('clear empties the entire cache', () => {
    const cache = new CognitiveMetricsCache();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get('a')).toBeNull();
  });

  it('default TTL matches COGNITIVE_METRICS_CACHE_TTL_SECONDS (1h)', () => {
    expect(COGNITIVE_METRICS_CACHE_TTL_SECONDS).toBe(3600);
    const cache = new CognitiveMetricsCache();
    cache.set('k', 'v');
    vi.advanceTimersByTime(COGNITIVE_METRICS_CACHE_TTL_SECONDS * 1000 - 1);
    expect(cache.get('k')).toBe('v');
    vi.advanceTimersByTime(2);
    expect(cache.get('k')).toBeNull();
  });

  it('overwriting a key refreshes its TTL', () => {
    const cache = new CognitiveMetricsCache();
    cache.set('k', 'v1', 10);
    vi.advanceTimersByTime(8000);
    cache.set('k', 'v2', 10);
    vi.advanceTimersByTime(5000);
    expect(cache.get('k')).toBe('v2');
  });
});

describe('buildCacheKey', () => {
  it('null tenantId emits "all" segment', () => {
    expect(
      buildCacheKey({
        tenantId: null,
        windowStart: new Date('2026-06-01T00:00:00Z'),
        windowEnd: new Date('2026-06-30T23:59:59Z'),
      }),
    ).toBe('all|2026-06-01T00:00:00.000Z|2026-06-30T23:59:59.000Z');
  });

  it('non-null tenantId emits the tenantId verbatim', () => {
    expect(
      buildCacheKey({
        tenantId: '9ca85088-f65b-4bac-b098-fff742281ede',
        windowStart: new Date('2026-06-01T00:00:00Z'),
        windowEnd: new Date('2026-06-30T23:59:59Z'),
      }),
    ).toBe(
      '9ca85088-f65b-4bac-b098-fff742281ede|2026-06-01T00:00:00.000Z|2026-06-30T23:59:59.000Z',
    );
  });

  it('different windows produce different keys for same tenant', () => {
    const t = '9ca85088-f65b-4bac-b098-fff742281ede';
    const k1 = buildCacheKey({
      tenantId: t,
      windowStart: new Date('2026-06-01T00:00:00Z'),
      windowEnd: new Date('2026-06-07T23:59:59Z'),
    });
    const k2 = buildCacheKey({
      tenantId: t,
      windowStart: new Date('2026-06-01T00:00:00Z'),
      windowEnd: new Date('2026-06-30T23:59:59Z'),
    });
    expect(k1).not.toBe(k2);
  });
});
