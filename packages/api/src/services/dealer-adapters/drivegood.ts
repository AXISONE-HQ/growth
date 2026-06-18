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

export interface ExtractedVehicleFields {
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  vin: string | null;
  mileage: number | null;
  bodyStyle: string | null;
  transmission: string | null;
  fuelType: string | null;
  drivetrain: string | null;
  condition: string | null;
  exteriorColor: string | null;
  interiorColor: string | null;
  stockNumber: string | null;
  dealerLot: string | null;
}

export interface DealerAdapter {
  hostname: string;
  parseVin(url: string, $: cheerio.CheerioAPI): string | null;
  parseStockNumber($: cheerio.CheerioAPI): string | null;
  enrichFields(
    $: cheerio.CheerioAPI,
    base: ExtractedVehicleFields,
  ): ExtractedVehicleFields;
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
};
