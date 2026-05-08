// PROMOTION CANDIDATE: lift into packages/ui (or packages/shared) in KAN-847
// Used by: SourceDetailDialog metadata grid, MetricStrip "Last source added" cell,
//          future Audit feed (KAN-830), Decision Feed (Sprint 12+)

/**
 * Relative-time formatter — "just now" / "Xm ago" / "Xh ago" / "Xd ago" / fallback.
 *
 * Pure function, no React deps, deterministic per `Date.now()`. Lifted out of
 * `source-detail-dialog.tsx` (KAN-829 sub-cohort 5) so MetricStrip's "Last source
 * added" cell can reuse it.
 *
 * **Microcopy contract:** "just now" inside this formatter is the ONLY allowed
 * instance of the otherwise-forbidden word "just" in rendered DS v1 copy. The
 * forbidden-words audit allow-lists this exact phrase.
 *
 * Spec reference: docs/design-system/v1.md Part 5 (UX writing principles —
 * forbidden words list). The "just now" carve-out is documented in the
 * `foundation-pattern.test.ts` regression guard.
 */

export function relativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}
