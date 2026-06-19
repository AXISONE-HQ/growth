/**
 * KAN-1216 — drivegood.com dealer adapter (Slice 4).
 *
 * Single adapter per J1 / Memo 54 empirical-priority discipline. vAuto /
 * DealerSocket / EBlock / Trader deferred until PROD signal of dealer-base
 * diversity. Reopen tickets for each platform when their first dealer
 * appears in the customer cohort.
 *
 * Adapter contract:
 *   - parseVin: URL-pattern extraction. Drivegood VDP URLs follow
 *     `/inventory/{VIN}/{slug}` or `/vehicle/{VIN}` shape. The captured
 *     VIN matches ISO 3779 (17 alphanumeric chars excluding I/O/Q).
 *   - parseStockNumber: data-attribute extraction (`[data-stock-number]`).
 *   - enrichFields: overlay dealerLot (and similar dealer-specific
 *     fields) on the generic-extractor base.
 *
 * VIN-case note: the regex character class `[A-HJ-NPR-Z0-9]` matches
 * upper-case ONLY by construction (Phase 1 J3 verdict). The trailing
 * `.toUpperCase()` is defensive — the regex already locks case.
 */
import type * as cheerio from "cheerio";
// KAN-1216 fix-forward: ExtractedVehicleFields hoisted to packages/shared so
// the discriminated union's extracted_partial variant can surface it cleanly.
import type { ExtractedVehicleFields } from "@growth/shared";

export type { ExtractedVehicleFields };

export interface DealerAdapter {
  hostname: string;
  /**
   * KAN-1219 fix-forward — Layer 2 dispatcher hook (Memo 57 anchor #4).
   *
   * Structural hint (meta / og signature) — NOT hostname. Handles
   * SaaS-backed dealers serving on vanity domains. Example: 4mkauto.com
   * (dealer vanity) served by drivegood.com SaaS backend; og:image points
   * at cdn.drivegood.com, meta-author is potenzaglobal.
   *
   * Generalizes to vAuto / DealerSocket / EBlock / Trader patterns.
   */
  fingerprint($: cheerio.CheerioAPI): boolean;
  parseVin(url: string, $: cheerio.CheerioAPI): string | null;
  parseStockNumber($: cheerio.CheerioAPI): string | null;
  enrichFields(
    $: cheerio.CheerioAPI,
    base: ExtractedVehicleFields,
  ): ExtractedVehicleFields;
  /**
   * KAN-1219 (Slice 5) — Parse an inventory listing page and return the
   * URLs of per-vehicle pages (VDPs) to crawl plus, optionally, fully
   * extracted Vehicle fields per entry.
   *
   * KAN-1219 fix-forward (Memo 39 refinement #2 / Option H+I): when the
   * adapter has a structured data source (drivegood's `cars_formatted.json`
   * is the canonical example), it MAY populate `directVehicles` so the
   * crawler can persist Vehicle rows directly without per-VDP HTML scraping.
   * This is required when VDP pages are behind a bot-detection challenge
   * (SiteGround CAPTCHA empirically blocks Cloud Run egress on 4mkauto.com),
   * and is just faster otherwise (one JSON fetch vs N HTTP roundtrips).
   *
   * `directVehicles[].url` is the VDP URL (same shape as `urls`); the
   * crawler keys by URL for audit-trail consistency. `directVehicles[].fields`
   * is a fully-populated ExtractedVehicleFields where every required Vehicle
   * column (year/make/model/bodyStyle/transmission/fuelType/drivetrain/
   * condition) is non-null. Partial JSON entries that can't satisfy the
   * full schema are dropped (not surfaced as `extracted_partial` — direct
   * extract is best-effort completeness; missing entries fall back to the
   * per-VDP scrape path).
   *
   * When `directVehicles` is undefined or empty, the crawler iterates
   * `urls` through its per-VDP scrape pipeline (KAN-1216 vehicle-scraper).
   *
   * @param html  The fetched listing HTML
   * @param $     Cheerio API loaded over `html` (caller-supplied for reuse)
   * @param baseUrl The listing URL (used to resolve relative hrefs)
   * @param deps  Optional fetch override for the SPA-fallback JSON fetch
   * @returns URLs + optional pre-extracted Vehicle fields, in source order.
   */
  parseInventoryListing(
    html: string,
    $: cheerio.CheerioAPI,
    baseUrl: string,
    deps?: { fetchImpl?: typeof fetch },
  ): Promise<{
    urls: string[];
    directVehicles?: Array<{ url: string; fields: ExtractedVehicleFields }>;
  }>;
}

