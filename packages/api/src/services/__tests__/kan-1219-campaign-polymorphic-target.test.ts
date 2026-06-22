/**
 * KAN-1219 Slice G1 — Campaign polymorphic target substrate tests.
 *
 * 8 scenarios across the substrate surfaces (no LLM/DB integration — those
 * land in G3):
 *
 *   1. CampaignTargetSchema validates a product variant
 *   2. CampaignTargetSchema validates a vehicle variant
 *   3. CampaignTargetSchema rejects invalid entityType
 *   4. fromCampaignRow / toCampaignRow round-trip
 *   5. heuristicEntityType detects vehicle signals (VIN + body style + dealer)
 *   6. heuristicEntityType detects product signals (subscription + SKU)
 *   7. normalizeEntityTypeExtraction parses 'product' / 'vehicle' / ambiguous
 *   8. normalizeVehicleExtraction parses year/bodyStyle/VIN + rejects empty
 *
 * Mirrors KAN-1184 conversational-orchestrator.test.ts harness shape.
 */
import { describe, it, expect } from "vitest";
import {
  CampaignTargetSchema,
  CampaignTargetEntityTypeEnum,
  fromCampaignRow,
  toCampaignRow,
} from "@growth/shared";
import {
  normalizeEntityTypeExtraction,
  heuristicEntityType,
} from "../orchestrator/extractEntityType.js";
import {
  normalizeVehicleExtraction,
  VehicleDimensionValueSchema,
} from "../orchestrator/extractVehicle.js";

// ─────────────────────────────────────────────
// 1-4 — CampaignTargetSchema + row adapters
// ─────────────────────────────────────────────

describe("KAN-1219 Slice G1 — CampaignTargetSchema", () => {
  it("Scenario 1 — product variant validates with UUID ids", () => {
    const parsed = CampaignTargetSchema.parse({
      entityType: "product",
      ids: ["11111111-1111-1111-1111-111111111111"],
    });
    expect(parsed.entityType).toBe("product");
    expect(parsed.ids).toHaveLength(1);
  });

  it("Scenario 2 — vehicle variant validates with UUID ids", () => {
    const parsed = CampaignTargetSchema.parse({
      entityType: "vehicle",
      ids: [
        "22222222-2222-2222-2222-222222222222",
        "33333333-3333-3333-3333-333333333333",
      ],
    });
    expect(parsed.entityType).toBe("vehicle");
    expect(parsed.ids).toHaveLength(2);
  });

  it("Scenario 3 — invalid entityType rejected", () => {
    const result = CampaignTargetSchema.safeParse({
      entityType: "service",
      ids: [],
    });
    expect(result.success).toBe(false);
  });

  it("Scenario 4 — fromCampaignRow / toCampaignRow round-trip", () => {
    const id = "44444444-4444-4444-4444-444444444444";
    // Confirmed-target row.
    const row = { targetEntityType: "vehicle", targetEntityIds: [id] };
    const target = fromCampaignRow(row);
    expect(target).not.toBeNull();
    expect(target?.entityType).toBe("vehicle");
    expect(target?.ids).toEqual([id]);
    // Round-trip.
    const back = toCampaignRow(target!);
    expect(back).toEqual({ targetEntityType: "vehicle", targetEntityIds: [id] });
    // Unconfirmed-target row (draft phase).
    expect(
      fromCampaignRow({ targetEntityType: null, targetEntityIds: [] }),
    ).toBeNull();
    // Schema-drift detection.
    expect(() =>
      fromCampaignRow({ targetEntityType: "service", targetEntityIds: [] }),
    ).toThrow(/Invalid Campaign.targetEntityType/);
  });
});

// ─────────────────────────────────────────────
// 5-6 — Heuristic entity-type classification
// ─────────────────────────────────────────────

