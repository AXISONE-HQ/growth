/**
 * KAN-1230 B2.3 — descriptorToVehicleSearch mapping unit tests.
 *
 * Locks the descriptor → API-filter translation (singular intent fields →
 * array filters), chip generation, search-seed (make+model), and maxCount
 * passthrough. Canonical sentence (Memo 56 #10): "sell 10 used cars by end of
 * month" → {condition:'used', maxCount:10}.
 */
import { describe, it, expect } from "vitest";
import {
  descriptorToVehicleSearch,
  chipsToFilterSpec,
} from "../vehicleTargetDescriptor";

describe("descriptorToVehicleSearch", () => {
  it('"sell 10 used cars" → condition chip + maxCount, conditionIn array spec', () => {
    const r = descriptorToVehicleSearch({ condition: "used", maxCount: 10 });
    expect(r.maxCount).toBe(10);
    expect(r.chips).toHaveLength(1);
    expect(r.chips[0]).toMatchObject({
      key: "condition",
      label: "Condition: Used",
      spec: { conditionIn: ["used"] },
    });
    expect(r.searchSeed).toBe("");
  });

  it("make + model → search seed, no chip", () => {
    const r = descriptorToVehicleSearch({ make: "Honda", model: "CR-V", maxCount: 5 });
    expect(r.searchSeed).toBe("Honda CR-V");
    expect(r.chips).toHaveLength(0);
    expect(r.maxCount).toBe(5);
  });

  it("bodyStyle → bodyStyleIn chip (SUV upper-cased)", () => {
    const r = descriptorToVehicleSearch({ bodyStyle: "suv" });
    expect(r.chips[0]).toMatchObject({
      label: "Body: SUV",
      spec: { bodyStyleIn: ["suv"] },
    });
  });

  it("year → yearMin=yearMax chip", () => {
    const r = descriptorToVehicleSearch({ year: 2007 });
    expect(r.chips[0]).toMatchObject({
      label: "Year: 2007",
      spec: { yearMin: 2007, yearMax: 2007 },
    });
  });

  it("price range → priceMin/priceMax chip", () => {
    const r = descriptorToVehicleSearch({ priceMin: 10000, priceMax: 20000 });
    expect(r.chips[0].label).toBe("Price: $10,000–$20,000");
    expect(r.chips[0].spec).toEqual({ priceMin: 10000, priceMax: 20000 });
  });

  it("combination (used SUV) → two chips", () => {
    const r = descriptorToVehicleSearch({ condition: "used", bodyStyle: "suv" });
    expect(r.chips.map((c) => c.key).sort()).toEqual(["bodyStyle", "condition"]);
  });

  it("empty / null / non-object → no chips, no seed, no maxCount", () => {
    for (const d of [undefined, null, {}, "nope", 42]) {
      const r = descriptorToVehicleSearch(d);
      expect(r.chips).toHaveLength(0);
      expect(r.searchSeed).toBe("");
      expect(r.maxCount).toBeUndefined();
    }
  });

  it("maxCount <= 0 is ignored", () => {
    expect(descriptorToVehicleSearch({ maxCount: 0 }).maxCount).toBeUndefined();
    expect(descriptorToVehicleSearch({ maxCount: -3 }).maxCount).toBeUndefined();
  });

  it("chipsToFilterSpec merges chip specs + searchText", () => {
    const { chips } = descriptorToVehicleSearch({ condition: "used", bodyStyle: "suv" });
    expect(chipsToFilterSpec(chips, "Honda")).toEqual({
      conditionIn: ["used"],
      bodyStyleIn: ["suv"],
      searchText: "Honda",
    });
    // empty searchText omitted
    expect(chipsToFilterSpec(chips, "")).toEqual({
      conditionIn: ["used"],
      bodyStyleIn: ["suv"],
    });
  });
});
