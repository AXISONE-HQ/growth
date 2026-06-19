/**
 * KAN-1219 Slice D — Vehicle detail columns roundtrip integration tests.
 *
 * 5 scenarios validating the new photoUrls + description + features
 * columns at the service-layer boundary:
 *
 *   1. createVehicle with detail fields → row roundtrips array values
 *      (Memo 39 codebase-precedent for TEXT[] roundtrip).
 *   2. updateVehicle with photoUrls + features → atomic partial UPDATE.
 *   3. getVehicleById returns the full Vehicle shape including new fields.
 *   4. createVehicle with omitted detail fields → defaults to empty arrays
 *      + null description (Memo 19/42 affordance-honesty).
 *   5. listVehicles surfaces new fields in each returned item.
 *
 * Pattern mirrors kan-1219-vehicle-price.test.ts harness.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { withCleanup, createTenant } from "./setup.js";

interface VehicleRow {
  id: string;
  photoUrls: string[];
  description: string | null;
  features: string[];
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
  getVehicleById: (
    prisma: unknown,
    tenantId: string,
    vehicleId: string,
    opts?: { includeArchived?: boolean },
  ) => Promise<VehicleRow | null>;
  listVehicles: (
    prisma: unknown,
    tenantId: string,
    filters: Record<string, unknown>,
    pagination: { cursor?: string; limit?: number },
  ) => Promise<{ items: VehicleRow[]; nextCursor: string | null; totalCount: number }>;
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

function baseInput(overrides: Record<string, unknown> = {}) {
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

const SAMPLE_PHOTOS = [
  "https://cdn.drivegood.com/photo-a.jpg",
  "https://cdn.drivegood.com/photo-b.jpg",
  "https://cdn.drivegood.com/photo-c.jpg",
];
const SAMPLE_FEATURES = ["remote_start", "rear_camera", "leather_seats"];
const SAMPLE_DESCRIPTION = "Toute équipée, vitres et miroirs électriques.";

describe("KAN-1219 Slice D — Vehicle detail columns roundtrip", () => {
  it("createVehicle with detail fields → roundtrips array + description values", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        const result = await svc.createVehicle(
          prisma,
          tenantId,
          baseInput({
            photoUrls: SAMPLE_PHOTOS,
            description: SAMPLE_DESCRIPTION,
            features: SAMPLE_FEATURES,
          }),
          "op-1",
          buildTestHooks(),
        );
        expect(result.vehicle.photoUrls).toEqual(SAMPLE_PHOTOS);
        expect(result.vehicle.description).toBe(SAMPLE_DESCRIPTION);
        expect(result.vehicle.features).toEqual(SAMPLE_FEATURES);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("updateVehicle with photoUrls + features → atomic partial UPDATE", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        const created = await svc.createVehicle(
          prisma,
          tenantId,
          baseInput({ description: "initial" }),
          "op-1",
          buildTestHooks(),
        );
        expect(created.vehicle.photoUrls).toEqual([]);
        expect(created.vehicle.features).toEqual([]);

        const updated = await svc.updateVehicle(
          prisma,
          tenantId,
          created.vehicle.id,
          { photoUrls: SAMPLE_PHOTOS, features: SAMPLE_FEATURES },
          "op-1",
          buildTestHooks(),
        );
        expect(updated.vehicle.photoUrls).toEqual(SAMPLE_PHOTOS);
        expect(updated.vehicle.features).toEqual(SAMPLE_FEATURES);
        // Untouched field preserved.
        expect(updated.vehicle.description).toBe("initial");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("getVehicleById returns the full Vehicle shape with detail fields", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        const created = await svc.createVehicle(
          prisma,
          tenantId,
          baseInput({
            photoUrls: SAMPLE_PHOTOS,
            description: SAMPLE_DESCRIPTION,
            features: SAMPLE_FEATURES,
          }),
          "op-1",
          buildTestHooks(),
        );
        const fetched = await svc.getVehicleById(prisma, tenantId, created.vehicle.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.photoUrls).toEqual(SAMPLE_PHOTOS);
        expect(fetched!.description).toBe(SAMPLE_DESCRIPTION);
        expect(fetched!.features).toEqual(SAMPLE_FEATURES);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("createVehicle with omitted detail fields → defaults to empty arrays + null description", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        const result = await svc.createVehicle(
          prisma,
          tenantId,
          baseInput(),
          "op-1",
          buildTestHooks(),
        );
        expect(result.vehicle.photoUrls).toEqual([]);
        expect(result.vehicle.description).toBeNull();
        expect(result.vehicle.features).toEqual([]);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("listVehicles surfaces detail fields in each returned item", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        await svc.createVehicle(
          prisma,
          tenantId,
          baseInput({
            status: "active",
            photoUrls: SAMPLE_PHOTOS,
            features: SAMPLE_FEATURES,
            description: SAMPLE_DESCRIPTION,
          }),
          "op-1",
          buildTestHooks(),
        );
        const result = await svc.listVehicles(prisma, tenantId, {}, { limit: 50 });
        expect(result.totalCount).toBe(1);
        const item = result.items[0]!;
        expect(item.photoUrls).toEqual(SAMPLE_PHOTOS);
        expect(item.features).toEqual(SAMPLE_FEATURES);
        expect(item.description).toBe(SAMPLE_DESCRIPTION);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });
});
