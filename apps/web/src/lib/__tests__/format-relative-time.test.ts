/**
 * KAN-1087 — format-relative-time unit tests (pure helper, deterministic).
 * KAN-1102 — relocated alongside source from
 * apps/web/src/app/settings/cognitive-metrics/_components/__tests__/ to
 * apps/web/src/lib/__tests__/ matching the apps/web convention (test
 * colocation with source — see also lib/__tests__/cognitive-metrics-api.test.ts
 * + lib/__tests__/board-helpers.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from '../format-relative-time';

describe('formatRelativeTime', () => {
  const now = new Date('2026-06-04T15:00:00Z');

  it('returns "Just now" for < 30s diff', () => {
    expect(formatRelativeTime(new Date('2026-06-04T14:59:45Z').toISOString(), now)).toBe('Just now');
  });

  it('returns seconds for 30-59s diff', () => {
    expect(formatRelativeTime(new Date('2026-06-04T14:59:15Z').toISOString(), now)).toBe('45s ago');
  });

  it('returns minutes for 1-59min diff', () => {
    expect(formatRelativeTime(new Date('2026-06-04T14:58:00Z').toISOString(), now)).toBe('2m ago');
  });

  it('returns hours for 1-23h diff', () => {
    expect(formatRelativeTime(new Date('2026-06-04T12:00:00Z').toISOString(), now)).toBe('3h ago');
  });

  it('returns days for >= 24h diff', () => {
    expect(formatRelativeTime(new Date('2026-06-02T15:00:00Z').toISOString(), now)).toBe('2d ago');
  });
});
