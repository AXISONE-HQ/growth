// PROMOTION CANDIDATE: lift into packages/ui in KAN-847 / KAN-842
// Used by: /settings/knowledge hero (this cohort), Decision Feed dashboard,
//          Brain Status page (Sprint 12+)

/**
 * MetricStrip — top-of-dashboard KPI summary. 4–6 metrics in a horizontal row.
 *
 * KAN-979 Phase B.4 — internal rewrite. Strip now renders <MetricCard>
 * children per the prototype's `.metric` shape (each cell is a standalone
 * card with its own border + shadow + padding). The prior grid-gap-px
 * hairline pattern is replaced with real gap-4 between cards. Existing
 * `<MetricStrip metrics={...}>` API preserved — no caller changes.
 *
 * **Anatomy** (post-B.4):
 *   - Each cell is a <MetricCard> (bg-card, border, --ds-radius-card,
 *     --ds-shadow-card) — see metric-card.tsx for the per-card contract
 *   - Strip wraps the cells in role="list" with role="listitem" per cell
 *     so the prior accessibility contract is preserved
 *
 * **Accessibility:** `role="list"` on the grid, `role="listitem"` on each
 * cell. MetricCard surfaces its own `aria-label="{label}: {value}"` for
 * screen-reader continuity.
 */
import * as React from "react";
import { MetricCard } from "./metric-card";

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
    ? Array.from({ length: metrics.length || 4 }, (_, i) => ({
        label: "",
        value: "",
        _skeleton: true,
        _idx: i,
      }))
    : metrics.map((m, i) => ({ ...m, _skeleton: false, _idx: i }));

  return (
    <div
      role="list"
      aria-label="Knowledge center metrics"
      className={[
        "grid gap-4",
        gridColsClass(cells.length),
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {cells.map((cell) => (
        <div key={cell._idx} role="listitem">
          <MetricCard
            label={cell._skeleton ? "" : (cell as MetricStripCell).label}
            value={cell._skeleton ? "" : (cell as MetricStripCell).value}
            delta={cell._skeleton ? undefined : (cell as MetricStripCell).delta}
            loading={cell._skeleton}
          />
        </div>
      ))}
    </div>
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
