/**
 * KAN-1166 PR 3-core-shell → PR 3-variants — Chat thread container.
 *
 * Renders the scrollable conversation panel composed of operator + AI
 * message bubbles. The shell composes:
 *   - the operator's goal-setting statement (from Campaign.goalDescription)
 *   - one AI turn rendering one of: LoadingState | FeasibilityCounselCard
 *     (which dispatches to ColdStart / Detail / AnalyzerUnavailable)
 *
 * PR 3-variants replaced the inline cold-start + honestAssessment paragraph
 * placeholders with the FeasibilityCounselCard dispatcher (variant cards).
 * PR 3-tests adds RTL coverage.
 */
import type { FeasibilityCounselResult } from "@growth/shared";
import { OperatorMessage } from "./OperatorMessage";
import { AIMessage } from "./AIMessage";
import { LoadingState } from "./LoadingState";
import { AnalyzerUnavailableCard } from "./AnalyzerUnavailableCard";
import { FeasibilityCounselCard } from "./FeasibilityCounselCard";

export interface ChatThreadProps {
  goalDescription: string;
  goalTarget: number;
  campaignId: string;
  feasibility: FeasibilityCounselResult | null;
  isAnalyzing: boolean;
  analyzeError: Error | null;
  onRetry: () => void;
}

export function ChatThread({
  goalDescription,
  goalTarget,
  campaignId,
  feasibility,
  isAnalyzing,
  analyzeError,
  onRetry,
}: ChatThreadProps) {
  return (
    <div className="flex flex-col gap-6 px-6 py-6">
      <OperatorMessage content={goalDescription} />
      <AIMessage timestamp={feasibility ? formatComputedAt(feasibility) : undefined}>
        {renderCounselBody({
          feasibility,
          goalTarget,
          campaignId,
          isAnalyzing,
          analyzeError,
          onRetry,
        })}
      </AIMessage>
    </div>
  );
}

function renderCounselBody({
  feasibility,
  goalTarget,
  campaignId,
  isAnalyzing,
  analyzeError,
  onRetry,
}: {
  feasibility: FeasibilityCounselResult | null;
  goalTarget: number;
  campaignId: string;
  isAnalyzing: boolean;
  analyzeError: Error | null;
  onRetry: () => void;
}): React.ReactNode {
  if (isAnalyzing && !feasibility) return <LoadingState />;
  if (analyzeError && !feasibility) {
    return (
      <AnalyzerUnavailableCard
        message={`Couldn't reach the analyzer (${analyzeError.message}). Try again in a moment.`}
        onRetry={onRetry}
      />
    );
  }
  if (!feasibility) {
    return <p className="text-body text-muted-foreground">Preparing counsel…</p>;
  }
  return (
    <FeasibilityCounselCard
      counsel={feasibility}
      goalTarget={goalTarget}
      campaignId={campaignId}
      onRetry={onRetry}
      onReAnalyze={onRetry}
      isReAnalyzing={isAnalyzing}
    />
  );
}

function formatComputedAt(result: FeasibilityCounselResult): string | undefined {
  if (result.kind === "analyzer_unavailable") return undefined;
  const date = new Date(result.computedAt);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString();
}
