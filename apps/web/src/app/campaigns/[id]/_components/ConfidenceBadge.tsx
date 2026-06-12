/**
 * KAN-1166 PR 3-variants — Confidence badge (analyzer's certainty).
 *
 * Visual hierarchy lock (Q-ADD V2 ratified):
 *   Achievability primary → filled Badge (operator's eye lands first)
 *   Confidence  secondary → outlined style (semantically present, visually
 *                            subordinate)
 *
 * Token mapping:
 *   high              → emerald outline (strong signal)
 *   medium            → amber outline (directional)
 *   low               → muted outline (rough; starting point)
 *   insufficient_data → AI violet fill (ties back to AI voice — "I don't
 *                       have enough data" speaks in the AI's signature)
 */
import type { FeasibilityConfidence } from "@growth/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export interface ConfidenceBadgeProps {
  confidence: FeasibilityConfidence;
  className?: string;
}

const LABEL_BY_CONFIDENCE: Record<FeasibilityConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
  insufficient_data: "Insufficient data",
};

const OUTLINE_CLASSES: Record<
  Exclude<FeasibilityConfidence, "insufficient_data">,
  string
> = {
  high: "border-[var(--ds-emerald-700)] text-[var(--ds-emerald-700)] bg-transparent",
  medium:
    "border-[var(--ds-warning-text)] text-[var(--ds-warning-text)] bg-transparent",
  low: "border-[var(--ds-ink-secondary)] text-[var(--ds-ink-secondary)] bg-transparent",
};

export function ConfidenceBadge({ confidence, className }: ConfidenceBadgeProps) {
  if (confidence === "insufficient_data") {
    return (
      <Badge variant="ai" className={className}>
        {LABEL_BY_CONFIDENCE[confidence]}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={cn(OUTLINE_CLASSES[confidence], className)}>
      {LABEL_BY_CONFIDENCE[confidence]}
    </Badge>
  );
}
