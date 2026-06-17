/**
 * KAN-1216d — ProductCategory CRUD integration tests.
 *
 * Validates M3 (recursive_tree_depth_guard_service_pattern) doctrine seeded
 * at product-category-service.ts module header — paired depth-guard +
 * cycle-prevention on parentId mutation. 9 scenarios per Phase 1 lock:
 *
 *   1. create root category happy path (AuditLog written)
 *   2. update category attributes happy path (delta payload)
 *   3. archive sets status='archived' + archivedAt + AuditLog
 *   4. MAX_CATEGORY_DEPTH=5 — creating depth=6 throws CategoryDepthLimitExceededError
 *   5. cycle on parentId mutation — moving A under its descendant throws CategoryCycleDetectedError
 *   6. archive children stay live with original parentId (M4 archive-terminal extension)
 *   7. multi-root sibling uniqueness — two roots with same name ALLOWED (Memo 45 NULL semantic)
 *   8. same-parent sibling uniqueness — duplicate name under same parent throws CategoryAlreadyExistsError (P2002 wrap)
 *   9. cross-tenant create rejected (multi-tenant isolation via parent-not-found)
 *
 * Uses `withCleanup` (NOT `withRollback`) per
 * `integration_test_isolation_pattern_must_match_service_tx_shape` memo —
 * service module opens its own $transaction internally.
 *
 * Service loaded via variable-specifier dynamic import (KAN-689 cohort).
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { withCleanup, createTenant } from "./setup.js";

interface CategoryRow {
  id: string;
  tenantId: string;
  parentId: string | null;
  name: string;
  description: string | null;
  status: string;
  archivedAt: Date | null;
}

interface ProductCategoryServiceModule {
  MAX_CATEGORY_DEPTH: number;
  createCategory: (
    prisma: unknown,
    tenantId: string,
    input: unknown,
    actor: string,
    hooks: unknown,
  ) => Promise<{ category: CategoryRow; auditLogId: string }>;
  updateCategory: (
    prisma: unknown,
    tenantId: string,
    categoryId: string,
    input: unknown,
    actor: string,
    hooks: unknown,
  ) => Promise<{ category: CategoryRow; auditLogId: string }>;
  archiveCategory: (
    prisma: unknown,
    tenantId: string,
    categoryId: string,
    actor: string,
    hooks: unknown,
  ) => Promise<{
    category: CategoryRow;
    auditLogId: string;
    alreadyArchived: boolean;
  }>;
  CategoryNotFoundError: new (id: string) => Error;
  ParentCategoryNotFoundError: new (id: string) => Error;
  CategoryDepthLimitExceededError: new (
    attempted: number,
    max: number,
  ) => Error;
  CategoryCycleDetectedError: new (
    targetId: string,
    attemptedParentId: string,
  ) => Error;
  ArchivedCategoryMutationError: new (id: string) => Error;
  CategoryAlreadyExistsError: new (
    tenantId: string,
    name: string,
    parentId: string | null,
  ) => Error;
}

let svc: ProductCategoryServiceModule;

beforeAll(async () => {
  const spec =
    "../../../../../packages/api/src/services/product-category-service.js";
  svc = (await import(spec)) as ProductCategoryServiceModule;
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
        (
          tx as {
            auditLog: {
              create: (args: unknown) => Promise<{ id: string }>;
            };
          }
        ).auditLog.create({
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

/**
 * Cleanup ProductCategory rows in FK-safe order. Because the schema's
 * self-FK uses `onDelete: SetNull` (NOT Cascade or Restrict), a flat
 * `deleteMany({ where: { tenantId } })` is safe — Postgres re-targets any
 * orphaned parentId references to NULL transparently during the bulk
 * delete. Then audit_log + tenant in canonical order.
 */
async function cleanupTenant(
  prisma: PrismaClient,
  tenantId: string,
): Promise<void> {
  await (
    prisma as unknown as {
      productCategory: { deleteMany: (args: unknown) => Promise<unknown> };
    }
  ).productCategory.deleteMany({ where: { tenantId } });
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}

