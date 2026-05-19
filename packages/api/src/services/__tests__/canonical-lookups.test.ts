/**
 * KAN-932 — canonical-lookups.ts smoke tests.
 *
 * The 5 lifted resolvers are deeply covered by:
 *   - import-commit.test.ts (KAN-921 multi-value + KAN-930 cache paths)
 *   - kan-922-configurable-matching.test.ts (KAN-922 happy path)
 *
 * This file's job is the lift-itself smoke: confirm that importing from
 * canonical-lookups.ts works for both direct callers (manual-form code
 * paths to come in Sub-cohort 3.1+) AND for the re-export shim in
 * import-commit.ts (the 7+ existing internal callers continue working).
 *
 * Pure refactor regression check, not behavior verification.
 */
import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  resolveContactByMatchKey,
  resolveContactByEmail,
  resolveDealByMatchKey,
  resolvePipelineByName,
  resolveStageByName,
  resolveCompanyByName,
} from "../canonical-lookups.js";
import * as ImportCommit from "../import-commit.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";

describe("KAN-932 — canonical-lookups lift", () => {
  describe("direct imports work", () => {
    it("resolveContactByMatchKey is callable", async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: "c1" });
      const prisma = { contact: { findFirst } } as unknown as PrismaClient;
      const result = await resolveContactByMatchKey(prisma, TENANT_A, {
        kind: "email",
        value: "test@test.com",
      });
      expect(result).toEqual({ id: "c1" });
    });

    it("resolveContactByEmail wrapper still works", async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: "c2" });
      const prisma = { contact: { findFirst } } as unknown as PrismaClient;
      const result = await resolveContactByEmail(prisma, TENANT_A, "test@test.com");
      expect(result).toEqual({ id: "c2" });
    });

    it("resolveDealByMatchKey is callable", async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: "d1" });
      const prisma = { deal: { findFirst } } as unknown as PrismaClient;
      const result = await resolveDealByMatchKey(prisma, TENANT_A, {
        kind: "external_id",
        source: "hubspot",
        value: "VID_A",
      });
      expect(result).toEqual({ id: "d1" });
    });

    it("resolvePipelineByName is callable", async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: "p1" });
      const prisma = { pipeline: { findFirst } } as unknown as PrismaClient;
      const result = await resolvePipelineByName(prisma, TENANT_A, "Sales");
      expect(result).toEqual({ id: "p1" });
    });

    it("resolveStageByName is callable", async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: "s1" });
      const prisma = { stage: { findFirst } } as unknown as PrismaClient;
      const result = await resolveStageByName(prisma, "p1", "Discovery");
      expect(result).toEqual({ id: "s1" });
    });

    it("resolveCompanyByName is callable (now exported, was private)", async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: "co1" });
      const prisma = { company: { findFirst } } as unknown as PrismaClient;
      const result = await resolveCompanyByName(prisma, TENANT_A, "Acme Corp");
      expect(result).toEqual({ id: "co1" });
    });
  });

  describe("re-exports from import-commit still work (backwards compat)", () => {
    it("ImportCommit.resolveContactByMatchKey === canonical-lookups version", () => {
      expect(ImportCommit.resolveContactByMatchKey).toBe(resolveContactByMatchKey);
    });

    it("ImportCommit.resolveContactByEmail === canonical-lookups version", () => {
      expect(ImportCommit.resolveContactByEmail).toBe(resolveContactByEmail);
    });

    it("ImportCommit.resolveDealByMatchKey === canonical-lookups version", () => {
      expect(ImportCommit.resolveDealByMatchKey).toBe(resolveDealByMatchKey);
    });

    it("ImportCommit.resolvePipelineByName === canonical-lookups version", () => {
      expect(ImportCommit.resolvePipelineByName).toBe(resolvePipelineByName);
    });

    it("ImportCommit.resolveStageByName === canonical-lookups version", () => {
      expect(ImportCommit.resolveStageByName).toBe(resolveStageByName);
    });
  });
});
