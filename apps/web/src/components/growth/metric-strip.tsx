// PROMOTION CANDIDATE: lift into packages/ui in KAN-847 / KAN-842
// Used by: /settings/knowledge hero (this cohort), Decision Feed dashboard,
//          Brain Status page (Sprint 12+)

/**
 * MetricStrip — top-of-dashboard KPI summary. 4–6 metrics in a horizontal row.
 *
 * Spec: docs/design-system/v1.md Part 3 §8.
 *
 * **Anatomy** (per spec):
 *   - Each cell has a label (text-caption, ink-tertiary) above a value
 *     (text-h2, ink-primary, tabular-nums)
 *   - Optional delta below value (±N% with up/down arrow, emerald-700 if
 *     positive, danger-text if negative)
 *   - Grid layout with 1px hairline gaps showing through (border-subtle bg
 *     bleeds through grid gap-px) — borders not shadows per spec Part 1
 *
 * **DS v1 compliance:**
 *   - Color via `var(--ds-*)` tokens — zero hex
 *   - Type scale: .text-caption labels + .text-h2 values (per spec Part 1)
 *   - .tabular-nums on every value cell so columns align
 *   - Sentence case labels — caller's responsibility
 *
 * **Loading state:** when `loading` is true, renders skeleton cells matching
 * the final shape per spec Part 4 (surface-sunken bg, no shimmer).
 *
 * **Accessibility:** `role="list"` on the grid, `role="listitem"` on each cell.
 * Each cell has `aria-label="{label}: {value}"` so screen readers don't read
 * the label and value as separate disjointed announcements.
 */
import * as React from "react";

export interface MetricStripCell {
  label: string;
  value: string | number;
  /** Optional ±N% delta. Positive renders emerald-700 ↑, negative renders danger-text ↓. */
  delta?: number;
}

interface MetricStripProps {
  metrics: MetricStripCell[];
  /** Render skeleton placeholders while data is loading. Default false. */
  loading?: boolean;
  className?: string;
}

export function MetricStrip({
  metrics,
  loading = false,
  className,
}: MetricStripProps): React.ReactElement {
  const cells = loading
    ? Array.from({ length: metrics.length || 4 }, (_, i) => ({ label: "", value: "", _skeleton: true, _idx: i }))
    : metrics.map((m, i) => ({ ...m, _skeleton: false, _idx: i }));

  return (
    <div
      role="list"
      aria-label="Knowledge center metrics"
      className={[
        "grid gap-px rounded-xl overflow-hidden border",
        gridColsClass(cells.length),
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        backgroundColor: "var(--ds-border-subtle)",
        borderColor: "var(--ds-border-subtle)",
      }}
    >
      {cells.map((cell) => (
        <div
          key={cell._idx}
          role="listitem"
          aria-label={cell._skeleton ? "Loading metric" : `${cell.label}: ${cell.value}`}
          className="p-4 flex flex-col gap-1"
          style={{ backgroundColor: "var(--ds-surface-raised)" }}
        >
          {cell._skeleton ? (
            <SkeletonCell />
          ) : (
            <>
              <div
                className="text-caption"
                style={{ color: "var(--ds-ink-tertiary)" }}
              >
                {cell.label}
              </div>
              <div
                className="text-h2 tabular-nums"
                style={{ color: "var(--ds-ink-primary)" }}
              >
                {cell.value}
              </div>
              {cell.delta !== undefined ? <DeltaRow delta={cell.delta} /> : null}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function DeltaRow({ delta }: { delta: number }): React.ReactElement {
  const positive = delta > 0;
  const arrow = positive ? "↑" : delta < 0 ? "↓" : "·";
  return (
    <div
      className="text-caption tabular-nums"
      style={{
        color: positive
          ? "var(--ds-emerald-700)"
          : delta < 0
            ? "var(--ds-danger-text)"
            : "var(--ds-ink-tertiary)",
      }}
    >
      {arrow} {Math.abs(delta)}%
    </div>
  );
}

function SkeletonCell(): React.ReactElement {
  return (
    <>
      <div
        className="rounded h-3 w-20"
        style={{ backgroundColor: "var(--ds-surface-sunken)" }}
        aria-hidden="true"
      />
      <div
        className="rounded h-7 w-16 mt-1"
        style={{ backgroundColor: "var(--ds-surface-sunken)" }}
        aria-hidden="true"
      />
    </>
  );
}

function gridColsClass(n: number): string {
  switch (n) {
    case 1: return "grid-cols-1";
    case 2: return "grid-cols-2";
    case 3: return "grid-cols-3";
    case 4: return "grid-cols-4";
    case 5: return "grid-cols-5";
    case 6: return "grid-cols-6";
    default: return "grid-cols-4";
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helper — humanizeBytes
// Used by /settings/knowledge MetricStrip "Storage used" cell. Pure function;
// rounds to 1 decimal at MB and above for readability per spec Part 5
// "numbers wherever possible" principle.
// ─────────────────────────────────────────────────────────────────────────

export function humanizeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1)} GB`;
}
