/**
 * KAN-1219 fix-forward — Generic hostname-restricted link-walk adapter
 * (Memo 57 anchor #4 — Layer 3 of the defense-in-depth dispatcher).
 *
 * Last-resort generic adapter — degraded extraction quality (no
 * platform-specific selectors), but FUNCTIONAL. Returns `true` for
 * fingerprint() (sentinel — always matches when Layer 2 falls through).
 *
 * The dispatcher in inventory-crawler.ts NEVER returns null with this
 * adapter present. Memo 19 / 42 affordance-honesty discipline —
 * graceful degradation, no hard-fail on unknown platforms.
 *
 * # Behavior
 *
 * - hostname: `*` sentinel — Layer 1 hostname-iteration MUST skip this
 *   entry. Dispatcher returns it only as the final fallback after Layer 2
 *   fingerprint match also failed.
 * - fingerprint: always returns `true`.
 * - parseVin: VIN extraction via ISO 3779 17-char regex over the URL
 *   first, then falls back to page text. Generic — no dealer-specific
 *   URL shape.
 * - parseStockNumber: null (no platform-specific data-attribute).
 * - enrichFields: pass-through (no platform-specific enrichment).
 * - parseInventoryListing: discovers SAME-HOSTNAME hrefs matching either
 *   a VIN-slug regex OR common path patterns (/inventory/|/vdp/|/vehicle/
 *   |/listing/). De-duplicates. Returns absolute URLs.
 */
import type * as cheerio from "cheerio";
import type { DealerAdapter } from "./drivegood.js";

// ISO 3779 17-char alphanumeric VIN (excludes I/O/Q).
const VIN_REGEX = /\b([A-HJ-NPR-Z0-9]{17})\b/i;

// Common VDP path patterns observed across dealer SaaS platforms.
const VDP_PATH_PATTERN = /\/(?:inventory|vdp|vehicle|listing)\/[^/?#]+/i;

export const genericHostnameRestrictedAdapter: DealerAdapter = {
  // Sentinel hostname — dispatcher's Layer 1 hostname-iteration MUST NOT
  // match this entry (it's only returned as the final fallback).
  hostname: "*",

  fingerprint: () => true,

  parseVin: (url, $) => {
    // Try URL first.
    const urlMatch = url.match(VIN_REGEX);
    if (urlMatch) return urlMatch[1]!.toUpperCase();
    // Fall back to page text (h1 / og:title / body).
    const pageText =
      ($('meta[property="og:title"]').attr("content") ?? "") +
      " " +
      ($("h1").first().text() ?? "");
    const textMatch = pageText.match(VIN_REGEX);
    if (textMatch) return textMatch[1]!.toUpperCase();
    return null;
  },

  parseStockNumber: () => null,

  enrichFields: (_$, base) => base,

  parseInventoryListing: (_html, $, baseUrl) => {
    const seen = new Set<string>();
    const out: string[] = [];
    let listingBase: URL;
    try {
      listingBase = new URL(baseUrl);
    } catch {
      return out;
    }
    const listingHost = listingBase.hostname.toLowerCase();

    $("a[href]").each((_, el) => {
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
      // Layer 3 discipline — hostname-restricted: never walk off the
      // listing host (mirrors vehicle-scraper hostnameMatches precedent).
      if (resolved.hostname.toLowerCase() !== listingHost) return;
      // Match either a VIN-slug or a VDP path pattern.
      const path = resolved.pathname;
      const matchesVin = VIN_REGEX.test(path);
      const matchesPath = VDP_PATH_PATTERN.test(path);
      if (!matchesVin && !matchesPath) return;
      resolved.hash = "";
      const key = resolved.toString();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(key);
    });
    return out;
  },
};
