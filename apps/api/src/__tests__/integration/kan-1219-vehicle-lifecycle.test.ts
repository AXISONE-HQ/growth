/**
 * KAN-1219 Slice F1 — Vehicle lifecycle reconcileInventory integration tests.
 *
 * 6 scenarios covering the reconcile state machine:
 *
 *   1. All-new feed → all VINs created with firstSeenAt = lastSeenAt = NOW().
 *   2. Overlapping feed → lastSeenAt advances; firstSeenAt preserved.
 *   3. Disappeared VIN → removedAt set on subsequent run; not re-set on
 *      a 3rd run (idempotent).
 *   4. Re-run with identical snapshot → idempotent (0 creates, 0 removes;
 *      unchangedCount captures the rest; lastSeenAt advances).
 *   5. Archived vehicles excluded from "missing" detection (don't get
 *      removedAt; don't get resurrected either).
 *   6. Audit log namespace — sync_seen / sync_created / sync_removed
 *      action_types emitted with extractionSource provenance.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { withCleanup, createTenant } from "./setup.js";

interface VehicleRow {
  id: string;
  vin: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  removedAt: Date | null;
  archivedAt: Date | null;
  status: string;
  year: number;
  make: string;
  model: string;
}
interface ReconcileEntry {
  vin: string;
  year: number;
  make: string;
  model: string;
  bodyStyle: string;
  transmission: string;
  fuelType: string;
  drivetrain: string;
  condition: string;
}
interface ReconcileResult {
  seenCount: number;
  createdCount: number;
  updatedCount: number;
  removedCount: number;
  unchangedCount: number;
  errors: Array<{ vin: string; phase: string; message: string }>;
}
interface VehicleServiceModule {
  reconcileInventory: (
    prisma: unknown,
    tenantId: string,
    entries: ReconcileEntry[],
    source: string,
    hooks: unknown,
  ) => Promise<ReconcileResult>;
  createVehicle: (
    prisma: unknown,
    tenantId: string,
    input: unknown,
    actor: string,
    hooks: unknown,
  ) => Promise<{ vehicle: VehicleRow }>;
  archiveVehicle: (
    prisma: unknown,
    tenantId: string,
    vehicleId: string,
    actor: string,
    hooks: unknown,
  ) => Promise<{ vehicle: VehicleRow }>;
}

let svc: VehicleServiceModule;

beforeAll(async () => {
  const spec = "../../../../../packages/api/src/services/vehicle-service.js";
  svc = (await import(spec)) as VehicleServiceModule;
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

async function cleanupTenant(prisma: PrismaClient, tenantId: string): Promise<void> {
  await (
    prisma as unknown as {
      vehicle: { deleteMany: (args: unknown) => Promise<unknown> };
    }
  ).vehicle.deleteMany({ where: { tenantId } });
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } });
}

function entry(o: Partial<ReconcileEntry> & { vin: string; make: string; model: string }): ReconcileEntry {
  return {
    year: 2024,
    bodyStyle: "sedan",
    transmission: "automatic",
    fuelType: "gas",
    drivetrain: "fwd",
    condition: "used",
    ...o,
  };
}

const SOURCE = "github-actions-daily-cron";

describe("KAN-1219 Slice F1 — reconcileInventory", () => {
  it("Scenario 1 — all-new feed: VINs created with firstSeenAt = lastSeenAt = NOW()", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        const feed = [
          entry({ vin: "1HGCM82633A100001", make: "Honda", model: "Accord" }),
          entry({ vin: "1HGCM82633A100002", make: "Honda", model: "Civic" }),
        ];
        const result = await svc.reconcileInventory(prisma, tenantId, feed, SOURCE, buildTestHooks());
        expect(result.createdCount).toBe(2);
        expect(result.seenCount).toBe(0);
        expect(result.removedCount).toBe(0);
        expect(result.errors).toEqual([]);

        const rows = (await (prisma as unknown as { vehicle: { findMany: (args: unknown) => Promise<VehicleRow[]> } })
          .vehicle.findMany({ where: { tenantId } })) as VehicleRow[];
        expect(rows).toHaveLength(2);
        for (const r of rows) {
          expect(r.firstSeenAt.getTime()).toBe(r.lastSeenAt.getTime());
          expect(r.removedAt).toBeNull();
          expect(r.status).toBe("active");
        }
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("Scenario 2 — overlapping feed: lastSeenAt advances, firstSeenAt preserved", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        const feed = [entry({ vin: "1HGCM82633A100003", make: "Honda", model: "CRV" })];
        const first = await svc.reconcileInventory(prisma, tenantId, feed, SOURCE, buildTestHooks());
        expect(first.createdCount).toBe(1);

        const after1 = (await (prisma as unknown as { vehicle: { findFirst: (args: unknown) => Promise<VehicleRow> } })
          .vehicle.findFirst({ where: { tenantId } })) as VehicleRow;
        const firstSeenAt = after1.firstSeenAt;
        const lastSeenAt1 = after1.lastSeenAt;

        // Sleep 50ms to ensure the next NOW() differs by enough to measure.
        await new Promise((r) => setTimeout(r, 50));
        const second = await svc.reconcileInventory(prisma, tenantId, feed, SOURCE, buildTestHooks());
        expect(second.seenCount).toBe(1);
        expect(second.createdCount).toBe(0);
        expect(second.unchangedCount).toBe(1);

        const after2 = (await (prisma as unknown as { vehicle: { findFirst: (args: unknown) => Promise<VehicleRow> } })
          .vehicle.findFirst({ where: { tenantId } })) as VehicleRow;
        expect(after2.firstSeenAt.getTime()).toBe(firstSeenAt.getTime());
        expect(after2.lastSeenAt.getTime()).toBeGreaterThan(lastSeenAt1.getTime());
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("Scenario 3 — disappeared VIN: removedAt set on next run; idempotent on 3rd", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        const initialFeed = [
          entry({ vin: "1HGCM82633A100004", make: "Honda", model: "A" }),
          entry({ vin: "1HGCM82633A100005", make: "Honda", model: "B" }),
        ];
        await svc.reconcileInventory(prisma, tenantId, initialFeed, SOURCE, buildTestHooks());

        // Second sync: only one VIN remains.
        const shrunkFeed = [entry({ vin: "1HGCM82633A100004", make: "Honda", model: "A" })];
        const second = await svc.reconcileInventory(prisma, tenantId, shrunkFeed, SOURCE, buildTestHooks());
        expect(second.removedCount).toBe(1);

        const removedRow = (await (prisma as unknown as { vehicle: { findFirst: (args: unknown) => Promise<VehicleRow | null> } })
          .vehicle.findFirst({ where: { tenantId, vin: "1HGCM82633A100005" } })) as VehicleRow | null;
        expect(removedRow).not.toBeNull();
        expect(removedRow!.removedAt).not.toBeNull();
        const removedAtFirst = removedRow!.removedAt!.getTime();

        // Third sync with same shrunk feed: removedAt MUST NOT be re-set.
        await new Promise((r) => setTimeout(r, 50));
        const third = await svc.reconcileInventory(prisma, tenantId, shrunkFeed, SOURCE, buildTestHooks());
        expect(third.removedCount).toBe(0);

        const stillRemoved = (await (prisma as unknown as { vehicle: { findFirst: (args: unknown) => Promise<VehicleRow | null> } })
          .vehicle.findFirst({ where: { tenantId, vin: "1HGCM82633A100005" } })) as VehicleRow | null;
        expect(stillRemoved!.removedAt!.getTime()).toBe(removedAtFirst);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("Scenario 4 — re-run with identical snapshot is idempotent", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        const feed = [
          entry({ vin: "1HGCM82633A100006", make: "Honda", model: "X" }),
          entry({ vin: "1HGCM82633A100007", make: "Honda", model: "Y" }),
        ];
        await svc.reconcileInventory(prisma, tenantId, feed, SOURCE, buildTestHooks());
        const second = await svc.reconcileInventory(prisma, tenantId, feed, SOURCE, buildTestHooks());
        expect(second.createdCount).toBe(0);
        expect(second.removedCount).toBe(0);
        expect(second.seenCount).toBe(2);
        expect(second.unchangedCount).toBe(2);

        const rows = (await (prisma as unknown as { vehicle: { findMany: (args: unknown) => Promise<VehicleRow[]> } })
          .vehicle.findMany({ where: { tenantId } })) as VehicleRow[];
        expect(rows).toHaveLength(2);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("Scenario 5 — archived vehicles excluded from missing-detection AND not resurrected", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        const created = await svc.createVehicle(
          prisma,
          tenantId,
          {
            year: 2020, make: "Honda", model: "Pilot",
            vin: "1HGCM82633A100008",
            bodyStyle: "suv", transmission: "automatic", fuelType: "gas",
            drivetrain: "awd", condition: "used", status: "active",
          },
          "operator-1",
          buildTestHooks(),
        );
        // Operator archives.
        await svc.archiveVehicle(prisma, tenantId, created.vehicle.id, "operator-1", buildTestHooks());

        // Reconcile with a feed that DOES include this VIN — archived rows
        // must NOT be resurrected (skip).
        const feedWithSame = [entry({ vin: "1HGCM82633A100008", make: "Honda", model: "Pilot" })];
        const r1 = await svc.reconcileInventory(prisma, tenantId, feedWithSame, SOURCE, buildTestHooks());
        expect(r1.seenCount).toBe(0); // archived row was skipped
        expect(r1.createdCount).toBe(0);
        expect(r1.removedCount).toBe(0);

        // And again with an EMPTY feed — archived rows must NOT get removedAt.
        const r2 = await svc.reconcileInventory(prisma, tenantId, [], SOURCE, buildTestHooks());
        expect(r2.removedCount).toBe(0);

        const row = (await (prisma as unknown as { vehicle: { findFirst: (args: unknown) => Promise<VehicleRow> } })
          .vehicle.findFirst({ where: { tenantId } })) as VehicleRow;
        expect(row.status).toBe("archived");
        expect(row.removedAt).toBeNull();
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("Scenario 6 — audit log namespace: sync_seen / sync_created / sync_removed", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        // Create.
        await svc.reconcileInventory(
          prisma,
          tenantId,
          [entry({ vin: "1HGCM82633A100009", make: "Honda", model: "Z" })],
          SOURCE,
          buildTestHooks(),
        );
        // Re-sync (seen).
        await svc.reconcileInventory(
          prisma,
          tenantId,
          [entry({ vin: "1HGCM82633A100009", make: "Honda", model: "Z" })],
          SOURCE,
          buildTestHooks(),
        );
        // Remove (empty feed).
        await svc.reconcileInventory(prisma, tenantId, [], SOURCE, buildTestHooks());

        const audits = await prisma.auditLog.findMany({
          where: { tenantId, actor: SOURCE },
          orderBy: { createdAt: "asc" },
        });
        const actionTypes = audits.map((a) => a.actionType);
        expect(actionTypes).toContain("vehicle.sync_created");
        expect(actionTypes).toContain("vehicle.sync_seen");
        expect(actionTypes).toContain("vehicle.sync_removed");
        for (const a of audits) {
          const payload = a.payload as { extractionSource?: string };
          expect(payload?.extractionSource).toBe(SOURCE);
        }
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });
});
