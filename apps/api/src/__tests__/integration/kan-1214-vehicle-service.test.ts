/**
 * KAN-1214 — Vehicle CRUD service integration tests.
 *
 * Mirrors kan-1216b-product-crud.test.ts shape. 7 scenarios per Phase 1 trace:
 *
 *   1. create happy path (full field set + audit snapshot)
 *   2. VIN dedup Memo 45 — NULL ≠ NULL allows multiple null-VIN rows;
 *      duplicate non-null VIN rejected (VinAlreadyExistsError)
 *   3. Zod enum rejection at service entry (bodyStyle: "spaceship")
 *   4. archive lifecycle — first archive sets status+archivedAt+audit;
 *      re-archive returns alreadyArchived=true with no duplicate audit row
 *   5. listVehicles pagination + default status filter (archivedAt:null
 *      excludes archived; includeArchived=true returns all; cursor round-trip)
 *   6. update lifecycle — createdAt preserved + updatedAt advanced + audit
 *      delta payload; update on archived rejects with ArchivedVehicleMutationError
 *   7. getVehicleById + includeArchived — archived row hidden by default;
 *      returned when includeArchived=true
 *
 * Uses `withCleanup` (NOT `withRollback`) because the service opens its own
 * `prisma.$transaction` internally — per
 * `integration_test_isolation_pattern_must_match_service_tx_shape` memo.
 *
 * Variable-specifier dynamic loader (KAN-689 cohort) — same pattern as
 * kan-1216b-product-crud.test.ts:73.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { withCleanup, createTenant } from "./setup.js";

interface VehicleRow {
  id: string;
  tenantId: string;
  year: number;
  make: string;
  model: string;
  vin: string | null;
  status: "draft" | "active" | "archived";
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface VehicleServiceModule {
  createVehicle: (
    prisma: unknown,
    tenantId: string,
    input: unknown,
    actor: string,
    hooks: unknown,
  ) => Promise<{ vehicle: VehicleRow; auditLogId: string }>;
  updateVehicle: (
    prisma: unknown,
    tenantId: string,
    vehicleId: string,
    input: unknown,
    actor: string,
    hooks: unknown,
  ) => Promise<{ vehicle: VehicleRow; auditLogId: string }>;
  archiveVehicle: (
    prisma: unknown,
    tenantId: string,
    vehicleId: string,
    actor: string,
    hooks: unknown,
  ) => Promise<{
    vehicle: VehicleRow;
    auditLogId: string;
    alreadyArchived: boolean;
  }>;
  getVehicleById: (
    prisma: unknown,
    tenantId: string,
    vehicleId: string,
    opts?: { includeArchived?: boolean },
  ) => Promise<VehicleRow | null>;
  listVehicles: (
    prisma: unknown,
    tenantId: string,
    filters: { status?: string; includeArchived?: boolean },
    pagination: { cursor?: string; limit?: number },
  ) => Promise<{ items: VehicleRow[]; nextCursor: string | null; totalCount: number }>;
  VehicleNotFoundError: new () => Error;
  ArchivedVehicleMutationError: new () => Error;
  VinAlreadyExistsError: new (tenantId: string, vin: string) => Error;
}

let svc: VehicleServiceModule;

beforeAll(async () => {
  const spec = "../../../../../packages/api/src/services/vehicle-service.js";
  svc = (await import(spec)) as VehicleServiceModule;
});

// Mirrors router buildVehicleHooks() — same AuditLog hook shape.
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
            auditLog: { create: (args: unknown) => Promise<{ id: string }> };
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

async function cleanupTenant(
  prisma: PrismaClient,
  tenantId: string,
): Promise<void> {
  // FK order: Vehicle → AuditLog → Tenant.
  await (
    prisma as unknown as {
      vehicle: { deleteMany: (args: unknown) => Promise<unknown> };
    }
  ).vehicle.deleteMany({ where: { tenantId } });
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}

function baseVehicleInput(overrides: Record<string, unknown> = {}) {
  return {
    year: 2024,
    make: "Toyota",
    model: "Camry",
    bodyStyle: "sedan",
    transmission: "automatic",
    fuelType: "gas",
    drivetrain: "fwd",
    condition: "new",
    ...overrides,
  };
}

describe("KAN-1214 — Vehicle CRUD service", () => {
  it("creates a vehicle + writes AuditLog atomically (create happy path)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;

        const result = await svc.createVehicle(
          prisma,
          tenantId,
          baseVehicleInput({
            trim: "XSE",
            vin: "1HGCM82633A123456",
            mileage: 12000,
            exteriorColor: "Silver",
            stockNumber: "STK-001",
          }),
          "operator-1",
          buildTestHooks(),
        );

        expect(result.vehicle.make).toBe("Toyota");
        expect(result.vehicle.model).toBe("Camry");
        expect(result.vehicle.status).toBe("draft");
        expect(result.vehicle.archivedAt).toBeNull();
        expect(result.vehicle.vin).toBe("1HGCM82633A123456");
        expect(result.auditLogId).toBeTruthy();

        const audit = await prisma.auditLog.findUnique({
          where: { id: result.auditLogId },
        });
        expect(audit?.actionType).toBe("vehicle.created");
        const payload = audit?.payload as
          | { vehicleId: string; snapshot: { make: string } }
          | null;
        expect(payload?.vehicleId).toBe(result.vehicle.id);
        expect(payload?.snapshot?.make).toBe("Toyota");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("allows multiple null-VIN rows but rejects duplicate non-null VIN (Memo 45)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;

        // A: vin null → succeeds
        const a = await svc.createVehicle(
          prisma,
          tenantId,
          baseVehicleInput({ make: "FordA" }),
          "op-1",
          buildTestHooks(),
        );
        expect(a.vehicle.vin).toBeNull();

        // B: vin null → also succeeds (NULL ≠ NULL under SQL 3VL)
        const b = await svc.createVehicle(
          prisma,
          tenantId,
          baseVehicleInput({ make: "FordB" }),
          "op-1",
          buildTestHooks(),
        );
        expect(b.vehicle.vin).toBeNull();
        expect(b.vehicle.id).not.toBe(a.vehicle.id);

        // C: distinct VIN → succeeds
        const c = await svc.createVehicle(
          prisma,
          tenantId,
          baseVehicleInput({ make: "FordC", vin: "1HGCM82633A123456" }),
          "op-1",
          buildTestHooks(),
        );
        expect(c.vehicle.vin).toBe("1HGCM82633A123456");

        // D: duplicate VIN → VinAlreadyExistsError
        await expect(
          svc.createVehicle(
            prisma,
            tenantId,
            baseVehicleInput({ make: "FordD", vin: "1HGCM82633A123456" }),
            "op-1",
            buildTestHooks(),
          ),
        ).rejects.toThrow(svc.VinAlreadyExistsError);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("rejects invalid bodyStyle enum at service-entry Zod parse", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;

        await expect(
          svc.createVehicle(
            prisma,
            tenantId,
            baseVehicleInput({ bodyStyle: "spaceship" }),
            "op-1",
            buildTestHooks(),
          ),
        ).rejects.toThrow();
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("archive lifecycle — first archive sets archivedAt + audit; re-archive idempotent", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const created = await svc.createVehicle(
          prisma,
          tenantId,
          baseVehicleInput({ status: "active" }),
          "op-1",
          buildTestHooks(),
        );

        const first = await svc.archiveVehicle(
          prisma,
          tenantId,
          created.vehicle.id,
          "op-1",
          buildTestHooks(),
        );
        expect(first.alreadyArchived).toBe(false);
        expect(first.vehicle.status).toBe("archived");
        expect(first.vehicle.archivedAt).not.toBeNull();

        const audit = await prisma.auditLog.findUnique({
          where: { id: first.auditLogId },
        });
        expect(audit?.actionType).toBe("vehicle.archived");

        const second = await svc.archiveVehicle(
          prisma,
          tenantId,
          created.vehicle.id,
          "op-1",
          buildTestHooks(),
        );
        expect(second.alreadyArchived).toBe(true);
        expect(second.auditLogId).toBe("");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("list pagination + default-hides archived; includeArchived returns all", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;

        // Seed 3 active + 1 archived
        for (let i = 0; i < 3; i++) {
          await svc.createVehicle(
            prisma,
            tenantId,
            baseVehicleInput({ status: "active", make: `Make-${i}` }),
            "op-1",
            buildTestHooks(),
          );
        }
        const toArchive = await svc.createVehicle(
          prisma,
          tenantId,
          baseVehicleInput({ status: "active", make: "ToArchive" }),
          "op-1",
          buildTestHooks(),
        );
        await svc.archiveVehicle(
          prisma,
          tenantId,
          toArchive.vehicle.id,
          "op-1",
          buildTestHooks(),
        );

        // Default — archived hidden
        const defaultList = await svc.listVehicles(
          prisma,
          tenantId,
          {},
          {},
        );
        expect(defaultList.items.length).toBe(3);
        expect(defaultList.totalCount).toBe(3);
        for (const v of defaultList.items) {
          expect(v.archivedAt).toBeNull();
        }

        // includeArchived:true — all 4 returned
        const allList = await svc.listVehicles(
          prisma,
          tenantId,
          { includeArchived: true },
          {},
        );
        expect(allList.items.length).toBe(4);
        expect(allList.totalCount).toBe(4);

        // Cursor round-trip across pages (limit=2)
        const page1 = await svc.listVehicles(
          prisma,
          tenantId,
          { includeArchived: true },
          { limit: 2 },
        );
        expect(page1.items.length).toBe(2);
        expect(page1.nextCursor).not.toBeNull();
        const page2 = await svc.listVehicles(
          prisma,
          tenantId,
          { includeArchived: true },
          { limit: 2, cursor: page1.nextCursor! },
        );
        expect(page2.items.length).toBe(2);
        const ids1 = new Set(page1.items.map((v) => v.id));
        const ids2 = new Set(page2.items.map((v) => v.id));
        // No overlap between pages
        for (const id of ids2) {
          expect(ids1.has(id)).toBe(false);
        }
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("update preserves createdAt + advances updatedAt + records audit delta; archived rejects update", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const created = await svc.createVehicle(
          prisma,
          tenantId,
          baseVehicleInput({ make: "Honda", model: "Civic" }),
          "op-1",
          buildTestHooks(),
        );
        const originalCreatedAt = created.vehicle.createdAt;
        const originalUpdatedAt = created.vehicle.updatedAt;

        // Brief wait so updatedAt observably advances
        await new Promise((r) => setTimeout(r, 10));

        const updated = await svc.updateVehicle(
          prisma,
          tenantId,
          created.vehicle.id,
          { model: "Accord" },
          "op-2",
          buildTestHooks(),
        );
        expect(updated.vehicle.model).toBe("Accord");
        expect(new Date(updated.vehicle.createdAt).getTime()).toBe(
          new Date(originalCreatedAt).getTime(),
        );
        expect(new Date(updated.vehicle.updatedAt).getTime()).toBeGreaterThan(
          new Date(originalUpdatedAt).getTime(),
        );

        const audit = await prisma.auditLog.findUnique({
          where: { id: updated.auditLogId },
        });
        expect(audit?.actionType).toBe("vehicle.updated");
        const payload = audit?.payload as
          | { before: { model: string }; after: { model: string } }
          | null;
        expect(payload?.before?.model).toBe("Civic");
        expect(payload?.after?.model).toBe("Accord");

        // Archive then attempt update → ArchivedVehicleMutationError
        await svc.archiveVehicle(
          prisma,
          tenantId,
          created.vehicle.id,
          "op-1",
          buildTestHooks(),
        );
        await expect(
          svc.updateVehicle(
            prisma,
            tenantId,
            created.vehicle.id,
            { model: "Resurrected" },
            "op-1",
            buildTestHooks(),
          ),
        ).rejects.toThrow(svc.ArchivedVehicleMutationError);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("getVehicleById hides archived by default; returns with includeArchived=true", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;
        const created = await svc.createVehicle(
          prisma,
          tenantId,
          baseVehicleInput({ status: "active" }),
          "op-1",
          buildTestHooks(),
        );
        await svc.archiveVehicle(
          prisma,
          tenantId,
          created.vehicle.id,
          "op-1",
          buildTestHooks(),
        );

        const defaultRead = await svc.getVehicleById(
          prisma,
          tenantId,
          created.vehicle.id,
        );
        expect(defaultRead).toBeNull();

        const withArchived = await svc.getVehicleById(
          prisma,
          tenantId,
          created.vehicle.id,
          { includeArchived: true },
        );
        expect(withArchived).not.toBeNull();
        expect(withArchived?.status).toBe("archived");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });
});
