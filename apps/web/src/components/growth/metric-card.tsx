/**
 * KAN-979 Phase B.4 — MetricCard.
 *
 * Single-card KPI primitive per prototype `.metric`:
 *
 *   ┌───────────────────────────────┐
 *   │ Active leads          [icon]  │  label row (muted, weight 500)
 *   │ 1,284                         │  value (28px, tabular-nums)
 *   │ ↑ 12% this month              │  trend chip (positive: green / negative: rose)
 *   └───────────────────────────────┘
 *
 * Use standalone for a single metric, or via `<MetricStrip metrics={...}>`
 * for the 4-6 KPI horizontal row.
 *
 * Anatomy (matches prototype tokens):
 *   - bg-card (white), border-border (#ECEDF3 hairline), --ds-radius-card
 *     (18px), --ds-shadow-card (hairline + soft), padding 18px
 *   - Label: 13px muted (--ds-ink-secondary), weight 500
 *   - Optional icon (18px, violet-tinted via --ds-violet-500) at the
 *     right end of the label row — matches prototype `.lbl .ic`
 *   - Value: 28px, weight 600, letter-spacing tightened, tabular-nums
 *   - Trend chip: ds-chip-base pill, green (positive) / rose (negative)
 *     / muted (zero) — arrow + percent
 *
 * Loading state: when `loading` is true, label + value render as
 * skeleton bars (--ds-surface-sunken bg, no shimmer) matching the prior
 * MetricStrip Skelton shape. Outer ARIA label changes to "Loading
 * metric" per the strip's existing contract.
 */
import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MetricCardProps {
  label: string;
  value: string | number;
  /**
   * Optional ±N% delta. Positive renders an emerald "↑ N%" chip;
   * negative renders a rose "↓ N%" chip; zero renders a muted "· 0%".
   */
  delta?: number;
  /**
   * Optional free-form subtitle rendered below the value (and below the
   * trend chip if both are present). Use when the trend doesn't fit a
   * ±N% shape (e.g., "+23 this week" or "from 3.1 min").
   */
  subtitle?: string;
  icon?: LucideIcon;
  loading?: boolean;
  className?: string;
}

export function MetricCard({
  label,
  value,
  delta,
  subtitle,
  icon: Icon,
  loading = false,
  className,
}: MetricCardProps): React.ReactElement {
  return (
    <div
      aria-label={loading ? "Loading metric" : `${label}: ${value}`}
      className={cn(
        "flex flex-col gap-1 rounded-[var(--ds-radius-card)] border border-border bg-card p-[18px] shadow-[var(--ds-shadow-card)]",
        className,
      )}
    >
      {loading ? (
        <SkeletonInner />
      ) : (
        <>
          {/* Label row — .text-label (13/18 weight 500) per DS v1 spec Part 1. */}
          <div
            className="text-label flex items-center justify-between"
            style={{ color: "var(--ds-ink-secondary)" }}
          >
            <span>{label}</span>
            {Icon ? (
              <Icon
                className="h-[18px] w-[18px]"
                style={{ color: "var(--ds-violet-500)" }}
                aria-hidden="true"
              />
            ) : null}
          </div>
          {/* Value — .text-h1 (28/36 weight 500) per DS v1 spec Part 1. The
           * prototype's weight-600 is intentionally dropped to comply with
           * the two-weight rule (foundation-pattern regression guard). */}
          <div
            className="text-h1 tabular-nums tracking-tight"
            style={{ color: "var(--ds-ink-primary)" }}
          >
            {value}
          </div>
          {delta !== undefined ? <TrendChip delta={delta} /> : null}
          {subtitle ? (
            <div
              className="text-caption mt-1"
              style={{ color: "var(--ds-ink-tertiary)" }}
            >
              {subtitle}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function TrendChip({ delta }: { delta: number }): React.ReactElement {
  const positive = delta > 0;
  const negative = delta < 0;
  const arrow = positive ? "↑" : negative ? "↓" : "·";
  const bg = positive
    ? "var(--ds-emerald-100)"
    : negative
      ? "var(--ds-danger-soft)"
      : "var(--ds-surface-sunken)";
  const fg = positive
    ? "var(--ds-emerald-700)"
    : negative
      ? "var(--ds-danger-text)"
      : "var(--ds-ink-secondary)";
  // .text-micro (11/16 weight 500) per DS v1 spec Part 1 — closest type-scale
  // token to the prototype's 11.5px chip. tabular-nums kept so chip values
  // align across cards in a strip.
  return (
    <div
      className="text-micro mt-2 inline-flex w-fit items-center gap-1 rounded-[var(--ds-radius-pill)] px-2 py-0.5 tabular-nums"
      style={{ backgroundColor: bg, color: fg }}
    >
      {arrow} {Math.abs(delta)}%
    </div>
  );
}

function SkeletonInner(): React.ReactElement {
  return (
    <>
      <div
        className="h-3 w-20 rounded"
        style={{ backgroundColor: "var(--ds-surface-sunken)" }}
        aria-hidden="true"
      />
      <div
        className="mt-1 h-7 w-16 rounded"
        style={{ backgroundColor: "var(--ds-surface-sunken)" }}
        aria-hidden="true"
      />
    </>
  );
}
