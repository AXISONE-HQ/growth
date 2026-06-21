/**
 * KAN-1219 Slice F2 — Drivegood (4mkauto) JSON → ReconcileVehicleEntry mapper.
 *
 * Local helper shared by:
 *   - apps/api/src/routes/inventory-sync.ts (GitHub Actions cron POST target)
 *   - apps/api/src/router.ts (vehicles.triggerManualSync tRPC procedure)
 *
 * Inline copy of the field-mapping logic in
 * packages/api/src/services/dealer-adapters/drivegood.ts. The full adapter
 * pulls Cheerio types in; here we only need the JSON→fields transformation.
 * Per Memo 54 empirical-priority, do NOT hoist to a shared package until a
 * 2nd dealer feed lands; both consumers live in apps/api so this local
 * helper is the smallest unification that satisfies DRY without speculative
 * generalization.
 *
 * Returns null when required enum slots can't be mapped — the reconcile
 * call skips those entries (no creation; no false-removal).
 */

export interface ReconcileVehicleEntry {
  vin: string;
  year: number;
  make: string;
  model: string;
  trim?: string | null;
  mileage?: number | null;
  bodyStyle: string;
  transmission: string;
  fuelType: string;
  drivetrain: string;
  condition: string;
  exteriorColor?: string | null;
  interiorColor?: string | null;
  stockNumber?: string | null;
  dealerLot?: string | null;
  price?: number | null;
  photoUrls?: string[];
  description?: string | null;
  features?: string[];
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
function parsePriceOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[^0-9.]/g, ""));
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
  const t: Record<string, string> = {
    suv: "suv", sedan: "sedan", truck: "truck", hatchback: "hatchback",
    coupe: "coupe", convertible: "convertible", minivan: "minivan",
    van: "van", wagon: "wagon", crossover: "suv",
  };
  return t[k] ?? null;
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
function splitCsvUnique(s: unknown): string[] {
  if (typeof s !== "string") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of s.split(",")) {
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
function buildPhotoUrls(e: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const candidates = [e.photo, ...splitCsvUnique(e.photos)];
  for (const c of candidates) {
    const url = stringOrNull(c);
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function mapDrivegoodEntry(
  e: Record<string, unknown>,
): ReconcileVehicleEntry | null {
  const vinRaw = stringOrNull(e.car_vin);
  if (!vinRaw || !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vinRaw)) return null;
  const year = parseIntOrNull(e.car_year);
  const make = titleCaseOrNull(e.maker);
  const model = stringOrNull(e.model);
  const bodyStyle = mapBodyStyle(stringOrNull(e.car_body));
  const transmission = mapTransmission(stringOrNull(e.car_transmission));
  const fuelType = mapFuelType(stringOrNull(e.car_fuel_type));
  const drivetrain = mapDrivetrain(stringOrNull(e.car_drivetrain));
  const condition = mapCondition(stringOrNull(e.condition));
  if (!year || !make || !model || !bodyStyle || !transmission || !fuelType || !drivetrain || !condition) {
    return null;
  }
  return {
    vin: vinRaw.toUpperCase(),
    year, make, model, bodyStyle, transmission, fuelType, drivetrain, condition,
    trim: stringOrNull(e.car_sub_model) ?? stringOrNull(e.car_trim),
    mileage: parseIntOrNull(e.car_mileage),
    exteriorColor: titleCaseOrNull(e.car_exterior_color),
    interiorColor: titleCaseOrNull(e.car_interrior_color),
    stockNumber: stringOrNull(e.stock),
    dealerLot: null,
    price: parsePriceOrNull(e.car_price),
    photoUrls: buildPhotoUrls(e),
    description: stringOrNull(e.post_content),
    features: splitCsvUnique(e.car_options),
  };
}
