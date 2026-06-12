/**
 * KAN-1166 PR 3-variants — Achievability verdict badge.
 *
 * No-euphemism doctrine (Q-ADD V1): labels render verbatim from the
 * AchievabilityVerdict discriminated union. Replacement labels like
 * "Challenging" or "Aspirational" would soften the AI's pushback and
 * violate the honest-counsel doctrine.
 *
 * Token mapping (Q-ADD V1 ratified):
 *   feasible    → Badge variant="green"  (no-action celebration)
 *   stretch     → Badge variant="amber"  (achievable-with-effort signal)
 *   unrealistic → Badge variant="rose"   (honest "math doesn't carry")
 */
import type { AchievabilityVerdict } from "@growth/shared";
import { Badge } from "@/components/ui/badge";

export interface AchievabilityBadgeProps {
  verdict: AchievabilityVerdict;
  className?: string;
}

const VARIANT_BY_VERDICT: Record<
  AchievabilityVerdict,
  "green" | "amber" | "rose"
> = {
  feasible: "green",
  stretch: "amber",
  unrealistic: "rose",
};

export function AchievabilityBadge({ verdict, className }: AchievabilityBadgeProps) {
  return (
    <Badge variant={VARIANT_BY_VERDICT[verdict]} className={className}>
      {verdict}
    </Badge>
  );
}
