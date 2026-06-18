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
   * @param html  The fetched listing HTML
   * @param $     Cheerio API loaded over `html` (caller-supplied for reuse)
   * @param baseUrl The listing URL (used to resolve relative hrefs)
   * @returns Absolute VDP URLs, in source-document order, de-duplicated.
   */
  parseInventoryListing(
    html: string,
    $: cheerio.CheerioAPI,
    baseUrl: string,
  ): string[];
}

// Drivegood VDP URL patterns: `/inventory/{VIN}/{slug}`, `/vehicle/{VIN}`,
// `/vdp/{VIN}`. ISO 3779 17-char alphanumeric (I/O/Q excluded).
const DRIVEGOOD_VIN_URL_PATTERN = /\/(?:vehicle|inventory|vdp)\/([A-HJ-NPR-Z0-9]{17})\b/i;

export const drivegoodAdapter: DealerAdapter = {
  hostname: "drivegood.com",

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

  // KAN-1219 — Drivegood inventory-listing parser. Selects anchors whose
  // href matches the VDP shape (`/inventory/{VIN}/...`). Resolves relative
  // hrefs against `baseUrl` and de-duplicates. We DO NOT validate that the
  // captured segment is a VIN here — the per-URL scrape will fail-soft if
  // the page turns out to be non-VDP. Caller is responsible for caps.
  parseInventoryListing: (_html, $, baseUrl) => {
    const seen = new Set<string>();
    const out: string[] = [];
    let listingBase: URL;
    try {
      listingBase = new URL(baseUrl);
    } catch {
      return out;
    }
    $('a[href*="/inventory/"]').each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      // Skip the listing root itself ("/inventory" or "/inventory/" or
      // "/inventory?page=…"). The VDP shape requires at least one trailing
      // path segment after /inventory/.
      const trimmed = href.trim();
      if (!trimmed) return;
      let resolved: URL;
      try {
        resolved = new URL(trimmed, listingBase);
      } catch {
        return;
      }
      // Per-page heuristic: VDP path must have a non-empty segment after
      // /inventory/. Excludes /inventory and /inventory/ exactly.
      const path = resolved.pathname;
      const vdpRe = /\/inventory\/[^/?#]+/;
      if (!vdpRe.test(path)) return;
      // Normalize on absolute href with no fragment.
      resolved.hash = "";
      const key = resolved.toString();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(key);
    });
    return out;
  },
};
