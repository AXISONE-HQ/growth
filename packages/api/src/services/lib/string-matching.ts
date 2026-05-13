/**
 * KAN-911 — Ingestion Cohort 2.6. String-matching utilities for
 * duplicate detection.
 *
 * Pure functions, no Prisma / GCS / network deps. Used by the
 * per-entity matchers in import-dedup.ts.
 *
 * Distance backend: `fastest-levenshtein` — battle-tested MIT lib,
 * ~2KB. Faster than the JS-naive implementation by ~10x at typical
 * name lengths.
 *
 * Threshold convention: Levenshtein distance / max(len(a), len(b))
 * ≤ 0.15 = "fuzzy match" (similarity ≥ 0.85). Confidence values are
 * 0-100 (matches the rest of the cohort's denomination); we cap fuzzy
 * scores at 94 so exact-signal floors (95+) stay distinct.
 */
import { distance } from "fastest-levenshtein";

/**
 * Canonicalize a string for fuzzy comparison.
 *
 * Steps (order matters):
 *   1. Lowercase
 *   2. Strip diacritics (NFD decomposition + drop combining marks)
 *   3. Replace non-alphanumeric with spaces (keeps word boundaries)
 *   4. Collapse consecutive whitespace + trim
 *
 * Examples:
 *   "Café"       → "cafe"
 *   "Acme Co."   → "acme co"
 *   "  Mr.O'Hara " → "mr o hara"
 */
export function normalize(s: string | null | undefined): string {
  if (s == null) return "";
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Returns true iff two strings match under the fuzzy threshold.
 *
 * Returns false on empty/missing input — we don't want two null
 * names to "match" (that's a different concern: every staging row
 * without a name shouldn't get fuzzy-matched to every existing entity
 * without a name).
 */
export function fuzzyEqual(
  a: string | null | undefined,
  b: string | null | undefined,
  threshold = 0.15,
): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return false;
  const ratio = distance(na, nb) / maxLen;
  return ratio <= threshold;
}

/**
 * Compute a fuzzy similarity score (0-100). 100 on exact match (after
 * normalization), 0 on either empty.
 *
 * `confidence = min(round(similarity × 100), 94)` is the cap rule from
 * decision B — but this helper returns the *raw* score; the matcher
 * applies the cap. Returning the raw value lets exact-signal floors
 * (email_exact, domain_exact) sit at 100 distinctly.
 */
export function fuzzyScore(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 0;
  const similarity = 1 - distance(na, nb) / maxLen;
  return Math.round(similarity * 100);
}

/**
 * Strip all non-digit characters from a phone string.
 *
 *   "+1-415-555-0142" → "14155550142"
 *   "(415) 555-0142"  → "4155550142"
 *
 * Returns "" for null/undefined input.
 */
export function normalizePhone(p: string | null | undefined): string {
  if (p == null) return "";
  return p.replace(/\D/g, "");
}

/**
 * NANP-aware phone equality.
 *
 * Two phones match if:
 *   - Both are non-empty after digit-only normalization, AND
 *   - Either they're exactly equal, OR
 *   - One is 11 digits starting with "1" and the other is the same 10
 *     digits (US/CA country-code stripping).
 *
 * Out of scope (deferred to a future cohort): full E.164, regional
 * country-code handling beyond NANP, vanity-number-to-digits decoding.
 */
export function phonesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // NANP fallback: 11-digit-starting-with-1 ↔ 10-digit equivalence.
  if (na.length === 11 && na.startsWith("1") && na.slice(1) === nb) return true;
  if (nb.length === 11 && nb.startsWith("1") && nb.slice(1) === na) return true;
  return false;
}

/**
 * Bucket key for first-letter fuzzy pre-filter (decision E).
 *
 * Returns the first character of `normalize(name)`, or `"_"` if the
 * normalized string is empty / starts with a non-alphanumeric (already
 * stripped by normalize, so the empty case is the only path here).
 *
 * 36+ possible buckets covering [a-z 0-9 _].
 */
export function bucketKey(name: string | null | undefined): string {
  const n = normalize(name);
  if (!n) return "_";
  const first = n[0]!;
  return first;
}
