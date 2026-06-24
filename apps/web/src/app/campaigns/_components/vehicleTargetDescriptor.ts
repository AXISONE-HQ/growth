/**
 * KAN-1230 B2.3 — map a vehicleTargetDescriptor (proposed by the LLM in the
 * 'product' dimension) to the TargetEntityPanel's vehicle-search inputs.
 *
 * The descriptor uses singular operator-intent fields ({condition:'used',
 * make:'Honda', maxCount:10}); the vehicles.searchForCampaignTarget API uses
 * array filters ({conditionIn:['used'], makeIn:['Honda']}) and has no maxCount.
 * Without this translation the panel passed the raw descriptor through and the
 * API ignored it → the operator saw ALL inventory unfiltered (the gap B2.3
 * closes). `maxCount` is NOT a server filter; it drives the cardinality UX.
 *
 * Structured enum/range fields become removable filter CHIPS (so the operator
 * can drop one). `make`/`model` become the search-box seed text (free-text,
 * editable) per the dispatch — the search already tokenizes make/model.
 */

export interface VehicleSearchFilterSpec {
  conditionIn?: string[];
  makeIn?: string[];
  bodyStyleIn?: string[];
  yearMin?: number;
  yearMax?: number;
  priceMin?: number;
  priceMax?: number;
  searchText?: string;
}

export interface DescriptorFilterChip {
  /** stable key for React + removal */
  key: string;
  /** operator-facing label, e.g. "Condition: Used" */
  label: string;
  /** the search-param contribution this chip applies */
  spec: Partial<VehicleSearchFilterSpec>;
}

export interface VehicleSearchFromDescriptor {
  /** removable structured filters (condition / bodyStyle / year / price) */
  chips: DescriptorFilterChip[];
  /** free-text seed for the search box (make + model) */
  searchSeed: string;
  /** operator-requested cap; undefined when not specified. Drives cardinality. */
  maxCount?: number;
}

function titleCase(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

/**
 * Translate a descriptor to {chips, searchSeed, maxCount}. Tolerant of unknown
 * shapes / missing fields — unmapped fields are silently skipped (edge case 1).
 */
export function descriptorToVehicleSearch(
  descriptor: unknown,
): VehicleSearchFromDescriptor {
  const chips: DescriptorFilterChip[] = [];
  if (!descriptor || typeof descriptor !== "object") {
    return { chips, searchSeed: "" };
  }
  const d = descriptor as Record<string, unknown>;

  if (typeof d.condition === "string" && d.condition) {
    const c = d.condition.toLowerCase();
    chips.push({
      key: "condition",
      label: `Condition: ${c === "cpo" ? "CPO" : titleCase(c)}`,
      spec: { conditionIn: [c] },
    });
  }

  if (typeof d.bodyStyle === "string" && d.bodyStyle) {
    const b = d.bodyStyle.toLowerCase();
    chips.push({
      key: "bodyStyle",
      label: `Body: ${b === "suv" || b === "van" ? b.toUpperCase() : titleCase(b)}`,
      spec: { bodyStyleIn: [b] },
    });
  }

  if (typeof d.year === "number" && Number.isFinite(d.year)) {
    const y = d.year;
    chips.push({
      key: "year",
      label: `Year: ${y}`,
      spec: { yearMin: y, yearMax: y },
    });
  }

  const priceMin = typeof d.priceMin === "number" ? d.priceMin : undefined;
  const priceMax = typeof d.priceMax === "number" ? d.priceMax : undefined;
  if (priceMin !== undefined || priceMax !== undefined) {
    const label =
      priceMin !== undefined && priceMax !== undefined
        ? `Price: ${fmtUsd(priceMin)}–${fmtUsd(priceMax)}`
        : priceMin !== undefined
          ? `Price: ${fmtUsd(priceMin)}+`
          : `Price: up to ${fmtUsd(priceMax as number)}`;
    chips.push({
      key: "price",
      label,
      spec: {
        ...(priceMin !== undefined ? { priceMin } : {}),
        ...(priceMax !== undefined ? { priceMax } : {}),
      },
    });
  }

  // make + model → free-text search seed (editable; not a chip).
  const make = typeof d.make === "string" ? d.make.trim() : "";
  const model = typeof d.model === "string" ? d.model.trim() : "";
  const searchSeed = [make, model].filter(Boolean).join(" ");

  const maxCount =
    typeof d.maxCount === "number" && d.maxCount > 0 ? d.maxCount : undefined;

  return { chips, searchSeed, maxCount };
}

/** Merge a set of active chips' specs (+ optional searchText) into one query. */
export function chipsToFilterSpec(
  chips: DescriptorFilterChip[],
  searchText: string,
): VehicleSearchFilterSpec {
  const merged: VehicleSearchFilterSpec = {};
  for (const chip of chips) Object.assign(merged, chip.spec);
  if (searchText) merged.searchText = searchText;
  return merged;
}
