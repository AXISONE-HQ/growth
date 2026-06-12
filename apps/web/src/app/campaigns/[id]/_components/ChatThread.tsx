/**
 * KAN-1166 PR 3-core-shell — Chat thread container.
 *
 * Renders the scrollable conversation panel composed of operator + AI
 * message bubbles. The shell composes:
 *   - the operator's goal-setting statement (from Campaign.goalDescription)
 *   - one AI turn rendering one of: LoadingState | AnalyzerUnavailableCard |
 *     feasibility honestAssessment | cold-start placeholder
 *
 * PR 3-variants expands the AI turn to render full cold_start_counsel +
 * feasibility_counsel cards with achievable-path grids. PR 3-tests adds RTL
 * coverage.
 */
import type { FeasibilityCounselResult } from "@growth/shared";
import { OperatorMessage } from "./OperatorMessage";
import { AIMessage } from "./AIMessage";
import { LoadingState } from "./LoadingState";
import { AnalyzerUnavailableCard } from "./AnalyzerUnavailableCard";

export interface ChatThreadProps {
  goalDescription: string;
  feasibility: FeasibilityCounselResult | null;
  isAnalyzing: boolean;
  analyzeError: Error | null;
  onRetry: () => void;
}

export function ChatThread({
  goalDescription,
  feasibility,
  isAnalyzing,
  analyzeError,
  onRetry,
}: ChatThreadProps) {
  return (
    <div className="flex flex-col gap-6 px-6 py-6">
      <OperatorMessage content={goalDescription} />
      <AIMessage timestamp={feasibility ? formatComputedAt(feasibility) : undefined}>
        {renderCounselBody({ feasibility, isAnalyzing, analyzeError, onRetry })}
      </AIMessage>
    </div>
  );
}

function renderCounselBody({
  feasibility,
  isAnalyzing,
  analyzeError,
  onRetry,
}: {
  feasibility: FeasibilityCounselResult | null;
  isAnalyzing: boolean;
  analyzeError: Error | null;
  onRetry: () => void;
}): React.ReactNode {
  if (isAnalyzing) return <LoadingState />;
  if (analyzeError) {
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
  if (feasibility.kind === "analyzer_unavailable") {
    return <AnalyzerUnavailableCard message={feasibility.message} onRetry={onRetry} />;
  }
  if (feasibility.kind === "cold_start_counsel") {
    return (
      <p className="whitespace-pre-wrap text-body">{feasibility.counsel.message}</p>
    );
  }
  return (
    <p className="whitespace-pre-wrap text-body">
      {feasibility.counsel.honestAssessment}
    </p>
  );
}

function formatComputedAt(result: FeasibilityCounselResult): string | undefined {
  if (result.kind === "analyzer_unavailable") return undefined;
  const date = new Date(result.computedAt);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString();
}
