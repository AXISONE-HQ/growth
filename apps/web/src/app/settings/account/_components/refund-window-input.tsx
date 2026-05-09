"use client";

/**
 * KAN-859 — RefundWindowInput. Number Input with client-side validation
 * per Fred's Decision 3: integer 0-365 (server schema is looser at
 * `int().nonnegative()`; tightening is in scope for KAN-860 follow-up).
 *
 * Empty input => null upstream (matches Cohort 3 RadiusInput pattern in
 * ServiceAreaPicker).
 */
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface RefundWindowInputProps {
  id?: string;
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
}

export function RefundWindowInput({
  id = "refund-window-days",
  value,
  onChange,
  disabled,
}: RefundWindowInputProps): React.ReactElement {
  const [raw, setRaw] = React.useState<string>(value == null ? "" : String(value));
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setRaw(value == null ? "" : String(value));
  }, [value]);

  function handleChange(next: string): void {
    setRaw(next);
    setError(null);
    if (next === "") {
      onChange(null);
      return;
    }
    if (!/^\d+$/.test(next)) {
      setError("Refund window must be a whole number of days.");
      return;
    }
    const n = Number(next);
    if (n < 0 || n > 365) {
      setError("Refund window must be between 0 and 365 days.");
      return;
    }
    onChange(n);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Refund window (days)</Label>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        value={raw}
        disabled={disabled}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="e.g., 14"
        aria-invalid={error != null}
      />
      <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
        Days from purchase the customer can request a refund.
      </p>
      {error ? (
        <p role="alert" className="text-sm" style={{ color: "var(--ds-danger-text)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
