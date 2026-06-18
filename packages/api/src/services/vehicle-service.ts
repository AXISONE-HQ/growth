/**
 * KAN-1214 (Slice 2 of KAN-1211 epic) — Vehicle CRUD service.
 *
 * Mirrors product-service.ts M4 archive-only doctrine. Memo 45 NULL semantics
 * apply to VIN uniqueness — multiple VIN-null rows per tenant intentional
 * (VIN-unknown inventory). Memo 53 distinguishable audit action_types:
 * vehicle.created / vehicle.updated / vehicle.archived.
 *
 * # SPO verdict locks
 *
 * 1. **listVehicles + getVehicleById live in service layer** (Q1/Q2). Justified
 *    by multi-dimension filter composition (status + includeArchived). Product's
 *    inline-router pattern was the older precedent; service-layer encapsulation
 *    cleaner when filter dimensions exceed 1.
 *
 * 2. **VIN stored as-submitted, NO normalization** (Q3 — Memo 39 anchor #8).
 *    ISO 3779 regex /^[A-HJ-NPR-Z0-9]{17}$/ at packages/shared/src/vehicles.ts:86
 *    already excludes lowercase. Zero codebase precedent for .toUpperCase()
 *    normalization across 3 product services.
 *
 * 3. **CURRENT_YEAR = 2026 trust shared** (Q5). Service does NOT re-validate
 *    year range; Zod parse at service entry enforces. Dynamic-year-resolution
 *    refactor tracked in separate Jira ticket.
 *
 * 4. **archive is one-way** (J4 verdict). No unarchive procedure. Mirrors
 *    product-service.ts:9 lock #1.
 *
 * # Module discipline
 *
 * Pure service module — Prisma + @growth/shared types only. No tRPC, no
 * Pub/Sub, no logger. Loaded via variable-specifier dynamic import (KAN-689
 * cohort) from apps/api/src/router.ts. Hooks injected by caller.
 */
import {
  VehicleCreateInputSchema,
  VehicleUpdateInputSchema,
  type Vehicle,
  type VehicleStatus,
} from "@growth/shared";

// ─────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────

export class VehicleNotFoundError extends Error {
  constructor() {
    super("Vehicle not found");
    this.name = "VehicleNotFoundError";
  }
}

export class ArchivedVehicleMutationError extends Error {
  constructor() {
    super("Cannot mutate archived vehicle");
    this.name = "ArchivedVehicleMutationError";
  }
}

export class VinAlreadyExistsError extends Error {
  constructor(public tenantId: string, public vin: string) {
    super(`Vehicle with VIN ${vin} already exists for tenant ${tenantId}`);
    this.name = "VinAlreadyExistsError";
  }
}

// ─────────────────────────────────────────────
// Hook contracts (injected by tRPC layer; mirrors product-service:54)
// ─────────────────────────────────────────────

export interface VehicleAuditLogHook {
  writeInTx(
    tx: unknown,
    args: {
      tenantId: string;
      actor: string;
      actionType: string;
      payload: Record<string, unknown>;
      reasoning: string;
    },
  ): Promise<{ id: string }>;
}

export interface VehicleServiceHooks {
  auditLog: VehicleAuditLogHook;
}

// ─────────────────────────────────────────────
// Prisma surface (loose typing — same posture as product-service.ts)
// ─────────────────────────────────────────────

interface VehiclePrismaTx {
  vehicle: {
    create: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
    findFirst: (args: unknown) => Promise<unknown>;
    findMany: (args: unknown) => Promise<unknown>;
    count: (args: unknown) => Promise<number>;
  };
  auditLog: {
    create: (args: unknown) => Promise<{ id: string }>;
  };
}

interface VehiclePrisma {
  $transaction: <T>(fn: (tx: VehiclePrismaTx) => Promise<T>) => Promise<T>;
  vehicle: {
    findFirst: (args: unknown) => Promise<unknown>;
    findMany: (args: unknown) => Promise<unknown>;
    count: (args: unknown) => Promise<number>;
  };
}

// ─────────────────────────────────────────────
// createVehicle — INSERT + AuditLog (atomic via $transaction)
// ─────────────────────────────────────────────

export interface CreateVehicleResult {
  vehicle: Vehicle;
  auditLogId: string;
}

