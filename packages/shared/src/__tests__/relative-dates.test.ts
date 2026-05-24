/**
 * KAN-997 Slice 1 — UTC-anchored relative-date resolution.
 *
 * Pins the boundary contract that the LLM extractor + count where-tree
 * both depend on. Half-open `[fromUtc, toUtcExclusive)` semantics is the
 * defensive choice against the KAN-cohort-3.5 off-by-one date class.
 */
import { describe, it, expect } from 'vitest';
import {
  MONTH_NAMES,
  resolveMonthRange,
  resolveMonthSpan,
  lastYearOf,
  thisYearOf,
} from '../relative-dates.js';

describe('KAN-997 — resolveMonthRange (UTC, half-open)', () => {
  it('March 2025 → [2025-03-01T00:00:00Z, 2025-04-01T00:00:00Z)', () => {
    const r = resolveMonthRange('March', 2025);
    expect(r.fromUtc).toBe('2025-03-01T00:00:00.000Z');
    expect(r.toUtcExclusive).toBe('2025-04-01T00:00:00.000Z');
  });

  it('January 2025 — start-of-year boundary', () => {
    const r = resolveMonthRange('January', 2025);
    expect(r.fromUtc).toBe('2025-01-01T00:00:00.000Z');
    expect(r.toUtcExclusive).toBe('2025-02-01T00:00:00.000Z');
  });

  it('December 2025 → rolls into Jan 2026 for the exclusive upper bound', () => {
    const r = resolveMonthRange('December', 2025);
    expect(r.fromUtc).toBe('2025-12-01T00:00:00.000Z');
    expect(r.toUtcExclusive).toBe('2026-01-01T00:00:00.000Z');
  });

  it('February in a leap year — exclusive upper bound is March 1 regardless', () => {
    // Half-open semantics sidesteps Feb 28 vs Feb 29 entirely.
    const r = resolveMonthRange('February', 2024); // 2024 is a leap year
    expect(r.fromUtc).toBe('2024-02-01T00:00:00.000Z');
    expect(r.toUtcExclusive).toBe('2024-03-01T00:00:00.000Z');
  });

  it('All 12 months produce well-formed ranges in 2025', () => {
    for (const month of MONTH_NAMES) {
      const r = resolveMonthRange(month, 2025);
      expect(new Date(r.fromUtc).getUTCFullYear()).toBeGreaterThanOrEqual(2025);
      expect(new Date(r.toUtcExclusive).getTime()).toBeGreaterThan(
        new Date(r.fromUtc).getTime(),
      );
    }
  });
});

describe('KAN-997 — resolveMonthSpan (contiguous months → single range)', () => {
  it('March/April/May 2025 → [2025-03-01, 2025-06-01) — the canonical case', () => {
    const r = resolveMonthSpan(['March', 'April', 'May'], 2025);
    expect(r.fromUtc).toBe('2025-03-01T00:00:00.000Z');
    expect(r.toUtcExclusive).toBe('2025-06-01T00:00:00.000Z');
  });

  it('single-month span = single resolveMonthRange', () => {
    const r = resolveMonthSpan(['July'], 2025);
    expect(r.fromUtc).toBe('2025-07-01T00:00:00.000Z');
    expect(r.toUtcExclusive).toBe('2025-08-01T00:00:00.000Z');
  });

  it('throws on empty months[]', () => {
    expect(() => resolveMonthSpan([], 2025)).toThrow(/cannot be empty/i);
  });

  it('throws on non-contiguous months (LLM should emit two anyOf ranges instead)', () => {
    expect(() => resolveMonthSpan(['March', 'May'], 2025)).toThrow(/contiguous/i);
  });

  it('throws on reversed order (April → March is non-contiguous)', () => {
    expect(() => resolveMonthSpan(['April', 'March'], 2025)).toThrow(/contiguous/i);
  });
});

describe('KAN-997 — lastYearOf / thisYearOf (UTC year)', () => {
  it('lastYearOf 2026-05-23 → 2025', () => {
    expect(lastYearOf(new Date('2026-05-23T14:00:00Z'))).toBe(2025);
  });

  it('thisYearOf 2026-05-23 → 2026', () => {
    expect(thisYearOf(new Date('2026-05-23T14:00:00Z'))).toBe(2026);
  });

  it("New Year's Eve in late UTC — TZ-wobble safety. Toronto Dec 31 23:59 = UTC Jan 1 04:59 — uses UTC year", () => {
    // A Toronto-local NYE moment that has already rolled over in UTC.
    // The browser's getUTCFullYear() returns the NEW year, so lastYearOf
    // returns the CURRENT calendar year for Toronto's "last year." This
    // is the documented contract — UTC anchor wins, no exception case.
    const torontoNye = new Date('2026-01-01T04:00:00Z'); // = 2025-12-31 23:00 in Toronto
    expect(lastYearOf(torontoNye)).toBe(2025);
    expect(thisYearOf(torontoNye)).toBe(2026);
  });
});
