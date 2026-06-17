/**
 * KAN-1216c — ProductVariant CRUD integration tests.
 *
 * Validates M1 (content-hash dedup) + M2 (price inheritance) doctrine seeded
 * at product-variant-service.ts module header. 7 scenarios per Phase 1 C1
 * trim (variant-archive dropped per F8 — variant lifecycle owned by parent):
 *
 *   1. create happy path (hash computed + AuditLog written)
 *   2. update happy path (delta payload)
 *   3. dedup idempotent-return (Path α — second create returns existing + isDedup=true)
 *   4. price inheritance: variant.price=null → product.price (M2)
 *   5. price inheritance: variant.price=49 + product.price=99 → 49 (override)
 *   6. parent archive does NOT destroy variant (M4 lock #2 sibling extension)
 *   7. multi-tenant isolation (cross-tenant create rejected as parent-not-found)
 *
 * Uses `withCleanup` (NOT `withRollback`) per
 * `integration_test_isolation_pattern_must_match_service_tx_shape` memo —
 * service module opens its own $transaction internally.
 *
 * Service loaded via variable-specifier dynamic import (KAN-689 cohort).
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { withCleanup, createTenant, getPrisma } from "./setup.js";

interface ProductVariantServiceModule {
  createVariant: (
    prisma: unknown,
    tenantId: string,
    input: unknown,
    actor: string,
    hooks: unknown,
  ) => Promise<{ variant: VariantRow; auditLogId: string; isDedup: boolean }>;
  updateVariant: (
    prisma: unknown,
    tenantId: string,
    variantId: string,
    input: unknown,
    actor: string,
    hooks: unknown,
  ) => Promise<{ variant: VariantRow; auditLogId: string }>;
  resolveEffectivePrice: (
    variant: { price: number | null },
    product: { price: number | null },
  ) => number | null;
  computeAttributesHash: (attributes: Record<string, unknown>) => string;
  ProductForVariantNotFoundError: new (id: string) => Error;
}

interface VariantRow {
  id: string;
  tenantId: string;
  productId: string;
  attributes: Record<string, unknown>;
  attributesHash: string | null;
  price: number | null;
}

let svc: ProductVariantServiceModule;

beforeAll(async () => {
  const spec = "../../../../../packages/api/src/services/product-variant-service.js";
  svc = (await import(spec)) as ProductVariantServiceModule;
});

function buildTestHooks() {
  return {
    auditLog: {
      writeInTx: async (
        tx: unknown,
        payload: {
          tenantId: string;
          actor: string;
          actionType: string;
          payload: Record<string, unknown>;
          reasoning: string;
        },
      ): Promise<{ id: string }> =>
        (tx as { auditLog: { create: (args: unknown) => Promise<{ id: string }> } }).auditLog.create({
          data: {
            tenantId: payload.tenantId,
            actor: payload.actor,
            actionType: payload.actionType,
            payload: payload.payload,
            reasoning: payload.reasoning,
          },
        }),
    },
  };
}

async function createTestProduct(
  prisma: PrismaClient,
  tenantId: string,
  price: number | null = null,
): Promise<{ id: string }> {
  return (prisma as unknown as {
    product: {
      create: (args: unknown) => Promise<{ id: string }>;
    };
  }).product.create({
    data: {
      tenantId,
      name: `Test Product ${Date.now()}-${Math.random()}`,
      price,
      currency: "USD",
    },
  });
}

async function cleanupTenant(prisma: PrismaClient, tenantId: string): Promise<void> {
  await (prisma as unknown as { productVariant: { deleteMany: (args: unknown) => Promise<unknown> } })
    .productVariant.deleteMany({ where: { tenantId } });
  await (prisma as unknown as { product: { deleteMany: (args: unknown) => Promise<unknown> } })
    .product.deleteMany({ where: { tenantId } });
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}

describe("KAN-1216c — ProductVariant CRUD service", () => {
  it("creates a variant + writes AuditLog atomically (create happy path)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const product = await createTestProduct(prisma, tenantId, 99.99);

        const result = await svc.createVariant(
          prisma,
          tenantId,
          { productId: product.id, attributes: { size: "M", color: "red" }, price: 49.99 },
          "operator-1",
          buildTestHooks(),
        );

        expect(result.isDedup).toBe(false);
        expect(result.variant.productId).toBe(product.id);
        expect(result.variant.attributesHash).toMatch(/^[0-9a-f]{16}$/); // M1: 16 hex chars
        // Prisma returns Decimal objects for Decimal(12,2) columns; coerce to
        // number for value comparison. Same pattern as KAN-1192 fixture handling.
        expect(Number(result.variant.price)).toBe(49.99);
        const audit = await prisma.auditLog.findUnique({
          where: { id: result.auditLogId },
        });
        expect(audit?.actionType).toBe("product_variant.created");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("updates a variant attributes + recomputes hash (update happy path)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const product = await createTestProduct(prisma, tenantId, 99);
        const created = await svc.createVariant(
          prisma,
          tenantId,
          { productId: product.id, attributes: { size: "M" } },
          "op-1",
          buildTestHooks(),
        );
        const originalHash = created.variant.attributesHash;

        const result = await svc.updateVariant(
          prisma,
          tenantId,
          created.variant.id,
          { attributes: { size: "L" }, price: 59 },
          "op-2",
          buildTestHooks(),
        );

        expect(Number(result.variant.price)).toBe(59); // Prisma Decimal coercion
        expect(result.variant.attributesHash).not.toBe(originalHash);
        const audit = await prisma.auditLog.findUnique({
          where: { id: result.auditLogId },
        });
        expect(audit?.actionType).toBe("product_variant.updated");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("dedup Path α: second create with identical attributes returns existing + isDedup=true (M1)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const product = await createTestProduct(prisma, tenantId, 99);

        const first = await svc.createVariant(
          prisma,
          tenantId,
          { productId: product.id, attributes: { size: "M", color: "red" } },
          "op-1",
          buildTestHooks(),
        );
        const second = await svc.createVariant(
          prisma,
          tenantId,
          { productId: product.id, attributes: { size: "M", color: "red" } },
          "op-1",
          buildTestHooks(),
        );

        expect(first.isDedup).toBe(false);
        expect(second.isDedup).toBe(true);
        expect(second.variant.id).toBe(first.variant.id);
        expect(second.auditLogId).toBe(""); // no duplicate audit row

        // Verify only ONE audit row written.
        const audits = await prisma.auditLog.findMany({
          where: { tenantId, actionType: "product_variant.created" },
        });
        expect(audits.length).toBe(1);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("M2 price inheritance: variant.price=null + product.price=99 → 99 (inherit)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const product = await createTestProduct(prisma, tenantId, 99);
        const created = await svc.createVariant(
          prisma,
          tenantId,
          { productId: product.id, attributes: { size: "M" }, price: null },
          "op-1",
          buildTestHooks(),
        );

        expect(created.variant.price).toBeNull();

        const resolved = svc.resolveEffectivePrice(
          { price: created.variant.price },
          { price: 99 },
        );
        expect(resolved).toBe(99);

        // Edge: both null → null (terminal; never coalesce to 0)
        const terminalResolved = svc.resolveEffectivePrice(
          { price: null },
          { price: null },
        );
        expect(terminalResolved).toBeNull();
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("M2 price inheritance: variant.price=49 + product.price=99 → 49 (override)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const product = await createTestProduct(prisma, tenantId, 99);
        const created = await svc.createVariant(
          prisma,
          tenantId,
          { productId: product.id, attributes: { size: "L" }, price: 49 },
          "op-1",
          buildTestHooks(),
        );

        expect(Number(created.variant.price)).toBe(49); // Prisma Decimal coercion

        const resolved = svc.resolveEffectivePrice(
          { price: created.variant.price as unknown as number | null },
          { price: 99 },
        );
        // Resolver passes Decimal through unchanged when present; coerce result.
        expect(Number(resolved)).toBe(49);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("parent archive does NOT destroy variant (M4 lock #2 extension)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const product = await createTestProduct(prisma, tenantId);
        const created = await svc.createVariant(
          prisma,
          tenantId,
          { productId: product.id, attributes: { size: "M" } },
          "op-1",
          buildTestHooks(),
        );

        // Soft-archive the parent product (status='archived'; archivedAt set).
        await (prisma as unknown as {
          product: { update: (args: unknown) => Promise<unknown> };
        }).product.update({
          where: { id: product.id },
          data: { status: "archived", archivedAt: new Date() },
        });

        // Variant survives — FK Cascade only fires on hard DELETE, not status change.
        const reread = await (prisma as unknown as {
          productVariant: {
            findUnique: (args: unknown) => Promise<{ id: string; productId: string } | null>;
          };
        }).productVariant.findUnique({
          where: { id: created.variant.id },
        });
        expect(reread).not.toBeNull();
        expect(reread?.productId).toBe(product.id);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("rejects cross-tenant create (multi-tenant isolation via parent-not-found)", async () => {
    let tenantA = "";
    let tenantB = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const a = await createTenant(prisma);
        const b = await createTenant(prisma);
        tenantA = a.id;
        tenantB = b.id;
        const productA = await createTestProduct(prisma, tenantA);

        // Tenant B tries to create a variant under Tenant A's product → reject.
        await expect(
          svc.createVariant(
            prisma,
            tenantB,
            { productId: productA.id, attributes: { size: "M" } },
            "op-b",
            buildTestHooks(),
          ),
        ).rejects.toThrow(svc.ProductForVariantNotFoundError);
      },
      async (prisma: PrismaClient) => {
        await cleanupTenant(prisma, tenantA);
        await cleanupTenant(prisma, tenantB);
      },
    );
  });
});
