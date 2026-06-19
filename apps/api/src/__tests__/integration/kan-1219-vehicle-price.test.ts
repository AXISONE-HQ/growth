/**
 * KAN-1219 Slice A — Vehicle.price column roundtrip integration tests.
 *
 * Covers Memo 39 Decimal-coercion-at-boundary doctrine (3rd formal anchor):
 *
 *   - Scenario 1: createVehicle with price → row carries Prisma Decimal value
 *     that round-trips equal (toNumber()) to the input JSON number.
 *   - Scenario 2: updateVehicle with price → atomic partial-UPDATE; createdAt
 *     preserved + updatedAt advanced; before/after audit payload captures the
 *     price delta.
 *
 * Codebase-precedent calibration (vs. SPO Phase 1 pre-lean): JSON wire format
 * at the Zod boundary is `z.number()`, matching Product.price at
 * packages/shared/src/products.ts:66. Prisma coerces Decimal(10,2) ↔ JS
 * number at serialization. NOT Int cents — refuted at memo banking.
 *
 * Reuses the vehicle-service.ts variable-specifier dynamic loader pattern
 * established in kan-1214-vehicle-service.test.ts:73.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { withCleanup, createTenant } from "./setup.js";

interface DecimalLike {
  toNumber: () => number;
}
interface VehicleRow {
  id: string;
  tenantId: string;
  price: DecimalLike | null;
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

describe("KAN-1219 Slice A — Vehicle.price Decimal roundtrip", () => {
  it("createVehicle with price → Decimal roundtrips equal to JSON number input", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;

        const result = await svc.createVehicle(
          prisma,
          tenantId,
          baseVehicleInput({ price: 17995.5 }),
          "op-1",
          buildTestHooks(),
        );

        expect(result.vehicle.price).not.toBeNull();
        expect(result.vehicle.price?.toNumber()).toBe(17995.5);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("updateVehicle with price → atomic UPDATE + audit before/after delta", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        const t = await createTenant(prisma);
        tenantId = t.id;

        const created = await svc.createVehicle(
          prisma,
          tenantId,
          baseVehicleInput({ price: 9995 }),
          "op-1",
          buildTestHooks(),
        );
        expect(created.vehicle.price?.toNumber()).toBe(9995);
        const originalCreatedAt = created.vehicle.createdAt;

        const updated = await svc.updateVehicle(
          prisma,
          tenantId,
          created.vehicle.id,
          { price: 11250.75 },
          "op-1",
          buildTestHooks(),
        );

        expect(updated.vehicle.price?.toNumber()).toBe(11250.75);
        expect(new Date(updated.vehicle.createdAt).getTime()).toBe(
          new Date(originalCreatedAt).getTime(),
        );

        const audit = await prisma.auditLog.findUnique({
          where: { id: updated.auditLogId },
        });
        expect(audit?.actionType).toBe("vehicle.updated");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });
});
