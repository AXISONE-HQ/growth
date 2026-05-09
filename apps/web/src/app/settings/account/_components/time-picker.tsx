"use client";

/**
 * KAN-857 — TimePicker. Native `<input type="time">` in the existing Input
 * shell so design-token treatment matches the rest of the form. Browser
 * provides keyboard nav (arrow keys adjust by 15-min increments per spec
 * §9) + the HH:mm 24h format string for free.
 *
 * Page-local — not promoted to DS v1 because every consumer to date
 * (Hours tab WeeklyHoursEditor) is the only caller. If a second consumer
 * appears, surface for promotion.
 */
import * as React from "react";
import { Input } from "@/components/ui/input";

interface TimePickerProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
}

export function TimePicker({
  id,
  value,
  onChange,
  ariaLabel,
  disabled,
}: TimePickerProps): React.ReactElement {
  return (
    <Input
      id={id}
      type="time"
      step={900}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      disabled={disabled}
      className="w-32"
    />
  );
}
