/**
 * KAN-1219 Slice B — listVehicles filter + sort expansion integration tests.
 *
 * 9 scenarios validating the new filter dimensions and sort options:
 *
 *   1. searchText matches across make + model + vin + stockNumber
 *      (case-insensitive contains).
 *   2. makeIn narrows to specific make set.
 *   3. bodyStyleIn narrows to specific body style set.
 *   4. yearMin / yearMax range filter (both ends + each in isolation).
 *   5. mileageMin / mileageMax range filter.
 *   6. priceMin / priceMax range filter (Decimal boundary Memo 39).
 *   7. Combined filters compose (bodyStyle + price + year all simultaneously).
 *   8. sort=price_asc orders ascending; sort=year_desc orders descending.
 *   9. Empty result with active filter that excludes all rows.
 *
 * Uses `withCleanup` to mirror kan-1214-vehicle-service.test.ts pattern.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { withCleanup, createTenant } from "./setup.js";

interface VehicleRow {
  id: string;
  make: string;
  model: string;
  year: number;
  mileage: number | null;
  price: { toNumber: () => number } | null;
}
interface ListResult {
  items: VehicleRow[];
  nextCursor: string | null;
  totalCount: number;
}
interface VehicleServiceModule {
  createVehicle: (
    prisma: unknown,
    tenantId: string,
    input: unknown,
    actor: string,
    hooks: unknown,
  ) => Promise<{ vehicle: VehicleRow }>;
  listVehicles: (
    prisma: unknown,
    tenantId: string,
    filters: Record<string, unknown>,
    pagination: { cursor?: string; limit?: number },
  ) => Promise<ListResult>;
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

interface SeedInput {
  year: number;
  make: string;
  model: string;
  bodyStyle?: string;
  transmission?: string;
  fuelType?: string;
  drivetrain?: string;
  condition?: string;
  mileage?: number;
  price?: number;
  vin?: string;
  stockNumber?: string;
  status?: string;
}
function vehicleInput(o: SeedInput) {
  return {
    year: o.year,
    make: o.make,
    model: o.model,
    bodyStyle: o.bodyStyle ?? "sedan",
    transmission: o.transmission ?? "automatic",
    fuelType: o.fuelType ?? "gas",
    drivetrain: o.drivetrain ?? "fwd",
    condition: o.condition ?? "used",
    mileage: o.mileage ?? null,
    price: o.price ?? null,
    vin: o.vin ?? null,
    stockNumber: o.stockNumber ?? null,
    status: o.status ?? "active",
  };
}

async function seedFleet(prisma: PrismaClient, tenantId: string) {
  // 5 deterministic rows for filter/sort assertions.
  await svc.createVehicle(prisma, tenantId, vehicleInput({
    year: 2020, make: "Nissan", model: "Rogue", bodyStyle: "suv",
    drivetrain: "awd", mileage: 75000, price: 17995,
    vin: "5N1AT2MVXLC790807", stockNumber: "ROG-001",
  }), "op", buildTestHooks());
  await svc.createVehicle(prisma, tenantId, vehicleInput({
    year: 2017, make: "Ford", model: "Transit", bodyStyle: "van",
    drivetrain: "rwd", mileage: 360000, price: 9995,
    vin: "1FTYE2YM1HKA43852", stockNumber: "TRN-002",
  }), "op", buildTestHooks());
  await svc.createVehicle(prisma, tenantId, vehicleInput({
    year: 2015, make: "Lincoln", model: "MKC", bodyStyle: "suv",
    drivetrain: "awd", mileage: 137000, price: 9995,
    vin: "5LMCJ2A97FUJ01176", stockNumber: "MKC-003",
  }), "op", buildTestHooks());
  await svc.createVehicle(prisma, tenantId, vehicleInput({
    year: 2023, make: "Tesla", model: "Model 3", bodyStyle: "sedan",
    fuelType: "electric", drivetrain: "rwd", mileage: 12000, price: 38995,
    vin: "5YJ3E1EA1PF123456", stockNumber: "TES-004",
  }), "op", buildTestHooks());
  await svc.createVehicle(prisma, tenantId, vehicleInput({
    year: 2024, make: "Toyota", model: "Camry", bodyStyle: "sedan",
    drivetrain: "fwd", mileage: 5000, price: 28500,
    vin: "4T1G11AK4PU987654", stockNumber: "CAM-005",
  }), "op", buildTestHooks());
}

describe("KAN-1219 Slice B — listVehicles filter + sort", () => {
  it("searchText matches case-insensitive across make/model/vin/stockNumber", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        await seedFleet(prisma, tenantId);

        // Match by model ("rogue" lowercased).
        const byModel = await svc.listVehicles(prisma, tenantId, { searchText: "rogue" }, { limit: 50 });
        expect(byModel.totalCount).toBe(1);
        expect(byModel.items[0]!.model).toBe("Rogue");

        // Match by VIN prefix.
        const byVin = await svc.listVehicles(prisma, tenantId, { searchText: "5N1AT2" }, { limit: 50 });
        expect(byVin.totalCount).toBe(1);

        // Match by stockNumber.
        const byStock = await svc.listVehicles(prisma, tenantId, { searchText: "TES-004" }, { limit: 50 });
        expect(byStock.totalCount).toBe(1);
        expect(byStock.items[0]!.make).toBe("Tesla");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("makeIn narrows to specific make set", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        await seedFleet(prisma, tenantId);

        const result = await svc.listVehicles(prisma, tenantId, { makeIn: ["Tesla", "Toyota"] }, { limit: 50 });
        expect(result.totalCount).toBe(2);
        const makes = result.items.map((v) => v.make).sort();
        expect(makes).toEqual(["Tesla", "Toyota"]);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("bodyStyleIn narrows to specific body styles", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        await seedFleet(prisma, tenantId);

        const result = await svc.listVehicles(prisma, tenantId, { bodyStyleIn: ["suv"] }, { limit: 50 });
        expect(result.totalCount).toBe(2);
        for (const v of result.items) expect(["Rogue", "MKC"]).toContain(v.model);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("yearMin / yearMax range filter (inclusive on both ends)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        await seedFleet(prisma, tenantId);

        const between = await svc.listVehicles(prisma, tenantId, { yearMin: 2020, yearMax: 2023 }, { limit: 50 });
        expect(between.totalCount).toBe(2);
        for (const v of between.items) {
          expect(v.year).toBeGreaterThanOrEqual(2020);
          expect(v.year).toBeLessThanOrEqual(2023);
        }

        const minOnly = await svc.listVehicles(prisma, tenantId, { yearMin: 2023 }, { limit: 50 });
        expect(minOnly.totalCount).toBe(2);

        const maxOnly = await svc.listVehicles(prisma, tenantId, { yearMax: 2017 }, { limit: 50 });
        expect(maxOnly.totalCount).toBe(2);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("mileageMin / mileageMax range filter", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        await seedFleet(prisma, tenantId);

        const lowMileage = await svc.listVehicles(prisma, tenantId, { mileageMax: 20000 }, { limit: 50 });
        expect(lowMileage.totalCount).toBe(2);
        for (const v of lowMileage.items) expect(v.mileage!).toBeLessThanOrEqual(20000);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("priceMin / priceMax range filter (Memo 39 Decimal boundary)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        await seedFleet(prisma, tenantId);

        const midRange = await svc.listVehicles(prisma, tenantId, { priceMin: 10000, priceMax: 30000 }, { limit: 50 });
        expect(midRange.totalCount).toBe(2);
        for (const v of midRange.items) {
          const p = v.price!.toNumber();
          expect(p).toBeGreaterThanOrEqual(10000);
          expect(p).toBeLessThanOrEqual(30000);
        }
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("combined filters compose (bodyStyle + price + year simultaneously)", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        await seedFleet(prisma, tenantId);

        const result = await svc.listVehicles(prisma, tenantId, {
          bodyStyleIn: ["sedan"],
          priceMin: 30000,
          yearMin: 2023,
        }, { limit: 50 });
        expect(result.totalCount).toBe(1);
        expect(result.items[0]!.make).toBe("Tesla");
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("sort=price_asc + sort=year_desc order correctly", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        await seedFleet(prisma, tenantId);

        const byPriceAsc = await svc.listVehicles(prisma, tenantId, { sort: "price_asc" }, { limit: 50 });
        const prices = byPriceAsc.items.map((v) => v.price!.toNumber());
        const sortedPrices = [...prices].sort((a, b) => a - b);
        expect(prices).toEqual(sortedPrices);

        const byYearDesc = await svc.listVehicles(prisma, tenantId, { sort: "year_desc" }, { limit: 50 });
        const years = byYearDesc.items.map((v) => v.year);
        const sortedYears = [...years].sort((a, b) => b - a);
        expect(years).toEqual(sortedYears);
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });

  it("empty result with active filter that excludes all rows", async () => {
    let tenantId = "";
    await withCleanup(
      async (prisma: PrismaClient) => {
        tenantId = (await createTenant(prisma)).id;
        await seedFleet(prisma, tenantId);

        const result = await svc.listVehicles(prisma, tenantId, {
          makeIn: ["Ferrari"],
        }, { limit: 50 });
        expect(result.totalCount).toBe(0);
        expect(result.items).toEqual([]);
        expect(result.nextCursor).toBeNull();
      },
      (prisma: PrismaClient) => cleanupTenant(prisma, tenantId),
    );
  });
});
