/**
 * KAN-1216b — Product CRUD integration tests.
 *
 * Validates the M4 (soft_delete_archive_only_crud_discipline) doctrine that
 * the product-service module seeds at its header. 7 scenarios per Phase 1
 * C1 trim:
 *
 *   1. create happy path
 *   2. update happy path (delta payload)
 *   3. archive happy path (status + archivedAt)
 *   4. multi-tenant isolation (cross-tenant access denied)
 *   5. archive does NOT cascade to variants (E7 lock + M4 #2)
 *   6. archive idempotency (alreadyArchived=true on second call)
 *   7. archived product cannot be updated (M4 #1 — archive is terminal)
 *
 * Uses `withCleanup` (NOT `withRollback`) because the service module opens
 * its own `prisma.$transaction` internally — per the
 * `integration_test_isolation_pattern_must_match_service_tx_shape` memo,
 * nested $transaction with withRollback's outer rollback triggers
 * Prisma's nested-tx TypeError soft-error.
 *
 * Service module loaded via variable-specifier dynamic import (KAN-689
 * cohort) — same pattern as apps/api/src/router.ts loaders. Direct
 * relative import would trigger TS6059 cross-rootDir error.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { withCleanup, createTenant, getPrisma } from "./setup.js";

// Variable-specifier dynamic loader (KAN-689 cohort) — same pattern as
// apps/api/src/router.ts:7266+ campaignsListModule loader.
interface ProductServiceModule {
  createProduct: (
    prisma: unknown,
    tenantId: string,
    input: unknown,
    actor: string,
    hooks: unknown,
  ) => Promise<{ product: ProductRow; auditLogId: string }>;
  updateProduct: (
    prisma: unknown,
    tenantId: string,
    productId: string,
    input: unknown,
    actor: string,
    hooks: unknown,
  ) => Promise<{ product: ProductRow; auditLogId: string }>;
  archiveProduct: (
    prisma: unknown,
    tenantId: string,
    productId: string,
    actor: string,
    hooks: unknown,
  ) => Promise<{
    product: ProductRow;
    auditLogId: string;
    alreadyArchived: boolean;
  }>;
  ArchivedProductMutationError: new (id: string) => Error;
}

interface ProductRow {
  id: string;
  tenantId: string;
  name: string;
  status: "draft" | "active" | "archived";
  archivedAt: Date | null;
}

let svc: ProductServiceModule;

beforeAll(async () => {
  const spec = "../../../../../packages/api/src/services/product-service.js";
  svc = (await import(spec)) as ProductServiceModule;
});

// Mirror router.ts:7772+ AuditLog hook wiring.
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

async function cleanupTenant(prisma: PrismaClient, tenantId: string): Promise<void> {
  // FK order: ProductVariant → Product → AuditLog → Tenant.
  await (prisma as unknown as { productVariant: { deleteMany: (args: unknown) => Promise<unknown> } })
    .productVariant.deleteMany({ where: { tenantId } });
  await (prisma as unknown as { product: { deleteMany: (args: unknown) => Promise<unknown> } })
    .product.deleteMany({ where: { tenantId } });
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}

describe("KAN-1216b — Product CRUD service", () => {
  it("creates a product + writes AuditLog atomically (create happy path)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;

        const result = await svc.createProduct(
          prisma,
          tenantId,
          { name: "Widget A", price: 19.99, currency: "USD", customFields: {} },
          "operator-1",
          buildTestHooks(),
        );

        expect(result.product.name).toBe("Widget A");
        expect(result.product.status).toBe("draft");
        expect(result.product.archivedAt).toBeNull();
        expect(result.auditLogId).toBeTruthy();

        const audit = await prisma.auditLog.findUnique({
          where: { id: result.auditLogId },
        });
        expect(audit?.actionType).toBe("product.created");
        expect((audit?.payload as { productId: string } | null)?.productId).toBe(result.product.id);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("updates a product + records before/after delta in AuditLog (update happy path)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const created = await svc.createProduct(
          prisma,
          tenantId,
          { name: "Original", price: 10 },
          "op-1",
          buildTestHooks(),
        );
        const productId = created.product.id;

        const result = await svc.updateProduct(
          prisma,
          tenantId,
          productId,
          { name: "Updated", price: 99 },
          "op-2",
          buildTestHooks(),
        );

        expect(result.product.name).toBe("Updated");
        const audit = await prisma.auditLog.findUnique({
          where: { id: result.auditLogId },
        });
        expect(audit?.actionType).toBe("product.updated");
        const payload = audit?.payload as { before: { name: string }; after: { name: string } } | null;
        expect(payload?.before?.name).toBe("Original");
        expect(payload?.after?.name).toBe("Updated");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("archives a product (status='archived' + archivedAt set; archive happy path)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const created = await svc.createProduct(
          prisma,
          tenantId,
          { name: "ToArchive" },
          "op-1",
          buildTestHooks(),
        );
        const productId = created.product.id;

        const result = await svc.archiveProduct(
          prisma,
          tenantId,
          productId,
          "op-1",
          buildTestHooks(),
        );

        expect(result.alreadyArchived).toBe(false);
        expect(result.product.status).toBe("archived");
        expect(result.product.archivedAt).not.toBeNull();
        const audit = await prisma.auditLog.findUnique({
          where: { id: result.auditLogId },
        });
        expect(audit?.actionType).toBe("product.archived");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("rejects cross-tenant update (multi-tenant isolation)", async () => {
    let tenantA = "";
    let tenantB = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const a = await createTenant(prisma);
        const b = await createTenant(prisma);
        tenantA = a.id;
        tenantB = b.id;
        const created = await svc.createProduct(
          prisma,
          tenantA,
          { name: "A-only" },
          "op-a",
          buildTestHooks(),
        );
        const productId = created.product.id;

        // Tenant B tries to update Tenant A's product — must reject as not found.
        await expect(
          svc.updateProduct(
            prisma,
            tenantB,
            productId,
            { name: "Hijacked" },
            "op-b",
            buildTestHooks(),
          ),
        ).rejects.toThrow(/not found/i);
      },
      async (prisma: PrismaClient) => {
        await cleanupTenant(prisma, tenantA);
        await cleanupTenant(prisma, tenantB);
      },
    );
  });

  it("archive does NOT cascade to variants (M4 #2 + E7 lock)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const created = await svc.createProduct(
          prisma,
          tenantId,
          { name: "Parent" },
          "op-1",
          buildTestHooks(),
        );
        const productId = created.product.id;

        // Create a sibling variant.
        const variant = await (prisma as unknown as {
          productVariant: { create: (args: unknown) => Promise<{ id: string; productId: string }> };
        }).productVariant.create({
          data: {
            tenantId,
            productId,
            attributes: { size: "M" },
            attributesHash: "test-hash-001",
          },
        });

        // Archive parent — variant must remain live (no cascade).
        await svc.archiveProduct(
          prisma,
          tenantId,
          productId,
          "op-1",
          buildTestHooks(),
        );

        const reread = await (prisma as unknown as {
          productVariant: {
            findUnique: (args: unknown) => Promise<{ id: string; productId: string } | null>;
          };
        }).productVariant.findUnique({
          where: { id: variant.id },
        });
        expect(reread).not.toBeNull();
        expect(reread?.productId).toBe(productId);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("re-archive is idempotent (alreadyArchived=true on second call)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const created = await svc.createProduct(
          prisma,
          tenantId,
          { name: "ArchiveTwice" },
          "op-1",
          buildTestHooks(),
        );
        const productId = created.product.id;

        const first = await svc.archiveProduct(
          prisma,
          tenantId,
          productId,
          "op-1",
          buildTestHooks(),
        );
        const second = await svc.archiveProduct(
          prisma,
          tenantId,
          productId,
          "op-1",
          buildTestHooks(),
        );

        expect(first.alreadyArchived).toBe(false);
        expect(second.alreadyArchived).toBe(true);
        expect(second.auditLogId).toBe(""); // no duplicate audit row
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("archived product cannot be updated (M4 #1 — archive is terminal)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const created = await svc.createProduct(
          prisma,
          tenantId,
          { name: "Doomed" },
          "op-1",
          buildTestHooks(),
        );
        const productId = created.product.id;

        await svc.archiveProduct(prisma, tenantId, productId, "op-1", buildTestHooks());

        await expect(
          svc.updateProduct(
            prisma,
            tenantId,
            productId,
            { name: "Resurrected" },
            "op-1",
            buildTestHooks(),
          ),
        ).rejects.toThrow(svc.ArchivedProductMutationError);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });
});
