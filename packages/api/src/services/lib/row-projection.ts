/**
 * KAN-915 — Canonical row projection (raw CSV → typed canonical fields).
 *
 * Pure function. No DB reads, no async, no LLM. Walks `sourceRowData`
 * keyed by `sourceColumn`, maps each via `fieldMappings` to its
 * `targetField`, coerces into typed shapes (Decimal / Date / enum /
 * boolean), and produces the per-entity ProjectedRow.
 *
 * Single source of truth for "what does this CSV row mean as a typed
 * Contact / Company / Deal / Order"? Used by:
 *   - import-row-classification.ts → populate mirror columns at
 *     staging-write time (the cache that KAN-911 dedup keys on + the
 *     review UI displays).
 *   - import-commit.ts → project at commit-time for the canonical
 *     INSERT/UPDATE (defense in depth — if mirror columns ever drift,
 *     commit stays correct).
 *
 * Lossy enum coercion (V1, per KAN-915 directive): unknown enum values
 * log a structured console.warn line and the field returns null. The
 * row still commits. Promote to commit_errors warning channel when
 * customer feedback warrants — until then, grep PROD logs for
 * `[import-projection] Unknown` to see the actual coverage gap by
 * enum name.
 *
 * Boolean parse is permissive (true|1|yes|t case-insensitive → true;
 * false|0|no|f → false; everything else → null).
 *
 * Lookup-kind targets (contactEmail, pipelineName, stageName,
 * companyName) are normalized here (trim; email lowercased) but
 * RESOLUTION to canonical FK ids stays in the commit handlers — the
 * projection only knows about typed values, not DB state.
 *
 * Reserved keys: any sourceRowData key starting with `_` is system
 * metadata (e.g., `_classification` written by KAN-907 row-class)
 * and is never projected. New system-metadata keys MUST follow the
 * `_<name>` convention to inherit this exclusion automatically.
 */
import { Prisma } from "@prisma/client";

// ─────────────────────────────────────────────
// Per-entity projected-row shapes
//
// Every field that the entity's commit handler reads has a typed slot
// here. Unknown / unparseable values land as null. The shapes here
// must stay in sync with the canonical Prisma model insert input.
// ─────────────────────────────────────────────

export type LifecycleStage = "lead" | "mql" | "sql" | "customer" | "lost";
export type ContactSource =
  | "email_inbox"
  | "web_form"
  | "meta_ad"
  | "manual"
  | "csv_import"
  | "api"
  | "hubspot"
  | "stripe"
  | "shopify"
  | "other";

export type CompanyLifecycleStage =
  | "prospect"
  | "customer"
  | "churned"
  | "partner"
  | "vendor";
export type CompanySize =
  | "range_1_10"
  | "range_11_50"
  | "range_51_200"
  | "range_201_1000"
  | "range_1001_5000"
  | "range_5000_plus";
export type TaxIdType = "ein" | "vat" | "gst" | "hst" | "qst" | "abn" | "other";

export type DealStatus = "open" | "won" | "lost";
export type DealLostReason =
  | "price"
  | "timing"
  | "competitor"
  | "no_response"
  | "not_qualified"
  | "feature_gap"
  | "other";

export type OrderStatus =
  | "pending"
  | "paid"
  | "refunded"
  | "partially_refunded"
  | "cancelled"
  | "failed";
export type PaymentMethod = "card" | "ach" | "invoice" | "manual" | "other";
export type PaymentProvider =
  | "stripe"
  | "square"
  | "shopify"
  | "manual"
  | "other";

