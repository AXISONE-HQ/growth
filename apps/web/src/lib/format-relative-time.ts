/**
 * Inline time-ago formatter for "Last refreshed: 2m ago" / "5m ago" style
 * relative timestamps. apps/web has no date-fns dep; this 10-LoC helper
 * covers the 5 cases consumers need.
 *
 * KAN-1087 (originally shipped at
 * apps/web/src/app/settings/cognitive-metrics/_components/format-relative-time.ts).
 * KAN-1102 — relocated to `apps/web/src/lib/` so multiple dashboard panels
 * can consume it without duplicating the helper.
 *
 * Consumers (ENUMERATED — KAN-1102 enumeration discipline):
 * - apps/web/src/app/settings/cognitive-metrics/_components/dashboard-header.tsx
 *   (KAN-1087 — "Last refreshed" header timestamp)
 * - apps/web/src/app/dashboard/page.tsx (KAN-1102 — Escalation Queue card
 *   relative timestamps for operator triage staleness signal)
 *
 * When adding a new consumer, append to this list. Test colocation at
 * `apps/web/src/lib/__tests__/format-relative-time.test.ts` (KAN-1087
 * deterministic 5-case suite, relocated alongside the source).
 */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diffMs = now.getTime() - then;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 30) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}
