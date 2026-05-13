/**
 * KAN-884 — enum-labels snapshot test.
 *
 * Snapshots the full enum→label maps so any accidental drift surfaces in
 * CI rather than slipping silently into PROD as a UI-side display change.
 * If you intentionally rename a label, update the snapshot.
 *
 * Also covers the safe-lookup helper (`enumLabel`).
 */
import { describe, it, expect } from "vitest";
import {
  CONTACT_SOURCE_LABELS,
  COMPANY_LIFECYCLE_STAGE_LABELS,
  COMPANY_SIZE_LABELS,
  DEAL_STATUS_LABELS,
  DEAL_LOST_REASON_LABELS,
  IMPORT_FILE_TYPE_LABELS,
  IMPORT_MODE_LABELS,
  IMPORT_STATUS_LABELS,
  LIFECYCLE_STAGE_LABELS,
  ORDER_STATUS_LABELS,
  ORDER_SOURCE_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_PROVIDER_LABELS,
  TAX_ID_TYPE_LABELS,
  enumLabel,
} from "../enum-labels";

describe("KAN-884 — enum-labels snapshot", () => {
  it("Contact LifecycleStage labels", () => {
    expect(LIFECYCLE_STAGE_LABELS).toMatchInlineSnapshot(`
      {
        "customer": "Customer",
        "lead": "Lead",
        "lost": "Lost",
        "mql": "MQL",
        "sql": "SQL",
      }
    `);
  });

  it("ContactSource labels", () => {
    expect(CONTACT_SOURCE_LABELS).toMatchInlineSnapshot(`
      {
        "api": "API",
        "csv_import": "CSV import",
        "email_inbox": "Email inbox",
        "hubspot": "HubSpot",
        "manual": "Manual",
        "meta_ad": "Meta ad",
        "other": "Other",
        "shopify": "Shopify",
        "stripe": "Stripe",
        "web_form": "Web form",
      }
    `);
  });

  it("CompanyLifecycleStage labels", () => {
    expect(COMPANY_LIFECYCLE_STAGE_LABELS).toMatchInlineSnapshot(`
      {
        "churned": "Churned",
        "customer": "Customer",
        "partner": "Partner",
        "prospect": "Prospect",
        "vendor": "Vendor",
      }
    `);
  });

  it("CompanySize labels render employee ranges", () => {
    // NOTE: vitest sorts snapshot keys lexicographically (ASCII), so
    // "range_11_50" sorts before "range_1_10" because '1' (0x31) < '_' (0x5F).
    expect(COMPANY_SIZE_LABELS).toMatchInlineSnapshot(`
      {
        "range_1001_5000": "1,001–5,000 employees",
        "range_11_50": "11–50 employees",
        "range_1_10": "1–10 employees",
        "range_201_1000": "201–1,000 employees",
        "range_5000_plus": "5,000+ employees",
        "range_51_200": "51–200 employees",
      }
    `);
  });

  it("DealStatus labels", () => {
    expect(DEAL_STATUS_LABELS).toMatchInlineSnapshot(`
      {
        "lost": "Lost",
        "open": "Open",
        "won": "Won",
      }
    `);
  });

  it("DealLostReason labels", () => {
    expect(DEAL_LOST_REASON_LABELS).toMatchInlineSnapshot(`
      {
        "competitor": "Competitor",
        "feature_gap": "Feature gap",
        "no_response": "No response",
        "not_qualified": "Not qualified",
        "other": "Other",
        "price": "Price",
        "timing": "Timing",
      }
    `);
  });

  it("OrderStatus labels — partially_refunded renders as 'Partial refund'", () => {
    expect(ORDER_STATUS_LABELS).toMatchInlineSnapshot(`
      {
        "cancelled": "Cancelled",
        "failed": "Failed",
        "paid": "Paid",
        "partially_refunded": "Partial refund",
        "pending": "Pending",
        "refunded": "Refunded",
      }
    `);
  });

  it("KAN-901 — ImportStatus labels", () => {
    expect(IMPORT_STATUS_LABELS).toMatchInlineSnapshot(`
      {
        "awaiting_upload": "Awaiting upload",
        "failed": "Failed",
        "inspected": "Ready",
        "inspecting": "Inspecting…",
        "uploaded": "Uploaded",
      }
    `);
  });

  it("KAN-901 — ImportMode labels", () => {
    expect(IMPORT_MODE_LABELS).toMatchInlineSnapshot(`
      {
        "replace_all": "Replace all",
        "update_add": "Update + add",
      }
    `);
  });

  it("KAN-901 — ImportFileType labels", () => {
    expect(IMPORT_FILE_TYPE_LABELS).toMatchInlineSnapshot(`
      {
        "csv": "CSV",
        "unknown": "Unknown",
        "xlsx": "XLSX",
      }
    `);
  });

  it("PaymentMethod / PaymentProvider / OrderSource / TaxIdType maps", () => {
    expect(PAYMENT_METHOD_LABELS).toEqual({
      card: "Card",
      ach: "ACH",
      invoice: "Invoice",
      manual: "Manual",
      other: "Other",
    });
    expect(PAYMENT_PROVIDER_LABELS).toEqual({
      stripe: "Stripe",
      square: "Square",
      shopify: "Shopify",
      manual: "Manual",
      other: "Other",
    });
    expect(ORDER_SOURCE_LABELS).toEqual({
      stripe_webhook: "Stripe (webhook)",
      shopify_webhook: "Shopify (webhook)",
      manual: "Manual",
      api: "API",
      csv_import: "CSV import",
    });
    expect(TAX_ID_TYPE_LABELS).toEqual({
      ein: "EIN",
      vat: "VAT",
      gst: "GST",
      hst: "HST",
      qst: "QST",
      abn: "ABN",
      other: "Other",
    });
  });
});

describe("KAN-884 — enumLabel helper", () => {
  it("returns the label for a known value", () => {
    expect(enumLabel(ORDER_STATUS_LABELS, "paid")).toBe("Paid");
  });

  it("falls back to the raw value when not in the map", () => {
    expect(enumLabel(ORDER_STATUS_LABELS, "unknown_new_state")).toBe(
      "unknown_new_state",
    );
  });

  it("returns em-dash for null", () => {
    expect(enumLabel(ORDER_STATUS_LABELS, null)).toBe("—");
  });

  it("returns em-dash for undefined", () => {
    expect(enumLabel(ORDER_STATUS_LABELS, undefined)).toBe("—");
  });
});
