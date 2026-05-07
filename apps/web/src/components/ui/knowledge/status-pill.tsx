// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Knowledge Sources list/detail (KAN-829), Audit feed (KAN-830),
//          Approval queue UI (Sprint 11b/13)

/**
 * StatusPill — visual indicator for a workflow status with paired text label.
 *
 * Five states map to Growth Design System v1 tokens (per Confluence page
 * 4456463 + globals.css `--ds-*` additive token block):
 *
 *   queued    → surface-sunken / ink-secondary / border-default       (no motion)
 *   embedding → violet-100 / violet-700 / violet-500 @ 30% opacity    (pulse 1.5s)
 *   ready     → emerald-100 / emerald-700 / emerald-500 @ 50% opacity (no motion)
 *   error     → danger-soft / danger-text / danger                    (no motion)
 *   deleted   → surface-base / ink-tertiary / border-subtle           (label strikethrough)
 *
 * Accessibility — color is NEVER the only signal:
 *   • text label always rendered
 *   • role="status" + aria-label="{label}"
 *   • pulse animation respects `prefers-reduced-motion` (static fallback)
 *
 * Tokens referenced via inline style (CSS custom properties) since Tailwind
 * doesn't yet have classes for the additive `--ds-*` variables. KAN-847
 * promotion will add Tailwind config entries + migrate to className-based.
 */
import * as React from "react";

export type StatusPillStatus = "queued" | "embedding" | "ready" | "error" | "deleted";

interface StatusPillProps {
  status: StatusPillStatus;
  label?: string;
  className?: string;
}

interface StateStyles {
  background: string;
  text: string;
  border: string;
  pulse: boolean;
  strikethrough: boolean;
  defaultLabel: string;
}

const STATE_STYLES: Record<StatusPillStatus, StateStyles> = {
  queued: {
    background: "var(--ds-surface-sunken)",
    text: "var(--ds-ink-secondary)",
    border: "var(--ds-border-default)",
    pulse: false,
    strikethrough: false,
    defaultLabel: "Queued",
  },
  embedding: {
    background: "var(--ds-violet-100)",
    text: "var(--ds-violet-700)",
    // border-color with 30% opacity — rgba via color-mix() for native CSS support
    border: "color-mix(in srgb, var(--ds-violet-500) 30%, transparent)",
    pulse: true,
    strikethrough: false,
    defaultLabel: "Embedding",
  },
  ready: {
    background: "var(--ds-emerald-100)",
    text: "var(--ds-emerald-700)",
    border: "color-mix(in srgb, var(--ds-emerald-500) 50%, transparent)",
    pulse: false,
    strikethrough: false,
    defaultLabel: "Ready",
  },
  error: {
    background: "var(--ds-danger-soft)",
    text: "var(--ds-danger-text)",
    border: "var(--ds-danger)",
    pulse: false,
    strikethrough: false,
    defaultLabel: "Error",
  },
  deleted: {
    background: "var(--ds-surface-base)",
    text: "var(--ds-ink-tertiary)",
    border: "var(--ds-border-subtle)",
    pulse: false,
    strikethrough: true,
    defaultLabel: "Deleted",
  },
};

export function StatusPill({ status, label, className }: StatusPillProps): React.ReactElement {
  const styles = STATE_STYLES[status];
  const resolvedLabel = label ?? styles.defaultLabel;

  return (
    <span
      role="status"
      aria-label={resolvedLabel}
      data-status={status}
      data-pulse={styles.pulse ? "true" : undefined}
      className={[
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full",
        "text-xs font-medium leading-none",
        "border transition-colors",
        // motion: pulse on `embedding` state. The keyframes class is defined
        // below; `motion-safe:animate-pulse` only fires when the user has NOT
        // requested reduced motion (browser respects prefers-reduced-motion).
        styles.pulse ? "motion-safe:animate-pulse" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        backgroundColor: styles.background,
        color: styles.text,
        borderColor: styles.border,
      }}
    >
      <span
        aria-hidden="true"
        className="inline-block w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: styles.text }}
      />
      <span style={styles.strikethrough ? { textDecoration: "line-through" } : undefined}>
        {resolvedLabel}
      </span>
    </span>
  );
}
