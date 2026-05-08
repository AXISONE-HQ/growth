// PROMOTION CANDIDATE: lift into packages/shared in KAN-847

/**
 * KAN-XXX — Service price formatter (pure module).
 *
 * Mirrors the server-side embed-text formatter in
 * `packages/api/src/services/services.ts:formatPricing` so the admin UI
 * surfaces the same string the AI cites in retrieval results. Keep these
 * in sync — drift means the operator sees one price label in the UI and a
 * different one inside the AI's answer.
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
 * Render the price for a Service row. CUSTOM uses the free-form label
 * verbatim; everything else is "$X.XX <unit>". Null price (only valid
 * for CUSTOM) falls back to a defensive "Contact for pricing".
 */
export function formatServicePrice(s: {
  price: number | null;
  priceUnit: ServicePriceUnit;
  priceCustomLabel: string | null;
}): string {
  if (s.priceUnit === "CUSTOM") {
    return s.priceCustomLabel?.trim() || "Contact for pricing";
  }
  const priceStr = s.price !== null ? `$${s.price.toFixed(2)}` : "(price not set)";
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
