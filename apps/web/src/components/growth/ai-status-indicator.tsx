// PROMOTION CANDIDATE: lift into packages/ui in KAN-847 / KAN-842
// Used by: Topbar (this cohort, replaces inline pill in app/layout.tsx),
//          future system-health surfaces

/**
 * AIStatusIndicator — always-visible top-right system-health pill.
 *
 * Spec: docs/design-system/v1.md Part 3 §7 + Part 2 §System health vocabulary.
 *
 * **Anatomy** (per spec):
 *   - Inline-flex pill, surface-raised bg, 0.5px subtle border, rounded-full
 *   - Status dot 8×8px with box-shadow ring 3px at 15% opacity (active variant
 *     animates the ring 1500ms ease-in-out infinite via --motion-pulse)
 *   - Status label in text-caption (12/18) ink-primary
 *
 * **States** (spec Part 2 line 193-198):
 *   - active    → emerald dot, "System active" label, pulse animation
 *   - degraded  → warning dot, "Degraded" + optional reason after em-dash
 *   - paused    → warning dot, "Paused by you" label
 *   - failed    → danger dot, "Action required" label
 *
 * **Accessibility:**
 *   - role="status" with aria-label that includes the textual status
 *   - prefers-reduced-motion: pulse animation disabled at the CSS level via
 *     globals.css media query, and the box-shadow-ring class is only applied
 *     when motion is allowed
 *   - Color is paired with text label on every state — never color-only
 *
 * **Backend wiring (TODO):** for this cohort the topbar mounts with
 * `status="active"` hardcoded. Real system-health resolution (degraded /
 * paused / failed transitions based on backend signals) ships in a future
 * ticket alongside the Decision Feed surface (Sprint 12+).
 */
"use client";

import * as React from "react";

export type AIStatusIndicatorState = "active" | "degraded" | "paused" | "failed";

interface AIStatusIndicatorProps {
  status?: AIStatusIndicatorState;
  /** Optional reason text shown after an em-dash on the degraded variant. */
  reason?: string;
  className?: string;
}

interface StateStyle {
  /** Dot fill color — references --ds-* token. */
  dotColor: string;
  /** box-shadow ring color (rgba) — derived from dotColor at 15% opacity. */
  ringRgba: string;
  /** Default label text per spec Part 2. */
  defaultLabel: string;
  /** Whether to apply the .motion-pulse animation. */
  pulse: boolean;
}

const STATE_STYLES: Record<AIStatusIndicatorState, StateStyle> = {
  active: {
    dotColor: "var(--ds-emerald-500)",
    ringRgba: "rgba(14, 168, 130, 0.15)", // emerald-500 at 15%
    defaultLabel: "System active",
    pulse: true,
  },
  degraded: {
    dotColor: "var(--ds-warning)",
    ringRgba: "rgba(217, 119, 6, 0.15)", // warning #D97706 at 15%
    defaultLabel: "Degraded",
    pulse: false,
  },
  paused: {
    dotColor: "var(--ds-warning)",
    ringRgba: "rgba(217, 119, 6, 0.15)",
    defaultLabel: "Paused by you",
    pulse: false,
  },
  failed: {
    dotColor: "var(--ds-danger)",
    ringRgba: "rgba(199, 62, 62, 0.15)", // danger #C73E3E at 15%
    defaultLabel: "Action required",
    pulse: false,
  },
};

export function AIStatusIndicator({
  status = "active",
  reason,
  className,
}: AIStatusIndicatorProps): React.ReactElement {
  const style = STATE_STYLES[status];
  const label =
    status === "degraded" && reason
      ? `${style.defaultLabel} — ${reason}`
      : style.defaultLabel;

  return (
    <div
      role="status"
      aria-label={label}
      data-status={status}
      className={[
        "inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-caption",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        backgroundColor: "var(--ds-surface-raised)",
        border: "0.5px solid var(--ds-border-subtle)",
        color: "var(--ds-ink-primary)",
      }}
    >
      <span
        aria-hidden="true"
        data-pulse={style.pulse ? "true" : undefined}
        className={[
          "inline-block w-2 h-2 rounded-full",
          style.pulse ? "motion-pulse" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{
          backgroundColor: style.dotColor,
          boxShadow: `0 0 0 3px ${style.ringRgba}`,
        }}
      />
      <span>{label}</span>
    </div>
  );
}
