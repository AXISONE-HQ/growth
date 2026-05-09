"use client";

/**
 * KAN-857 Decision 5 — Timezone Select.
 *
 * Renders the full IANA list grouped by continent prefix via
 * `<optgroup>`. Filters to canonical city-format zones (excludes
 * Etc/*, GMT/*, deprecated POSIX aliases) so the spec §5 strict-list
 * timezone validator (used in Cohort 1 HoursUpdateSchema) accepts every
 * option. Display label is "City, Continent" so typing "to" surfaces
 * Toronto, Tokyo, etc.
 *
 * The list is computed at module load (immutable after first render).
 * On Node 18+ / modern browsers `Intl.supportedValuesOf("timeZone")`
 * returns ~600 zones; the filter narrows to ~400 city-format ones.
 */
import * as React from "react";

interface TimezoneOption {
  value: string;       // canonical IANA, e.g., "America/Toronto"
  label: string;       // "Toronto, America"
  continent: string;   // "America", "Europe", etc.
}

const _ZONES: readonly TimezoneOption[] = (() => {
  type IntlWithSupported = typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  const intl = Intl as IntlWithSupported;
  if (typeof intl.supportedValuesOf !== "function") return [];
  let raw: string[] = [];
  try {
    raw = intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
  const skip = /^(Etc|GMT|UCT|posix|US|Canada|Asia\/Calcutta)\//;
  const cityFormat = /^[A-Z][a-z]+\/[A-Z]/;
  return raw
    .filter((z) => cityFormat.test(z) && !skip.test(z))
    .map<TimezoneOption>((z) => {
      const [continent, ...rest] = z.split("/");
      const city = rest.join("/").replace(/_/g, " ");
      return { value: z, label: `${city}, ${continent}`, continent };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
})();

const _ZONES_BY_CONTINENT: Record<string, TimezoneOption[]> = (() => {
  const grouped: Record<string, TimezoneOption[]> = {};
  for (const z of _ZONES) {
    if (!grouped[z.continent]) grouped[z.continent] = [];
    grouped[z.continent].push(z);
  }
  return grouped;
})();

interface TimezoneSelectProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function TimezoneSelect({
  id,
  value,
  onChange,
  disabled,
}: TimezoneSelectProps): React.ReactElement {
  const continents = Object.keys(_ZONES_BY_CONTINENT).sort();
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="h-10 w-full rounded-md border px-3 text-sm motion-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:var(--ds-violet-500)] [--tw-ring-offset-color:var(--ds-ring-offset)]"
      style={{
        backgroundColor: "var(--ds-surface-base)",
        borderColor: "var(--ds-border-default)",
        color: "var(--ds-ink-primary)",
      }}
    >
      {continents.map((c) => (
        <optgroup key={c} label={c}>
          {_ZONES_BY_CONTINENT[c].map((z) => (
            <option key={z.value} value={z.value}>
              {z.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Test seam — exposes the filtered zone list for vitest assertions
 * without re-running the Intl probe in test code. */
export function _getTimezoneOptionsForTest(): readonly TimezoneOption[] {
  return _ZONES;
}
