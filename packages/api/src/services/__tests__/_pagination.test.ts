/**
 * KAN-883 — cursor pagination helper tests.
 *
 * Coverage:
 *   - encode/decode round-trip preserves id + createdAt exactly
 *   - decode returns null on malformed tokens (base64 garbage, broken JSON,
 *     wrong shape) — never throws
 *   - decode returns null on empty/undefined cursors
 *   - buildCursorWhere generates the correct OR/AND tuple for stable
 *     pagination under createdAt ties
 *   - buildCursorWhere accepts a custom timestamp field name (orders use
 *     placedAt, not createdAt)
 */
import { describe, it, expect } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  buildCursorWhere,
} from "../_pagination.js";

describe("_pagination — encode/decode round-trip", () => {
  it("preserves id + createdAt across encode → decode", () => {
    const original = { id: "ct_abc123", createdAt: new Date("2026-05-12T10:00:00.000Z") };
    const token = encodeCursor(original);
    const decoded = decodeCursor(token);
    expect(decoded).toEqual({
      id: "ct_abc123",
      createdAt: "2026-05-12T10:00:00.000Z",
    });
  });

  it("produces opaque base64 (callers can't introspect)", () => {
    const token = encodeCursor({ id: "x", createdAt: new Date() });
    // Should be base64-ish — only alphanumerics + / + + + =
    expect(token).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(token).not.toContain("createdAt");
    expect(token).not.toContain("ct_");
  });
});

describe("_pagination — decode defense", () => {
  it("returns null on undefined input (first-page semantics)", () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  it("returns null on empty string", () => {
    expect(decodeCursor("")).toBeNull();
  });

  it("returns null on base64 garbage that decodes to non-JSON", () => {
    expect(decodeCursor("Z2FyYmFnZQ==")).toBeNull(); // "garbage" base64
  });

  it("returns null on valid JSON but wrong shape (missing fields)", () => {
    const wrongShape = Buffer.from(JSON.stringify({ foo: "bar" }), "utf-8").toString("base64");
    expect(decodeCursor(wrongShape)).toBeNull();
  });

  it("returns null on valid JSON but invalid createdAt ISO", () => {
    const wrongShape = Buffer.from(
      JSON.stringify({ id: "x", createdAt: "not-a-date" }),
      "utf-8",
    ).toString("base64");
    expect(decodeCursor(wrongShape)).toBeNull();
  });

  it("returns null on completely malformed base64 (throws inside Buffer)", () => {
    // ★★ never throws ★★ — even if base64 itself is broken, we get null,
    // not a 500. Critical for public API surface.
    expect(decodeCursor("!@#$%^&*()")).toBeNull();
  });
});

describe("_pagination — buildCursorWhere", () => {
  it("returns empty object when no cursor (first page)", () => {
    expect(buildCursorWhere(null)).toEqual({});
  });

  it("builds OR/AND tuple for stable pagination under createdAt ties", () => {
    const cursor = {
      id: "ct_abc",
      createdAt: "2026-05-12T10:00:00.000Z",
    };
    const where = buildCursorWhere(cursor);
    expect(where).toHaveProperty("OR");
    const or = where.OR as Array<Record<string, unknown>>;
    expect(or).toHaveLength(2);
    // First clause: createdAt strictly less than the cursor timestamp
    expect(or[0]).toEqual({ createdAt: { lt: new Date("2026-05-12T10:00:00.000Z") } });
    // Second clause: same createdAt, smaller id (the tiebreaker)
    expect(or[1]).toHaveProperty("AND");
    const and = (or[1] as { AND: Array<Record<string, unknown>> }).AND;
    expect(and).toHaveLength(2);
    expect(and[0]).toEqual({ createdAt: new Date("2026-05-12T10:00:00.000Z") });
    expect(and[1]).toEqual({ id: { lt: "ct_abc" } });
  });

  it("accepts a custom timestamp field (orders use placedAt, not createdAt)", () => {
    const cursor = { id: "ord_xyz", createdAt: "2026-05-12T10:00:00.000Z" };
    const where = buildCursorWhere(cursor, "placedAt");
    const or = where.OR as Array<Record<string, unknown>>;
    expect(or[0]).toHaveProperty("placedAt");
    const and = (or[1] as { AND: Array<Record<string, unknown>> }).AND;
    expect(and[0]).toHaveProperty("placedAt");
    // The id tiebreaker stays the same regardless of the timestamp field
    expect(and[1]).toEqual({ id: { lt: "ord_xyz" } });
  });
});
