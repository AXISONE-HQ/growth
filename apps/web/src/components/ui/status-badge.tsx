/**
 * KAN-884 — enum-aware status badge.
 *
 * Maps a value from any of the CRM enums (OrderStatus / DealStatus /
 * CompanyLifecycleStage / Contact LifecycleStage) to a color-coded pill.
 * Reads display labels from `lib/enum-labels.ts` — the single canonical
 * source. Color choice is purely visual signalling (green=good/positive,
 * amber=needs-attention, red=terminal-negative, grey=neutral).
 *
 * Used by /companies + /orders list tables and detail card headers.
 */
import { cn } from "@/lib/utils";
import {
  COMPANY_LIFECYCLE_STAGE_LABELS,
  DEAL_STATUS_LABELS,
  LIFECYCLE_STAGE_LABELS,
  ORDER_STATUS_LABELS,
  enumLabel,
} from "@/lib/enum-labels";

type Tone = "green" | "emerald" | "blue" | "amber" | "red" | "grey";

const TONE_CLASSES: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-700 border-emerald-200",
  emerald: "bg-emerald-100 text-emerald-800 border-emerald-300",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  red: "bg-red-50 text-red-700 border-red-200",
  grey: "bg-gray-100 text-gray-700 border-gray-200",
};

// Value-to-tone map per enum. Values not present here fall back to grey.
const ORDER_STATUS_TONES: Record<string, Tone> = {
  pending: "blue",
  paid: "green",
  refunded: "amber",
  partially_refunded: "amber",
  cancelled: "grey",
  failed: "red",
};

const DEAL_STATUS_TONES: Record<string, Tone> = {
  open: "green",
  won: "emerald",
  lost: "red",
};

const COMPANY_LIFECYCLE_TONES: Record<string, Tone> = {
  prospect: "blue",
  customer: "green",
  churned: "red",
  partner: "emerald",
  vendor: "grey",
};

const CONTACT_LIFECYCLE_TONES: Record<string, Tone> = {
  lead: "blue",
  mql: "blue",
  sql: "amber",
  customer: "green",
  lost: "red",
};

type StatusBadgeKind =
  | "order-status"
  | "deal-status"
  | "company-lifecycle"
  | "contact-lifecycle";

interface StatusBadgeProps {
  kind: StatusBadgeKind;
  value: string | null | undefined;
  className?: string;
}

function resolveTone(kind: StatusBadgeKind, value: string | null | undefined): Tone {
  if (value == null) return "grey";
  switch (kind) {
    case "order-status":
      return ORDER_STATUS_TONES[value] ?? "grey";
    case "deal-status":
      return DEAL_STATUS_TONES[value] ?? "grey";
    case "company-lifecycle":
      return COMPANY_LIFECYCLE_TONES[value] ?? "grey";
    case "contact-lifecycle":
      return CONTACT_LIFECYCLE_TONES[value] ?? "grey";
  }
}

function resolveLabel(kind: StatusBadgeKind, value: string | null | undefined): string {
  switch (kind) {
    case "order-status":
      return enumLabel(ORDER_STATUS_LABELS, value);
    case "deal-status":
      return enumLabel(DEAL_STATUS_LABELS, value);
    case "company-lifecycle":
      return enumLabel(COMPANY_LIFECYCLE_STAGE_LABELS, value);
    case "contact-lifecycle":
      return enumLabel(LIFECYCLE_STAGE_LABELS, value);
  }
}

export function StatusBadge({ kind, value, className }: StatusBadgeProps) {
  const tone = resolveTone(kind, value);
  const label = resolveLabel(kind, value);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {label}
    </span>
  );
}
