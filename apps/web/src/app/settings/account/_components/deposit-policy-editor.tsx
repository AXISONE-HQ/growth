"use client";

/**
 * KAN-859 — DepositPolicyEditor. RadioGroup composed from native radios
 * (No deposit / Percentage / Fixed) + conditional sub-input per type.
 * Client-side validation per Fred's Decision 3:
 *   - Percentage: integer 1-100
 *   - Fixed: positive decimal ≤999999
 *
 * Maps to the flat `depositRequired` + `depositType` + `depositValue`
 * Cohort 1 schema columns:
 *   No deposit  → depositRequired=false, depositType=null, depositValue=null
 *   Percentage  → depositRequired=true, depositType='percentage', depositValue=N
 *   Fixed       → depositRequired=true, depositType='fixed', depositValue=N
 */
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CURRENCIES_BY_CODE } from "./currency-catalog";

export type DepositMode = "none" | "percentage" | "fixed";

interface DepositPolicyEditorProps {
  /** Whether the tenant requires any deposit (drives the radio's
   * "no deposit" branch). */
  required: boolean;
  /** Sub-shape: the type of deposit when required=true. Null when
   * required=false. */
  type: "percentage" | "fixed" | null;
  /** Numeric value (percent or fixed amount). Null when required=false. */
  amount: number | null;
  /** Tenant's default currency — drives the "{currency} amount" label
   * for the Fixed sub-input. Falls back to "USD" for display. */
  defaultCurrencyCode: string | null;
  onChange: (next: { required: boolean; type: "percentage" | "fixed" | null; amount: number | null }) => void;
  disabled?: boolean;
}

const RADIO_OPTIONS: ReadonlyArray<{ mode: DepositMode; label: string; caption: string }> = [
  {
    mode: "none",
    label: "No deposit required",
    caption: "Customer pays in full at booking or invoice.",
  },
  {
    mode: "percentage",
    label: "Percentage of total",
    caption: "Customer pays a percent of the order up front.",
  },
  {
    mode: "fixed",
    label: "Fixed amount",
    caption: "Customer pays a flat amount up front, regardless of order size.",
  },
];

