/**
 * KAN-968 — Pipelines kanban board helpers.
 *
 * Pure functions for rendering the deal card UI:
 *   - humanizeActionType: maps Brain actionType enum to user-facing copy
 *   - confidenceLevel: bucket a 0..1 score into one of 4 visual tiers
 *   - confidenceClasses: tier → tailwind classes (text + bg + ring) so the
 *     mapping is centralized and trivially testable
 *   - formatStageAge: enteredStageAt → "2h" / "3d" / "30m" relative copy
 *
 * Confidence color system (per PRD):
 *   85+ → emerald  (high)
 *   65–84 → indigo (good)
 *   40–64 → yellow (uncertain)
 *   <40  → red     (low)
 *
 * Color is supplementary — the text label is always present (accessibility:
 * color alone is never load-bearing).
 */

const ACTION_LABELS: Record<string, string> = {
  send_follow_up: "Sending follow-up",
  wait_for_response: "Waiting for reply",
  advance_stage: "Advancing",
  escalate_to_human: "Escalated",
  close_deal_lost: "Closing",
  close_deal_won: "Closing won",
  no_action: "Monitoring",
};

export function humanizeActionType(actionType: string): string {
  return ACTION_LABELS[actionType] ?? actionType;
}

export type ConfidenceLevel = "high" | "good" | "uncertain" | "low";

export function confidenceLevel(score: number): ConfidenceLevel {
  // score is 0..1; convert to 0..100 for bucketing
  const pct = Math.round(score * 100);
  if (pct >= 85) return "high";
  if (pct >= 65) return "good";
  if (pct >= 40) return "uncertain";
  return "low";
}

export function confidencePercent(score: number): number {
  return Math.round(score * 100);
}

export function confidenceClasses(level: ConfidenceLevel): string {
  switch (level) {
    case "high":
      return "text-emerald-300 bg-emerald-500/15 ring-1 ring-emerald-500/30";
    case "good":
      return "text-indigo-300 bg-indigo-500/15 ring-1 ring-indigo-500/30";
    case "uncertain":
      return "text-yellow-300 bg-yellow-500/15 ring-1 ring-yellow-500/30";
    case "low":
      return "text-red-300 bg-red-500/15 ring-1 ring-red-500/30";
  }
}

/**
 * Relative-age renderer for stage entry. Picks a tight unit:
 *   < 1m → "just now"
 *   < 60m → "{n}m"
 *   < 24h → "{n}h"
 *   ≥ 24h → "{n}d"
 *
 * `now` injectable for deterministic tests.
 */
export function formatStageAge(enteredAt: Date | string, now: Date = new Date()): string {
  const entered = typeof enteredAt === "string" ? new Date(enteredAt) : enteredAt;
  const diffMs = now.getTime() - entered.getTime();
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function contactDisplayName(
  contact: { firstName: string | null; lastName: string | null },
): string {
  const parts = [contact.firstName, contact.lastName].filter(
    (s): s is string => s !== null && s.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : "(no name)";
}

export function formatMoney(value: string, currency: string): string {
  // Decimal arrives as string; coerce to Number for Intl.NumberFormat (acceptable
  // precision for board display — full-precision lives on Deal detail).
  const n = Number(value);
  if (!Number.isFinite(n)) return `${value} ${currency}`;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}
