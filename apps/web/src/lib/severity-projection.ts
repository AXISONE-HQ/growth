/**
 * KAN-1102 — Shared severity → Badge projection for Escalation / Recommendation rows.
 *
 * Extracted from `apps/web/src/app/escalations/page.tsx` (KAN-1006 SAE PR2)
 * so multiple Dashboard v2 panels can consume the same canonical 5-severity
 * → 3-visual-tier mapping without duplicating the helper inline.
 *
 * Consumers (ENUMERATED — KAN-1102 enumeration discipline):
 * - apps/web/src/app/escalations/page.tsx (KAN-754 + KAN-1006 — list + detail surfaces)
 * - apps/web/src/app/dashboard/page.tsx (KAN-1102 — Escalation Queue panel)
 *
 * When adding a new consumer, append to this list. When changing the mapping
 * (e.g., a new Escalation.severity vocabulary value), audit all listed
 * consumers + sentinel tests.
 *
 * Source-of-truth note: the `Escalation.severity` column is a Prisma `String`
 * (no enum at the DB layer) but Zod-validated at the router input as
 * `'low' | 'medium' | 'high' | 'critical' | 'info'` (KAN-1005 M2-5 added
 * `'info'` for sampled post-hoc reviews). The Badge variant ranking below
 * reflects most → least concern: rose → amber → ai → muted. Unknown
 * severities fall through to `muted` so a future vocabulary extension
 * degrades visually rather than crashing.
 */
import { type BadgeProps } from '@/components/ui/badge';

// ─────────────────────────────────────────────
// Severity → Badge variant mapping (light DS tokens)
// Intentional ranking (most → least concern): rose → amber → ai → muted.
// ─────────────────────────────────────────────
export const SEVERITY_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = {
  critical: 'rose',
  high: 'amber',
  medium: 'ai',
  low: 'muted',
};

export const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export function severityBadge(severity: string): {
  variant: NonNullable<BadgeProps['variant']>;
  label: string;
} {
  return {
    variant: SEVERITY_VARIANT[severity] ?? 'muted',
    label: SEVERITY_LABEL[severity] ?? severity,
  };
}
