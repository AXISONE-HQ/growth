/**
 * KAN-1188 G8 — Tenant-level confidence badge for ActionPlan.
 *
 * Distinct from the KAN-1166 `[id]/_components/ConfidenceBadge.tsx` which
 * binds `FeasibilityConfidence` (4 values, includes insufficient_data).
 * ActionPlan confidence is `ActionPlanConfidence` (3 values per D5 lock —
 * tenant-level only, no insufficient_data variant since the plan would
 * never be generated under that signal).
 *
 * Renders inline with a native title-attribute tooltip showing the
 * confidence reason (audit-trail string from FCS dominantConfidence).
 * No JS-tooltip primitive dependency.
 */
import type { ActionPlanConfidence } from "@growth/shared";
import { Badge } from "@/components/ui/badge";

export interface ActionPlanConfidenceBadgeProps {
  confidence: ActionPlanConfidence;
  reason: string;
  className?: string;
}

const LABEL: Record<ActionPlanConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

const VARIANT: Record<ActionPlanConfidence, "green" | "amber" | "muted"> = {
  high: "green",
  medium: "amber",
  low: "muted",
};

export function ActionPlanConfidenceBadge({
  confidence,
  reason,
  className,
}: ActionPlanConfidenceBadgeProps) {
  return (
    <Badge
      variant={VARIANT[confidence]}
      title={reason}
      aria-label={`${LABEL[confidence]} — ${reason}`}
      className={className}
    >
      {LABEL[confidence]}
    </Badge>
  );
}
