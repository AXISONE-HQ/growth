/**
 * KAN-1166 PR 3-core-shell — Analyzer-unavailable card.
 *
 * Rendered inside an AI message bubble when feasibility.kind ===
 * 'analyzer_unavailable' (LLM transient post-retry-exhaustion). Surfaces
 * the server message verbatim + a "Try again" CTA wired to the parent's
 * triggerAnalyze handler.
 */
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface AnalyzerUnavailableCardProps {
  message: string;
  onRetry: () => void;
  isRetrying?: boolean;
}

export function AnalyzerUnavailableCard({
  message,
  onRetry,
  isRetrying,
}: AnalyzerUnavailableCardProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <p className="text-body">{message}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        disabled={isRetrying}
        className="self-start"
      >
        {isRetrying ? "Retrying…" : "Try again"}
      </Button>
    </div>
  );
}
