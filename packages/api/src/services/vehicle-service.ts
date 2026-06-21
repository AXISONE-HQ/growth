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
  type VehicleListSort,
  type BodyStyle,
  type Transmission,
  type FuelType,
  type Drivetrain,
  type VehicleCondition,
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
          price: parsed.price ?? null,
          photoUrls: parsed.photoUrls ?? [],
          description: parsed.description ?? null,
          features: parsed.features ?? [],
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
          ...(parsed.price !== undefined && { price: parsed.price }),
          ...(parsed.photoUrls !== undefined && { photoUrls: parsed.photoUrls }),
          ...(parsed.description !== undefined && { description: parsed.description }),
          ...(parsed.features !== undefined && { features: parsed.features }),
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
// listVehicles — paginated list with KAN-1219 Slice B filter + sort
// expansion. Existing { status, includeArchived } shape preserved; new
// dimensions are optional. Cursor pagination still keys off `id` (the
// sort tiebreaker), so cursors stay stable across sort changes within
// a single sort+filter context. Sort changes invalidate cursors —
// callers must reset on sort change.
// ─────────────────────────────────────────────

export interface ListVehiclesResult {
  items: Vehicle[];
  nextCursor: string | null;
  totalCount: number;
}

export interface ListVehiclesFilters {
  status?: VehicleStatus;
  includeArchived?: boolean;
  searchText?: string;
  makeIn?: string[];
  bodyStyleIn?: BodyStyle[];
  transmissionIn?: Transmission[];
  fuelTypeIn?: FuelType[];
  drivetrainIn?: Drivetrain[];
  conditionIn?: VehicleCondition[];
  yearMin?: number;
  yearMax?: number;
  mileageMin?: number;
  mileageMax?: number;
  priceMin?: number;
  priceMax?: number;
  sort?: VehicleListSort;
}

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;

function buildSortOrderBy(
  sort: VehicleListSort | undefined,
): Array<Record<string, "asc" | "desc">> {
  // `id` tiebreaker is mandatory for cursor pagination stability.
  switch (sort) {
    case "year_asc":
      return [{ year: "asc" }, { id: "desc" }];
    case "year_desc":
      return [{ year: "desc" }, { id: "desc" }];
    case "mileage_asc":
      return [{ mileage: "asc" }, { id: "desc" }];
    case "mileage_desc":
      return [{ mileage: "desc" }, { id: "desc" }];
    case "price_asc":
      return [{ price: "asc" }, { id: "desc" }];
    case "price_desc":
      return [{ price: "desc" }, { id: "desc" }];
    case "createdAt_desc":
    case undefined:
    default:
      return [{ createdAt: "desc" }, { id: "desc" }];
  }
}

function buildRange(
  min: number | undefined,
  max: number | undefined,
): Record<string, number> | undefined {
  if (min === undefined && max === undefined) return undefined;
  const range: Record<string, number> = {};
  if (min !== undefined) range.gte = min;
  if (max !== undefined) range.lte = max;
  return range;
}