export interface ProjectedContact {
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  lifecycleStage: LifecycleStage | null;
  source: ContactSource | null;
  segment: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface ProjectedCompany {
  name: string | null;
  legalName: string | null;
  domain: string | null;
  website: string | null;
  industry: string | null;
  sizeRange: CompanySize | null;
  annualRevenue: Prisma.Decimal | null;
  phone: string | null;
  email: string | null;
  description: string | null;
  lifecycleStage: CompanyLifecycleStage | null;
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  billingCity: string | null;
  billingRegion: string | null;
  billingPostalCode: string | null;
  billingCountry: string | null;
  mailingAddressLine1: string | null;
  mailingAddressLine2: string | null;
  mailingCity: string | null;
  mailingRegion: string | null;
  mailingPostalCode: string | null;
  mailingCountry: string | null;
  taxId: string | null;
  taxIdType: TaxIdType | null;
  businessRegistrationNumber: string | null;
  incorporationJurisdiction: string | null;
  isTaxExempt: boolean | null;
  ownerId: string | null;
  linkedinUrl: string | null;
}

export interface ProjectedDeal {
  name: string | null;
  value: Prisma.Decimal | null;
  currency: string | null;
  status: DealStatus | null;
  probability: number | null;
  expectedCloseDate: Date | null;
  closedAt: Date | null;
  lostReason: DealLostReason | null;
  lostReasonDetail: string | null;
  wonProductSummary: string | null;
  ownerId: string | null;
  // Lookup-kind targets — raw normalized values; resolved at commit time.
  contactEmail: string | null;
  companyName: string | null;
  pipelineName: string | null;
  stageName: string | null;
}

export interface ProjectedOrder {
  orderNumber: string | null;
  providerOrderId: string | null;
  status: OrderStatus | null;
  totalAmount: Prisma.Decimal | null;
  taxAmount: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal | null;
  grandTotal: Prisma.Decimal | null;
  currency: string | null;
  placedAt: Date | null;
  paidAt: Date | null;
  refundedAt: Date | null;
  paymentMethod: PaymentMethod | null;
  paymentProvider: PaymentProvider | null;
  customerNotes: string | null;
  // Lookup-kind targets — raw normalized values; resolved at commit time.
  contactEmail: string | null;
  companyName: string | null;
}

export type EntityType = "contacts" | "companies" | "deals" | "orders";

// ─────────────────────────────────────────────
// Enum value tables (mirror schema.prisma)
// ─────────────────────────────────────────────

const LIFECYCLE_STAGE_VALUES: readonly LifecycleStage[] = [
  "lead",
  "mql",
  "sql",
  "customer",
  "lost",
];
const CONTACT_SOURCE_VALUES: readonly ContactSource[] = [
  "email_inbox",
  "web_form",
  "meta_ad",
  "manual",
  "csv_import",
  "api",
  "hubspot",
  "stripe",
  "shopify",
  "other",
];
const COMPANY_LIFECYCLE_STAGE_VALUES: readonly CompanyLifecycleStage[] = [
  "prospect",
  "customer",
  "churned",
  "partner",
  "vendor",
];
const COMPANY_SIZE_VALUES: readonly CompanySize[] = [
  "range_1_10",
  "range_11_50",
  "range_51_200",
  "range_201_1000",
  "range_1001_5000",
  "range_5000_plus",
];
const TAX_ID_TYPE_VALUES: readonly TaxIdType[] = [
  "ein",
  "vat",
  "gst",
  "hst",
  "qst",
  "abn",
  "other",
];
const DEAL_STATUS_VALUES: readonly DealStatus[] = ["open", "won", "lost"];
const DEAL_LOST_REASON_VALUES: readonly DealLostReason[] = [
  "price",
  "timing",
  "competitor",
  "no_response",
  "not_qualified",
  "feature_gap",
  "other",
];
const ORDER_STATUS_VALUES: readonly OrderStatus[] = [
  "pending",
  "paid",
  "refunded",
  "partially_refunded",
  "cancelled",
  "failed",
];
const PAYMENT_METHOD_VALUES: readonly PaymentMethod[] = [
  "card",
  "ach",
  "invoice",
  "manual",
  "other",
];
const PAYMENT_PROVIDER_VALUES: readonly PaymentProvider[] = [
  "stripe",
  "square",
  "shopify",
  "manual",
  "other",
];

// ─────────────────────────────────────────────
// FieldMappingEntry shape (kept loose to avoid a cross-module import
// at the lib layer; the canonical type lives in import-mapping.ts).
// ─────────────────────────────────────────────

export interface FieldMappingEntryLike {
  sourceColumn: string;
  targetField: string;
  confidence: number | null;
}

// ─────────────────────────────────────────────
// Logging context for unknown-enum warnings.
// Pass-through from the caller so the warning has the tenantId +
// importJobId + sourceRowIndex needed to triage.
// ─────────────────────────────────────────────

export interface ProjectionLogContext {
  tenantId: string;
  importJobId: string;
  sourceRowIndex: number;
}

// ─────────────────────────────────────────────
// Coercion primitives
// ─────────────────────────────────────────────

/** Trim + null-if-empty. Returns null for non-string / null / "". */
function coerceString(raw: unknown): string | null {
  if (raw == null) return null;
  const str = typeof raw === "string" ? raw : String(raw);
  const trimmed = str.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Email: trim + lowercase. Used by lookup-kind contactEmail too. */
function coerceEmail(raw: unknown): string | null {
  const str = coerceString(raw);
  return str == null ? null : str.toLowerCase();
}

/** Decimal parse via Prisma.Decimal. Returns null on parse error. */
function coerceDecimal(raw: unknown): Prisma.Decimal | null {
  if (raw == null) return null;
  const str = typeof raw === "string" ? raw.trim() : String(raw);
  if (str.length === 0) return null;
  try {
    return new Prisma.Decimal(str);
  } catch {
    return null;
  }
}

/** Integer parse + optional clamp. NaN/non-finite → null. */
function coerceInt(
  raw: unknown,
  opts: { min?: number; max?: number } = {},
): number | null {
  if (raw == null) return null;
  const str = typeof raw === "string" ? raw.trim() : String(raw);
  if (str.length === 0) return null;
  const n = Number(str);
  if (!Number.isFinite(n)) return null;
  let v = Math.trunc(n);
  if (opts.min != null && v < opts.min) v = opts.min;
  if (opts.max != null && v > opts.max) v = opts.max;
  return v;
}

/** Date parse via `new Date()`. NaN → null. */
function coerceDate(raw: unknown): Date | null {
  if (raw == null) return null;
  const str = typeof raw === "string" ? raw.trim() : String(raw);
  if (str.length === 0) return null;
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Permissive bool parse. `true|1|yes|t` → true; `false|0|no|f` → false; else null. */
function coerceBool(raw: unknown): boolean | null {
  if (raw == null) return null;
  if (typeof raw === "boolean") return raw;
  const str = (typeof raw === "string" ? raw : String(raw)).trim().toLowerCase();
  if (str === "true" || str === "1" || str === "yes" || str === "t") return true;
  if (str === "false" || str === "0" || str === "no" || str === "f") return false;
  return null;
}

/**
 * Enum coercion — case-insensitive, normalizes whitespace/hyphens to
 * underscores. Returns { value, unknownRaw } so the caller can log
 * the unknown-raw channel without an extra grep.
 */
function coerceEnum<T extends string>(
  raw: unknown,
  allowedValues: readonly T[],
): { value: T | null; unknownRaw: string | null } {
  if (raw == null) return { value: null, unknownRaw: null };
  const rawStr = typeof raw === "string" ? raw : String(raw);
  const normalized = rawStr
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (normalized.length === 0) return { value: null, unknownRaw: null };
  const hit = allowedValues.find((v) => v === normalized);
  return hit ? { value: hit, unknownRaw: null } : { value: null, unknownRaw: rawStr };
}

/**
 * Apply enum coercion + log unknown values via structured console.warn.
 * Centralizes the V1 lossy behavior so every call site emits the same
 * filterable log line (gcloud logging read --filter='textPayload:"[import-projection] Unknown"').
 */
function coerceEnumWithWarn<T extends string>(
  raw: unknown,
  allowedValues: readonly T[],
  enumName: string,
  targetField: string,
  ctx: ProjectionLogContext,
): T | null {
  const result = coerceEnum(raw, allowedValues);
  if (result.value === null && result.unknownRaw !== null) {
    // eslint-disable-next-line no-console
    console.warn(
      `[import-projection] Unknown ${enumName} value: ` +
        `tenantId=${ctx.tenantId} importJobId=${ctx.importJobId} ` +
        `rowIndex=${ctx.sourceRowIndex} field=${targetField} ` +
        `rawValue=${JSON.stringify(result.unknownRaw)}`,
    );
  }
  return result.value;
}

// ─────────────────────────────────────────────
// FieldMappings → raw-value lookup helpers
//
// The projection walks the entity's expected canonical fields and for
// each one finds the mapped sourceColumn, then reads the raw value
// from sourceRowData. If no mapping exists OR the source key is
// missing OR the operator marked it skip, the field stays null.
// ─────────────────────────────────────────────

function buildLookup(
  fieldMappings: FieldMappingEntryLike[],
): Map<string, string> {
  // targetField → sourceColumn. Skip entries are excluded so they
  // produce null on lookup. Defensive: also drop any mapping whose
  // sourceColumn starts with `_` (reserved for system metadata —
  // e.g., `_classification` written by KAN-907; an operator-supplied
  // mapping should never point at one of these).
  const map = new Map<string, string>();
  for (const entry of fieldMappings) {
    if (entry.targetField === "skip") continue;
    if (entry.sourceColumn.startsWith("_")) continue;
    map.set(entry.targetField, entry.sourceColumn);
  }
  return map;
}

function rawValue(
  sourceRowData: Record<string, unknown>,
  mappings: Map<string, string>,
  targetField: string,
): unknown {
  const sourceColumn = mappings.get(targetField);
  if (sourceColumn == null) return null;
  // Defense in depth — even if a `_`-prefixed sourceColumn slipped
  // past buildLookup, refuse to read it. Reserved for system metadata.
  if (sourceColumn.startsWith("_")) return null;
  // sourceRowData uses the raw CSV header name as keys.
  return sourceRowData[sourceColumn] ?? null;
}

// ─────────────────────────────────────────────
// Public — projectRow
// ─────────────────────────────────────────────

/**
 * Project a raw CSV row + saved field mappings into the typed
 * canonical-entity shape. The return type is the union of all four
 * ProjectedX shapes — the caller narrows based on entityType.
 *
 * NOT async, no DB reads. Safe to call thousands of times per request.
 */
export function projectRow(
  sourceRowData: Record<string, unknown>,
  fieldMappings: FieldMappingEntryLike[],
  entityType: EntityType,
  ctx: ProjectionLogContext,
): ProjectedContact | ProjectedCompany | ProjectedDeal | ProjectedOrder {
  const lookup = buildLookup(fieldMappings);
  const get = (target: string): unknown => rawValue(sourceRowData, lookup, target);

  switch (entityType) {
    case "contacts":
      return projectContact(get, ctx);
    case "companies":
      return projectCompany(get, ctx);
    case "deals":
      return projectDeal(get, ctx);
    case "orders":
      return projectOrder(get, ctx);
  }
}

type Getter = (targetField: string) => unknown;

function projectContact(get: Getter, ctx: ProjectionLogContext): ProjectedContact {
  return {
    email: coerceEmail(get("email")),
    phone: coerceString(get("phone")),
    firstName: coerceString(get("firstName")),
    lastName: coerceString(get("lastName")),
    companyName: coerceString(get("companyName")),
    lifecycleStage: coerceEnumWithWarn(
      get("lifecycleStage"),
      LIFECYCLE_STAGE_VALUES,
      "LifecycleStage",
      "lifecycleStage",
      ctx,
    ),
    source: coerceEnumWithWarn(
      get("source"),
      CONTACT_SOURCE_VALUES,
      "ContactSource",
      "source",
      ctx,
    ),
    segment: coerceString(get("segment")),
    addressLine1: coerceString(get("addressLine1")),
    addressLine2: coerceString(get("addressLine2")),
    city: coerceString(get("city")),
    region: coerceString(get("region")),
    postalCode: coerceString(get("postalCode")),
    country: coerceString(get("country")),
  };
}

function projectCompany(get: Getter, ctx: ProjectionLogContext): ProjectedCompany {
  return {
    name: coerceString(get("name")),
    legalName: coerceString(get("legalName")),
    domain: coerceString(get("domain")),
    website: coerceString(get("website")),
    industry: coerceString(get("industry")),
    sizeRange: coerceEnumWithWarn(
      get("sizeRange"),
      COMPANY_SIZE_VALUES,
      "CompanySize",
      "sizeRange",
      ctx,
    ),
    annualRevenue: coerceDecimal(get("annualRevenue")),
    phone: coerceString(get("phone")),
    email: coerceEmail(get("email")),
    description: coerceString(get("description")),
    lifecycleStage: coerceEnumWithWarn(
      get("lifecycleStage"),
      COMPANY_LIFECYCLE_STAGE_VALUES,
      "CompanyLifecycleStage",
      "lifecycleStage",
      ctx,
    ),
    billingAddressLine1: coerceString(get("billingAddressLine1")),
    billingAddressLine2: coerceString(get("billingAddressLine2")),
    billingCity: coerceString(get("billingCity")),
    billingRegion: coerceString(get("billingRegion")),
    billingPostalCode: coerceString(get("billingPostalCode")),
    billingCountry: coerceString(get("billingCountry")),
    mailingAddressLine1: coerceString(get("mailingAddressLine1")),
    mailingAddressLine2: coerceString(get("mailingAddressLine2")),
    mailingCity: coerceString(get("mailingCity")),
    mailingRegion: coerceString(get("mailingRegion")),
    mailingPostalCode: coerceString(get("mailingPostalCode")),
    mailingCountry: coerceString(get("mailingCountry")),
    taxId: coerceString(get("taxId")),
    taxIdType: coerceEnumWithWarn(
      get("taxIdType"),
      TAX_ID_TYPE_VALUES,
      "TaxIdType",
      "taxIdType",
      ctx,
    ),
    businessRegistrationNumber: coerceString(get("businessRegistrationNumber")),
    incorporationJurisdiction: coerceString(get("incorporationJurisdiction")),
    isTaxExempt: coerceBool(get("isTaxExempt")),
    ownerId: coerceString(get("ownerId")),
    linkedinUrl: coerceString(get("linkedinUrl")),
  };
}

function projectDeal(get: Getter, ctx: ProjectionLogContext): ProjectedDeal {
  return {
    name: coerceString(get("name")),
    value: coerceDecimal(get("value")),
    currency: coerceString(get("currency")),
    status: coerceEnumWithWarn(
      get("status"),
      DEAL_STATUS_VALUES,
      "DealStatus",
      "status",
      ctx,
    ),
    probability: coerceInt(get("probability"), { min: 0, max: 100 }),
    expectedCloseDate: coerceDate(get("expectedCloseDate")),
    closedAt: coerceDate(get("closedAt")),
    lostReason: coerceEnumWithWarn(
      get("lostReason"),
      DEAL_LOST_REASON_VALUES,
      "DealLostReason",
      "lostReason",
      ctx,
    ),
    lostReasonDetail: coerceString(get("lostReasonDetail")),
    wonProductSummary: coerceString(get("wonProductSummary")),
    ownerId: coerceString(get("ownerId")),
    contactEmail: coerceEmail(get("contactEmail")),
    companyName: coerceString(get("companyName")),
    pipelineName: coerceString(get("pipelineName")),
    stageName: coerceString(get("stageName")),
  };
}

function projectOrder(get: Getter, ctx: ProjectionLogContext): ProjectedOrder {
  return {
    orderNumber: coerceString(get("orderNumber")),
    providerOrderId: coerceString(get("providerOrderId")),
    status: coerceEnumWithWarn(
      get("status"),
      ORDER_STATUS_VALUES,
      "OrderStatus",
      "status",
      ctx,
    ),
    totalAmount: coerceDecimal(get("totalAmount")),
    taxAmount: coerceDecimal(get("taxAmount")),
    discountAmount: coerceDecimal(get("discountAmount")),
    grandTotal: coerceDecimal(get("grandTotal")),
    currency: coerceString(get("currency")),
    placedAt: coerceDate(get("placedAt")),
    paidAt: coerceDate(get("paidAt")),
    refundedAt: coerceDate(get("refundedAt")),
    paymentMethod: coerceEnumWithWarn(
      get("paymentMethod"),
      PAYMENT_METHOD_VALUES,
      "PaymentMethod",
      "paymentMethod",
      ctx,
    ),
    paymentProvider: coerceEnumWithWarn(
      get("paymentProvider"),
      PAYMENT_PROVIDER_VALUES,
      "PaymentProvider",
      "paymentProvider",
      ctx,
    ),
    customerNotes: coerceString(get("customerNotes")),
    contactEmail: coerceEmail(get("contactEmail")),
    companyName: coerceString(get("companyName")),
  };
}

// ─────────────────────────────────────────────
// Mirror-column subset extractors
//
// The staging-table mirror columns are a strict subset of the
// canonical projection (dedup keys + review UI display). Use these
// helpers in row-classification.ts to project ONLY the columns that
// actually exist on the staging tables.
// ─────────────────────────────────────────────

export function projectedContactMirrorColumns(p: ProjectedContact) {
  return {
    email: p.email,
    phone: p.phone,
    firstName: p.firstName,
    lastName: p.lastName,
    companyName: p.companyName,
    lifecycleStage: p.lifecycleStage,
    source: p.source,
  };
}

export function projectedCompanyMirrorColumns(p: ProjectedCompany) {
  return {
    name: p.name,
    domain: p.domain,
    industry: p.industry,
    billingCity: p.billingCity,
    billingCountry: p.billingCountry,
  };
}

export function projectedDealMirrorColumns(p: ProjectedDeal) {
  return {
    name: p.name,
    value: p.value,
    currency: p.currency,
    status: p.status,
    expectedCloseDate: p.expectedCloseDate,
    contactEmail: p.contactEmail,
    companyName: p.companyName,
    pipelineName: p.pipelineName,
    stageName: p.stageName,
  };
}

export function projectedOrderMirrorColumns(p: ProjectedOrder) {
  return {
    orderNumber: p.orderNumber,
    providerOrderId: p.providerOrderId,
    status: p.status,
    grandTotal: p.grandTotal,
    currency: p.currency,
    placedAt: p.placedAt,
    contactEmail: p.contactEmail,
    companyName: p.companyName,
  };
}
