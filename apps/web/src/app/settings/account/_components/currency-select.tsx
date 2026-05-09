"use client";

/**
 * KAN-859 — CurrencySelect (default currency picker). Native `<select>`
 * grouped by region via `<optgroup>` per Fred's Decision 4. Options
 * formatted as `"USD — US Dollar ($)"`.
 *
 * Pattern mirrors Cohort 3 TimezoneSelect (native select + optgroup).
 * Native browser typeahead handles "USD" / "EUR" / "GBP" without a
 * full combobox primitive.
 */
import * as React from "react";
import {
  CURRENCY_REGIONS_ORDERED,
  CURRENCIES_BY_REGION,
  formatCurrencyOption,
} from "./currency-catalog";

interface CurrencySelectProps {
  id: string;
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
}

export function CurrencySelect({
  id,
  value,
  onChange,
  disabled,
}: CurrencySelectProps): React.ReactElement {
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
      aria-label="Default currency"
    >
      {CURRENCY_REGIONS_ORDERED.map((region) => (
        <optgroup key={region} label={region}>
          {(CURRENCIES_BY_REGION.get(region) ?? []).map((c) => (
            <option key={c.code} value={c.code}>
              {formatCurrencyOption(c)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
