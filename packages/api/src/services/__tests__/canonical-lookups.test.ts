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
  assertCompanyInTenant,
  assertContactInTenant,
  assertPipelineInTenant,
  assertStageInPipeline,
  assertDealInTenant,
  toDate,
} from "../canonical-lookups.js";
import * as ImportCommit from "../import-commit.js";
import * as ContactsRouter from "../contacts-router.js";
import * as DealsRouter from "../deals-router.js";

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

// ─────────────────────────────────────────────────────────────────────
// KAN-938 — FK validation assertions: lift identity + 3 new helpers.
//
// `assertCompanyInTenant` was lifted from contacts-router.ts in KAN-938;
// identity check pins the re-export shim. 3 new helpers (Contact, Pipeline,
// Stage-in-Pipeline) cover the FK surface for Sub-cohort 3.3 Deal CRUD.
// ─────────────────────────────────────────────────────────────────────
describe("KAN-938 — FK validation assertions", () => {
  describe("assertCompanyInTenant lift (identity check)", () => {
    it("ContactsRouter.assertCompanyInTenant === canonical-lookups version", () => {
      expect(ContactsRouter.assertCompanyInTenant).toBe(assertCompanyInTenant);
    });

    it("returns silently for null companyId (optional FK)", async () => {
      const findFirst = vi.fn();
      const prisma = { company: { findFirst } } as unknown as PrismaClient;
      await expect(
        assertCompanyInTenant(prisma, TENANT_A, null),
      ).resolves.toBeUndefined();
      expect(findFirst).not.toHaveBeenCalled();
    });

    it("throws BAD_REQUEST when company is in a different tenant", async () => {
      const findFirst = vi.fn().mockResolvedValue(null);
      const prisma = { company: { findFirst } } as unknown as PrismaClient;
      await expect(
        assertCompanyInTenant(prisma, TENANT_A, "co_other_tenant"),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  describe("assertContactInTenant", () => {
    it("returns silently for null contactId", async () => {
      const findFirst = vi.fn();
      const prisma = { contact: { findFirst } } as unknown as PrismaClient;
      await expect(
        assertContactInTenant(prisma, TENANT_A, null),
      ).resolves.toBeUndefined();
      expect(findFirst).not.toHaveBeenCalled();
    });

    it("returns silently when contact exists in tenant", async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: "c_1" });
      const prisma = { contact: { findFirst } } as unknown as PrismaClient;
      await expect(
        assertContactInTenant(prisma, TENANT_A, "c_1"),
      ).resolves.toBeUndefined();
    });

    it("throws BAD_REQUEST when contact is in a different tenant", async () => {
      const findFirst = vi.fn().mockResolvedValue(null);
      const prisma = { contact: { findFirst } } as unknown as PrismaClient;
      await expect(
        assertContactInTenant(prisma, TENANT_A, "c_other"),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringMatching(/contact not found/i),
      });
    });
  });

  describe("assertPipelineInTenant", () => {
    it("returns silently for null pipelineId", async () => {
      const findFirst = vi.fn();
      const prisma = { pipeline: { findFirst } } as unknown as PrismaClient;
      await expect(
        assertPipelineInTenant(prisma, TENANT_A, null),
      ).resolves.toBeUndefined();
      expect(findFirst).not.toHaveBeenCalled();
    });

    it("returns silently when pipeline exists in tenant", async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: "p_1" });
      const prisma = { pipeline: { findFirst } } as unknown as PrismaClient;
      await expect(
        assertPipelineInTenant(prisma, TENANT_A, "p_1"),
      ).resolves.toBeUndefined();
    });

    it("throws BAD_REQUEST when pipeline is in a different tenant", async () => {
      const findFirst = vi.fn().mockResolvedValue(null);
      const prisma = { pipeline: { findFirst } } as unknown as PrismaClient;
      await expect(
        assertPipelineInTenant(prisma, TENANT_A, "p_other"),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringMatching(/pipeline not found/i),
      });
    });
  });

  describe("assertStageInPipeline (self-contained tenant-isolation guard)", () => {
    it("returns silently when either pipelineId or stageId is null", async () => {
      const findFirst = vi.fn();
      const prisma = { stage: { findFirst } } as unknown as PrismaClient;
      await expect(
        assertStageInPipeline(prisma, TENANT_A, null, "s_1"),
      ).resolves.toBeUndefined();
      await expect(
        assertStageInPipeline(prisma, TENANT_A, "p_1", null),
      ).resolves.toBeUndefined();
      expect(findFirst).not.toHaveBeenCalled();
    });

    it("returns silently when stage belongs to pipeline AND pipeline is in tenant", async () => {
      const findFirst = vi.fn().mockResolvedValue({ id: "s_1" });
      const prisma = { stage: { findFirst } } as unknown as PrismaClient;
      await expect(
        assertStageInPipeline(prisma, TENANT_A, "p_1", "s_1"),
      ).resolves.toBeUndefined();
      // Query MUST join through pipeline → tenantId for self-contained
      // defense-in-depth (caller may have skipped assertPipelineInTenant).
      expect(findFirst).toHaveBeenCalledWith({
        where: { id: "s_1", pipeline: { id: "p_1", tenantId: TENANT_A } },
        select: { id: true },
      });
    });

    it("throws BAD_REQUEST when stage does not belong to the pipeline", async () => {
      const findFirst = vi.fn().mockResolvedValue(null);
      const prisma = { stage: { findFirst } } as unknown as PrismaClient;
      await expect(
        assertStageInPipeline(prisma, TENANT_A, "p_1", "s_from_other_pipeline"),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringMatching(/stage does not belong/i),
      });
    });

    // Defense-in-depth: stage belongs to the right pipeline, but the pipeline
    // is in a different tenant. The helper must reject EVEN IF the caller
    // skipped assertPipelineInTenant (which is what currently sequences
    // tenant validation in createDeal/updateDeal). This pins the
    // join-through-tenant invariant.
    it("throws BAD_REQUEST when stage's pipeline is in a different tenant", async () => {
      // The relational where clause `pipeline: { id, tenantId }` returns null
      // because no Stage matches a Pipeline that's both in `p_cross_tenant`
      // AND in TENANT_A. Real Prisma would join; the mock just returns null.
      const findFirst = vi.fn().mockResolvedValue(null);
      const prisma = { stage: { findFirst } } as unknown as PrismaClient;
      await expect(
        assertStageInPipeline(prisma, TENANT_A, "p_cross_tenant", "s_1"),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringMatching(/stage does not belong/i),
      });
      // The defense-in-depth check is in the query shape itself.
      expect(findFirst).toHaveBeenCalledWith({
        where: { id: "s_1", pipeline: { id: "p_cross_tenant", tenantId: TENANT_A } },
        select: { id: true },
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// KAN-945 — assertDealInTenant + toDate lift.
//
// `toDate` was lifted from deals-router.ts in KAN-945; identity check
// pins the re-export shim. `assertDealInTenant` is a NEW helper for
// Order.dealId optional-FK validation (Sub-cohort 3.4).
// ─────────────────────────────────────────────────────────────────────
describe("KAN-945 — assertDealInTenant", () => {
  it("returns silently for null dealId (optional FK)", async () => {
    const findFirst = vi.fn();
    const prisma = { deal: { findFirst } } as unknown as PrismaClient;
    await expect(
      assertDealInTenant(prisma, TENANT_A, null),
    ).resolves.toBeUndefined();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns silently when deal exists in tenant", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "dl_1" });
    const prisma = { deal: { findFirst } } as unknown as PrismaClient;
    await expect(
      assertDealInTenant(prisma, TENANT_A, "dl_1"),
    ).resolves.toBeUndefined();
  });

  it("throws BAD_REQUEST when deal is in a different tenant", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { deal: { findFirst } } as unknown as PrismaClient;
    await expect(
      assertDealInTenant(prisma, TENANT_A, "dl_other"),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/deal not found/i),
    });
  });
});

describe("KAN-945 — toDate lift", () => {
  it("DealsRouter.toDate === canonical-lookups version (identity check)", () => {
    expect(DealsRouter.toDate).toBe(toDate);
  });

  it("coerces yyyy-mm-dd string to UTC-midnight Date", () => {
    const result = toDate("2026-09-30");
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe("2026-09-30T00:00:00.000Z");
  });

  it("returns null for null / undefined / empty-string", () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate("")).toBeNull();
  });

  it("preserves full ISO-8601 DateTime if caller passes one", () => {
    const result = toDate("2026-05-20T19:30:00.000Z");
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe("2026-05-20T19:30:00.000Z");
  });
});
