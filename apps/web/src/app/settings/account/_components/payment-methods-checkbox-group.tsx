"use client";

/**
 * KAN-859 — PaymentMethodsCheckboxGroup. Six native checkboxes laid out
 * in two columns. Each option matches the AcceptedPaymentMethod enum
 * from packages/shared (`["card", "ach", "wire", "check", "stripe", "paypal"]`).
 *
 * Page-local — no new DS primitive. Pattern mirrors the native-radio
 * approach from Cohort 3 AfterHoursBehaviorPicker.
 */
import * as React from "react";

export type AcceptedPaymentMethod =
  | "card"
  | "ach"
  | "wire"
  | "check"
  | "stripe"
  | "paypal";

interface MethodOption {
  value: AcceptedPaymentMethod;
  label: string;
  caption: string;
}

const OPTIONS: readonly MethodOption[] = [
  { value: "card", label: "Card", caption: "Visa, Mastercard, Amex via your processor." },
  { value: "ach", label: "ACH", caption: "Direct bank transfer (US)." },
  { value: "wire", label: "Wire", caption: "Bank wire transfer (international)." },
  { value: "check", label: "Check", caption: "Mailed paper check." },
  { value: "stripe", label: "Stripe", caption: "Stripe Checkout link." },
  { value: "paypal", label: "PayPal", caption: "PayPal account or guest checkout." },
];

interface PaymentMethodsCheckboxGroupProps {
  value: readonly AcceptedPaymentMethod[];
  onChange: (next: AcceptedPaymentMethod[]) => void;
  disabled?: boolean;
}

export function PaymentMethodsCheckboxGroup({
  value,
  onChange,
  disabled,
}: PaymentMethodsCheckboxGroupProps): React.ReactElement {
  function toggle(method: AcceptedPaymentMethod): void {
    if (value.includes(method)) {
      onChange(value.filter((m) => m !== method));
    } else {
      onChange([...value, method]);
    }
  }

  return (
    <fieldset
      aria-label="Accepted payment methods"
      className="grid grid-cols-1 sm:grid-cols-2 gap-2 m-0 p-0 border-0"
    >
      <legend className="sr-only">Accepted payment methods</legend>
      {OPTIONS.map((opt) => {
        const id = `payment-method-${opt.value}`;
        const checked = value.includes(opt.value);
        return (
          <label
            key={opt.value}
            htmlFor={id}
            className={[
              "flex items-start gap-3 p-3 rounded-md border cursor-pointer motion-default",
              disabled ? "cursor-not-allowed opacity-60" : "",
            ].join(" ")}
            style={{
              borderColor: checked
                ? "var(--ds-violet-500)"
                : "var(--ds-border-subtle)",
              backgroundColor: checked
                ? "var(--ds-surface-raised)"
                : "transparent",
            }}
          >
            <input
              id={id}
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() => toggle(opt.value)}
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
        );
      })}
    </fieldset>
  );
}
