/**
 * KAN-1212 (Slice 1 of KAN-1211 epic) — Vehicle Inventory shared schema.
 *
 * Single source of truth for Vehicle shape across workspaces:
 *   - apps/api    — vehicles.list / create / update / archive procedures
 *                   (substrate in this slice; service module deferred to Slice 2)
 *   - apps/web    — Settings vehicle inventory UI (Slice 3)
 *   - apps/connectors — feed-import target (deferred)
 *
 * # Memo 45 NULL semantics — VIN nullable uniqueness
 *
 * VIN is OPTIONAL at the Zod boundary (`z.string().regex(VIN_REGEX).nullable().optional()`).
 * The Prisma `@@unique([tenantId, vin])` constraint allows multiple NULL-VIN
 * rows per tenant because NULL ≠ NULL under SQL three-valued logic. This
 * matches the doctrine documented at the Vehicle model header. Operators
 * inserting unidentified inventory (legacy / private sale / pre-1981) skip
 * the VIN check; insertions with a present VIN must be tenant-unique.
 *
 * # Memo 53 audit provenance
 *
 * Service-layer consumers (KAN-1212 Slice 2) emit audit_log action_types
 * `vehicle.created` / `vehicle.updated` / `vehicle.archived` — distinct from
 * `product.*` because Vehicle is a separate vertical entity, not a Product
 * specialization. The taxonomy keeps cross-entity audit queries unambiguous.
 *
 * # dealerLot deferral (KAN-1213 forward reference)
 *
 * `dealerLot` is a free-form `String?` column in this slice. Future
 * normalization to a dedicated DealerLot entity tracked in KAN-1213. Per
 * Memo 54 empirical-priority discipline — no speculative normalization
 * without measured cardinality signal.
 *
 * # VIN regex (ISO 3779)
 *
 * 17 alphanumeric characters EXCLUDING I, O, Q (avoid digit ambiguity per
 * ISO 3779). Application-layer enforcement; the DB column is plain TEXT.
 *
 * # Year bounds
 *
 * Lower bound 1900 covers pre-war collector cars; upper bound `CURRENT_YEAR + 2`
 * supports MY-ahead-of-CY ordering pattern (e.g. 2027 MY orderable in 2026).
 *
 * # KAN-1219 Slice A — price (Memo 39 Decimal-coercion-at-boundary)
 *
 * `price` is `z.number().nullable().optional()` at the JSON boundary; Prisma
 * coerces `Decimal(10,2)` ↔ JS `number` at serialization. Mirrors
 * `Product.price` at packages/shared/src/products.ts:66 — NOT Int cents.
 * Ceiling 9,999,999.99 matches the Prisma DB precision; positive constraint
 * rules out negative prices (sentinel for fixture bugs). Tenant-currency for
 * now (explicit `currency` column deferred per Memo 54 empirical-priority).
 */
import { z } from "zod";

export const VEHICLE_STATUSES = ["draft", "active", "archived"] as const;
export const VehicleStatusEnum = z.enum(VEHICLE_STATUSES);
export type VehicleStatus = z.infer<typeof VehicleStatusEnum>;

export const BODY_STYLES = [
  "suv",
  "sedan",
  "truck",
  "hatchback",
  "coupe",
  "convertible",
  "minivan",
  "van",
  "wagon",
] as const;
export const BodyStyleEnum = z.enum(BODY_STYLES);
export type BodyStyle = z.infer<typeof BodyStyleEnum>;

export const TRANSMISSIONS = ["automatic", "manual", "cvt", "dct"] as const;
export const TransmissionEnum = z.enum(TRANSMISSIONS);
export type Transmission = z.infer<typeof TransmissionEnum>;

export const FUEL_TYPES = [
  "gas",
  "diesel",
  "hybrid",
  "electric",
  "plugin_hybrid",
] as const;
export const FuelTypeEnum = z.enum(FUEL_TYPES);
export type FuelType = z.infer<typeof FuelTypeEnum>;

export const DRIVETRAINS = ["fwd", "rwd", "awd", "four_wd"] as const;
export const DrivetrainEnum = z.enum(DRIVETRAINS);
export type Drivetrain = z.infer<typeof DrivetrainEnum>;