export async function listVehicles(
  prisma: VehiclePrisma,
  tenantId: string,
  filters: ListVehiclesFilters,
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
  if (filters.searchText) {
    const q = filters.searchText.trim();
    if (q.length > 0) {
      where.OR = [
        { make: { contains: q, mode: "insensitive" } },
        { model: { contains: q, mode: "insensitive" } },
        { vin: { contains: q, mode: "insensitive" } },
        { stockNumber: { contains: q, mode: "insensitive" } },
      ];
    }
  }
  if (filters.makeIn && filters.makeIn.length > 0) {
    where.make = { in: filters.makeIn };
  }
  if (filters.bodyStyleIn && filters.bodyStyleIn.length > 0) {
    where.bodyStyle = { in: filters.bodyStyleIn };
  }
  if (filters.transmissionIn && filters.transmissionIn.length > 0) {
    where.transmission = { in: filters.transmissionIn };
  }
  if (filters.fuelTypeIn && filters.fuelTypeIn.length > 0) {
    where.fuelType = { in: filters.fuelTypeIn };
  }
  if (filters.drivetrainIn && filters.drivetrainIn.length > 0) {
    where.drivetrain = { in: filters.drivetrainIn };
  }
  if (filters.conditionIn && filters.conditionIn.length > 0) {
    where.condition = { in: filters.conditionIn };
  }
  const yearRange = buildRange(filters.yearMin, filters.yearMax);
  if (yearRange) where.year = yearRange;
  const mileageRange = buildRange(filters.mileageMin, filters.mileageMax);
  if (mileageRange) where.mileage = mileageRange;
  const priceRange = buildRange(filters.priceMin, filters.priceMax);
  if (priceRange) where.price = priceRange;

  const totalCount = await prisma.vehicle.count({ where });

  const items = (await prisma.vehicle.findMany({
    where,
    orderBy: buildSortOrderBy(filters.sort),
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

// ─────────────────────────────────────────────────────────────────────
// KAN-1219 Slice F1 — reconcileInventory
// ─────────────────────────────────────────────────────────────────────
//
// Reconciles a tenant's inventory against a fresh dealer-feed snapshot.
// Called by the GitHub Actions daily cron (KAN-1219 Slice F2) and the
// manual Sync Now button. Pure service function — Prisma + audit hooks
// only; no Pub/Sub, no HTTP.
//
// Semantics:
//   - For each entry in the snapshot keyed by VIN (entries without VIN
//     are skipped at this stage — Memo 45 NULL semantics; manual import
//     path handles VIN-null cases separately):
//       * VIN exists, archived=false, removedAt IS NULL → UPDATE
//         lastSeenAt = NOW(); refresh feed-derived fields; audit
//         vehicle.sync_seen.
//       * VIN does not exist → INSERT with firstSeenAt = lastSeenAt =
//         NOW(); audit vehicle.sync_created.
//       * VIN exists but archived=true → SKIP (operator chose to archive;
//         do not resurrect via feed).
//       * VIN exists with removedAt non-null → SKIP (vehicle was
//         previously removed; do not bring back automatically — operator
//         decides via UI in Slice F3).
//   - For each pre-existing vehicle (archived=false, removedAt IS NULL)
//     whose VIN is NOT in the snapshot → SET removedAt = NOW(); audit
//     vehicle.sync_removed.
//
// Idempotent: calling reconcileInventory twice with the same snapshot
// produces 0 creates, 0 removes; lastSeenAt advances on each call.
//
// Per-row tx so a single bad row doesn't roll back the whole sync.
// Returns counts + error samples.

export interface ReconcileVehicleEntry {
  vin: string;
  year: number;
  make: string;
  model: string;
  trim?: string | null;
  mileage?: number | null;
  bodyStyle: BodyStyle;
  transmission: Transmission;
  fuelType: FuelType;
  drivetrain: Drivetrain;
  condition: VehicleCondition;
  exteriorColor?: string | null;
  interiorColor?: string | null;
  stockNumber?: string | null;
  dealerLot?: string | null;
  price?: number | null;
  photoUrls?: string[];
  description?: string | null;
  features?: string[];
}

export interface ReconcileError {
  vin: string;
  phase: "seen" | "created" | "removed";
  message: string;
}

export interface ReconcileResult {
  seenCount: number;
  createdCount: number;
  updatedCount: number;
  removedCount: number;
  unchangedCount: number;
  errors: ReconcileError[];
}

interface ReconcileExistingRow {
  id: string;
  vin: string;
  archivedAt: Date | null;
  removedAt: Date | null;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  mileage: number | null;
  bodyStyle: BodyStyle;
  transmission: Transmission;
  fuelType: FuelType;
  drivetrain: Drivetrain;
  condition: VehicleCondition;
  exteriorColor: string | null;
  interiorColor: string | null;
  stockNumber: string | null;
  dealerLot: string | null;
  price: { toNumber: () => number } | null;
  photoUrls: string[];
  description: string | null;
  features: string[];
}

interface ReconcileVehiclePrisma extends VehiclePrisma {
  vehicle: VehiclePrisma["vehicle"] & {
    findMany: (args: unknown) => Promise<unknown>;
  };
}

function hasFieldChanged<T>(a: T, b: T): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
    return false;
  }
  return a !== b;
}

export async function reconcileInventory(
  prisma: ReconcileVehiclePrisma,
  tenantId: string,
  entries: ReconcileVehicleEntry[],
  source: string,
  hooks: VehicleServiceHooks,
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    seenCount: 0,
    createdCount: 0,
    updatedCount: 0,
    removedCount: 0,
    unchangedCount: 0,
    errors: [],
  };

  const byVin = new Map<string, ReconcileVehicleEntry>();
  for (const e of entries) {
    if (typeof e.vin !== "string" || e.vin.length !== 17) continue;
    byVin.set(e.vin.toUpperCase(), e);
  }
  const feedVins = [...byVin.keys()];

  // Load all matching + all candidate-for-removal rows in one round-trip.
  const existing = (await prisma.vehicle.findMany({
    where: { tenantId },
    select: {
      id: true, vin: true, archivedAt: true, removedAt: true,
      year: true, make: true, model: true, trim: true, mileage: true,
      bodyStyle: true, transmission: true, fuelType: true, drivetrain: true,
      condition: true, exteriorColor: true, interiorColor: true,
      stockNumber: true, dealerLot: true, price: true,
      photoUrls: true, description: true, features: true,
    },
  })) as ReconcileExistingRow[];

  const existingByVin = new Map<string, ReconcileExistingRow>();
  for (const row of existing) {
    if (row.vin) existingByVin.set(row.vin.toUpperCase(), row);
  }

  // Pass 1 — seen / created.
  for (const vin of feedVins) {
    const entry = byVin.get(vin)!;
    const row = existingByVin.get(vin);
    try {
      if (row) {
        // Archived / removed VINs are skipped (don't resurrect).
        if (row.archivedAt != null || row.removedAt != null) {
          continue;
        }
        // UPDATE — refresh lastSeenAt + any changed field.
        await prisma.$transaction(async (tx) => {
          const update: Record<string, unknown> = { lastSeenAt: new Date() };
          if (hasFieldChanged(row.year, entry.year)) update.year = entry.year;
          if (hasFieldChanged(row.make, entry.make)) update.make = entry.make;
          if (hasFieldChanged(row.model, entry.model)) update.model = entry.model;
          if (entry.trim !== undefined && hasFieldChanged(row.trim, entry.trim ?? null)) update.trim = entry.trim ?? null;
          if (entry.mileage !== undefined && hasFieldChanged(row.mileage, entry.mileage ?? null)) update.mileage = entry.mileage ?? null;
          if (hasFieldChanged(row.bodyStyle, entry.bodyStyle)) update.bodyStyle = entry.bodyStyle;
          if (hasFieldChanged(row.transmission, entry.transmission)) update.transmission = entry.transmission;
          if (hasFieldChanged(row.fuelType, entry.fuelType)) update.fuelType = entry.fuelType;
          if (hasFieldChanged(row.drivetrain, entry.drivetrain)) update.drivetrain = entry.drivetrain;
          if (hasFieldChanged(row.condition, entry.condition)) update.condition = entry.condition;
          if (entry.exteriorColor !== undefined && hasFieldChanged(row.exteriorColor, entry.exteriorColor ?? null)) update.exteriorColor = entry.exteriorColor ?? null;
          if (entry.interiorColor !== undefined && hasFieldChanged(row.interiorColor, entry.interiorColor ?? null)) update.interiorColor = entry.interiorColor ?? null;
          if (entry.stockNumber !== undefined && hasFieldChanged(row.stockNumber, entry.stockNumber ?? null)) update.stockNumber = entry.stockNumber ?? null;
          if (entry.dealerLot !== undefined && hasFieldChanged(row.dealerLot, entry.dealerLot ?? null)) update.dealerLot = entry.dealerLot ?? null;
          if (entry.price !== undefined) {
            const rowPrice = row.price ? row.price.toNumber() : null;
            if (hasFieldChanged(rowPrice, entry.price ?? null)) update.price = entry.price ?? null;
          }
          if (entry.photoUrls !== undefined && hasFieldChanged(row.photoUrls, entry.photoUrls)) update.photoUrls = entry.photoUrls;
          if (entry.description !== undefined && hasFieldChanged(row.description, entry.description ?? null)) update.description = entry.description ?? null;
          if (entry.features !== undefined && hasFieldChanged(row.features, entry.features)) update.features = entry.features;

          const changedKeys = Object.keys(update).filter((k) => k !== "lastSeenAt");
          await tx.vehicle.update({ where: { id: row.id }, data: update });
          await hooks.auditLog.writeInTx(tx, {
            tenantId,
            actor: source,
            actionType: "vehicle.sync_seen",
            payload: {
              vehicleId: row.id,
              vin,
              fieldsChanged: changedKeys,
              extractionSource: source,
            },
            reasoning: `reconcileInventory sync_seen — ${vin} (${changedKeys.length} field(s) updated; source=${source})`,
          });
          result.seenCount++;
          if (changedKeys.length > 0) result.updatedCount++;
          else result.unchangedCount++;
        });
      } else {
        // CREATE — new VIN; insert with firstSeenAt = lastSeenAt = NOW().
        await prisma.$transaction(async (tx) => {
          const created = (await tx.vehicle.create({
            data: {
              tenantId,
              year: entry.year,
              make: entry.make,
              model: entry.model,
              trim: entry.trim ?? null,
              vin,
              mileage: entry.mileage ?? null,
              bodyStyle: entry.bodyStyle,
              transmission: entry.transmission,
              fuelType: entry.fuelType,
              drivetrain: entry.drivetrain,
              condition: entry.condition,
              exteriorColor: entry.exteriorColor ?? null,
              interiorColor: entry.interiorColor ?? null,
              stockNumber: entry.stockNumber ?? null,
              dealerLot: entry.dealerLot ?? null,
              price: entry.price ?? null,
              photoUrls: entry.photoUrls ?? [],
              description: entry.description ?? null,
              features: entry.features ?? [],
              status: "active",
            },
          })) as { id: string };
          await hooks.auditLog.writeInTx(tx, {
            tenantId,
            actor: source,
            actionType: "vehicle.sync_created",
            payload: {
              vehicleId: created.id,
              vin,
              extractionSource: source,
            },
            reasoning: `reconcileInventory sync_created — new VIN ${vin} (${entry.year} ${entry.make} ${entry.model}; source=${source})`,
          });
          result.createdCount++;
        });
      }
    } catch (err) {
      result.errors.push({
        vin,
        phase: row ? "seen" : "created",
        message: (err instanceof Error ? err.message : String(err)).slice(0, 240),
      });
    }
  }

  // Pass 2 — removed. Vehicles previously visible (archived=false,
  // removedAt=null) whose VIN is NOT in the current feed.
  const feedVinSet = new Set(feedVins);
  for (const row of existing) {
    if (!row.vin) continue;
    if (row.archivedAt != null) continue;
    if (row.removedAt != null) continue;
    if (feedVinSet.has(row.vin.toUpperCase())) continue;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.vehicle.update({
          where: { id: row.id },
          data: { removedAt: new Date() },
        });
        await hooks.auditLog.writeInTx(tx, {
          tenantId,
          actor: source,
          actionType: "vehicle.sync_removed",
          payload: {
            vehicleId: row.id,
            vin: row.vin,
            extractionSource: source,
          },
          reasoning: `reconcileInventory sync_removed — VIN ${row.vin} absent from current feed (source=${source})`,
        });
        result.removedCount++;
      });
    } catch (err) {
      result.errors.push({
        vin: row.vin,
        phase: "removed",
        message: (err instanceof Error ? err.message : String(err)).slice(0, 240),
      });
    }
  }

  return result;
}
