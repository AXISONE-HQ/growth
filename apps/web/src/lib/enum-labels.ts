/**
 * KAN-884 — single canonical source for human-readable labels of the CRM
 * enums introduced by KAN-879 (schema) + KAN-883 (tRPC surface).
 *
 * Anywhere the UI renders an enum value as text — chip label, badge text,
 * detail-page caption — it should read through one of these maps. Keeps
 * "what does this enum look like to a user?" in one file so renaming a
 * stage or adding a new payment method doesn't sprawl into a dozen string
 * literals.
 *
 * Snapshot test in __tests__/enum-labels.test.ts pins the full output so
 * accidental drift surfaces in CI.
 */

// ─────────────────────────────────────────────────────────────────────────
// Contact (KAN-879)
// ─────────────────────────────────────────────────────────────────────────

export const LIFECYCLE_STAGE_LABELS: Record<string, string> = {
  lead: "Lead",
  mql: "MQL",
  sql: "SQL",
  customer: "Customer",
  lost: "Lost",
};

export const CONTACT_SOURCE_LABELS: Record<string, string> = {
  email_inbox: "Email inbox",
  web_form: "Web form",
  meta_ad: "Meta ad",
  manual: "Manual",
  csv_import: "CSV import",
  api: "API",
  hubspot: "HubSpot",
  stripe: "Stripe",
  shopify: "Shopify",
  other: "Other",
};

// ─────────────────────────────────────────────────────────────────────────
// Company (KAN-879)
// ─────────────────────────────────────────────────────────────────────────

export const COMPANY_LIFECYCLE_STAGE_LABELS: Record<string, string> = {
  prospect: "Prospect",
  customer: "Customer",
  churned: "Churned",
  partner: "Partner",
  vendor: "Vendor",
};

export const COMPANY_SIZE_LABELS: Record<string, string> = {
  range_1_10: "1–10 employees",
  range_11_50: "11–50 employees",
  range_51_200: "51–200 employees",
  range_201_1000: "201–1,000 employees",
  range_1001_5000: "1,001–5,000 employees",
  range_5000_plus: "5,000+ employees",
};

export const TAX_ID_TYPE_LABELS: Record<string, string> = {
  ein: "EIN",
  vat: "VAT",
  gst: "GST",
  hst: "HST",
  qst: "QST",
  abn: "ABN",
  other: "Other",
};

// ─────────────────────────────────────────────────────────────────────────
// Deal (KAN-879)
// ─────────────────────────────────────────────────────────────────────────

export const DEAL_STATUS_LABELS: Record<string, string> = {
  open: "Open",
  won: "Won",
  lost: "Lost",
};

export const DEAL_LOST_REASON_LABELS: Record<string, string> = {
  price: "Price",
  timing: "Timing",
  competitor: "Competitor",
  no_response: "No response",
  not_qualified: "Not qualified",
  feature_gap: "Feature gap",
  other: "Other",
};

// ─────────────────────────────────────────────────────────────────────────
// Order (KAN-879)
// ─────────────────────────────────────────────────────────────────────────

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  paid: "Paid",
  refunded: "Refunded",
  partially_refunded: "Partial refund",
  cancelled: "Cancelled",
  failed: "Failed",
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  card: "Card",
  ach: "ACH",
  invoice: "Invoice",
  manual: "Manual",
  other: "Other",
};

export const PAYMENT_PROVIDER_LABELS: Record<string, string> = {
  stripe: "Stripe",
  square: "Square",
  shopify: "Shopify",
  manual: "Manual",
  other: "Other",
};

export const ORDER_SOURCE_LABELS: Record<string, string> = {
  stripe_webhook: "Stripe (webhook)",
  shopify_webhook: "Shopify (webhook)",
  manual: "Manual",
  api: "API",
  csv_import: "CSV import",
};

// ─────────────────────────────────────────────────────────────────────────
// Safe lookup helper
// ─────────────────────────────────────────────────────────────────────────

/**
 * Look up an enum's display label with graceful fallback when the value
 * doesn't appear in the map. Falls back to the raw value so a freshly-added
 * enum case still renders (just without the polished label) instead of
 * disappearing from the UI.
 */
export function enumLabel(
  map: Record<string, string>,
  value: string | null | undefined,
): string {
  if (value == null) return "—";
  return map[value] ?? value;
}
