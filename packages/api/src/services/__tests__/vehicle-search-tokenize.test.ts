/**
 * KAN-1228 — tokenizeSearch unit tests.
 *
 * The operator pain: searching "Honda CR-V" in TargetEntityPanel returned 0
 * (whole-string `contains` matched no single field) while "Honda" returned 7.
 * Tokenizing on whitespace + hyphens fixes it (each token matches some field).
 */
import { describe, it, expect } from "vitest";
import { tokenizeSearch } from "../vehicle-service.js";

describe("KAN-1228 — tokenizeSearch", () => {
  it('"Honda CR-V" → ["honda","cr","v"] (whitespace + hyphen split, lowercased)', () => {
    expect(tokenizeSearch("Honda CR-V")).toEqual(["honda", "cr", "v"]);
  });

  it("case-insensitive: HONDA cr-v → same tokens", () => {
    expect(tokenizeSearch("HONDA cr-v")).toEqual(["honda", "cr", "v"]);
  });

  it("single token still works", () => {
    expect(tokenizeSearch("Honda")).toEqual(["honda"]);
  });

  it("collapses extra whitespace + leading/trailing", () => {
    expect(tokenizeSearch("  Honda   CR-V  ")).toEqual(["honda", "cr", "v"]);
  });

  it("blank / whitespace-only / hyphen-only → [] (no AND clause → returns all)", () => {
    expect(tokenizeSearch("")).toEqual([]);
    expect(tokenizeSearch("   ")).toEqual([]);
    expect(tokenizeSearch("--")).toEqual([]);
  });

  it("VIN-like single token preserved", () => {
    expect(tokenizeSearch("5J6RE48797L813664")).toEqual(["5j6re48797l813664"]);
  });
});