export async function createVehicle(
  prisma: VehiclePrisma,
  tenantId: string,
  input: unknown,
  actor: string,
  hooks: VehicleServiceHooks,
): Promise<CreateVehicleResult> {
  // SPO lock #3: defensive Zod parse at service entry.
  const parsed = VehicleCreateInputSchema.parse(input);

  try {
    return await prisma.$transaction(async (tx) => {
      // Memo 45: explicit VIN duplicate check WHEN VIN is non-null. Null VINs
      // bypass uniqueness intentionally (NULL ≠ NULL under SQL 3VL).
      if (parsed.vin != null) {
        const existing = (await tx.vehicle.findFirst({
          where: { tenantId, vin: parsed.vin },
          select: { id: true },
        })) as { id: string } | null;
        if (existing) {
          throw new VinAlreadyExistsError(tenantId, parsed.vin);
        }
      }

      const vehicle = (await tx.vehicle.create({
        data: {
          tenantId,
          year: parsed.year,
          make: parsed.make,
          model: parsed.model,
          trim: parsed.trim ?? null,
          vin: parsed.vin ?? null,
          mileage: parsed.mileage ?? null,
          bodyStyle: parsed.bodyStyle,
          transmission: parsed.transmission,
          fuelType: parsed.fuelType,
          exteriorColor: parsed.exteriorColor ?? null,
          interiorColor: parsed.interiorColor ?? null,
          drivetrain: parsed.drivetrain,
          condition: parsed.condition,
          stockNumber: parsed.stockNumber ?? null,
          dealerLot: parsed.dealerLot ?? null,
          status: parsed.status,
        },
      })) as Vehicle;

      // Memo 53: distinguishable audit action_type.
      const audit = await hooks.auditLog.writeInTx(tx, {
        tenantId,
        actor,
        actionType: "vehicle.created",
        payload: {
          vehicleId: vehicle.id,
          snapshot: vehicle as unknown as Record<string, unknown>,
        },
        reasoning: `operator ${actor} created vehicle ${vehicle.year} ${vehicle.make} ${vehicle.model}`,
      });

      return { vehicle, auditLogId: audit.id };
    });
  } catch (err) {
    // P2002 race-condition fallback in case the up-front findFirst missed a
    // concurrent insert.
    if (
      err != null &&
      typeof err === "object" &&
      (err as { code?: string }).code === "P2002" &&
      parsed.vin != null
    ) {
      throw new VinAlreadyExistsError(tenantId, parsed.vin);
    }
    throw err;
  }
}

// ─────────────────────────────────────────────
// updateVehicle — partial UPDATE + AuditLog before/after delta
// ─────────────────────────────────────────────

export interface UpdateVehicleResult {
  vehicle: Vehicle;
  auditLogId: string;
}

export async function updateVehicle(
  prisma: VehiclePrisma,
  tenantId: string,
  vehicleId: string,
  input: unknown,
  actor: string,
  hooks: VehicleServiceHooks,
): Promise<UpdateVehicleResult> {
  const parsed = VehicleUpdateInputSchema.parse(input);

  try {
    return await prisma.$transaction(async (tx) => {
      const before = (await tx.vehicle.findFirst({
        where: { id: vehicleId, tenantId },
      })) as Vehicle | null;
      if (!before) throw new VehicleNotFoundError();
      // SPO lock #4: archive is terminal.
      if (before.status === "archived") {
        throw new ArchivedVehicleMutationError();
      }

      // Memo 45: VIN change to non-null must check uniqueness.
      if (
        parsed.vin !== undefined &&
        parsed.vin !== before.vin &&
        parsed.vin !== null
      ) {
        const conflict = (await tx.vehicle.findFirst({
          where: { tenantId, vin: parsed.vin, NOT: { id: vehicleId } },
          select: { id: true },
        })) as { id: string } | null;
        if (conflict) {
          throw new VinAlreadyExistsError(tenantId, parsed.vin);
        }
      }

      const after = (await tx.vehicle.update({
        where: { id: vehicleId },
        data: {
          ...(parsed.year !== undefined && { year: parsed.year }),
          ...(parsed.make !== undefined && { make: parsed.make }),
          ...(parsed.model !== undefined && { model: parsed.model }),
          ...(parsed.trim !== undefined && { trim: parsed.trim }),
          ...(parsed.vin !== undefined && { vin: parsed.vin }),
          ...(parsed.mileage !== undefined && { mileage: parsed.mileage }),
          ...(parsed.bodyStyle !== undefined && { bodyStyle: parsed.bodyStyle }),
          ...(parsed.transmission !== undefined && {
            transmission: parsed.transmission,
          }),
          ...(parsed.fuelType !== undefined && { fuelType: parsed.fuelType }),
          ...(parsed.exteriorColor !== undefined && {
            exteriorColor: parsed.exteriorColor,
          }),
          ...(parsed.interiorColor !== undefined && {
            interiorColor: parsed.interiorColor,
          }),
          ...(parsed.drivetrain !== undefined && {
            drivetrain: parsed.drivetrain,
          }),
          ...(parsed.condition !== undefined && { condition: parsed.condition }),
          ...(parsed.stockNumber !== undefined && {
            stockNumber: parsed.stockNumber,
          }),
          ...(parsed.dealerLot !== undefined && { dealerLot: parsed.dealerLot }),
          ...(parsed.status !== undefined && { status: parsed.status }),
        },
      })) as Vehicle;

      const audit = await hooks.auditLog.writeInTx(tx, {
        tenantId,
        actor,
        actionType: "vehicle.updated",
        payload: {
          vehicleId,
          before: before as unknown as Record<string, unknown>,
          after: after as unknown as Record<string, unknown>,
        },
        reasoning: `operator ${actor} updated vehicle ${after.year} ${after.make} ${after.model}`,
      });

      return { vehicle: after, auditLogId: audit.id };
    });
  } catch (err) {
    if (
      err != null &&
      typeof err === "object" &&
      (err as { code?: string }).code === "P2002" &&
      parsed.vin != null
    ) {
      throw new VinAlreadyExistsError(tenantId, parsed.vin);
    }
    throw err;
  }
}

