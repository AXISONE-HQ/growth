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

// KAN-986 Phase C.3 — migrated from raw Tailwind dark-theme classes
// (`text-emerald-300 bg-emerald-500/15 ring-emerald-500/30` etc., which
// were illegible on the new white canvas) to the design-system tokens
// established in Phase A + B.1. The four tiers map onto the same pastel
// chip palette as `<Badge variant="green|ai|amber|rose">` so confidence
// chips visually rhyme with every other semantic chip in the app while
// keeping the four tiers distinctly readable.
//
// HARD REQUIREMENT (standing): the four tiers MUST remain visually
// distinct (green / indigo / amber / rose). The test at
// __tests__/board-helpers.test.ts pins distinctness in three ways:
//   1. Each tier returns a class string referencing its tier-specific
//      --ds-* token
//   2. All four tier strings are pairwise unequal
//   3. The DataTable/board confidence-badge data-confidence-level
//      attribute (deal-card.tsx) still emits high/good/uncertain/low
//      verbatim, so accessibility-driven tests can target the tier name
//      independently of the visual class.
export function confidenceClasses(level: ConfidenceLevel): string {
  switch (level) {
    case "high":
      return "bg-[var(--ds-emerald-100)] text-[var(--ds-emerald-700)]";
    case "good":
      return "bg-[var(--ds-violet-100)] text-[var(--ds-violet-500)]";
    case "uncertain":
      return "bg-[var(--ds-warning-soft)] text-[var(--ds-warning-text)]";
    case "low":
      return "bg-[var(--ds-danger-soft)] text-[var(--ds-danger-text)]";
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
