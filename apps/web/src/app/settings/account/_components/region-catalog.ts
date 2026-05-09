/**
 * KAN-857 — Region catalog for "Regional" service area selection.
 *
 * 50 US states + DC + 13 Canadian provinces/territories = 64 entries
 * total. Stored on AccountProfile.serviceAreaRegions as ISO 3166-2
 * subdivision codes (e.g., "US-FL", "CA-ON") — forward-compat for
 * later expansion to ISO 3166-2 globally without a data migration.
 *
 * KAN-XXX (TBD post-implementation) tracks the upgrade path: when
 * growth expands beyond US/CA, swap this hardcoded list for a fetch
 * against a fuller ISO 3166-2 catalog without changing the storage
 * shape or any consumer.
 */

export interface Region {
  /** ISO 3166-2 subdivision code, e.g., "US-FL" / "CA-ON". Stored verbatim. */
  code: string;
  /** UI display label, e.g., "Florida" / "Ontario". */
  label: string;
  /** Two-letter ISO 3166-1 country code; drives the optgroup. */
  country: "US" | "CA";
}

export const US_STATES: readonly Region[] = [
  { code: "US-AL", label: "Alabama", country: "US" },
  { code: "US-AK", label: "Alaska", country: "US" },
  { code: "US-AZ", label: "Arizona", country: "US" },
  { code: "US-AR", label: "Arkansas", country: "US" },
  { code: "US-CA", label: "California", country: "US" },
  { code: "US-CO", label: "Colorado", country: "US" },
  { code: "US-CT", label: "Connecticut", country: "US" },
  { code: "US-DE", label: "Delaware", country: "US" },
  { code: "US-DC", label: "District of Columbia", country: "US" },
  { code: "US-FL", label: "Florida", country: "US" },
  { code: "US-GA", label: "Georgia", country: "US" },
  { code: "US-HI", label: "Hawaii", country: "US" },
  { code: "US-ID", label: "Idaho", country: "US" },
  { code: "US-IL", label: "Illinois", country: "US" },
  { code: "US-IN", label: "Indiana", country: "US" },
  { code: "US-IA", label: "Iowa", country: "US" },
  { code: "US-KS", label: "Kansas", country: "US" },
  { code: "US-KY", label: "Kentucky", country: "US" },
  { code: "US-LA", label: "Louisiana", country: "US" },
  { code: "US-ME", label: "Maine", country: "US" },
  { code: "US-MD", label: "Maryland", country: "US" },
  { code: "US-MA", label: "Massachusetts", country: "US" },
  { code: "US-MI", label: "Michigan", country: "US" },
  { code: "US-MN", label: "Minnesota", country: "US" },
  { code: "US-MS", label: "Mississippi", country: "US" },
  { code: "US-MO", label: "Missouri", country: "US" },
  { code: "US-MT", label: "Montana", country: "US" },
  { code: "US-NE", label: "Nebraska", country: "US" },
  { code: "US-NV", label: "Nevada", country: "US" },
  { code: "US-NH", label: "New Hampshire", country: "US" },
  { code: "US-NJ", label: "New Jersey", country: "US" },
  { code: "US-NM", label: "New Mexico", country: "US" },
  { code: "US-NY", label: "New York", country: "US" },
  { code: "US-NC", label: "North Carolina", country: "US" },
  { code: "US-ND", label: "North Dakota", country: "US" },
  { code: "US-OH", label: "Ohio", country: "US" },
  { code: "US-OK", label: "Oklahoma", country: "US" },
  { code: "US-OR", label: "Oregon", country: "US" },
  { code: "US-PA", label: "Pennsylvania", country: "US" },
  { code: "US-RI", label: "Rhode Island", country: "US" },
  { code: "US-SC", label: "South Carolina", country: "US" },
  { code: "US-SD", label: "South Dakota", country: "US" },
  { code: "US-TN", label: "Tennessee", country: "US" },
  { code: "US-TX", label: "Texas", country: "US" },
  { code: "US-UT", label: "Utah", country: "US" },
  { code: "US-VT", label: "Vermont", country: "US" },
  { code: "US-VA", label: "Virginia", country: "US" },
  { code: "US-WA", label: "Washington", country: "US" },
  { code: "US-WV", label: "West Virginia", country: "US" },
  { code: "US-WI", label: "Wisconsin", country: "US" },
  { code: "US-WY", label: "Wyoming", country: "US" },
];

export const CA_PROVINCES: readonly Region[] = [
  { code: "CA-AB", label: "Alberta", country: "CA" },
  { code: "CA-BC", label: "British Columbia", country: "CA" },
  { code: "CA-MB", label: "Manitoba", country: "CA" },
  { code: "CA-NB", label: "New Brunswick", country: "CA" },
  { code: "CA-NL", label: "Newfoundland and Labrador", country: "CA" },
  { code: "CA-NS", label: "Nova Scotia", country: "CA" },
  { code: "CA-NT", label: "Northwest Territories", country: "CA" },
  { code: "CA-NU", label: "Nunavut", country: "CA" },
  { code: "CA-ON", label: "Ontario", country: "CA" },
  { code: "CA-PE", label: "Prince Edward Island", country: "CA" },
  { code: "CA-QC", label: "Quebec", country: "CA" },
  { code: "CA-SK", label: "Saskatchewan", country: "CA" },
  { code: "CA-YT", label: "Yukon", country: "CA" },
];

export const ALL_REGIONS: readonly Region[] = [...US_STATES, ...CA_PROVINCES];

/** Fast lookup by code. */
export const REGIONS_BY_CODE: ReadonlyMap<string, Region> = new Map(
  ALL_REGIONS.map((r) => [r.code, r]),
);

export function isValidRegionCode(code: string): boolean {
  return REGIONS_BY_CODE.has(code);
}