describe("KAN-1219 Slice G1 — heuristicEntityType", () => {
  it("Scenario 5 — vehicle signals (VIN, body style, dealer phrasing)", () => {
    expect(
      heuristicEntityType("campaign for VIN 1HGCM82633A123456"),
    ).toBe("vehicle");
    expect(heuristicEntityType("promote the new SUV models")).toBe("vehicle");
    expect(heuristicEntityType("move the trade-in inventory")).toBe("vehicle");
    expect(heuristicEntityType("our 4 trucks need attention")).toBe("vehicle");
  });

  it("Scenario 6 — product signals (subscription, SKU)", () => {
    expect(heuristicEntityType("promote Growth Platform subscription")).toBe(
      "product",
    );
    expect(heuristicEntityType("SKU 12345 needs a push")).toBe("product");
    expect(heuristicEntityType("campaign for the Pro plan tier")).toBe(
      "product",
    );
    // Ambiguous → null (delegate to LLM).
    expect(heuristicEntityType("we should run a campaign")).toBeNull();
  });
});

// ─────────────────────────────────────────────
// 7 — normalizeEntityTypeExtraction
// ─────────────────────────────────────────────

describe("KAN-1219 Slice G1 — normalizeEntityTypeExtraction", () => {
  it("Scenario 7 — parses product / vehicle / ambiguous", () => {
    // Clean product extraction.
    const product = normalizeEntityTypeExtraction({
      kind: "extracted",
      value: "product",
      confidence: "high",
      aiMessage: "Got it — this is a product campaign.",
    });
    expect(product.kind).toBe("extracted");
    if (product.kind === "extracted") {
      expect(product.entityType).toBe("product");
      expect(product.confidence).toBe("high");
    }

    // Clean vehicle extraction.
    const vehicle = normalizeEntityTypeExtraction({
      kind: "extracted",
      value: "vehicle",
      confidence: "medium",
      aiMessage: "Targeting vehicles?",
    });
    expect(vehicle.kind).toBe("extracted");
    if (vehicle.kind === "extracted") {
      expect(vehicle.entityType).toBe("vehicle");
    }

    // Invalid value falls back to clarification.
    const ambiguous = normalizeEntityTypeExtraction({
      kind: "extracted",
      value: "service",
      confidence: "low",
      aiMessage: "Need clarification.",
    });
    expect(ambiguous.kind).toBe("clarification");

    // Passthrough clarification.
    const clarif = normalizeEntityTypeExtraction({
      kind: "clarification",
      aiMessage: "Could you specify?",
    });
    expect(clarif.kind).toBe("clarification");

    // Enum smoke — guards against future entityType expansion drift.
    expect(CampaignTargetEntityTypeEnum.options).toEqual(["product", "vehicle"]);
  });
});

// ─────────────────────────────────────────────
// 8 — normalizeVehicleExtraction
// ─────────────────────────────────────────────

describe("KAN-1219 Slice G1 — normalizeVehicleExtraction", () => {
  it("Scenario 8 — parses descriptive intents + VIN hints; rejects empty", () => {
    // Year + bodyStyle.
    const r1 = normalizeVehicleExtraction({
      kind: "extracted",
      value: { year: 2023, bodyStyle: "suv" },
      confidence: "high",
      aiMessage: "ok",
    });
    expect(r1.kind).toBe("extracted");
    if (r1.kind === "extracted") {
      expect(r1.value.year).toBe(2023);
      expect(r1.value.bodyStyle).toBe("suv");
    }

    // VIN hints + snake_case alias acceptance.
    const r2 = normalizeVehicleExtraction({
      kind: "extracted",
      value: {
        vinHints: ["1HGCM82633A123456"],
        price_max: 25000,
      },
      confidence: "medium",
      aiMessage: "ok",
    });
    expect(r2.kind).toBe("extracted");
    if (r2.kind === "extracted") {
      expect(r2.value.vinHints).toEqual(["1HGCM82633A123456"]);
      expect(r2.value.priceMax).toBe(25000);
    }

    // Empty object → clarification.
    const r3 = normalizeVehicleExtraction({
      kind: "extracted",
      value: {},
      confidence: "low",
      aiMessage: "",
    });
    expect(r3.kind).toBe("clarification");

    // Schema bound smoke.
    expect(VehicleDimensionValueSchema.safeParse({ year: 2024 }).success).toBe(
      true,
    );
  });
});
