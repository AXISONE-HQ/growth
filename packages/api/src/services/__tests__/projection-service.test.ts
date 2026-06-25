/**
 * KAN-1234 Phase A — projection-service unit tests (pure math).
 *
 * Canonical: "sell 10 used cars by end of month" → reachable 137 used cars ×
 * 6% industry rate × 30-day window = 8.2 projected vs goal 10 → STRETCH.
 */
import { describe, it, expect } from "vitest";
import {
  computeProjection,
  descriptorToVehicleFilters,
} from "../projection-service.js";

const WIN_START = new Date("2026-06-24T00:00:00.000Z");
const WIN_END = new Date("2026-07-24T00:00:00.000Z"); // 30 days

const baseOutcomes = { total: 0, hits: 0 };

describe("computeProjection — progressive disclosure", () => {
  it("no target yet (reachable null) → all fields null", () => {
    const r = computeProjection({
      reachableContacts: null,
      goalTarget: 10,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      industry: "used_auto",
      measuredOutcomes: baseOutcomes,
    });
    expect(r.reachableContacts).toBeNull();
    expect(r.projected).toBeNull();
    expect(r.verdict).toBeNull();
  });

  it("target set, no objective → reachableContacts only", () => {
    const r = computeProjection({
      reachableContacts: 137,
      goalTarget: null,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      industry: "used_auto",
      measuredOutcomes: baseOutcomes,
    });
    expect(r.reachableContacts).toBe(137);
    expect(r.daysInWindow).toBe(30);
    expect(r.closingRate).toBeNull();
    expect(r.projected).toBeNull();
    expect(r.goal).toBeNull();
    expect(r.verdict).toBeNull();
  });
});

describe("computeProjection — canonical + verdict math", () => {
  it('canonical "sell 10 used cars by end of month" → 8.2 projected, STRETCH', () => {
    const r = computeProjection({
      reachableContacts: 137,
      goalTarget: 10,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      industry: "used_auto",
      measuredOutcomes: baseOutcomes,
    });
    expect(r.closingRate).toBe(0.06);
    expect(r.closingRateSource).toBe("industry");
    expect(r.projected).toBe(8.2); // 137 × 0.06 × 1
    expect(r.goal).toBe(10);
    expect(r.gap).toBe(1.8);
    expect(r.verdict).toBe("stretch");
    expect(r.daysInWindow).toBe(30);
  });

  it("projected >= goal → on_track", () => {
    const r = computeProjection({
      reachableContacts: 200,
      goalTarget: 10,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      industry: "used_auto", // 200 × 0.06 = 12 >= 10
      measuredOutcomes: baseOutcomes,
    });
    expect(r.projected).toBe(12);
    expect(r.verdict).toBe("on_track");
    expect(r.gap).toBe(-2);
  });

  it("projected < goal*0.5 → unrealistic", () => {
    const r = computeProjection({
      reachableContacts: 50,
      goalTarget: 10,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      industry: "used_auto", // 50 × 0.06 = 3 < 5
      measuredOutcomes: baseOutcomes,
    });
    expect(r.projected).toBe(3);
    expect(r.verdict).toBe("unrealistic");
  });

  it("no timeline → default 30-day window factor", () => {
    const r = computeProjection({
      reachableContacts: 137,
      goalTarget: 10,
      windowStart: null,
      windowEnd: null,
      industry: "used_auto",
      measuredOutcomes: baseOutcomes,
    });
    expect(r.daysInWindow).toBeNull();
    expect(r.projected).toBe(8.2); // still uses the 30-day default
  });

  it("longer window scales projection linearly (60 days → 2x)", () => {
    const r = computeProjection({
      reachableContacts: 137,
      goalTarget: 10,
      windowStart: WIN_START,
      windowEnd: new Date("2026-08-23T00:00:00.000Z"), // 60 days
      industry: "used_auto",
      measuredOutcomes: baseOutcomes,
    });
    expect(r.daysInWindow).toBe(60);
    expect(r.projected).toBe(16.4); // 137 × 0.06 × 2
    expect(r.verdict).toBe("on_track");
  });
});

describe("computeProjection — closing-rate source", () => {
  it("< 3 measured outcomes → industry source", () => {
    const r = computeProjection({
      reachableContacts: 100,
      goalTarget: 5,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      industry: "saas_b2b",
      measuredOutcomes: { total: 2, hits: 2 },
    });
    expect(r.closingRateSource).toBe("industry");
    expect(r.closingRate).toBe(0.03);
  });

  it(">= 3 measured outcomes → tenant source (hits/total)", () => {
    const r = computeProjection({
      reachableContacts: 100,
      goalTarget: 5,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      industry: "saas_b2b",
      measuredOutcomes: { total: 5, hits: 2 },
    });
    expect(r.closingRateSource).toBe("tenant");
    expect(r.closingRate).toBe(0.4); // 2/5
  });

  it("unknown industry → 5% generic baseline", () => {
    const r = computeProjection({
      reachableContacts: 100,
      goalTarget: 5,
      windowStart: WIN_START,
      windowEnd: WIN_END,
      industry: "unknown",
      measuredOutcomes: baseOutcomes,
    });
    expect(r.closingRate).toBe(0.05);
  });
});

describe("descriptorToVehicleFilters", () => {
  it('"used" descriptor → conditionIn array', () => {
    expect(descriptorToVehicleFilters({ condition: "used", maxCount: 10 })).toEqual({
      conditionIn: ["used"],
    });
  });

  it("make + model → makeIn + searchText", () => {
    expect(descriptorToVehicleFilters({ make: "Honda", model: "CR-V" })).toEqual({
      makeIn: ["Honda"],
      searchText: "CR-V",
    });
  });

  it("year + price + bodyStyle", () => {
    expect(
      descriptorToVehicleFilters({ year: 2007, priceMin: 10000, priceMax: 20000, bodyStyle: "suv" }),
    ).toEqual({
      yearMin: 2007,
      yearMax: 2007,
      priceMin: 10000,
      priceMax: 20000,
      bodyStyleIn: ["suv"],
    });
  });

  it("empty / non-object → {}", () => {
    expect(descriptorToVehicleFilters(undefined)).toEqual({});
    expect(descriptorToVehicleFilters(null)).toEqual({});
    expect(descriptorToVehicleFilters("nope")).toEqual({});
  });
});
