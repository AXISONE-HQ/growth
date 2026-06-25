/**
 * KAN-1234 Phase A — industry-default closing rates.
 *
 * Used by the Decision Scoreboard's projection when a tenant does NOT yet have
 * ≥3 measured campaign outcomes (the bootstrap window). Once a tenant has real
 * outcomes the projection sources its rate from those instead (Doctrine #4 —
 * outcome learning); these defaults are the honest "(industry baseline)" the
 * operator sees in the meantime (Memo 19/42 affordance-honesty).
 *
 * Rates are normalized 30-day closing rates (fraction of reachable contacts /
 * inventory that close within a 30-day window). Refined per-vertical in
 * KAN-1234 Phase C.
 */

export const INDUSTRY_CLOSING_RATE_DEFAULTS: Record<string, number> = {
  used_auto: 0.06,
  new_auto: 0.04,
  saas_b2b: 0.03,
  real_estate: 0.04,
  ecommerce: 0.025,
};

/** Generic fallback when industry is 'unknown' / absent / unmapped. */
export const GENERIC_CLOSING_RATE_DEFAULT = 0.05;

/** Minimum measured outcomes before a tenant's own rate supersedes the default. */
export const TENANT_RATE_MIN_OUTCOMES = 3;

/**
 * Resolve the industry-default closing rate for a tenant vertical. Tolerant of
 * null/unknown/unmapped values → generic 5% baseline.
 */
export function industryDefaultClosingRate(industry: string | null | undefined): number {
  if (!industry) return GENERIC_CLOSING_RATE_DEFAULT;
  return INDUSTRY_CLOSING_RATE_DEFAULTS[industry] ?? GENERIC_CLOSING_RATE_DEFAULT;
}