// ─────────────────────────────────────────────
// archiveVehicle — soft-delete via status='archived' + archivedAt=now()
// ─────────────────────────────────────────────

export interface ArchiveVehicleResult {
  vehicle: Vehicle;
  auditLogId: string;
  /** True if the vehicle was already archived (idempotent re-archive). */
  alreadyArchived: boolean;
}

export async function archiveVehicle(
  prisma: VehiclePrisma,
  tenantId: string,
  vehicleId: string,
  actor: string,
  hooks: VehicleServiceHooks,
): Promise<ArchiveVehicleResult> {
  return prisma.$transaction(async (tx) => {
    const before = (await tx.vehicle.findFirst({
      where: { id: vehicleId, tenantId },
    })) as Vehicle | null;
    if (!before) throw new VehicleNotFoundError();

    // SPO lock #4: archive is idempotent — return existing state on re-archive
    // without logging a duplicate audit row.
    if (before.status === "archived") {
      return { vehicle: before, auditLogId: "", alreadyArchived: true };
    }

    const now = new Date();
    const after = (await tx.vehicle.update({
      where: { id: vehicleId },
      data: {
        status: "archived",
        archivedAt: now,
      },
    })) as Vehicle;

    const audit = await hooks.auditLog.writeInTx(tx, {
      tenantId,
      actor,
      actionType: "vehicle.archived",
      payload: {
        vehicleId,
        archivedAt: now.toISOString(),
        snapshot: after as unknown as Record<string, unknown>,
      },
      reasoning: `operator ${actor} archived vehicle ${after.year} ${after.make} ${after.model}`,
    });

    return { vehicle: after, auditLogId: audit.id, alreadyArchived: false };
  });
}

// ─────────────────────────────────────────────
// getVehicleById — single-row read scoped to tenant
// ─────────────────────────────────────────────

export async function getVehicleById(
  prisma: VehiclePrisma,
  tenantId: string,
  vehicleId: string,
  opts?: { includeArchived?: boolean },
): Promise<Vehicle | null> {
  const where: Record<string, unknown> = { id: vehicleId, tenantId };
  if (!opts?.includeArchived) {
    where.archivedAt = null;
  }
  return (await prisma.vehicle.findFirst({ where })) as Vehicle | null;
}

// ─────────────────────────────────────────────
// listVehicles — paginated list with status + archived filters
// ─────────────────────────────────────────────

export interface ListVehiclesResult {
  items: Vehicle[];
  nextCursor: string | null;
  totalCount: number;
}

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

export async function listVehicles(
  prisma: VehiclePrisma,
  tenantId: string,
  filters: { status?: VehicleStatus; includeArchived?: boolean },
  pagination: { cursor?: string; limit?: number },
): Promise<ListVehiclesResult> {
  const limit = Math.min(
    Math.max(pagination.limit ?? LIST_DEFAULT_LIMIT, 1),
    LIST_MAX_LIMIT,
  );

  const where: Record<string, unknown> = { tenantId };
  if (!filters.includeArchived) {
    where.archivedAt = null;
  }
  if (filters.status !== undefined) {
    where.status = filters.status;
  }

  const totalCount = await prisma.vehicle.count({ where });

  const items = (await prisma.vehicle.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(pagination.cursor
      ? { cursor: { id: pagination.cursor }, skip: 1 }
      : {}),
  })) as Vehicle[];

  const hasMore = items.length > limit;
  const slice = hasMore ? items.slice(0, limit) : items;
  const nextCursor = hasMore ? slice[slice.length - 1]!.id : null;

  return { items: slice, nextCursor, totalCount };
}
