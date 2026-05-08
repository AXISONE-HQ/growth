// PROMOTION CANDIDATE: lift into packages/shared in KAN-847

/**
 * KAN-XXX — Service price formatter (pure module).
 *
 * Mirrors the server-side embed-text formatter in
 * `packages/api/src/services/services.ts:formatPricing` so the admin UI
 * surfaces the same string the AI cites in retrieval results. Keep these
 * in sync — drift means the operator sees one price label in the UI and a
 * different one inside the AI's answer.
 *
 * **Prisma Decimal serialization gotcha (KAN-851 fix-forward):**
 *
 * Prisma's `Decimal(10,2)` column serializes to a STRING in JSON ("250.00"),
 * not a number — Decimal.js preserves precision that way. Calling
 * `.toFixed()` directly on the field crashes with `TypeError: e.price.toFixed
 * is not a function` because String has no `.toFixed`. This module's helpers
 * therefore accept `string | number | null` for any Decimal-sourced field
 * and coerce via `Number()` with a finite-number guard.
 *
 * KAN-850 server tests masked the bug because the in-process mock returned
 * the field as a JS number; only the real Prisma client serialized to
 * string. The regression-pattern test added in this fix asserts no
 * `.price.toFixed(` call survives in components/knowledge/.
 */

export type ServicePriceUnit =
  | "PER_HOUR"
  | "PER_MONTH"
  | "PER_PROJECT"
  | "PER_UNIT"
  | "FIXED"
  | "CUSTOM";

const PRICE_UNIT_LABELS: Record<ServicePriceUnit, string> = {
  PER_HOUR: "per hour",
  PER_MONTH: "per month",
  PER_PROJECT: "per project",
  PER_UNIT: "per unit",
  FIXED: "fixed price",
  CUSTOM: "",
};

/** Sentence-case label for a `priceUnit` value, suitable for the unit dropdown. */
export function priceUnitLabel(unit: ServicePriceUnit): string {
  switch (unit) {
    case "PER_HOUR":
      return "Per hour";
    case "PER_MONTH":
      return "Per month";
    case "PER_PROJECT":
      return "Per project";
    case "PER_UNIT":
      return "Per unit";
    case "FIXED":
      return "Fixed price";
    case "CUSTOM":
      return "Custom (free-form label)";
  }
}

/**
 * Coerce a Prisma Decimal-sourced field to number for arithmetic / formatting.
 * Accepts the JSON serialization shape (`string`), the typed-client shape
 * (`number`), or null. Returns null when the input is null/undefined or
 * doesn't parse to a finite number — call sites guard with a fallback
 * label rather than crashing on NaN-toFixed.
 */
export function coerceDecimal(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Render the price for a Service row. CUSTOM uses the free-form label
 * verbatim; everything else is "$X.XX <unit>". Null price (only valid
 * for CUSTOM) falls back to a defensive "Contact for pricing".
 *
 * `price` accepts `string | number | null` to handle Prisma's Decimal
 * serialization on the JSON boundary (see module-level note).
 */
export function formatServicePrice(s: {
  price: string | number | null;
  priceUnit: ServicePriceUnit;
  priceCustomLabel: string | null;
}): string {
  if (s.priceUnit === "CUSTOM") {
    return s.priceCustomLabel?.trim() || "Contact for pricing";
  }
  const num = coerceDecimal(s.price);
  const priceStr = num !== null ? `$${num.toFixed(2)}` : "(price not set)";
  return `${priceStr} ${PRICE_UNIT_LABELS[s.priceUnit]}`.trim();
}

export const PRICE_UNIT_VALUES: ServicePriceUnit[] = [
  "PER_HOUR",
  "PER_MONTH",
  "PER_PROJECT",
  "PER_UNIT",
  "FIXED",
  "CUSTOM",
];
