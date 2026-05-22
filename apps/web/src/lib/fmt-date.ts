/**
 * KAN-989 — TZ-safe date / datetime formatters for detail pages.
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
 * Reuse contract: ALL detail pages MUST import these — never call
 * `new Date(iso).toLocaleDateString()` / `.toLocaleString()` directly
 * on date-only ISO strings.
 */

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "UTC" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { timeZone: "UTC" });
}
