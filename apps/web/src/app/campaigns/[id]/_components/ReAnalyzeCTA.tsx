/**
 * KAN-1166 PR 3-variants — Re-analyze CTA (inline within counsel cards).
 *
 * Placement (Q-ADD I1 ratified): bottom-right of FeasibilityCounselDetailCard.
 * Stays within the AI message bubble; page chrome (DetailPageShell
 * headerAction) is reserved for status + edit per the "chat is the surface"
 * doctrine. Visual consistency with AnalyzerUnavailableCard's retry CTA.
 *
 * Re-fires campaigns.analyzeFeasibility via the parent's triggerAnalyze
 * (from useCampaignChat). Server idempotently overwrites + audits prior
 * counsel snapshot.
 */
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ReAnalyzeCTAProps {
  onReAnalyze: () => void;
  isReAnalyzing?: boolean;
  className?: string;
}

export function ReAnalyzeCTA({
  onReAnalyze,
  isReAnalyzing,
  className,
}: ReAnalyzeCTAProps) {
  return (
    <div className={"flex justify-end " + (className ?? "")}>
      <Button
        variant="outline"
        size="sm"
        onClick={onReAnalyze}
        disabled={isReAnalyzing}
        className="gap-1.5"
      >
        <RefreshCw className={"h-3.5 w-3.5 " + (isReAnalyzing ? "animate-spin" : "")} />
        {isReAnalyzing ? "Re-analyzing…" : "Re-analyze"}
      </Button>
    </div>
  );
}
