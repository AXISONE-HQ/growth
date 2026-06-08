"use client";

/**
 * KAN-857 — HolidayList. Inline-add row pattern (mirrors
 * SocialProfileList from Cohort 2). Native `<input type="date">` for
 * the date picker — same convention as KAN-850 services pages.
 *
 * Empty state copy from spec §8 verbatim.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { trpcMutation } from "@/lib/api";
import { toast } from "sonner";
import { X } from "lucide-react";

export interface HolidayRow {
  id: string;
  name: string;
  /** ISO date string from the server (YYYY-MM-DD or full ISO datetime). */
  date: string;
  recurring: boolean;
}

interface HolidayListProps {
  holidays: HolidayRow[];
  /** Called after a successful add/remove so the parent re-fetches. */
  onChange: () => void | Promise<void>;
}

function formatDate(iso: string): string {
  // Handle both "2026-12-25" and "2026-12-25T00:00:00.000Z" shapes.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // KAN-1131 PR 2 fix (2026-06-08) — Holiday.date is `@db.Date` (calendar
  // day, stored as midnight UTC). Without `timeZone: 'UTC'` the rendered
  // day shifts by the browser's UTC offset: in America/Toronto (UTC-5),
  // "2026-12-25" was rendering as "December 24". Same bug class as KAN-943
  // (KAN-cohort-3.5 detail pages, fixed via `fmt-date.ts`); this site was
  // missed in the original sweep because the formatter is local to this
  // component instead of going through the shared helper.
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function toIsoDate(iso: string): string {
  // Server may return full datetime; the date input wants YYYY-MM-DD.
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

export function HolidayList({ holidays, onChange }: HolidayListProps): React.ReactElement {
  const [name, setName] = React.useState("");
  const [date, setDate] = React.useState("");
  const [recurring, setRecurring] = React.useState(false);
  const [isAdding, setIsAdding] = React.useState(false);
  const [pendingRemoveId, setPendingRemoveId] = React.useState<string | null>(null);
  const [addError, setAddError] = React.useState<string | null>(null);

  async function handleAdd(): Promise<void> {
    setAddError(null);
    if (!name.trim()) {
      setAddError("Name is required.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setAddError("Pick a date.");
      return;
    }
    setIsAdding(true);
    try {
      await trpcMutation("account.addHoliday", {
        name: name.trim(),
        date,
        recurring,
      });
      setName("");
      setDate("");
      setRecurring(false);
      await onChange();
      toast.success("Holiday added.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Add failed. Try again.";
      setAddError(message);
      toast.error(message);
    } finally {
      setIsAdding(false);
    }
  }

  async function handleRemove(id: string): Promise<void> {
    setPendingRemoveId(id);
    try {
      await trpcMutation("account.removeHoliday", { id });
      await onChange();
      toast.success("Holiday removed.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Remove failed. Try again.";
      toast.error(message);
    } finally {
      setPendingRemoveId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {holidays.length === 0 ? (
        <p
          className="text-sm py-4 px-3 rounded-md"
          style={{
            color: "var(--ds-ink-tertiary)",
            backgroundColor: "var(--ds-surface-sunken)",
          }}
        >
          No holidays added. AI uses these to pause sending on observed dates.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Observed holidays">
          {holidays.map((h) => (
            <li
              key={h.id}
              className="flex items-center gap-3 p-3 rounded-md border"
              style={{ borderColor: "var(--ds-border-subtle)" }}
            >
              <span className="text-sm font-medium flex-1" style={{ color: "var(--ds-ink-primary)" }}>
                {h.name}
              </span>
              <span className="text-sm" style={{ color: "var(--ds-ink-secondary)" }}>
                {formatDate(toIsoDate(h.date))}
              </span>
              {h.recurring ? (
                <span
                  className="text-xs font-medium px-2 py-0.5 rounded"
                  style={{
                    backgroundColor: "var(--ds-surface-sunken)",
                    color: "var(--ds-ink-secondary)",
                  }}
                >
                  Recurring
                </span>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pendingRemoveId === h.id}
                onClick={() => void handleRemove(h.id)}
                aria-label={`Remove holiday: ${h.name}`}
              >
                <X className="w-4 h-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div
        className="flex flex-col gap-2 pt-3"
        style={{ borderTop: "1px solid var(--ds-border-subtle)" }}
      >
        <div className="flex items-end gap-2 flex-wrap">
          <div className="flex flex-col gap-1.5 flex-1 min-w-40">
            <Label htmlFor="holiday-name">Holiday name</Label>
            <Input
              id="holiday-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              disabled={isAdding}
              placeholder="e.g., Canada Day"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="holiday-date">Date</Label>
            <Input
              id="holiday-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={isAdding}
            />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Switch
              id="holiday-recurring"
              checked={recurring}
              onCheckedChange={setRecurring}
              disabled={isAdding}
              aria-label="Recurring annually"
            />
            <Label htmlFor="holiday-recurring" className="cursor-pointer text-xs">
              Repeats yearly
            </Label>
          </div>
          <Button
            type="button"
            disabled={isAdding || !name.trim() || !date}
            onClick={() => void handleAdd()}
            aria-label="Add holiday"
          >
            {isAdding ? "Adding…" : "Add holiday"}
          </Button>
        </div>
        {addError ? (
          <p role="alert" className="text-sm" style={{ color: "var(--ds-danger-text)" }}>
            {addError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
