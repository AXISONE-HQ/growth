/**
 * KAN-1216 (Slice 4 of KAN-1211 epic) — Dealer-page vehicle scraper.
 *
 * Single-URL scraper. NO full-inventory crawler (Slice 5). 7-variant
 * discriminated union per Memo 41. Reuses helpers from product-scraper.ts
 * (Memo 37 pre-hoist export pattern — defer packages/shared hoist until
 * 3rd consumer arrives).
 *
 * # SPO verdict locks
 *
 * 1. **7th variant kept** (Q1) — `tenant_marketing_domain_not_configured`
 *    preserves operator UX precision (button-disable signal before user
 *    attempts scrape).
 *
 * 2. **Schema.org JSON-LD inline parser** (Q3 — Memo 39 anchor #9). No
 *    schema-dts library dep. Inline parse keeps surface tight; ~50 LoC
 *    handler in extractVehicleFields.
 *
 * 3. **Single adapter at Slice 4** (J1, Memo 54). drivegood.com only;
 *    vAuto / DealerSocket / EBlock / Trader deferred until empirical
 *    signal of dealer-base diversity.
 *
 * 4. **Synthesized test fixture** (Q4 — Memo 47). drivegood scenario uses
 *    deterministic HTML mirroring page shape; no live network in CI.
 *
 * 5. **Vehicle.scraped audit action_type** (Q7 — Memo 53). 4th sibling
 *    of product.* family.
 *
 * 6. **VIN as-submitted, no normalization** (carry-forward from KAN-1214
 *    Q3 / Memo 39 anchor #8). ISO 3779 regex already excludes lowercase.
 */
import * as cheerio from "cheerio";
import {
  type VehicleScraperInput,
  type VehicleScraperResult,
  VehicleScraperInputSchema,
  SCRAPER_TIMEOUT_MS,
  SCRAPER_MAX_RESPONSE_BYTES,
} from "@growth/shared";

import {
  hostnameMatches,
  stripSiteSuffix,
  isGenericH1,
} from "./product-scraper.js";
import {
  drivegoodAdapter,
  type DealerAdapter,
  type ExtractedVehicleFields,
} from "./dealer-adapters/drivegood.js";

// ─────────────────────────────────────────────
// Prisma surface (Q6 — NARROW VehicleScraperPrisma; do NOT widen)
// ─────────────────────────────────────────────

export interface VehicleScraperTx {
  vehicle: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
  auditLog: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
}

export interface VehicleScraperPrisma {
  tenant: {
    findUnique: (args: {
      where: { id: string };
      select?: { marketingDomain: true };
    }) => Promise<{ marketingDomain: string | null } | null>;
  };
  $transaction: <T>(fn: (tx: VehicleScraperTx) => Promise<T>) => Promise<T>;
}

export interface VehicleScraperAuditInput {
  tenantId: string;
  actor: string;
  actionType: string;
  payload: Record<string, unknown>;
  reasoning: string;
}

export interface VehicleScraperAuditHook {
  writeInTx: (
    tx: VehicleScraperTx,
    input: VehicleScraperAuditInput,
  ) => Promise<{ id: string }>;
}

export interface VehicleScraperHooks {
  auditLog: VehicleScraperAuditHook;
}

// ─────────────────────────────────────────────
// extractHostnameFromConfigured — local copy (helper not exported from
// product-scraper). Cheap; Memo 37 pre-hoist applies only when ≥3 consumers.
// ─────────────────────────────────────────────

function extractHostnameFromConfigured(configured: string): string {
  try {
    return new URL(configured).hostname;
  } catch {
    return configured.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  }
}

// ─────────────────────────────────────────────
// Adapter dispatch table (J1 — single adapter at Slice 4)
// ─────────────────────────────────────────────

const ADAPTERS: ReadonlyArray<DealerAdapter> = [drivegoodAdapter];

