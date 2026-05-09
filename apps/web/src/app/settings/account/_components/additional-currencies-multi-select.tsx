"use client";

/**
 * KAN-859 — AdditionalCurrenciesMultiSelect. Multi-select grid of
 * currency checkboxes grouped by region. Auto-excludes the currently
 * selected default currency (parent owns this — passes
 * `excludedCode={defaultCurrency}`).
 *
 * Native `<select multiple>` would be poor UX (no grouping, no
 * keyboard-friendly multi-toggle). Checkbox grid is the established
 * pattern from Cohort 3 ServiceAreaPicker (US states + CA provinces).
 */
import * as React from "react";
import {
  CURRENCY_REGIONS_ORDERED,
  CURRENCIES_BY_REGION,
  formatCurrencyOption,
} from "./currency-catalog";

interface AdditionalCurrenciesMultiSelectProps {
  /** Currently selected additional currencies. */
  value: readonly string[];
  /** Currency code to hide from the picker (typically the default
   * currency). When the default changes, parent should also drop any
   * matching entry from `value` — see usage in payments/page.tsx. */
  excludedCode: string | null;
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

export function AdditionalCurrenciesMultiSelect({
  value,
  excludedCode,
  onChange,
  disabled,
}: AdditionalCurrenciesMultiSelectProps): React.ReactElement {
  function toggle(code: string): void {
    if (value.includes(code)) {
      onChange(value.filter((c) => c !== code));
    } else {
      onChange([...value, code]);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {CURRENCY_REGIONS_ORDERED.map((region) => {
        const inRegion = (CURRENCIES_BY_REGION.get(region) ?? []).filter(
          (c) => c.code !== excludedCode,
        );
        if (inRegion.length === 0) return null;
        return (
          <fieldset
            key={region}
            className="flex flex-col gap-2 m-0 p-0 border-0"
          >
            <legend
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: "var(--ds-ink-tertiary)" }}
            >
              {region}
            </legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {inRegion.map((c) => {
                const id = `additional-currency-${c.code}`;
                const checked = value.includes(c.code);
                return (
                  <label
                    key={c.code}
                    htmlFor={id}
                    className={[
                      "flex items-center gap-2 p-2 rounded-md border cursor-pointer motion-default text-sm",
                      disabled ? "cursor-not-allowed opacity-60" : "",
                    ].join(" ")}
                    style={{
                      borderColor: checked
                        ? "var(--ds-violet-500)"
                        : "var(--ds-border-subtle)",
                      backgroundColor: checked
                        ? "var(--ds-surface-raised)"
                        : "transparent",
                      color: "var(--ds-ink-primary)",
                    }}
                  >
                    <input
                      id={id}
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(c.code)}
                      className="h-4 w-4 [accent-color:var(--ds-violet-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:var(--ds-violet-500)] [--tw-ring-offset-color:var(--ds-ring-offset)]"
                    />
                    <span>{formatCurrencyOption(c)}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
      {value.length === 0 ? (
        <p
          className="text-sm py-3 px-3 rounded-md"
          style={{
            color: "var(--ds-ink-tertiary)",
            backgroundColor: "var(--ds-surface-sunken)",
          }}
        >
          Add currencies you also accept.
        </p>
      ) : null}
    </div>
  );
}
