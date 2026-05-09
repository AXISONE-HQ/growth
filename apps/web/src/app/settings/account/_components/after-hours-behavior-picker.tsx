"use client";

/**
 * KAN-857 — AfterHoursBehaviorPicker. RadioGroup composed from native
 * `<input type="radio">` styled with foundation tokens. Three options
 * with sub-captions per spec §7.4. Helper text per spec §8 verbatim.
 *
 * No new RadioGroup primitive in components/ui/ (none exists today;
 * adding one would violate the "compose from existing atoms" Cohort 2
 * convention — page-local only).
 */
import * as React from "react";

export type AfterHoursBehavior =
  | "pause"
  | "send_anyway"
  | "high_confidence_only";

interface Option {
  value: AfterHoursBehavior;
  label: string;
  caption: string;
}

const OPTIONS: readonly Option[] = [
  {
    value: "pause",
    label: "Pause sending until next business hour",
    caption: "AI queues outbound messages and sends when business reopens.",
  },
  {
    value: "send_anyway",
    label: "Send anyway — let AI decide based on contact urgency",
    caption: "AI may send after-hours for high-intent or active conversations.",
  },
  {
    value: "high_confidence_only",
    label: "Send only for high-confidence (>85%) decisions",
    caption: "AI sends only when confidence is high; queues the rest.",
  },
];

interface AfterHoursBehaviorPickerProps {
  value: AfterHoursBehavior;
  onChange: (value: AfterHoursBehavior) => void;
  disabled?: boolean;
}

export function AfterHoursBehaviorPicker({
  value,
  onChange,
  disabled,
}: AfterHoursBehaviorPickerProps): React.ReactElement {
  return (
    <div role="radiogroup" aria-label="After-hours behavior" className="flex flex-col gap-2">
      {OPTIONS.map((opt) => {
        const id = `after-hours-${opt.value}`;
        const isSelected = value === opt.value;
        return (
          <label
            key={opt.value}
            htmlFor={id}
            className={[
              "flex items-start gap-3 p-3 rounded-md border cursor-pointer motion-default",
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
              name="after-hours-behavior"
              value={opt.value}
              checked={isSelected}
              onChange={() => onChange(opt.value)}
              disabled={disabled}
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
    </div>
  );
}
