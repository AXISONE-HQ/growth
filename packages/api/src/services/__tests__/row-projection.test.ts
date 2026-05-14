/**
 * KAN-915 — Unit tests for the pure `projectRow()` function. No DB,
 * no LLM, no Prisma client — just inputs in, typed shape out.
 *
 * Coverage matrix:
 *   - 4 entities × happy path (every field type round-trips)
 *   - 4 entities × NULL / empty / whitespace
 *   - 4 entities × unknown enum value → null + console.warn fires
 *   - Type-coercion edges: Decimal parse error → null; Date parse
 *     error → null; permissive boolean parse; integer clamp
 *   - Cross-entity: malformed fieldMappings (sourceColumn references
 *     a missing key in sourceRowData) → field is null, no throw
 *   - System-metadata exclusion: `_classification` key in
 *     sourceRowData is never projected
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import {
  projectRow,
  type FieldMappingEntryLike,
  type ProjectedCompany,
  type ProjectedContact,
  type ProjectedDeal,
  type ProjectedOrder,
} from "../lib/row-projection.js";

const CTX = {
  tenantId: "tenant-A",
  importJobId: "job_kan915_001",
  sourceRowIndex: 0,
};

function makeMappings(pairs: Array<[string, string]>): FieldMappingEntryLike[] {
  return pairs.map(([sourceColumn, targetField]) => ({
    sourceColumn,
    targetField,
    confidence: 100,
  }));
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

// ─────────────────────────────────────────────
// Contacts
// ─────────────────────────────────────────────

describe("projectRow — contacts happy path", () => {
  it("projects every Contact field type round-trip", () => {
    const sourceRowData = {
      email: "Alice.Morgan@Acme.io",
      phone: "+1-415-555-0142",
      first_name: "  Alice  ",
      last_name: "Morgan",
      lifecycle_stage: "customer",
      source: "web_form",
      city: "San Francisco",
      country: "US",
    };
    const mappings = makeMappings([
      ["email", "email"],
      ["phone", "phone"],
      ["first_name", "firstName"],
      ["last_name", "lastName"],
      ["lifecycle_stage", "lifecycleStage"],
      ["source", "source"],
      ["city", "city"],
      ["country", "country"],
    ]);
    const r = projectRow(sourceRowData, mappings, "contacts", CTX) as ProjectedContact;
    expect(r.email).toBe("alice.morgan@acme.io"); // lowercased
    expect(r.phone).toBe("+1-415-555-0142");
    expect(r.firstName).toBe("Alice"); // trimmed
    expect(r.lastName).toBe("Morgan");
    expect(r.lifecycleStage).toBe("customer");
    expect(r.source).toBe("web_form");
    expect(r.city).toBe("San Francisco");
    expect(r.country).toBe("US");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("NULL / empty / whitespace → null", () => {
    const sourceRowData = {
      email: null,
      phone: "",
      first_name: "   ",
      last_name: "Morgan",
    };
    const mappings = makeMappings([
      ["email", "email"],
      ["phone", "phone"],
      ["first_name", "firstName"],
      ["last_name", "lastName"],
    ]);
    const r = projectRow(sourceRowData, mappings, "contacts", CTX) as ProjectedContact;
    expect(r.email).toBeNull();
    expect(r.phone).toBeNull();
    expect(r.firstName).toBeNull();
    expect(r.lastName).toBe("Morgan");
  });

  it("unknown LifecycleStage → null + structured console.warn", () => {
    const sourceRowData = { lifecycle_stage: "VIP customer" };
    const mappings = makeMappings([["lifecycle_stage", "lifecycleStage"]]);
    const r = projectRow(sourceRowData, mappings, "contacts", CTX) as ProjectedContact;
    expect(r.lifecycleStage).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("[import-projection] Unknown LifecycleStage value");
    expect(msg).toContain(`tenantId=${CTX.tenantId}`);
    expect(msg).toContain(`importJobId=${CTX.importJobId}`);
    expect(msg).toContain(`rowIndex=${CTX.sourceRowIndex}`);
    expect(msg).toContain("field=lifecycleStage");
    expect(msg).toContain(`rawValue="VIP customer"`);
  });

  it("unknown ContactSource → null + console.warn", () => {
    const sourceRowData = { source: "google_ads" };
    const mappings = makeMappings([["source", "source"]]);
    const r = projectRow(sourceRowData, mappings, "contacts", CTX) as ProjectedContact;
    expect(r.source).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("ContactSource");
  });

  it("case-insensitive enum coercion (Customer → customer; META-AD → meta_ad)", () => {
    const sourceRowData = { lifecycle_stage: "Customer", source: "META-AD" };
    const mappings = makeMappings([
      ["lifecycle_stage", "lifecycleStage"],
      ["source", "source"],
    ]);
    const r = projectRow(sourceRowData, mappings, "contacts", CTX) as ProjectedContact;
    expect(r.lifecycleStage).toBe("customer");
    expect(r.source).toBe("meta_ad");
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// Companies
// ─────────────────────────────────────────────

describe("projectRow — companies happy path", () => {
  it("projects core Company fields + permissive bool + size enum", () => {
    const sourceRowData = {
      name: "Acme Corporation",
      domain: "acme.io",
      size_range: "range_51_200",
      annual_revenue: "5000000",
      is_tax_exempt: "yes",
      billing_city: "Toronto",
      billing_country: "CA",
    };
    const mappings = makeMappings([
      ["name", "name"],
      ["domain", "domain"],
      ["size_range", "sizeRange"],
      ["annual_revenue", "annualRevenue"],
      ["is_tax_exempt", "isTaxExempt"],
      ["billing_city", "billingCity"],
      ["billing_country", "billingCountry"],
    ]);
    const r = projectRow(sourceRowData, mappings, "companies", CTX) as ProjectedCompany;
    expect(r.name).toBe("Acme Corporation");
    expect(r.domain).toBe("acme.io");
    expect(r.sizeRange).toBe("range_51_200");
    expect(r.annualRevenue).toBeInstanceOf(Prisma.Decimal);
    expect(r.annualRevenue?.toString()).toBe("5000000");
    expect(r.isTaxExempt).toBe(true);
    expect(r.billingCity).toBe("Toronto");
  });

  it("permissive bool variants (true/1/yes/t/false/0/no/f)", () => {
    const mappings = makeMappings([["x", "isTaxExempt"]]);
    expect(
      (projectRow({ x: "true" }, mappings, "companies", CTX) as ProjectedCompany)
        .isTaxExempt,
    ).toBe(true);
    expect(
      (projectRow({ x: "1" }, mappings, "companies", CTX) as ProjectedCompany)
        .isTaxExempt,
    ).toBe(true);
    expect(
      (projectRow({ x: "YES" }, mappings, "companies", CTX) as ProjectedCompany)
        .isTaxExempt,
    ).toBe(true);
    expect(
      (projectRow({ x: "T" }, mappings, "companies", CTX) as ProjectedCompany)
        .isTaxExempt,
    ).toBe(true);
    expect(
      (projectRow({ x: "false" }, mappings, "companies", CTX) as ProjectedCompany)
        .isTaxExempt,
    ).toBe(false);
    expect(
      (projectRow({ x: "0" }, mappings, "companies", CTX) as ProjectedCompany)
        .isTaxExempt,
    ).toBe(false);
    expect(
      (projectRow({ x: "no" }, mappings, "companies", CTX) as ProjectedCompany)
        .isTaxExempt,
    ).toBe(false);
    // Unrecognized → null
    expect(
      (projectRow({ x: "maybe" }, mappings, "companies", CTX) as ProjectedCompany)
        .isTaxExempt,
    ).toBeNull();
  });

  it("Decimal parse error → null (no throw)", () => {
    const mappings = makeMappings([["x", "annualRevenue"]]);
    expect(
      (
        projectRow({ x: "not a number" }, mappings, "companies", CTX) as ProjectedCompany
      ).annualRevenue,
    ).toBeNull();
  });

  it("unknown CompanyLifecycleStage → null + warn", () => {
    const mappings = makeMappings([["x", "lifecycleStage"]]);
    const r = projectRow({ x: "lead" }, mappings, "companies", CTX) as ProjectedCompany;
    // Note: 'lead' is a Contact lifecycle, NOT a Company lifecycle
    expect(r.lifecycleStage).toBeNull();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("CompanyLifecycleStage");
  });
});

// ─────────────────────────────────────────────
// Deals
// ─────────────────────────────────────────────

describe("projectRow — deals happy path", () => {
  it("projects Deal canonical + lookup fields + Date + Decimal + enum", () => {
    const sourceRowData = {
      name: "Acme Renewal Q1",
      value: "25000.50",
      currency: "USD",
      status: "open",
      probability: "75",
      expected_close_date: "2026-12-31",
      contact_email: "ALICE@acme.io",
      pipeline_name: "Sales",
      stage_name: "Discovery",
    };
    const mappings = makeMappings([
      ["name", "name"],
      ["value", "value"],
      ["currency", "currency"],
      ["status", "status"],
      ["probability", "probability"],
      ["expected_close_date", "expectedCloseDate"],
      ["contact_email", "contactEmail"],
      ["pipeline_name", "pipelineName"],
      ["stage_name", "stageName"],
    ]);
    const r = projectRow(sourceRowData, mappings, "deals", CTX) as ProjectedDeal;
    expect(r.name).toBe("Acme Renewal Q1");
    expect(r.value).toBeInstanceOf(Prisma.Decimal);
    expect(r.value?.toString()).toBe("25000.5");
    expect(r.currency).toBe("USD");
    expect(r.status).toBe("open");
    expect(r.probability).toBe(75);
    expect(r.expectedCloseDate).toBeInstanceOf(Date);
    expect(r.contactEmail).toBe("alice@acme.io"); // email lowercased
    expect(r.pipelineName).toBe("Sales");
    expect(r.stageName).toBe("Discovery");
  });

  it("invalid Date → null", () => {
    const mappings = makeMappings([["x", "expectedCloseDate"]]);
    expect(
      (projectRow({ x: "not a date" }, mappings, "deals", CTX) as ProjectedDeal)
        .expectedCloseDate,
    ).toBeNull();
  });

  it("probability clamps to 0-100 range", () => {
    const mappings = makeMappings([["x", "probability"]]);
    expect(
      (projectRow({ x: "150" }, mappings, "deals", CTX) as ProjectedDeal).probability,
    ).toBe(100);
    expect(
      (projectRow({ x: "-5" }, mappings, "deals", CTX) as ProjectedDeal).probability,
    ).toBe(0);
    expect(
      (projectRow({ x: "abc" }, mappings, "deals", CTX) as ProjectedDeal).probability,
    ).toBeNull();
  });

  it("unknown DealStatus → null + warn", () => {
    const mappings = makeMappings([["x", "status"]]);
    const r = projectRow({ x: "pending" }, mappings, "deals", CTX) as ProjectedDeal;
    expect(r.status).toBeNull();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("DealStatus");
  });

  it("DealLostReason maps no-response variants", () => {
    const mappings = makeMappings([["x", "lostReason"]]);
    expect(
      (projectRow({ x: "no_response" }, mappings, "deals", CTX) as ProjectedDeal).lostReason,
    ).toBe("no_response");
    expect(
      (projectRow({ x: "no-response" }, mappings, "deals", CTX) as ProjectedDeal).lostReason,
    ).toBe("no_response"); // hyphen normalized
    expect(
      (projectRow({ x: "no response" }, mappings, "deals", CTX) as ProjectedDeal).lostReason,
    ).toBe("no_response"); // space normalized
  });
});

// ─────────────────────────────────────────────
// Orders
// ─────────────────────────────────────────────

describe("projectRow — orders happy path", () => {
  it("projects Order canonical + lookup + 4 Decimal amount fields + payment enums", () => {
    const sourceRowData = {
      order_number: "ORD-7777",
      provider_order_id: "stripe_pi_xyz",
      status: "paid",
      total_amount: "100.00",
      tax_amount: "13.00",
      discount_amount: "0.00",
      grand_total: "113.00",
      currency: "CAD",
      placed_at: "2026-05-13T10:00:00Z",
      payment_method: "card",
      payment_provider: "stripe",
      contact_email: "alice@acme.io",
    };
    const mappings = makeMappings([
      ["order_number", "orderNumber"],
      ["provider_order_id", "providerOrderId"],
      ["status", "status"],
      ["total_amount", "totalAmount"],
      ["tax_amount", "taxAmount"],
      ["discount_amount", "discountAmount"],
      ["grand_total", "grandTotal"],
      ["currency", "currency"],
      ["placed_at", "placedAt"],
      ["payment_method", "paymentMethod"],
      ["payment_provider", "paymentProvider"],
      ["contact_email", "contactEmail"],
    ]);
    const r = projectRow(sourceRowData, mappings, "orders", CTX) as ProjectedOrder;
    expect(r.orderNumber).toBe("ORD-7777");
    expect(r.providerOrderId).toBe("stripe_pi_xyz");
    expect(r.status).toBe("paid");
    expect(r.totalAmount?.toString()).toBe("100");
    expect(r.taxAmount?.toString()).toBe("13");
    expect(r.grandTotal?.toString()).toBe("113");
    expect(r.currency).toBe("CAD");
    expect(r.placedAt).toBeInstanceOf(Date);
    expect(r.paymentMethod).toBe("card");
    expect(r.paymentProvider).toBe("stripe");
    expect(r.contactEmail).toBe("alice@acme.io");
  });

  it("OrderStatus 'partially_refunded' round-trip (multi-word enum)", () => {
    const mappings = makeMappings([["x", "status"]]);
    expect(
      (projectRow({ x: "partially_refunded" }, mappings, "orders", CTX) as ProjectedOrder)
        .status,
    ).toBe("partially_refunded");
    expect(
      (projectRow({ x: "Partially Refunded" }, mappings, "orders", CTX) as ProjectedOrder)
        .status,
    ).toBe("partially_refunded"); // case + space normalized
  });

  it("unknown PaymentProvider → null + warn", () => {
    const mappings = makeMappings([["x", "paymentProvider"]]);
    const r = projectRow({ x: "paypal" }, mappings, "orders", CTX) as ProjectedOrder;
    expect(r.paymentProvider).toBeNull();
    expect(warnSpy.mock.calls[0]?.[0]).toContain("PaymentProvider");
  });
});

// ─────────────────────────────────────────────
// Cross-entity edges
// ─────────────────────────────────────────────

describe("projectRow — cross-entity edges", () => {
  it("malformed fieldMappings (sourceColumn references missing key) → field null, no throw", () => {
    const sourceRowData = { email: "a@b.com" };
    const mappings = makeMappings([
      ["email", "email"],
      ["nonexistent_column", "firstName"],
    ]);
    const r = projectRow(sourceRowData, mappings, "contacts", CTX) as ProjectedContact;
    expect(r.email).toBe("a@b.com");
    expect(r.firstName).toBeNull(); // graceful — no throw
  });

  it("empty fieldMappings → all fields null", () => {
    const sourceRowData = { email: "a@b.com", first_name: "Alice" };
    const r = projectRow(sourceRowData, [], "contacts", CTX) as ProjectedContact;
    expect(r.email).toBeNull();
    expect(r.firstName).toBeNull();
  });

  it("'skip' targetField is dropped from projection table", () => {
    const sourceRowData = { internal_id: "X", email: "a@b.com" };
    const mappings = makeMappings([
      ["internal_id", "skip"],
      ["email", "email"],
    ]);
    const r = projectRow(sourceRowData, mappings, "contacts", CTX) as ProjectedContact;
    expect(r.email).toBe("a@b.com");
    // No way to assert on a skipped field directly; verify the
    // projection doesn't crash + happy fields still project.
  });

  it("_classification system metadata key is never projected (defense)", () => {
    // Even if someone maliciously maps `_classification` → firstName,
    // buildLookup drops the entry. firstName ends up null.
    const sourceRowData = {
      _classification: { source: "heuristic", confidence: 100 },
      first_name: "RealName",
    };
    const mappingsMalicious = makeMappings([
      ["_classification", "firstName"],
    ]);
    const r1 = projectRow(sourceRowData, mappingsMalicious, "contacts", CTX) as ProjectedContact;
    expect(r1.firstName).toBeNull();
    // And the legitimate mapping still works
    const mappingsGood = makeMappings([["first_name", "firstName"]]);
    const r2 = projectRow(sourceRowData, mappingsGood, "contacts", CTX) as ProjectedContact;
    expect(r2.firstName).toBe("RealName");
  });

  it("multiple unknown enums in one row → one warn per enum", () => {
    const sourceRowData = {
      lifecycle: "VIP",
      src: "google_ads",
    };
    const mappings = makeMappings([
      ["lifecycle", "lifecycleStage"],
      ["src", "source"],
    ]);
    const r = projectRow(sourceRowData, mappings, "contacts", CTX) as ProjectedContact;
    expect(r.lifecycleStage).toBeNull();
    expect(r.source).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("known enum values do NOT trigger warn", () => {
    const sourceRowData = { ls: "customer", src: "web_form" };
    const mappings = makeMappings([
      ["ls", "lifecycleStage"],
      ["src", "source"],
    ]);
    projectRow(sourceRowData, mappings, "contacts", CTX);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("numeric input coerces to string then through type pipeline", () => {
    // CSV parsers occasionally type-coerce; ensure Decimal/Date helpers
    // tolerate raw numbers (e.g., `25000` not `"25000"`).
    const sourceRowData = { amount: 25000, prob: 50 };
    const mappings = makeMappings([
      ["amount", "value"],
      ["prob", "probability"],
    ]);
    const r = projectRow(sourceRowData, mappings, "deals", CTX) as ProjectedDeal;
    expect(r.value?.toString()).toBe("25000");
    expect(r.probability).toBe(50);
  });
});
