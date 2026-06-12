/**
 * KAN-1166 PR 3-variants — Feasibility counsel detail card (sufficient /
 * partial paths). The substantive "AI honest counsel" surface.
 *
 * Above-the-fold doctrine (Q-ADD D1 — NON-NEGOTIABLE):
 *   1. AchievabilityBadge + ConfidenceBadge — top row, side-by-side
 *   2. MathCard — projection + goal + gap
 *   3. honestAssessment paragraph — first-class, NOT collapsed (Q-ADD D2)
 *   On 1920×1080 with sidebar+header, these all render within first ~500px.
 *
 * Below the fold (acceptable per brief):
 *   4. PathCard ×3 (exactly 3 per Q10 v0.1 lock; vertical stack per V4)
 *   5. ReAnalyzeCTA — bottom-right of card (Q-ADD I1)
 */
import type { FeasibilityCounsel } from "@growth/shared";
import { AchievabilityBadge } from "./AchievabilityBadge";
import { ConfidenceBadge } from "./ConfidenceBadge";
import { MathCard } from "./MathCard";
import { PathCard } from "./PathCard";
import { ReAnalyzeCTA } from "./ReAnalyzeCTA";

export interface FeasibilityCounselDetailCardProps {
  counsel: FeasibilityCounsel;
  goalTarget: number;
  campaignId: string;
  onReAnalyze: () => void;
  isReAnalyzing?: boolean;
  className?: string;
}

export function FeasibilityCounselDetailCard({
  counsel,
  goalTarget,
  campaignId,
  onReAnalyze,
  isReAnalyzing,
  className,
}: FeasibilityCounselDetailCardProps) {
  return (
    <div
      data-doctrine-anchor="counsel-detail-fold"
      className={"flex flex-col gap-4 " + (className ?? "")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <AchievabilityBadge verdict={counsel.achievability} />
        <ConfidenceBadge confidence={counsel.confidence} />
      </div>

      <MathCard
        projectedOrganic={counsel.projectedOrganic}
        goalTarget={goalTarget}
        goalGap={counsel.goalGap}
      />

      <p className="whitespace-pre-wrap text-body">{counsel.honestAssessment}</p>

      <div className="flex flex-col gap-3">
        {counsel.achievablePaths.map((path, idx) => (
          <PathCard key={`${path.label}-${idx}`} path={path} campaignId={campaignId} />
        ))}
      </div>

      <ReAnalyzeCTA onReAnalyze={onReAnalyze} isReAnalyzing={isReAnalyzing} />
    </div>
  );
}
