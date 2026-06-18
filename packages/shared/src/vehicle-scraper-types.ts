/**
 * KAN-1216 (Slice 4 of KAN-1211 epic) — Dealer-page vehicle scraper output contract.
 *
 * Input schema + discriminated result union for the vehicle-scraper service
 * (packages/api/src/services/vehicle-scraper.ts). Consumed by:
 *   - apps/api vehiclesRouter.scrape tRPC procedure (forthcoming slice)
 *   - apps/web /settings/inventory ScrapeVehicleModal (forthcoming slice)
 *
 * # Discriminated union — 7 variants (Q1 lock — KEEP 7th variant)
 *
 *   - extracted_full — all required identity + enum fields extracted;
 *     vehicle persisted with status='active'.
 *   - extracted_partial — name fields present (year/make/model) but one or
 *     more enum / VIN slots missing; persisted with status='draft' +
 *     extractGaps[] populated for operator review.
 *   - tenant_marketing_domain_not_configured — defensive variant; UI button
 *     SHOULD be disabled when this is true. Preserves operator UX precision
 *     (button-disable signal before user attempts scrape) per Q1 verdict.
 *   - hostname_mismatch — input URL hostname does not match the tenant's
 *     configured marketingDomain (subdomain-aware, suffix-attack-guarded).
 *     Mirrors KAN-1217 H3 boundary precedent.
 *   - fetch_timeout — AbortController fired after SCRAPER_TIMEOUT_MS.
 *   - response_too_large — response body exceeded SCRAPER_MAX_RESPONSE_BYTES.
 *   - extraction_failed — fetch returned body but no parseable vehicle
 *     structure (no schema.org JSON-LD, no og:* meta, no usable h1).
 *
 * # SPO verdict locks (Phase 1 trace)
 *
 *   - Q1 — 7th variant kept (tenant_marketing_domain_not_configured) for
 *     operator UX precision; rejection of "merge into extraction_failed".
 *   - Q3 — Schema.org JSON-LD inline parser (no schema-dts dep). Memo 39
 *     anchor #9. Implemented in service layer extractVehicleFields step.
 *   - Q4 — Synthesized test fixtures only; no live network in CI. Memo 47.
 *   - Q6 — Narrow VehicleScraperPrisma surface (no broad ScraperPrisma reuse).
 *   - Q7 — vehicle.scraped audit action_type (4th sibling of product.*
 *     family per Memo 53 dual-audit-type discipline).
 *
 * # Memo anchors
 *
 *   - Memo 37 — pre-hoist helper export pattern (stripSiteSuffix /
 *     isGenericH1 / applySuffixStrip exported from product-scraper.ts;
 *     defer packages/shared hoist until 3rd consumer arrives).
 *   - Memo 39 — codebase precedent over external convention (no schema-dts).
 *   - Memo 41 — discriminated-union exhaustiveness (UI consumer MUST branch
 *     on every variant; rejected-variant must surface to operator per the
 *     handle*Activate precedent).
 *   - Memo 53 — AuditLog action_type provenance distinguishability (every
 *     commit path emits a distinct row-level action_type).
 *   - Memo 54 — empirical-priority discipline (Q-J1 single drivegood
 *     adapter only; vAuto / DealerSocket / EBlock / Trader deferred until
 *     PROD signal of dealer-base diversity).
 *
 * # Resource limits — reused from product-scraper-types
 *
 * SCRAPER_TIMEOUT_MS (5s) + SCRAPER_MAX_RESPONSE_BYTES (200KB) imported
 * and re-exported below — single source of truth. Vehicle dealer pages
 * sit in the same image-heavy storefront band as product pages; the 200KB
 * J5 REFUTE band applies symmetrically.
 */
import { z } from "zod";
import {
  SCRAPER_TIMEOUT_MS,
  SCRAPER_MAX_RESPONSE_BYTES,
} from "./product-scraper-types.js";

// Re-export resource limits so vehicle-scraper consumers import from one place.
export { SCRAPER_TIMEOUT_MS, SCRAPER_MAX_RESPONSE_BYTES };

// ─────────────────────────────────────────────
// Input schema — single URL target
// ─────────────────────────────────────────────

export const VehicleScraperInputSchema = z.object({
  url: z.string().url(),
});
export type VehicleScraperInput = z.infer<typeof VehicleScraperInputSchema>;

// ─────────────────────────────────────────────
// VehicleScraperResult — discriminated return shape (7 variants)
// ─────────────────────────────────────────────

export type VehicleScraperResult =
  | {
      kind: "extracted_full";
      /** Persisted vehicle id (consumer refetches via vehicles.list). */
      vehicleId: string;
    }
  | {
      kind: "extracted_partial";
      /** Persisted vehicle id (status='draft'). */
      vehicleId: string;
      /** Field names missing from the extract (e.g. ["bodyStyle", "vin"]).
       *  Operator UI renders as a hint list. Non-empty by construction. */
      extractGaps: string[];
    }
  | {
      kind: "tenant_marketing_domain_not_configured";
    }
  | {
      kind: "hostname_mismatch";
      /** Hostname parsed from input URL. */
      hostname: string;
      /** Tenant's configured marketingDomain (for operator-facing message). */
      configuredDomain: string;
    }
  | {
      kind: "fetch_timeout";
    }
  | {
      kind: "response_too_large";
      maxBytes: number;
      actualBytes: number;
    }
  | {
      kind: "extraction_failed";
      /** Short human-readable reason (e.g. "no name extracted",
       *  "no parseable structure"). */
      reason: string;
    };