export const VEHICLE_CONDITIONS = ["new", "used", "cpo"] as const;
export const VehicleConditionEnum = z.enum(VEHICLE_CONDITIONS);
export type VehicleCondition = z.infer<typeof VehicleConditionEnum>;

// ISO 3779 VIN: 17 alphanumeric chars excluding I, O, Q (avoid digit ambiguity).
const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/;
const CURRENT_YEAR = 2026;

export const VehicleCreateInputSchema = z.object({
  year: z.number().int().min(1900).max(CURRENT_YEAR + 2),
  make: z.string().min(1),
  model: z.string().min(1),
  trim: z.string().nullable().optional(),
  vin: z.string().regex(VIN_REGEX).nullable().optional(),
  mileage: z.number().int().min(0).max(999_999).nullable().optional(),
  bodyStyle: BodyStyleEnum,
  transmission: TransmissionEnum,
  fuelType: FuelTypeEnum,
  exteriorColor: z.string().nullable().optional(),
  interiorColor: z.string().nullable().optional(),
  drivetrain: DrivetrainEnum,
  condition: VehicleConditionEnum,
  stockNumber: z.string().nullable().optional(),
  dealerLot: z.string().nullable().optional(),
  // KAN-1219 Slice A — Decimal(10,2) at DB; number at JSON boundary (Memo 39).
  price: z.number().positive().max(9_999_999.99).nullable().optional(),
  status: VehicleStatusEnum.default("draft"),
});

export type VehicleCreateInput = z.infer<typeof VehicleCreateInputSchema>;

export const VehicleUpdateInputSchema = VehicleCreateInputSchema.partial();
export type VehicleUpdateInput = z.infer<typeof VehicleUpdateInputSchema>;

export const VehicleSchema = VehicleCreateInputSchema.extend({
  id: z.string().uuid(),
  tenantId: z.string(),
  archivedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Vehicle = z.infer<typeof VehicleSchema>;

// ─────────────────────────────────────────────────────────────────────────
// KAN-1219 Slice B — list-view filter + sort
//
// `searchText` is case-insensitive `contains` across {make, model, vin,
// stockNumber}. The `In` filters narrow by enum value sets. Numeric range
// filters use `gte`/`lte` semantics; both ends are optional and independent.
// `price` ranges are JS numbers at the JSON boundary per Memo 39 (Prisma
// coerces to Decimal(10,2) at query construction).
// ─────────────────────────────────────────────────────────────────────────

export const VEHICLE_LIST_SORTS = [
  "createdAt_desc",
  "year_asc",
  "year_desc",
  "mileage_asc",
  "mileage_desc",
  "price_asc",
  "price_desc",
] as const;
export const VehicleListSortEnum = z.enum(VEHICLE_LIST_SORTS);
export type VehicleListSort = z.infer<typeof VehicleListSortEnum>;

export const VehicleListFiltersSchema = z.object({
  status: VehicleStatusEnum.optional(),
  includeArchived: z.boolean().optional(),
  searchText: z.string().min(1).max(120).optional(),
  makeIn: z.array(z.string().min(1)).max(50).optional(),
  bodyStyleIn: z.array(BodyStyleEnum).max(BODY_STYLES.length).optional(),
  transmissionIn: z.array(TransmissionEnum).max(TRANSMISSIONS.length).optional(),
  fuelTypeIn: z.array(FuelTypeEnum).max(FUEL_TYPES.length).optional(),
  drivetrainIn: z.array(DrivetrainEnum).max(DRIVETRAINS.length).optional(),
  conditionIn: z
    .array(VehicleConditionEnum)
    .max(VEHICLE_CONDITIONS.length)
    .optional(),
  yearMin: z.number().int().min(1900).max(CURRENT_YEAR + 2).optional(),
  yearMax: z.number().int().min(1900).max(CURRENT_YEAR + 2).optional(),
  mileageMin: z.number().int().min(0).max(999_999).optional(),
  mileageMax: z.number().int().min(0).max(999_999).optional(),
  priceMin: z.number().nonnegative().max(9_999_999.99).optional(),
  priceMax: z.number().nonnegative().max(9_999_999.99).optional(),
  sort: VehicleListSortEnum.optional(),
});
export type VehicleListFilters = z.infer<typeof VehicleListFiltersSchema>;
