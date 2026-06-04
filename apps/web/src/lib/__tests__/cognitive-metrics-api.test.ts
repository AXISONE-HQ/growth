/**
 * KAN-1087 — cognitive-metrics-api helper unit tests.
 *
 * Covers the window-bound math + sparkline-bucket derivation; the
 * trpcQuery wrapper itself is exercised by integration in PR II's smoke.
 */
import { describe, it, expect } from 'vitest';
import { windowToBounds, sparklineBucketForWindow } from '../cognitive-metrics-api';

describe('windowToBounds', () => {
  const now = new Date('2026-06-04T15:00:00Z');

  it('24h subtracts 24 * 60 * 60 * 1000 ms', () => {
    const { windowStart, windowEnd } = windowToBounds('24h', now);
    expect(windowEnd).toBe('2026-06-04T15:00:00.000Z');
    expect(windowStart).toBe('2026-06-03T15:00:00.000Z');
  });

  it('7d subtracts 7 * 24h', () => {
    const { windowStart } = windowToBounds('7d', now);
    expect(windowStart).toBe('2026-05-28T15:00:00.000Z');
  });

  it('30d subtracts 30 * 24h', () => {
    const { windowStart } = windowToBounds('30d', now);
    expect(windowStart).toBe('2026-05-05T15:00:00.000Z');
  });
});

describe('sparklineBucketForWindow', () => {
  it("uses 'hour' for 24h window (sub-day granularity)", () => {
    expect(sparklineBucketForWindow('24h')).toBe('hour');
  });

  it("uses 'day' for 7d window", () => {
    expect(sparklineBucketForWindow('7d')).toBe('day');
  });

  it("uses 'day' for 30d window", () => {
    expect(sparklineBucketForWindow('30d')).toBe('day');
  });
});