// Drivegood VDP URL patterns: `/inventory/{VIN}/{slug}`, `/vehicle/{VIN}`,
// `/vdp/{VIN}`. ISO 3779 17-char alphanumeric (I/O/Q excluded).
const DRIVEGOOD_VIN_URL_PATTERN = /\/(?:vehicle|inventory|vdp)\/([A-HJ-NPR-Z0-9]{17})\b/i;

export const drivegoodAdapter: DealerAdapter = {
  hostname: "drivegood.com",

  // KAN-1219 fix-forward (Memo 57 #5 sub-refinement — multi-marker
  // defense-in-depth at fingerprint level). Drivegood SaaS-served dealer
  // sites embed identifying meta even when hosted on a vanity domain
  // (e.g., 4mkauto.com). Multiple empirical signatures observed; ANY
  // match dispatches drivegood. Single-marker fingerprint is a single
  // point of failure if PROD egress receives different HTML than local
  // (CDN/geo variation), so we widen across orthogonal markers:
  //   1. og:image points at cdn.drivegood.com
  //   2. meta[author] = potenzaglobalsolutions (the SaaS vendor)
  //   3. body / script text references cdn.drivegood.com or drivegood.com
  //   4. script[src] references /react-cars-app/ (drivegood's React app
  //      bundled inside the WordPress theme)
  fingerprint: ($) => {
    const ogImage = $('meta[property="og:image"]').attr("content") ?? "";
    if (/drivegood/i.test(ogImage)) return true;
    const metaAuthor = $('meta[name="author"]').attr("content") ?? "";
    if (/potenzaglobal/i.test(metaAuthor)) return true;
    if ($('script[src*="/react-cars-app/"]').length > 0) return true;
    const html = $.html();
    if (/cdn\.drivegood\.com|\bdrivegood\.com/i.test(html)) return true;
    return false;
  },

  parseVin: (url: string) => {
    const match = url.match(DRIVEGOOD_VIN_URL_PATTERN);
    if (!match) return null;
    return match[1].toUpperCase();
  },

  parseStockNumber: ($) => {
    const raw = $("[data-stock-number]").first().attr("data-stock-number");
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  },

  enrichFields: ($, base) => {
    const dealerLotRaw = $("[data-dealer-lot]").first().text().trim();
    return {
      ...base,
      dealerLot: dealerLotRaw.length > 0 ? dealerLotRaw : base.dealerLot,
    };
  },

  // KAN-1219 — Drivegood inventory-listing parser. Dual-mode (Memo 57 #5
  // content-rendering-mode sub-refinement):
  //   Mode A (primary) — server-rendered HTML. Selects anchors whose href
  //     matches the VDP shape (`/inventory/{VIN}/...`). Resolves relative
  //     hrefs against `baseUrl` and de-duplicates.
  //   Mode B (fallback) — React SPA shell. When the primary returns zero
  //     anchors AND the page advertises the drivegood React app
  //     (`<script src="…/react-cars-app/…">`), fetch the WordPress theme's
  //     `cars_formatted.json` (the JSON the React app itself loads). Pull
  //     VDP URLs from each entry's `guid` field; fall back to
  //     `${origin}/vehicle/${car_vin}` when `guid` is missing.
  //
  // Why URL-discovery (not direct-extract from JSON):
  //   - VDP pages on drivegood-backed vanity domains ARE server-rendered
  //     (empirically verified at https://www.4mkauto.com/vehicle/{VIN} →
  //     260KB HTML with VIN/title/price). The per-VDP scraper (KAN-1216)
  //     already handles them.
  //   - Preserves the existing per-vehicle pipeline (rate limit, dedup,
  //     error counters, partial-extract semantics). Direct-extract would
  //     fork the persistence path.
  //   - When VDPs ALSO turn out to be SPA-rendered for some future tenant,
  //     the per-VDP scraper can grow its own dual-mode independently.
  //
  // Caller is responsible for response-size caps + timeouts via the
  // injected fetchImpl. We DO NOT validate that the captured segment is
  // a VIN here — the per-URL scrape will fail-soft if the page turns out
  // to be non-VDP. See task #52 for generic React-shell walker.
  parseInventoryListing: async (_html, $, baseUrl, deps) => {
    const seen = new Set<string>();
    const urls: string[] = [];
    let listingBase: URL;
    try {
      listingBase = new URL(baseUrl);
    } catch {
      return { urls };
    }

    // ── Mode A: server-rendered HTML ──────────────────────────────────
    $('a[href*="/inventory/"]').each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      const trimmed = href.trim();
      if (!trimmed) return;
      let resolved: URL;
      try {
        resolved = new URL(trimmed, listingBase);
      } catch {
        return;
      }
      const path = resolved.pathname;
      const vdpRe = /\/inventory\/[^/?#]+/;
      if (!vdpRe.test(path)) return;
      resolved.hash = "";
      const key = resolved.toString();
      if (seen.has(key)) return;
      seen.add(key);
      urls.push(key);
    });
    if (urls.length > 0) return { urls };

    // ── Mode B: React SPA / CAPTCHA-blocked fallback (JSON inventory) ─
    // The cars_formatted.json endpoint is a static file in the WordPress
    // theme. SiteGround anti-bot CAPTCHA (Memo 51 #11 confirmed) does not
    // apply to static asset paths, so this fetch succeeds from Cloud Run
    // egress even when /en/inventory returns a CAPTCHA challenge.
    const reactAppScript = $('script[src*="/react-cars-app/"]').length;
    // KAN-1219 Option H+I: also fall through to JSON when listing body is
    // empty/tiny — CAPTCHA challenge pages strip all markers, so we can't
    // rely on the React app script being present.
    const htmlLength = $.html()?.length ?? 0;
    if (reactAppScript === 0 && htmlLength > 2000) return { urls };

    const fetchImpl = deps?.fetchImpl ?? fetch;
    const jsonUrl =
      listingBase.origin +
      "/wp-content/themes/astra/car_single_page_data/cars_formatted.json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DRIVEGOOD_JSON_TIMEOUT_MS);
    let entries: unknown;
    try {
      const resp = await fetchImpl(jsonUrl, {
        signal: controller.signal,
        redirect: "follow",
        headers: { accept: "application/json" },
      });
      if (!resp.ok) return { urls };
      const text = await resp.text();
      const bodyBytes = Buffer.byteLength(text, "utf8");
      if (bodyBytes > DRIVEGOOD_JSON_MAX_BYTES) {
        console.log(
          JSON.stringify({
            type: "drivegood_json_too_large",
            hostname: listingBase.hostname,
            bodyByteLength: bodyBytes,
            cap: DRIVEGOOD_JSON_MAX_BYTES,
          }),
        );
        return { urls };
      }
      try {
        entries = JSON.parse(text);
      } catch {
        return { urls };
      }
    } catch {
      return { urls };
    } finally {
      clearTimeout(timer);
    }
    if (!Array.isArray(entries)) return { urls };

    const directVehicles: Array<{ url: string; fields: ExtractedVehicleFields }> = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      let candidate: string | null = null;
      if (typeof e.guid === "string" && /^https?:\/\//.test(e.guid)) {
        candidate = e.guid;
      } else if (
        typeof e.car_vin === "string" &&
        /^[A-HJ-NPR-Z0-9]{17}$/i.test(e.car_vin)
      ) {
        candidate = `${listingBase.origin}/vehicle/${e.car_vin.toUpperCase()}`;
      }
      if (!candidate) continue;
      let key: string;
      try {
        const resolved = new URL(candidate);
        resolved.hash = "";
        key = resolved.toString();
      } catch {
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(key);

      // Direct-extract: map JSON fields → ExtractedVehicleFields. Entries
      // missing any required Vehicle enum (bodyStyle/transmission/fuelType/
      // drivetrain/condition) are skipped from the direct path; their URL
      // remains in `urls` so the per-VDP scraper can still attempt them
      // (or fail visibly under CAPTCHA, surfaced via errorSamples).
      const direct = mapDrivegoodEntryToFields(e);
      if (direct) directVehicles.push({ url: key, fields: direct });
    }
    return directVehicles.length > 0
      ? { urls, directVehicles }
      : { urls };
  },
};

