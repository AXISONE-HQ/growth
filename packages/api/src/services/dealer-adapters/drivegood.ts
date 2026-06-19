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
   * KAN-1219 (Slice 5) — Parse an inventory listing page and return the list
   * of per-vehicle URLs (VDPs) to crawl. Returns absolute URLs (resolved
   * against the listing URL).
   *
   * For drivegood: VDP links match the inventory/{VIN}/{slug} pattern
   * (`a[href*="/inventory/"]`). De-duplicated by URL.
   *
   * KAN-1219 fix-forward (Memo 57 #5 content-rendering-mode sub-refinement):
   * Async to support adapters that fall back to a JSON inventory endpoint
   * when the listing is rendered client-side (React SPA shell). The
   * existing server-rendered Cheerio path remains the primary path; the
   * fallback fires only when (a) the primary returns zero anchors AND
   * (b) the page advertises a known SPA marker. Optional `deps.fetchImpl`
   * lets tests stub the JSON fetch.
   *
   * @param html  The fetched listing HTML
   * @param $     Cheerio API loaded over `html` (caller-supplied for reuse)
   * @param baseUrl The listing URL (used to resolve relative hrefs)
   * @param deps  Optional fetch override for the SPA-fallback JSON fetch
   * @returns Absolute VDP URLs, in source-document order, de-duplicated.
   */
  parseInventoryListing(
    html: string,
    $: cheerio.CheerioAPI,
    baseUrl: string,
    deps?: { fetchImpl?: typeof fetch },
  ): Promise<string[]>;
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
    const out: string[] = [];
    let listingBase: URL;
    try {
      listingBase = new URL(baseUrl);
    } catch {
      return out;
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
      out.push(key);
    });
    if (out.length > 0) return out;

    // ── Mode B: React SPA fallback (cars_formatted.json) ──────────────
    // SPA marker: drivegood ships a WordPress theme bundling react-cars-app.
    const reactAppScript = $('script[src*="/react-cars-app/"]').length;
    if (reactAppScript === 0) return out;

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
      if (!resp.ok) return out;
      const text = await resp.text();
      const bodyBytes = Buffer.byteLength(text, "utf8");
      if (bodyBytes > DRIVEGOOD_JSON_MAX_BYTES) {
        // KAN-1219 fix-forward (Memo 19/42 affordance-honesty): cap-exceeded
        // was previously a silent return-empty. Surface the explicit signal
        // so operator diagnosis matches Layer A diagnostic logging shape.
        console.log(
          JSON.stringify({
            type: "drivegood_json_too_large",
            hostname: listingBase.hostname,
            bodyByteLength: bodyBytes,
            cap: DRIVEGOOD_JSON_MAX_BYTES,
          }),
        );
        return out;
      }
      try {
        entries = JSON.parse(text);
      } catch {
        return out;
      }
    } catch {
      return out;
    } finally {
      clearTimeout(timer);
    }
    if (!Array.isArray(entries)) return out;

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
      try {
        const resolved = new URL(candidate);
        resolved.hash = "";
        const key = resolved.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
      } catch {
        continue;
      }
    }
    return out;
  },
};

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
