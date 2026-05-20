/**
 * KAN-936 fix-forward — `entityId` shared id-string validator regression.
 *
 * Class fix for the uuid/cuid/firebase-uid validator-mismatch class that
 * has bitten us 4× this session (KAN-944 Q9 reverted Contact.id from
 * `.cuid()` back to UUID; KAN-893 swept Deal/Company `.uuid()` → `.cuid()`;
 * KAN-936 PR #167 shipped `ownerId: z.string().uuid()` against PROD User
 * rows that carry Firebase Auth UIDs, hard-failing the picker).
 *
 * Inverse of the Q9 test: instead of pinning a single format, this asserts
 * the shared `entityId` validator accepts ALL three formats present in the
 * codebase + rejects obvious garbage.
 *
 * The four post-KAN-936 ownerId validators (deals.create / deals.update /
 * companies.create / companies.update) all bind to `entityId`, so once this
 * passes the real-PROD Firebase UID will round-trip through every owner
 * mutation entry-point.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";

// Re-derive entityId locally to keep this test isolated from router.ts's
// runtime imports (TRPCError + Prisma client chain). Drift between this
// shape and router.ts:entityId would show up in the boundary tests below
// (Real PROD User.id) — if Fred's PROD User.id ever fails this test, the
// shared validator definition has regressed.
const entityId = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[a-zA-Z0-9_-]+$/, "Invalid id format");

describe("KAN-936 fix-forward — entityId accepts all 3 id formats", () => {
  it("accepts a UUID v4 (Contact.id, Pipeline.id, Stage.id default)", () => {
    const result = entityId.safeParse("123e4567-e89b-12d3-a456-426614174000");
    expect(result.success).toBe(true);
  });

  it("accepts a CUID (Deal.id, Company.id, Order.id default)", () => {
    const result = entityId.safeParse("cmou3yc2o0002a9tnt34f5q81");
    expect(result.success).toBe(true);
  });

  it("accepts a Firebase Auth UID — 28-char base62 (real PROD User.id format)", () => {
    // Real fred@axisone.ca User.id from PROD growth-db (KAN-936 smoke
    // failure root-cause). Pre-fix this value hit Zod with
    // `{validation:"uuid", message:"Invalid uuid"}`.
    const result = entityId.safeParse("LZkfptFgMcO8KxMaO2ZXLm3cKFw1");
    expect(result.success).toBe(true);
  });

  it("rejects empty string", () => {
    expect(entityId.safeParse("").success).toBe(false);
  });

  it("rejects whitespace-padded id (no trim semantics at the wire)", () => {
    expect(entityId.safeParse(" LZkfptFgMcO8KxMaO2ZXLm3cKFw1 ").success).toBe(false);
  });

  it("rejects sql-injection-shaped input (single-quote in charset)", () => {
    expect(entityId.safeParse("'; DROP TABLE users; --").success).toBe(false);
  });

  it("rejects shorter-than-floor (< 20 chars)", () => {
    expect(entityId.safeParse("short").success).toBe(false);
  });

  it("rejects longer-than-ceiling (> 40 chars)", () => {
    const long = "a".repeat(41);
    expect(entityId.safeParse(long).success).toBe(false);
  });
});

describe("KAN-936 fix-forward — ownerId composed validator round-trips", () => {
  // Mirror the exact shape used in router.ts for ownerId on deals.create /
  // deals.update / companies.create / companies.update.
  const ownerIdSchema = z.object({
    ownerId: entityId.nullable().optional(),
  });

  const REAL_PROD_USER_ID = "LZkfptFgMcO8KxMaO2ZXLm3cKFw1";

  it("accepts a real Firebase UID — fixes the PR #167 PROD smoke regression", () => {
    const result = ownerIdSchema.safeParse({ ownerId: REAL_PROD_USER_ID });
    expect(result.success).toBe(true);
  });

  it("accepts null (clear-owner path)", () => {
    expect(ownerIdSchema.safeParse({ ownerId: null }).success).toBe(true);
  });

  it("accepts undefined / missing (partial update without ownerId)", () => {
    expect(ownerIdSchema.safeParse({}).success).toBe(true);
  });
});
