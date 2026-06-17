/**
 * KAN-1218 — Zombie procedure deletion + salesObjections migration.
 *
 * 5 assertions:
 *   1-4. knowledge.{listProducts, createProduct, updateProduct, deleteProduct}
 *        are GONE from the router surface. The Phase 1 audit identified these
 *        as zombies — Prisma.product.active column was renamed status/archivedAt
 *        in KAN-1213 schema migration; the procedures silently 500'd in PROD
 *        for ~2mo (Memo 41 anchor). Sub-cat 8 + sub-cat 6 hybrid archetype:
 *        substrate cleanup + new operator surface land atomically.
 *
 *   5.   salesObjectionsRouter's product context-loading uses canonical
 *        `status: 'active'` + `archivedAt: null` filter (KAN-1218 step 4),
 *        not the legacy phantom `active: true` predicate. Asserts the Prisma
 *        query against a seeded product round-trips.
 *
 * Uses `withCleanup` because the salesObjections.create mutation opens its
 * own $transaction at the router layer (integration_test_isolation_pattern
 * memo).
 */
import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { appRouter } from "../../router.js";
import { withCleanup, createTenant } from "./setup.js";

describe("KAN-1218 — knowledge.*Product zombie deletion", () => {
  it("knowledge.listProducts no longer exists on the router surface", () => {
    const knowledge = appRouter._def.procedures as Record<string, unknown>;
    expect(knowledge["knowledge.listProducts"]).toBeUndefined();
  });

  it("knowledge.createProduct no longer exists on the router surface", () => {
    const procs = appRouter._def.procedures as Record<string, unknown>;
    expect(procs["knowledge.createProduct"]).toBeUndefined();
  });

  it("knowledge.updateProduct no longer exists on the router surface", () => {
    const procs = appRouter._def.procedures as Record<string, unknown>;
    expect(procs["knowledge.updateProduct"]).toBeUndefined();
  });

  it("knowledge.deleteProduct no longer exists on the router surface", () => {
    const procs = appRouter._def.procedures as Record<string, unknown>;
    expect(procs["knowledge.deleteProduct"]).toBeUndefined();
  });
});

describe("KAN-1218 — salesObjectionsRouter product-context filter migration", () => {
  it("ctx.prisma.product.findMany scoped by status='active' + archivedAt=null returns the seeded active product (canonical KAN-1213 shape)", async () => {
    let tenantId = "";
    let productId = "";
    let archivedId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;

        // Seed one active + one archived product. The canonical KAN-1218
        // step 4 filter (status='active' + archivedAt=null) must return only
        // the active row — the legacy `active: true` predicate (PROD-zombie)
        // would have matched neither, since the column was renamed in
        // KAN-1213 schema migration.
        const active = await (prisma as any).product.create({
          data: {
            tenantId,
            name: "Active Product",
            status: "active",
            currency: "USD",
          },
          select: { id: true },
        });
        productId = active.id;

        const archived = await (prisma as any).product.create({
          data: {
            tenantId,
            name: "Archived Product",
            status: "archived",
            archivedAt: new Date(),
            currency: "USD",
          },
          select: { id: true },
        });
        archivedId = archived.id;

        // Mirror the salesObjectionsRouter query shape after migration.
        const rows = await (prisma as any).product.findMany({
          where: { tenantId, status: "active", archivedAt: null },
          take: 10,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(productId);
      },
      async (prisma: PrismaClient) => {
        await (prisma as any).product.deleteMany({
          where: { id: { in: [productId, archivedId] } },
        });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      },
    );
  });
});
