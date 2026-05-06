// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Add Source dialog (KAN-829), future Sprint 12+ ingestion surfaces

/**
 * SourceTypeCard — single card in the Add Source step-1 grid.
 *
 * **Three states (KAN-829 sub-cohort 6):**
 *  - default (lockedReason undefined) — clickable, full opacity
 *  - 'tier' — feature exists, plan doesn't include it. Clickable; routes
 *    to the upgrade dialog upstream. Lock icon overlay + "Upgrade to
 *    unlock" subtext + dashed border in violet.
 *  - 'coming-soon' — feature not implemented yet. Disabled treatment;
 *    Clock icon overlay + existing "Coming soon" eyebrow.
 *
 * The tier-vs-coming-soon distinction matters: tier-locked is recoverable
 * by the user (upgrade), coming-soon is not (engineering hasn't shipped).
 * Conflating them removes the upgrade hook and over-promises feature
 * availability.
 *
 * **DS v1 compliance:**
 *  - Borders not shadows
 *  - Sentence case copy + verb+object microcopy ("Upgrade to unlock")
 *  - Color paired with text label and an icon on every locked state
 *  - Tier-locked clicks fire onClick (upstream opens upgrade dialog);
 *    coming-soon clicks are no-ops (preventDefault).
 *
 * Props are explicit (no `any`); icon accepts a Lucide-style component
 * via type alias to avoid pulling in lucide-react types directly.
 */
import * as React from "react";
import { Lock, Clock } from "lucide-react";

export type LockedReason = "tier" | "coming-soon";

interface SourceTypeCardProps {
  title: string;
  description: string;
  /** Lucide-react icon component (e.g., FileText, Upload). Pass the component itself, not a JSX element. */
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  /**
   * Why this card is locked. `undefined` = available; `'tier'` = upgrade
   * recoverable; `'coming-soon'` = not yet shipped.
   */
  lockedReason?: LockedReason;
  /** Hint text shown as the eyebrow + browser-native title attribute when coming-soon. */
  comingSoonHint?: string;
  onClick?: () => void;
}

export function SourceTypeCard({
  title,
  description,
  icon: Icon,
  lockedReason,
  comingSoonHint,
  onClick,
}: SourceTypeCardProps): React.ReactElement {
  const isComingSoon = lockedReason === "coming-soon";
  const isTierLocked = lockedReason === "tier";
  const isClickable = !isComingSoon; // tier-locked AND default both fire onClick

  const handleClick = React.useCallback(
    (e: React.MouseEvent) => {
      if (!isClickable) {
        e.preventDefault();
        return;
      }
      onClick?.();
    },
    [isClickable, onClick],
  );

  // Border + cursor + opacity treatment per state
  const borderStyle: React.CSSProperties = isTierLocked
    ? {
        borderStyle: "dashed",
        borderColor: "color-mix(in srgb, var(--ds-violet-500) 50%, transparent)",
      }
    : {
        borderStyle: "solid",
        borderColor: "var(--ds-border-subtle)",
      };

  return (
    <button
      type="button"
      aria-disabled={isComingSoon ? "true" : undefined}
      data-locked-reason={lockedReason}
      onClick={handleClick}
      title={isComingSoon ? comingSoonHint : undefined}
      className={[
        "relative flex flex-col items-start text-left p-4 rounded-lg border w-full transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        isComingSoon
          ? "cursor-not-allowed"
          : "cursor-pointer hover:border-[var(--ds-violet-500)]",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        backgroundColor: "var(--ds-surface-base)",
        opacity: isComingSoon ? 0.55 : 1,
        ...borderStyle,
      }}
    >
      {/* Status overlay icon — top-right corner. Visually paired with text
       * eyebrow below (color is never the only signal). */}
      {isTierLocked ? (
        <span
          aria-label="Tier-locked"
          className="absolute top-3 right-3"
          style={{ color: "var(--ds-violet-700)" }}
        >
          <Lock className="w-4 h-4" aria-hidden="true" />
        </span>
      ) : null}
      {isComingSoon ? (
        <span
          aria-label="Coming soon"
          className="absolute top-3 right-3"
          style={{ color: "var(--ds-ink-tertiary)" }}
        >
          <Clock className="w-4 h-4" aria-hidden="true" />
        </span>
      ) : null}

      <Icon className="w-5 h-5 mb-3" aria-hidden="true" />
      <span
        className="text-sm font-medium mb-1"
        style={{ color: "var(--ds-ink-secondary)" }}
      >
        {title}
      </span>
      <span
        className="text-xs leading-relaxed"
        style={{ color: "var(--ds-ink-tertiary)" }}
      >
        {description}
      </span>

      {/* Eyebrow — text label paired with the corner icon */}
      {isTierLocked ? (
        <span
          className="text-xs mt-2 font-medium"
          style={{ color: "var(--ds-violet-700)" }}
        >
          Upgrade to unlock
        </span>
      ) : null}
      {isComingSoon && comingSoonHint ? (
        <span
          className="text-xs mt-2 font-medium"
          style={{ color: "var(--ds-ink-tertiary)" }}
        >
          {comingSoonHint}
        </span>
      ) : null}
    </button>
  );
}
