"use client";

/**
 * KAN-866 — DS v1 §3.1 ConfidenceBadge.
 *
 * **PROMOTION CANDIDATE** — KAN-842 lifts the canonical 8 DS v1 components
 * out of apps/web into packages/ui. This is the first of those 8 to ship.
 * When that lift happens, the export here becomes a re-export.
 *
 * Pure-presentation badge expressing AI confidence as a colored dot +
 * percentage + (optional) status word. Static — no hover, no animation.
 *
 * **Variants** (per spec §3.1):
 *   - high   (85+) emerald
 *   - normal (65–84) violet
 *   - low    (40–64) warning
 *   - below  (0–39) danger
 *
 * **A11y**: `role="status"` with `aria-label="N percent confidence, [level]"`.
 * Color is paired with a status word so it is never the only signal — DS
 * accessibility contract per spec Part 6.
 *
 * **DS compliance**: every color via `var(--ds-*)`; zero hex literals. The
 * spec gives hex in its Tailwind reference, but the canonical token mapping
 * is documented in globals.css (see `--ds-emerald-*`, `--ds-violet-*`,
 * `--ds-warning-*`, `--ds-danger-*`).
 */
import * as React from "react";

export type ConfidenceLevel = "high" | "normal" | "low" | "below";

interface ConfidenceTokens {
  bg: string;
  text: string;
  dot: string;
  border: string;
  word: string;
}

const TOKENS: Record<ConfidenceLevel, ConfidenceTokens> = {
  high: {
    bg: "var(--ds-emerald-100)",
    text: "var(--ds-emerald-700)",
    dot: "var(--ds-emerald-500)",
    border: "var(--ds-emerald-500)",
    word: "high",
  },
  normal: {
    bg: "var(--ds-violet-50)",
    text: "var(--ds-violet-700)",
    dot: "var(--ds-violet-500)",
    border: "var(--ds-violet-500)",
    word: "normal",
  },
  low: {
    bg: "var(--ds-warning-soft)",
    text: "var(--ds-warning-text)",
    dot: "var(--ds-warning)",
    border: "var(--ds-warning)",
    word: "low",
  },
  below: {
    bg: "var(--ds-danger-soft)",
    text: "var(--ds-danger-text)",
    dot: "var(--ds-danger)",
    border: "var(--ds-danger)",
    word: "below",
  },
};

export function levelForConfidence(value: number): ConfidenceLevel {
  if (value >= 85) return "high";
  if (value >= 65) return "normal";
  if (value >= 40) return "low";
  return "below";
}

export interface ConfidenceBadgeProps {
  /** 0–100 integer percentage. Decimal values get rounded. */
  value: number;
  /** Render the status word ("high"/"normal"/"low"/"below") after the percent. */
  showWord?: boolean;
  className?: string;
}

export function ConfidenceBadge({
  value,
  showWord = true,
  className,
}: ConfidenceBadgeProps): React.ReactElement {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const level = levelForConfidence(clamped);
  const t = TOKENS[level];
  const ariaLabel = `${clamped} percent confidence, ${t.word}`;
  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={[
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full",
        "text-micro border",
        className ?? "",
      ].join(" ")}
      style={{
        backgroundColor: t.bg,
        color: t.text,
        borderColor: t.border,
      }}
    >
      <span
        aria-hidden="true"
        className="w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: t.dot }}
      />
      <span>
        {clamped}%{showWord ? ` · ${t.word}` : null}
      </span>
    </span>
  );
}
