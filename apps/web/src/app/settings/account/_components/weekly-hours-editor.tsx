"use client";

/**
 * KAN-857 — WeeklyHoursEditor.
 *
 * 7 day rows. Each row: day label · TimePicker (open) · "to" · TimePicker
 * (close) · Switch (closed). Plus an "Apply same hours to all" button at
 * the top.
 *
 * State semantics (Decisions 6, 7, A):
 *
 *   6. Initial state — when `value` is `{}` or any day key missing,
 *      that day defaults to `{ closed: true }`. Switch ON, TimePickers
 *      hidden, muted "Closed" label visible.
 *
 *   7. "Apply same hours to all" — disabled when every day is closed.
 *      Otherwise: copies the FIRST non-closed day's open/close to every
 *      OTHER non-closed day. Closed days stay closed.
 *
 *   A. Closed-day hours preservation — toggling a day from open → closed
 *      hides the TimePickers but RETAINS their value in component state.
 *      Toggling back open restores the previous open/close. The serialized
 *      payload (what gets sent to the server) only includes open/close
 *      for non-closed days; the discriminated-union HoursUpdateSchema in
 *      packages/shared rejects { closed: true, open, close } shapes.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TimePicker } from "./time-picker";

const DAYS = [
  { key: "monday", label: "Monday" },
  { key: "tuesday", label: "Tuesday" },
  { key: "wednesday", label: "Wednesday" },
  { key: "thursday", label: "Thursday" },
  { key: "friday", label: "Friday" },
  { key: "saturday", label: "Saturday" },
  { key: "sunday", label: "Sunday" },
] as const;
type DayKey = (typeof DAYS)[number]["key"];

export type DayHours =
  | { closed: true }
  | { closed: false; open: string; close: string };

export type WeeklyHours = Record<DayKey, DayHours>;

/** What WeeklyHoursEditor tracks internally — keeps open/close around
 * even when a day is closed (Decision A: preserve on toggle). */
interface InternalDayState {
  closed: boolean;
  open: string;
  close: string;
}
type InternalState = Record<DayKey, InternalDayState>;

/** Hydrate internal state from the server-shape value. Missing keys
 * default to closed (Decision 6). */
function hydrateInternalState(value: Partial<WeeklyHours>): InternalState {
  const result = {} as InternalState;
  for (const { key } of DAYS) {
    const dh = value[key];
    if (dh && dh.closed === false) {
      result[key] = { closed: false, open: dh.open, close: dh.close };
    } else {
      // Empty / missing key / { closed: true } → closed by default
      // with sensible 09:00–17:00 hours retained for toggle-back.
      result[key] = { closed: true, open: "09:00", close: "17:00" };
    }
  }
  return result;
}

/** Serialize internal state back to the WeeklyHoursSchema-compatible
 * shape for save. Closed days emit { closed: true } only — discriminated
 * union rejects { closed: true, open, close }. */
function serializeForSave(state: InternalState): WeeklyHours {
  const result = {} as WeeklyHours;
  for (const { key } of DAYS) {
    const s = state[key];
    if (s.closed) {
      result[key] = { closed: true };
    } else {
      result[key] = { closed: false, open: s.open, close: s.close };
    }
  }
  return result;
}

interface WeeklyHoursEditorProps {
  value: Partial<WeeklyHours>;
  onChange: (next: WeeklyHours) => void;
  disabled?: boolean;
}

export function WeeklyHoursEditor({
  value,
  onChange,
  disabled,
}: WeeklyHoursEditorProps): React.ReactElement {
  const [state, setState] = React.useState<InternalState>(() =>
    hydrateInternalState(value),
  );
  // Re-hydrate when the server value changes (post-save refetch).
  // Skip when the parent is feeding us back our own most-recent
  // serialization (would clobber the in-flight closed-but-preserved state).
  const lastSerializedRef = React.useRef<string>("");
  React.useEffect(() => {
    const incoming = JSON.stringify(value);
    if (incoming === lastSerializedRef.current) return;
    lastSerializedRef.current = incoming;
    setState(hydrateInternalState(value));
  }, [value]);

  function commit(next: InternalState): void {
    setState(next);
    const serialized = serializeForSave(next);
    lastSerializedRef.current = JSON.stringify(serialized);
    onChange(serialized);
  }

  function handleToggleClosed(key: DayKey, nextClosed: boolean): void {
    commit({ ...state, [key]: { ...state[key], closed: nextClosed } });
  }

  function handleTimeChange(key: DayKey, field: "open" | "close", v: string): void {
    commit({ ...state, [key]: { ...state[key], [field]: v } });
  }

  const firstNonClosed = DAYS.find(({ key }) => !state[key].closed);
  const allClosed = !firstNonClosed;

  function handleApplyAll(): void {
    if (!firstNonClosed) return;
    const source = state[firstNonClosed.key];
    const next = { ...state };
    for (const { key } of DAYS) {
      if (next[key].closed) continue; // Decision 7: preserve closed
      next[key] = { closed: false, open: source.open, close: source.close };
    }
    commit(next);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium" style={{ color: "var(--ds-ink-primary)" }}>
          Weekly hours
        </Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleApplyAll}
          disabled={disabled || allClosed}
          title={allClosed ? "Open at least one day first." : undefined}
          aria-label="Apply same hours to all open days"
        >
          Apply same hours to all
        </Button>
      </div>
      <ul className="flex flex-col gap-2">
        {DAYS.map(({ key, label }) => {
          const s = state[key];
          const switchId = `weekly-hours-${key}-closed`;
          const openId = `weekly-hours-${key}-open`;
          const closeId = `weekly-hours-${key}-close`;
          return (
            <li
              key={key}
              className="flex items-center gap-3 p-3 rounded-md border"
              style={{ borderColor: "var(--ds-border-subtle)" }}
            >
              <span
                className="text-sm font-medium w-24 flex-shrink-0"
                style={{ color: "var(--ds-ink-primary)" }}
              >
                {label}
              </span>
              {s.closed ? (
                <span
                  className="text-sm flex-1"
                  style={{ color: "var(--ds-ink-tertiary)" }}
                >
                  Closed
                </span>
              ) : (
                <div className="flex items-center gap-2 flex-1">
                  <TimePicker
                    id={openId}
                    value={s.open}
                    onChange={(v) => handleTimeChange(key, "open", v)}
                    ariaLabel={`${label} open time`}
                    disabled={disabled}
                  />
                  <span className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
                    to
                  </span>
                  <TimePicker
                    id={closeId}
                    value={s.close}
                    onChange={(v) => handleTimeChange(key, "close", v)}
                    ariaLabel={`${label} close time`}
                    disabled={disabled}
                  />
                </div>
              )}
              <div className="flex items-center gap-2 ml-auto">
                <Label htmlFor={switchId} className="text-xs cursor-pointer" style={{ color: "var(--ds-ink-tertiary)" }}>
                  {s.closed ? "Closed" : "Open"}
                </Label>
                <Switch
                  id={switchId}
                  checked={s.closed}
                  onCheckedChange={(c: boolean) => handleToggleClosed(key, c)}
                  disabled={disabled}
                  aria-label={`${label} closed toggle. Toggle off to open this day.`}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
        AI uses these to decide when to send. Inbound replies are processed
        24/7 regardless. Toggle off to open a day.
      </p>
    </div>
  );
}
