/**
 * KAN-997 Campaign Layer Slice 1 — UTC-anchored relative-date resolution.
 *
 * Why this lives in @growth/shared: the LLM extractor in
 * packages/api/services/audience-router.ts produces an audience_conditions
 * jsonb with half-open `[fromUtc, toUtcExclusive)` ranges, and the
 * count-side Prisma where-tree consumes the same shape. Web surfaces may
 * also render these ranges. Single source of truth avoids drift.
 *
 * Why half-open ranges: closed-on-both-ends ("March 1 to March 31")
 * collides with the off-by-one date class we've been bitten by twice
 * (KAN-cohort-3.5 / KAN-943 / KAN-945). Encoding "March 2025" as
 * [2025-03-01T00:00:00Z, 2025-04-01T00:00:00Z) makes the inclusive-
 * exclusive contract explicit + sidesteps "is the 31st in or out?".
 *
 * Why UTC: every Date math here uses Date.UTC() / getUTC*() so the
 * tenant's wall-clock TZ doesn't shift the boundary. Aligns with the
 * apps/web fmt-date.ts util that renders date-only values with
 * `timeZone: 'UTC'`.
 */

/**
 * Month index → name (0-indexed, matches Date.UTC() month argument).
 * `MONTH_NAMES[2] === 'March'`.
 */
export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export type MonthName = (typeof MONTH_NAMES)[number];

/**
 * Resolve a month name + year → half-open UTC ISO range.
 *
 * Example: `resolveMonthRange('March', 2025)` →
 *   { fromUtc: '2025-03-01T00:00:00.000Z',
 *     toUtcExclusive: '2025-04-01T00:00:00.000Z' }
 *
 * Edge: December → next year's January.
 *   `resolveMonthRange('December', 2025)` →
 *   { fromUtc: '2025-12-01T00:00:00.000Z',
 *     toUtcExclusive: '2026-01-01T00:00:00.000Z' }
 */
export function resolveMonthRange(
  monthName: MonthName,
  year: number,
): { fromUtc: string; toUtcExclusive: string } {
  const monthIdx = MONTH_NAMES.indexOf(monthName);
  if (monthIdx < 0) {
    throw new Error(`Invalid month name: ${monthName}`);
  }
  const from = new Date(Date.UTC(year, monthIdx, 1, 0, 0, 0, 0));
  // Month overflow handled by Date.UTC — month 12 in year Y becomes
  // month 0 in year Y+1.
  const to = new Date(Date.UTC(year, monthIdx + 1, 1, 0, 0, 0, 0));
  return {
    fromUtc: from.toISOString(),
    toUtcExclusive: to.toISOString(),
  };
}

/**
 * Resolve a contiguous span of months → single half-open UTC range.
 *
 * Example: `resolveMonthSpan(['March','April','May'], 2025)` →
 *   { fromUtc: '2025-03-01T00:00:00.000Z',
 *     toUtcExclusive: '2025-06-01T00:00:00.000Z' }
 *
 * Months MUST be contiguous in their natural calendar order — the
 * canonical NL case "March, April & May" assumes ordered + adjacent.
 * Non-contiguous input throws (the LLM extractor should emit two
 * separate `anyOf` ranges instead).
 */
export function resolveMonthSpan(
  months: MonthName[],
  year: number,
): { fromUtc: string; toUtcExclusive: string } {
  if (months.length === 0) {
    throw new Error('resolveMonthSpan: months[] cannot be empty');
  }
  const indices = months.map((m) => {
    const i = MONTH_NAMES.indexOf(m);
    if (i < 0) throw new Error(`Invalid month name: ${m}`);
    return i;
  });
  // Contiguous-check: each subsequent index = previous + 1.
  for (let i = 1; i < indices.length; i++) {
    if (indices[i]! !== indices[i - 1]! + 1) {
      throw new Error(
        `resolveMonthSpan: months must be contiguous in calendar order — got ${months.join(', ')}`,
      );
    }
  }
  const firstMonth = months[0]!;
  const lastMonth = months[months.length - 1]!;
  const first = resolveMonthRange(firstMonth, year);
  const last = resolveMonthRange(lastMonth, year);
  return { fromUtc: first.fromUtc, toUtcExclusive: last.toUtcExclusive };
}

/**
 * Resolve "last year" relative to a reference date.
 *
 * Example: `lastYearOf(new Date('2026-05-23T14:00:00Z'))` → 2025.
 *
 * Always uses UTC year so TZ-shifted New Year's Eve doesn't bounce.
 */
export function lastYearOf(today: Date): number {
  return today.getUTCFullYear() - 1;
}

/**
 * Resolve "this year" — pinned for symmetry + testability.
 */
export function thisYearOf(today: Date): number {
  return today.getUTCFullYear();
}
