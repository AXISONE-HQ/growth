"use client";

/**
 * KAN-857 — ServiceAreaPicker.
 *
 * RadioGroup (Local / Regional / National / International) with
 * conditional sub-inputs:
 *   - Local       → number input for radius (km)
 *   - Regional    → checkbox-grid multi-select over 64 US/CA regions
 *   - National    → no extra input
 *   - International → no extra input
 *
 * Native `<input type="radio">` styled with foundation tokens (matches
 * AfterHoursBehaviorPicker pattern). Multi-select is a checkbox grid
 * (NOT `<select multiple>` — terrible UX with Cmd-click semantics).
 *
 * Decision B: radius input renders empty with placeholder "e.g., 50";
 * validation enforces positive integer ≤10000 km.
 */
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { US_STATES, CA_PROVINCES } from "./region-catalog";

export type ServiceAreaType = "local" | "regional" | "national" | "international";

interface ServiceAreaPickerProps {
  type: ServiceAreaType;
  radiusKm: number | null;
  regions: string[];
  onTypeChange: (type: ServiceAreaType) => void;
  onRadiusChange: (km: number | null) => void;
  onRegionsChange: (codes: string[]) => void;
  disabled?: boolean;
}

const RADIO_OPTIONS: ReadonlyArray<{ value: ServiceAreaType; label: string }> = [
  { value: "local", label: "Local — a specific area near my address" },
  { value: "regional", label: "Regional — selected states or provinces" },
  { value: "national", label: "National — across the whole country" },
  { value: "international", label: "International — multiple countries" },
];

const MAX_RADIUS_KM = 10_000;

export function ServiceAreaPicker({
  type,
  radiusKm,
  regions,
  onTypeChange,
  onRadiusChange,
  onRegionsChange,
  disabled,
}: ServiceAreaPickerProps): React.ReactElement {
  const [radiusError, setRadiusError] = React.useState<string | null>(null);

  function handleRadiusInput(raw: string): void {
    setRadiusError(null);
    if (raw === "") {
      onRadiusChange(null);
      return;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      setRadiusError("Radius must be a positive whole number.");
      return;
    }
    if (n > MAX_RADIUS_KM) {
      setRadiusError(`Radius must be ${MAX_RADIUS_KM.toLocaleString()} km or less.`);
      return;
    }
    onRadiusChange(n);
  }

  function toggleRegion(code: string): void {
    if (regions.includes(code)) {
      onRegionsChange(regions.filter((c) => c !== code));
    } else {
      onRegionsChange([...regions, code]);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <Label className="text-sm font-medium" style={{ color: "var(--ds-ink-primary)" }}>
        Service area
      </Label>
      <div role="radiogroup" aria-label="Service area type" className="flex flex-col gap-2">
        {RADIO_OPTIONS.map((opt) => {
          const id = `service-area-${opt.value}`;
          const isSelected = type === opt.value;
          return (
            <label
              key={opt.value}
              htmlFor={id}
              className={[
                "flex items-center gap-3 p-3 rounded-md border cursor-pointer motion-default",
                disabled ? "cursor-not-allowed opacity-60" : "",
              ].join(" ")}
              style={{
                borderColor: isSelected
                  ? "var(--ds-violet-500)"
                  : "var(--ds-border-subtle)",
                backgroundColor: isSelected
                  ? "var(--ds-surface-raised)"
                  : "transparent",
              }}
            >
              <input
                id={id}
                type="radio"
                name="service-area-type"
                value={opt.value}
                checked={isSelected}
                onChange={() => onTypeChange(opt.value)}
                disabled={disabled}
                className="h-4 w-4 [accent-color:var(--ds-violet-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:var(--ds-violet-500)] [--tw-ring-offset-color:var(--ds-ring-offset)]"
              />
              <span className="text-sm" style={{ color: "var(--ds-ink-primary)" }}>
                {opt.label}
              </span>
            </label>
          );
        })}
      </div>

      {/* Conditional sub-inputs */}
      {type === "local" ? (
        <div className="flex flex-col gap-2 pl-3" aria-label="Local service area radius">
          <Label htmlFor="service-area-radius">Radius (km)</Label>
          <Input
            id="service-area-radius"
            type="number"
            min="1"
            max={MAX_RADIUS_KM}
            step="1"
            inputMode="numeric"
            value={radiusKm ?? ""}
            onChange={(e) => handleRadiusInput(e.target.value)}
            placeholder="e.g., 50"
            disabled={disabled}
            className="w-32"
          />
          <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
            Distance from your address.
          </p>
          {radiusError ? (
            <p role="alert" className="text-sm" style={{ color: "var(--ds-danger-text)" }}>
              {radiusError}
            </p>
          ) : null}
        </div>
      ) : null}

      {type === "regional" ? (
        <div className="flex flex-col gap-3 pl-3">
          <Label className="text-sm" style={{ color: "var(--ds-ink-primary)" }}>
            Regions you serve
          </Label>
          {regions.length === 0 ? (
            <p
              className="text-xs py-2 px-3 rounded-md"
              style={{
                color: "var(--ds-ink-tertiary)",
                backgroundColor: "var(--ds-surface-sunken)",
              }}
            >
              Pick the regions you serve.
            </p>
          ) : null}
          <fieldset className="flex flex-col gap-3">
            <legend className="sr-only">United States</legend>
            <span
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: "var(--ds-ink-tertiary)" }}
            >
              United States
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {US_STATES.map((r) => (
                <RegionCheckbox
                  key={r.code}
                  code={r.code}
                  label={r.label}
                  checked={regions.includes(r.code)}
                  onToggle={toggleRegion}
                  disabled={disabled}
                />
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-3">
            <legend className="sr-only">Canada</legend>
            <span
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: "var(--ds-ink-tertiary)" }}
            >
              Canada
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {CA_PROVINCES.map((r) => (
                <RegionCheckbox
                  key={r.code}
                  code={r.code}
                  label={r.label}
                  checked={regions.includes(r.code)}
                  onToggle={toggleRegion}
                  disabled={disabled}
                />
              ))}
            </div>
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}

interface RegionCheckboxProps {
  code: string;
  label: string;
  checked: boolean;
  onToggle: (code: string) => void;
  disabled?: boolean;
}

function RegionCheckbox({
  code,
  label,
  checked,
  onToggle,
  disabled,
}: RegionCheckboxProps): React.ReactElement {
  const id = `region-${code}`;
  return (
    <label
      htmlFor={id}
      className="flex items-center gap-2 cursor-pointer text-sm"
      style={{ color: "var(--ds-ink-primary)" }}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(code)}
        disabled={disabled}
        className="h-4 w-4 [accent-color:var(--ds-violet-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:var(--ds-violet-500)] [--tw-ring-offset-color:var(--ds-ring-offset)]"
        aria-label={label}
      />
      {label}
    </label>
  );
}
