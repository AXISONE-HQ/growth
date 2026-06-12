/**
 * KAN-1166 PR 3-variants — Variant dispatcher for FeasibilityCounselResult.
 *
 * Reads the discriminated union's `kind` and renders the appropriate card:
 *   - cold_start_counsel  → ColdStartCounselCard
 *   - feasibility_counsel → FeasibilityCounselDetailCard
 *   - analyzer_unavailable → AnalyzerUnavailableCard (inherited from
 *                            PR 3-core-shell)
 *
 * The dispatcher is intentionally thin — all rendering logic lives in the
 * leaf components. This file's job is purely the kind-switch.
 */
import type { FeasibilityCounselResult } from "@growth/shared";
import { AnalyzerUnavailableCard } from "./AnalyzerUnavailableCard";
import { ColdStartCounselCard } from "./ColdStartCounselCard";
import { FeasibilityCounselDetailCard } from "./FeasibilityCounselDetailCard";

export interface FeasibilityCounselCardProps {
  counsel: FeasibilityCounselResult;
  goalTarget: number;
  campaignId: string;
  onRetry: () => void;
  onReAnalyze: () => void;
  isReAnalyzing?: boolean;
}

export function FeasibilityCounselCard({
  counsel,
  goalTarget,
  campaignId,
  onRetry,
  onReAnalyze,
  isReAnalyzing,
}: FeasibilityCounselCardProps) {
  if (counsel.kind === "analyzer_unavailable") {
    return <AnalyzerUnavailableCard message={counsel.message} onRetry={onRetry} />;
  }
  if (counsel.kind === "cold_start_counsel") {
    return <ColdStartCounselCard counsel={counsel.counsel} />;
  }
  return (
    <FeasibilityCounselDetailCard
      counsel={counsel.counsel}
      goalTarget={goalTarget}
      campaignId={campaignId}
      onReAnalyze={onReAnalyze}
      isReAnalyzing={isReAnalyzing}
    />
  );
}
