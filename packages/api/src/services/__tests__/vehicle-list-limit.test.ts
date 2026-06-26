/**
 * KAN-1235c-fix — clampListLimit unit tests.
 *
 * Root cause of the PROD regression: listVehicles hard-capped page size at 100
 * (LIST_MAX_LIMIT) while every tRPC caller declares z.number().max(200), so the
 * campaign-target "all matching" selection silently truncated to 100-of-N. The
 * cap is now 200 (aligned with the contract). This is the deterministic test the
 * mocked RTL coverage lacked — it asserts the service actually accepts up to 200
 * without seeding >100 rows in the flaky integration DB.
 */
import { describe, it, expect } from "vitest";
import { clampListLimit } from "../vehicle-service.js";

describe("KAN-1235c-fix — clampListLimit", () => {
  it("accepts up to 200 (the contract max) — was capped at 100 (the bug)", () => {
    expect(clampListLimit(200)).toBe(200);
    expect(clampListLimit(137)).toBe(137); // the canonical PROD inventory size
    expect(clampListLimit(150)).toBe(150); // would have been 100 pre-fix
  });

  it("clamps above-max requests down to 200", () => {
    expect(clampListLimit(500)).toBe(200);
    expect(clampListLimit(201)).toBe(200);
  });

  it("defaults to 50 when unset, floors at 1", () => {
    expect(clampListLimit(undefined)).toBe(50);
    expect(clampListLimit(50)).toBe(50);
    expect(clampListLimit(0)).toBe(1);
    expect(clampListLimit(-5)).toBe(1);
  });
});
