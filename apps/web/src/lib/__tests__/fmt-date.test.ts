/**
 * KAN-989 — fmtDate / fmtDateTime TZ-safety contract.
 *
 * Regression guard for the KAN-cohort-3.5 / KAN-943 / KAN-945 TZ off-by-
 * one class. yyyy-mm-dd values stored as midnight UTC must render in UTC,
 * not shift backward in US-leaning locales.
 */
import { describe, it, expect } from "vitest";
import { fmtDate, fmtDateTime } from "../fmt-date";

describe("KAN-989 — fmtDate (TZ-safe, UTC-anchored)", () => {
  it("renders 2026-09-30T00:00:00Z as 9/30/2026, not 9/29/2026", () => {
    expect(fmtDate("2026-09-30T00:00:00.000Z")).toBe("9/30/2026");
  });

  it("returns em-dash for null / undefined / empty input (no NaN leak)", () => {
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate(undefined)).toBe("—");
    expect(fmtDate("")).toBe("—");
  });

  it("renders a far-future date correctly", () => {
    expect(fmtDate("2099-01-15T00:00:00.000Z")).toBe("1/15/2099");
  });
});

describe("KAN-989 — fmtDateTime (TZ-safe, UTC-anchored)", () => {
  it("renders ISO datetime in UTC", () => {
    // Format includes time; we assert the date portion is UTC-anchored
    // and the time portion is the UTC clock time.
    const out = fmtDateTime("2026-09-30T14:30:00.000Z");
    expect(out).toContain("9/30/2026");
    expect(out).toMatch(/2:30/);
  });

  it("returns em-dash for null / undefined / empty input", () => {
    expect(fmtDateTime(null)).toBe("—");
    expect(fmtDateTime(undefined)).toBe("—");
    expect(fmtDateTime("")).toBe("—");
  });
});