export function DepositPolicyEditor({
  required,
  type,
  amount,
  defaultCurrencyCode,
  onChange,
  disabled,
}: DepositPolicyEditorProps): React.ReactElement {
  const mode: DepositMode = required ? (type ?? "percentage") : "none";

  const [pctRaw, setPctRaw] = React.useState<string>(
    mode === "percentage" && amount != null ? String(amount) : "",
  );
  const [fixedRaw, setFixedRaw] = React.useState<string>(
    mode === "fixed" && amount != null ? String(amount) : "",
  );
  const [pctError, setPctError] = React.useState<string | null>(null);
  const [fixedError, setFixedError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (mode === "percentage") {
      setPctRaw(amount == null ? "" : String(amount));
    }
    if (mode === "fixed") {
      setFixedRaw(amount == null ? "" : String(amount));
    }
  }, [amount, mode]);

  function selectMode(next: DepositMode): void {
    if (next === "none") {
      onChange({ required: false, type: null, amount: null });
      setPctError(null);
      setFixedError(null);
      return;
    }
    if (next === "percentage") {
      const n = pctRaw === "" ? null : Number(pctRaw);
      onChange({
        required: true,
        type: "percentage",
        amount: Number.isFinite(n) ? n : null,
      });
      return;
    }
    // fixed
    const n = fixedRaw === "" ? null : Number(fixedRaw);
    onChange({
      required: true,
      type: "fixed",
      amount: Number.isFinite(n) ? n : null,
    });
  }

  function handlePctChange(next: string): void {
    setPctRaw(next);
    setPctError(null);
    if (next === "") {
      onChange({ required: true, type: "percentage", amount: null });
      return;
    }
    if (!/^\d+$/.test(next)) {
      setPctError("Percent must be a whole number between 1 and 100.");
      return;
    }
    const n = Number(next);
    if (n < 1 || n > 100) {
      setPctError("Percent must be between 1 and 100.");
      return;
    }
    onChange({ required: true, type: "percentage", amount: n });
  }

  function handleFixedChange(next: string): void {
    setFixedRaw(next);
    setFixedError(null);
    if (next === "") {
      onChange({ required: true, type: "fixed", amount: null });
      return;
    }
    if (!/^\d+(\.\d+)?$/.test(next)) {
      setFixedError("Amount must be a positive number.");
      return;
    }
    const n = Number(next);
    if (n < 0 || n > 999999) {
      setFixedError("Amount must be between 0 and 999,999.");
      return;
    }
    onChange({ required: true, type: "fixed", amount: n });
  }

  const currencyLabel =
    defaultCurrencyCode != null && CURRENCIES_BY_CODE.has(defaultCurrencyCode)
      ? defaultCurrencyCode
      : "USD";

  return (
    <div role="radiogroup" aria-label="Deposit policy" className="flex flex-col gap-2">
      {RADIO_OPTIONS.map((opt) => {
        const id = `deposit-${opt.mode}`;
        const selected = mode === opt.mode;
        return (
          <div key={opt.mode} className="flex flex-col gap-2">
            <label
              htmlFor={id}
              className={[
                "flex items-start gap-3 p-3 rounded-md border cursor-pointer motion-default",
                disabled ? "cursor-not-allowed opacity-60" : "",
              ].join(" ")}
              style={{
                borderColor: selected ? "var(--ds-violet-500)" : "var(--ds-border-subtle)",
                backgroundColor: selected
                  ? "var(--ds-surface-raised)"
                  : "transparent",
              }}
            >
              <input
                id={id}
                type="radio"
                name="deposit-policy"
                value={opt.mode}
                checked={selected}
                disabled={disabled}
                onChange={() => selectMode(opt.mode)}
                className="mt-0.5 h-4 w-4 [accent-color:var(--ds-violet-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:var(--ds-violet-500)] [--tw-ring-offset-color:var(--ds-ring-offset)]"
              />
              <div className="flex flex-col gap-0.5 flex-1">
                <span
                  className="text-sm font-medium"
                  style={{ color: "var(--ds-ink-primary)" }}
                >
                  {opt.label}
                </span>
                <span
                  className="text-xs"
                  style={{ color: "var(--ds-ink-tertiary)" }}
                >
                  {opt.caption}
                </span>
              </div>
            </label>
            {selected && opt.mode === "percentage" ? (
              <div className="flex flex-col gap-1.5 pl-7">
                <Label htmlFor="deposit-percent">Percent of total</Label>
                <Input
                  id="deposit-percent"
                  type="text"
                  inputMode="numeric"
                  value={pctRaw}
                  disabled={disabled}
                  onChange={(e) => handlePctChange(e.target.value)}
                  placeholder="e.g., 25"
                  aria-invalid={pctError != null}
                />
                {pctError ? (
                  <p
                    role="alert"
                    className="text-sm"
                    style={{ color: "var(--ds-danger-text)" }}
                  >
                    {pctError}
                  </p>
                ) : null}
              </div>
            ) : null}
            {selected && opt.mode === "fixed" ? (
              <div className="flex flex-col gap-1.5 pl-7">
                <Label htmlFor="deposit-fixed-amount">Amount in {currencyLabel}</Label>
                <Input
                  id="deposit-fixed-amount"
                  type="text"
                  inputMode="decimal"
                  value={fixedRaw}
                  disabled={disabled}
                  onChange={(e) => handleFixedChange(e.target.value)}
                  placeholder="e.g., 500"
                  aria-invalid={fixedError != null}
                />
                {fixedError ? (
                  <p
                    role="alert"
                    className="text-sm"
                    style={{ color: "var(--ds-danger-text)" }}
                  >
                    {fixedError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