// Drivegood JSON entry → ExtractedVehicleFields. Returns null when any
// required Vehicle enum can't be resolved (caller falls back to per-VDP
// scrape for those entries).
function mapDrivegoodEntryToFields(
  e: Record<string, unknown>,
): ExtractedVehicleFields | null {
  const year = parseIntOrNull(e.car_year);
  const make = titleCaseOrNull(e.maker);
  const model = stringOrNull(e.model);
  if (year === null || !make || !model) return null;
  const bodyStyle = mapBodyStyle(stringOrNull(e.car_body));
  const transmission = mapTransmission(stringOrNull(e.car_transmission));
  const fuelType = mapFuelType(stringOrNull(e.car_fuel_type));
  const drivetrain = mapDrivetrain(stringOrNull(e.car_drivetrain));
  const condition = mapCondition(stringOrNull(e.condition));
  if (!bodyStyle || !transmission || !fuelType || !drivetrain || !condition) {
    return null;
  }
  const vinRaw = stringOrNull(e.car_vin);
  const vin = vinRaw && /^[A-HJ-NPR-Z0-9]{17}$/i.test(vinRaw)
    ? vinRaw.toUpperCase()
    : null;
  return {
    year,
    make,
    model,
    trim: stringOrNull(e.car_sub_model) ?? stringOrNull(e.car_trim),
    vin,
    mileage: parseIntOrNull(e.car_mileage),
    bodyStyle,
    transmission,
    fuelType,
    drivetrain,
    condition,
    exteriorColor: titleCaseOrNull(e.car_exterior_color),
    interiorColor: titleCaseOrNull(e.car_interrior_color),
    stockNumber: stringOrNull(e.stock),
    dealerLot: null,
  };
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function parseIntOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = parseInt(v.replace(/[^0-9]/g, ""), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}
function titleCaseOrNull(v: unknown): string | null {
  const s = stringOrNull(v);
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
function mapBodyStyle(s: string | null): string | null {
  if (!s) return null;
  const k = s.toLowerCase();
  const table: Record<string, string> = {
    suv: "suv", sedan: "sedan", truck: "truck", hatchback: "hatchback",
    coupe: "coupe", convertible: "convertible", minivan: "minivan",
    van: "van", wagon: "wagon", crossover: "suv",
  };
  return table[k] ?? null;
}
function mapTransmission(s: string | null): string | null {
  if (!s) return null;
  const k = s.toLowerCase();
  if (k === "automatic" || k === "auto") return "automatic";
  if (k === "manual") return "manual";
  if (k === "cvt") return "cvt";
  if (k === "dct") return "dct";
  return null;
}
function mapFuelType(s: string | null): string | null {
  if (!s) return null;
  const k = s.toLowerCase();
  if (k === "gasoline" || k === "gas") return "gas";
  if (k === "diesel") return "diesel";
  if (k === "hybrid") return "hybrid";
  if (k === "electric" || k === "ev") return "electric";
  if (k === "plugin_hybrid" || k === "phev") return "plugin_hybrid";
  return null;
}
function mapDrivetrain(s: string | null): string | null {
  if (!s) return null;
  const k = s.toLowerCase();
  if (k === "fwd") return "fwd";
  if (k === "rwd") return "rwd";
  if (k === "awd") return "awd";
  if (k === "4wd" || k === "four_wd" || k === "4x4") return "four_wd";
  return null;
}
function mapCondition(s: string | null): string | null {
  if (!s) return null;
  const k = s.toLowerCase();
  if (k === "new") return "new";
  if (k === "used") return "used";
  if (k === "cpo" || k === "certified") return "cpo";
  return null;
}

// Drivegood JSON-fallback fetch caps.
//
// Timeout mirrors vehicle-scraper precedent (5s — fast-fail on slow CDNs).
//
// KAN-1219 fix-forward (Memo 39 refinement — wrong-shape-precedent transfer):
// Body cap was initially 200KB, copied verbatim from vehicle-scraper's
// SCRAPER_MAX_RESPONSE_BYTES. That cap is sized for ONE HTML VDP page; the
// drivegood JSON inventory endpoint legitimately carries N vehicles × M
// fields. Empirical 4mkauto (135 vehicles) = 1.5MB. Franchise dealers
// (500+ vehicles) project to 5-6MB; powersports+auto combined plausibly
// 7-8MB. 10MB cap covers growth headroom while still rejecting pathological
// responses (>10MB JSON inventory is a misconfiguration signal). 5MB initial
// proposal raised to 10MB at SPO Option E refinement.
const DRIVEGOOD_JSON_TIMEOUT_MS = 5000;
const DRIVEGOOD_JSON_MAX_BYTES = 10 * 1024 * 1024;