function pickAdapter(hostname: string): DealerAdapter | null {
  const lower = hostname.toLowerCase();
  for (const adapter of ADAPTERS) {
    if (lower === adapter.hostname || lower.endsWith(`.${adapter.hostname}`)) {
      return adapter;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// extractVehicleFields — schema.org JSON-LD priority + og:* fallback
// ─────────────────────────────────────────────

const VIN_REGEX = /\b([A-HJ-NPR-Z0-9]{17})\b/;
const YEAR_REGEX = /\b(19[0-9]{2}|20[0-9]{2})\b/;
const MILEAGE_REGEX = /\b([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})\s*(?:mi|miles|km)\b/i;

const EMPTY_FIELDS: ExtractedVehicleFields = {
  year: null,
  make: null,
  model: null,
  trim: null,
  vin: null,
  mileage: null,
  bodyStyle: null,
  transmission: null,
  fuelType: null,
  drivetrain: null,
  condition: null,
  exteriorColor: null,
  interiorColor: null,
  stockNumber: null,
  dealerLot: null,
};

function pickMeta($: cheerio.CheerioAPI, selector: string): string | null {
  const el = $(selector).first();
  const content = el.attr("content");
  if (!content) return null;
  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pickText($: cheerio.CheerioAPI, selector: string): string | null {
  const el = $(selector).first();
  const text = el.text();
  if (!text) return null;
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : null;
}

/** Lowercase enum normalizer — caller validates against ENUM lists at persist. */
function lower(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = value.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

/**
 * parseJsonLdVehicle — walk <script type="application/ld+json"> blocks and
 * return the first @type='Vehicle' | 'Car' object. Returns null when none
 * found OR when JSON parse fails (per-block try/catch — don't break on one
 * malformed block).
 *
 * Q3 lock: inline parser; no schema-dts library dep.
 */
function parseJsonLdVehicle($: cheerio.CheerioAPI): Record<string, unknown> | null {
  const blocks = $('script[type="application/ld+json"]').toArray();
  for (const node of blocks) {
    const raw = $(node).contents().text();
    if (!raw || raw.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const cand of candidates) {
      if (typeof cand !== "object" || cand === null) continue;
      const t = (cand as { "@type"?: unknown })["@type"];
      const typeStr =
        typeof t === "string" ? t : Array.isArray(t) ? t.find((v) => typeof v === "string") : null;
      if (typeStr === "Vehicle" || typeStr === "Car") {
        return cand as Record<string, unknown>;
      }
    }
  }
  return null;
}

function jsonLdString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && v !== null) {
    const name = (v as { name?: unknown }).name;
    if (typeof name === "string") return name.trim() || null;
  }
  return null;
}

function jsonLdNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, ""));
    if (Number.isFinite(n)) return n;
  }
  if (typeof v === "object" && v !== null) {
    const inner = (v as { value?: unknown }).value;
    if (typeof inner === "number" && Number.isFinite(inner)) return inner;
    if (typeof inner === "string") {
      const n = Number(inner.replace(/,/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

export function extractVehicleFields(
  html: string,
  adapter: DealerAdapter | null,
): ExtractedVehicleFields {
  const $ = cheerio.load(html);
  const fields: ExtractedVehicleFields = { ...EMPTY_FIELDS };

  // ── Step 1: Schema.org JSON-LD (priority) ──────────────────────────────
  const ld = parseJsonLdVehicle($);
  if (ld) {
    const yearRaw = jsonLdNumber(ld, "modelYear") ?? jsonLdNumber(ld, "vehicleModelDate");
    if (yearRaw !== null && Number.isInteger(yearRaw)) fields.year = yearRaw;
    fields.make = jsonLdString(ld, "manufacturer") ?? jsonLdString(ld, "brand");
    fields.model = jsonLdString(ld, "model");
    fields.trim = jsonLdString(ld, "vehicleConfiguration") ?? jsonLdString(ld, "trim");
    fields.vin = jsonLdString(ld, "vehicleIdentificationNumber");
    fields.mileage = jsonLdNumber(ld, "mileageFromOdometer");
    fields.bodyStyle = lower(jsonLdString(ld, "bodyType"));
    fields.transmission = lower(jsonLdString(ld, "vehicleTransmission"));
    fields.fuelType = lower(jsonLdString(ld, "fuelType"));
    fields.drivetrain = lower(jsonLdString(ld, "driveWheelConfiguration"));
    fields.condition = lower(jsonLdString(ld, "itemCondition"));
    fields.exteriorColor = jsonLdString(ld, "color");
    fields.interiorColor = jsonLdString(ld, "vehicleInteriorColor");
  }

  // ── Step 2: og:* / h1 fallback for name fields ─────────────────────────
  // Title shape: "<YEAR> <MAKE> <MODEL> <TRIM?>" — common dealer pattern.
  if (!fields.year || !fields.make || !fields.model) {
    const ogTitle = pickMeta($, 'meta[property="og:title"]');
    const h1 = pickText($, "h1");
    const ogCleaned = ogTitle ? stripSiteSuffix(ogTitle, $) : null;
    const h1Cleaned = h1 && !isGenericH1(h1) ? stripSiteSuffix(h1, $) : null;
    const titleCandidate = ogCleaned ?? h1Cleaned ?? pickMeta($, 'meta[name="title"]');
    if (titleCandidate) {
      const parts = titleCandidate.split(/\s+/).filter(Boolean);
      if (parts.length >= 3) {
        const yearMatch = parts[0]?.match(/^(19[0-9]{2}|20[0-9]{2})$/);
        if (yearMatch && !fields.year) fields.year = Number(yearMatch[1]);
        if (!fields.make) fields.make = parts[1] ?? null;
        if (!fields.model) fields.model = parts[2] ?? null;
        if (!fields.trim && parts.length >= 4) {
          fields.trim = parts.slice(3).join(" ");
        }
      }
    }
  }

  // ── Step 3: body-text fallback for VIN + mileage + year ────────────────
  const bodyText = $("body").text();
  if (!fields.vin) {
    const m = bodyText.match(VIN_REGEX);
    if (m) fields.vin = m[1].toUpperCase();
  }
  if (!fields.year) {
    const m = bodyText.match(YEAR_REGEX);
    if (m) fields.year = Number(m[1]);
  }
  if (fields.mileage == null) {
    const m = bodyText.match(MILEAGE_REGEX);
    if (m) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n)) fields.mileage = n;
    }
  }

  // ── Step 4: og:description for description-style fields (color hints) ──
  // (No-op for current required field list; placeholder for future enrichment.)

  // ── Step 5: adapter overrides (URL-pattern VIN, stock number, dealerLot) ─
  if (adapter) {
    fields.stockNumber = fields.stockNumber ?? adapter.parseStockNumber($);
    const enriched = adapter.enrichFields($, fields);
    Object.assign(fields, enriched);
  }

  return fields;
}

// ─────────────────────────────────────────────
// classifyExtract — required field policy
//
// "Full" requires: year/make/model + all 5 enum families (bodyStyle /
// transmission / fuelType / drivetrain / condition). VIN is OPTIONAL at
// the boundary (Memo 45 NULL semantics) but its absence flags a gap for
// operator review.
// ─────────────────────────────────────────────

interface ClassifiedExtract {
  status: "active" | "draft";
  extractGaps: string[];
  hasMinimumIdentity: boolean;
}

function classifyExtract(fields: ExtractedVehicleFields): ClassifiedExtract {
  const hasMinimumIdentity = fields.year != null && !!fields.make && !!fields.model;
  const gaps: string[] = [];
  if (!fields.bodyStyle) gaps.push("bodyStyle");
  if (!fields.transmission) gaps.push("transmission");
  if (!fields.fuelType) gaps.push("fuelType");
  if (!fields.drivetrain) gaps.push("drivetrain");
  if (!fields.condition) gaps.push("condition");
  if (!fields.vin) gaps.push("vin");
  const status: "active" | "draft" = gaps.length === 0 ? "active" : "draft";
  return { status, extractGaps: gaps, hasMinimumIdentity };
}

// ─────────────────────────────────────────────
// VIN normalization — Memo 39 anchor #8 carry-forward
//
// VIN persisted AS-SUBMITTED (no transformation). The ISO 3779 regex
// already excludes lowercase by character-class construction; toUpperCase
// at extraction time is defensive only.
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// scrapeVehicleUrl — main service entry point
// ─────────────────────────────────────────────

export async function scrapeVehicleUrl(
  prisma: VehicleScraperPrisma,
  tenantId: string,
  input: VehicleScraperInput,
  actor: string,
  hooks: VehicleScraperHooks,
  fetchImpl: typeof fetch = fetch,
): Promise<VehicleScraperResult> {
  // Defensive boundary (M4 lock #3 — same posture as product-scraper).
  const parsed = VehicleScraperInputSchema.parse(input);

  // ── Step 1: tenant.marketingDomain lookup ──────────────────────────────
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { marketingDomain: true },
  });
  if (!tenant || !tenant.marketingDomain) {
    return { kind: "tenant_marketing_domain_not_configured" };
  }

  // ── Step 2: subdomain-aware hostname match (KAN-1217 H3 precedent) ─────
  let inputHost: string;
  try {
    inputHost = new URL(parsed.url).hostname;
  } catch {
    // z.string().url() should reject this at parse; safety net for boundary drift.
    return { kind: "extraction_failed", reason: "invalid URL" };
  }
  const configuredHost = extractHostnameFromConfigured(tenant.marketingDomain);
  if (!hostnameMatches(inputHost, configuredHost)) {
    return {
      kind: "hostname_mismatch",
      hostname: inputHost,
      configuredDomain: configuredHost,
    };
  }

  // ── Step 3: pick adapter (J1 — drivegood only at Slice 4) ──────────────
  const adapter = pickAdapter(inputHost);

  // ── Step 4: fetch with AbortController timeout ─────────────────────────
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT_MS);
  let responseText: string;
  try {
    const resp = await fetchImpl(parsed.url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "AxisOne/1.0 (+https://growth-ai.com; vehicle-scraper; contact: support@growth-ai.com)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!resp.ok) {
      return { kind: "extraction_failed", reason: `HTTP ${resp.status}` };
    }
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("xhtml")) {
      return { kind: "extraction_failed", reason: `unsupported content-type: ${ct}` };
    }
    responseText = await resp.text();
  } catch (err) {
    const isAbort = (err as { name?: string } | null)?.name === "AbortError";
    if (isAbort) return { kind: "fetch_timeout" };
    return {
      kind: "extraction_failed",
      reason: (err as Error)?.message ?? "network error",
    };
  } finally {
    clearTimeout(timer);
  }

  // ── Step 5: response size cap (200KB per J5 REFUTE precedent) ──────────
  const actualBytes = Buffer.byteLength(responseText, "utf8");
  if (actualBytes > SCRAPER_MAX_RESPONSE_BYTES) {
    return {
      kind: "response_too_large",
      maxBytes: SCRAPER_MAX_RESPONSE_BYTES,
      actualBytes,
    };
  }

  // ── Step 6: parse + extract ────────────────────────────────────────────
  const fields = extractVehicleFields(responseText, adapter);

  // Adapter URL-pattern VIN override — applied after extract so URL VIN
  // wins over body-text regex match when both present (Drivegood VIN URL
  // pattern is canonical for that platform).
  if (adapter) {
    const urlVin = adapter.parseVin(parsed.url, cheerio.load(responseText));
    if (urlVin) fields.vin = urlVin;
  }

  // ── Step 7: classify ───────────────────────────────────────────────────
  const classified = classifyExtract(fields);
  if (!classified.hasMinimumIdentity) {
    return {
      kind: "extraction_failed",
      reason: "no parseable vehicle structure",
    };
  }

  // ── Step 7a: partial extract → return WITHOUT persisting ───────────────
  //
  // KAN-1216 fix-forward (Option B): Vehicle Prisma model (KAN-1212) requires
  // bodyStyle / transmission / fuelType / drivetrain / condition as
  // NON-nullable enums. Persisting a partial extract with missing enums
  // would throw PrismaClientValidationError. Instead, surface the extracted
  // fields so the operator can complete via /settings/inventory Create form.
  // Memo 51 #6 — test-found semantic-vs-substrate mismatch.
  if (classified.extractGaps.length > 0) {
    return {
      kind: "extracted_partial",
      extractedFields: { ...fields },
      extractGaps: classified.extractGaps,
    };
  }

  // ── Step 8: persist + write `vehicle.scraped` audit row (FULL only) ────
  //
  // Memo 53 — AuditLog action_type provenance distinguishability.
  // `vehicle.scraped` is the 4th sibling of the product.* family
  // (product.created / product.updated / product.archived / product.scraped)
  // applied to the vehicle vertical. Distinct row-level action_type for
  // queryable provenance (operators-created vs scraper-created split).
  const scrapedAt = new Date().toISOString();
  const { vehicleId } = await prisma.$transaction(async (tx) => {
    const created = await tx.vehicle.create({
      data: {
        tenantId,
        year: fields.year,
        make: fields.make,
        model: fields.model,
        trim: fields.trim,
        vin: fields.vin,
        mileage: fields.mileage,
        bodyStyle: fields.bodyStyle,
        transmission: fields.transmission,
        fuelType: fields.fuelType,
        drivetrain: fields.drivetrain,
        condition: fields.condition,
        exteriorColor: fields.exteriorColor,
        interiorColor: fields.interiorColor,
        stockNumber: fields.stockNumber,
        dealerLot: fields.dealerLot,
        status: classified.status,
      },
    });
    await hooks.auditLog.writeInTx(tx, {
      tenantId,
      actor,
      actionType: "vehicle.scraped",
      payload: {
        vehicleId: created.id,
        externalUrl: parsed.url,
        extractedFields: { ...fields },
        extractGaps: classified.extractGaps,
        scrapedAt,
      },
      reasoning: `scraper (${actor}) scraped vehicle from ${parsed.url} (gaps: none)`,
    });
    return { vehicleId: created.id };
  });

  return { kind: "extracted_full", vehicleId };
}

/** Test seam — exposed for unit-level helper coverage. */
export const _internalForTest = {
  pickAdapter,
  classifyExtract,
  extractHostnameFromConfigured,
  parseJsonLdVehicle,
};
