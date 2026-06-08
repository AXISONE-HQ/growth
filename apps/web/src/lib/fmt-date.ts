/**
 * KAN-989 — TZ-safe date / datetime formatters for `@db.Date` source columns ONLY.
 *
 * Hoisted from the 4 [id] pages (deal/company/order/contact) so the
 * KAN-cohort-3.5 / KAN-943 / KAN-945 fix lives in one place.
 *
 * Why `timeZone: 'UTC'`:
 *   `new Date(iso).toLocaleDateString()` without a `timeZone` option
 *   shifts the rendered day by the browser's UTC offset. In TZs west
 *   of UTC (e.g., America/Toronto), a yyyy-mm-dd value stored as
 *   midnight UTC renders one day earlier than intended (KAN-3.3 PROD
 *   smoke incident). `timeZone: 'UTC'` aligns the detail-page display
 *   with the edit-form's UTC-day pre-population.
 *
 * Use this helper for date-only Prisma fields backed by `@db.Date`:
 * `Campaign.startDate`, `Campaign.endDate`, `Deal.expectedCloseDate`,
 * `Holiday.date`, `Order.expectedCloseDate`. The KAN-1131 PR 2 audit
 * (2026-06-08) enumerated the full set in `packages/db/prisma/schema.prisma`
 * (5 columns at the time of audit).
 *
 * Do NOT use for `DateTime` (instant) fields. Operator timestamps
 * (`createdAt`, `uploadedAt`, `occurredAt`, `lastUsedAt`, `revokedAt`,
 * etc.) should render in USER-tz via raw `toLocaleDateString()` /
 * `toLocaleString()` — that's semantically correct for "this happened
 * at X" displays. UTC-locking those would over-correct: e.g. a 9pm-ET
 * upload would render as "the next day" for everyone.
 *
 * Reuse contract: detail/list pages displaying `@db.Date` fields MUST
 * import these. The KAN-1131 PR 2 audit found 14 other sites correctly
 * using raw locale formatters (DateTime instants) + 1 latent bug at
 * `holiday-list.tsx` (the `Holiday.date @db.Date` case), fixed in the
 * same PR.
 *
 * Audited 2026-06-08 per KAN-1131 PR 2.
 */

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "UTC" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { timeZone: "UTC" });
}