describe("KAN-1216d — ProductCategory CRUD service", () => {
  it("creates a root category + writes AuditLog atomically (create happy path)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;

        const result = await svc.createCategory(
          prisma,
          tenantId,
          { name: "Electronics", parentId: null },
          "operator-1",
          buildTestHooks(),
        );

        expect(result.category.parentId).toBeNull();
        expect(result.category.name).toBe("Electronics");
        expect(result.category.status).toBe("active");
        const audit = await prisma.auditLog.findUnique({
          where: { id: result.auditLogId },
        });
        expect(audit?.actionType).toBe("product_category.created");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("updates category attributes + writes AuditLog (update happy path)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const created = await svc.createCategory(
          prisma,
          tenantId,
          { name: "Toys", parentId: null },
          "op-1",
          buildTestHooks(),
        );

        const result = await svc.updateCategory(
          prisma,
          tenantId,
          created.category.id,
          { name: "Games", description: "Updated taxonomy node" },
          "op-2",
          buildTestHooks(),
        );

        expect(result.category.name).toBe("Games");
        expect(result.category.description).toBe("Updated taxonomy node");
        const audit = await prisma.auditLog.findUnique({
          where: { id: result.auditLogId },
        });
        expect(audit?.actionType).toBe("product_category.updated");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("archive sets status='archived' + archivedAt + writes AuditLog (archive happy path)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const created = await svc.createCategory(
          prisma,
          tenantId,
          { name: "Deprecated", parentId: null },
          "op-1",
          buildTestHooks(),
        );

        const result = await svc.archiveCategory(
          prisma,
          tenantId,
          created.category.id,
          "op-2",
          buildTestHooks(),
        );

        expect(result.alreadyArchived).toBe(false);
        expect(result.category.status).toBe("archived");
        expect(result.category.archivedAt).not.toBeNull();
        const audit = await prisma.auditLog.findUnique({
          where: { id: result.auditLogId },
        });
        expect(audit?.actionType).toBe("product_category.archived");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("enforces MAX_CATEGORY_DEPTH=5 — creating depth=6 throws CategoryDepthLimitExceededError", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;

        // Build chain root (depth 0) → 1 → 2 → 3 → 4 → 5 (max).
        let currentParentId: string | null = null;
        let lastId = "";
        for (let depth = 0; depth <= svc.MAX_CATEGORY_DEPTH; depth += 1) {
          const r = await svc.createCategory(
            prisma,
            tenantId,
            { name: `Level-${depth}`, parentId: currentParentId },
            "op-1",
            buildTestHooks(),
          );
          currentParentId = r.category.id;
          lastId = r.category.id;
        }

        // Attempt depth=6 under the depth=5 leaf → must reject.
        await expect(
          svc.createCategory(
            prisma,
            tenantId,
            { name: "Level-6-overdepth", parentId: lastId },
            "op-1",
            buildTestHooks(),
          ),
        ).rejects.toThrow(svc.CategoryDepthLimitExceededError);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("prevents cycle on parentId mutation — moving A under its descendant throws CategoryCycleDetectedError", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;

        // Build chain A → B → C.
        const a = await svc.createCategory(
          prisma,
          tenantId,
          { name: "A", parentId: null },
          "op-1",
          buildTestHooks(),
        );
        const b = await svc.createCategory(
          prisma,
          tenantId,
          { name: "B", parentId: a.category.id },
          "op-1",
          buildTestHooks(),
        );
        const c = await svc.createCategory(
          prisma,
          tenantId,
          { name: "C", parentId: b.category.id },
          "op-1",
          buildTestHooks(),
        );

        // Attempt: A.parentId = C (transitive cycle — C is descendant of A).
        await expect(
          svc.updateCategory(
            prisma,
            tenantId,
            a.category.id,
            { parentId: c.category.id },
            "op-1",
            buildTestHooks(),
          ),
        ).rejects.toThrow(svc.CategoryCycleDetectedError);

        // Self-cycle: A.parentId = A.
        await expect(
          svc.updateCategory(
            prisma,
            tenantId,
            a.category.id,
            { parentId: a.category.id },
            "op-1",
            buildTestHooks(),
          ),
        ).rejects.toThrow(svc.CategoryCycleDetectedError);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("archive children stay live with original parentId (M4 archive-terminal extension; FK SetNull only fires on hard DELETE)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;

        const parent = await svc.createCategory(
          prisma,
          tenantId,
          { name: "Parent", parentId: null },
          "op-1",
          buildTestHooks(),
        );
        const child = await svc.createCategory(
          prisma,
          tenantId,
          { name: "Child", parentId: parent.category.id },
          "op-1",
          buildTestHooks(),
        );

        await svc.archiveCategory(
          prisma,
          tenantId,
          parent.category.id,
          "op-1",
          buildTestHooks(),
        );

        // Child survives — FK SetNull only fires on hard DELETE.
        const reread = await (
          prisma as unknown as {
            productCategory: {
              findUnique: (args: unknown) => Promise<{
                id: string;
                parentId: string | null;
                status: string;
              } | null>;
            };
          }
        ).productCategory.findUnique({
          where: { id: child.category.id },
        });
        expect(reread).not.toBeNull();
        expect(reread?.parentId).toBe(parent.category.id);
        expect(reread?.status).toBe("active");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("multi-root sibling uniqueness — two roots with same name ALLOWED (Memo 45 NULL semantic)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;

        const first = await svc.createCategory(
          prisma,
          tenantId,
          { name: "Imports", parentId: null },
          "op-1",
          buildTestHooks(),
        );
        const second = await svc.createCategory(
          prisma,
          tenantId,
          { name: "Imports", parentId: null },
          "op-1",
          buildTestHooks(),
        );

        // Both root rows succeed — Postgres treats NULL parentId as distinct.
        expect(first.category.id).not.toBe(second.category.id);
        expect(first.category.name).toBe("Imports");
        expect(second.category.name).toBe("Imports");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("same-parent sibling uniqueness — duplicate name under same parent throws CategoryAlreadyExistsError (P2002 wrap)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;

        const parent = await svc.createCategory(
          prisma,
          tenantId,
          { name: "Parent", parentId: null },
          "op-1",
          buildTestHooks(),
        );

        await svc.createCategory(
          prisma,
          tenantId,
          { name: "Dup", parentId: parent.category.id },
          "op-1",
          buildTestHooks(),
        );

        // Second sibling with same name under same parent → P2002 → typed error.
        await expect(
          svc.createCategory(
            prisma,
            tenantId,
            { name: "Dup", parentId: parent.category.id },
            "op-1",
            buildTestHooks(),
          ),
        ).rejects.toThrow(svc.CategoryAlreadyExistsError);
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

        const parentInA = await svc.createCategory(
          prisma,
          tenantA,
          { name: "TenantA Parent", parentId: null },
          "op-a",
          buildTestHooks(),
        );

        // Tenant B tries to create a child under Tenant A's parent → reject.
        await expect(
          svc.createCategory(
            prisma,
            tenantB,
            { name: "Cross-tenant child", parentId: parentInA.category.id },
            "op-b",
            buildTestHooks(),
          ),
        ).rejects.toThrow(svc.ParentCategoryNotFoundError);
      },
      async (prisma: PrismaClient) => {
        await cleanupTenant(prisma, tenantA);
        await cleanupTenant(prisma, tenantB);
      },
    );
  });
});
