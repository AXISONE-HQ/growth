"use client";

/**
 * KAN-1187 — Builder chat thread (F4 turn-by-turn renderer + F5 inline
 * Generate Action Plan button + X3 reset-turn delimiter).
 *
 * Dispatches on ChatTurnResult.kind for AI turns:
 *   clarification           → AIMessage + text
 *   dimension_proposed      → AIMessage + text + "Proposed: <dim>" chip
 *   dimension_confirmed     → AIMessage + text + "✓ Confirmed: <dim>" chip
 *   all_dimensions_confirmed → AIMessage + text + inline Generate Action Plan button (F5)
 *   reset                   → AIMessage + "— Reset to start —" delimiter (X3)
 *   analyzer_unavailable    → AnalyzerUnavailableCard reuse
 *
 * Optimistic UI (F6): operator turn appended before the chat mutation resolves;
 * LoadingState shown for the pending AI turn.
 */
import { useState, type FormEvent } from "react";
import { Send, Sparkles } from "lucide-react";
import { OperatorMessage } from "../../_components/OperatorMessage";
import { AIMessage } from "../../_components/AIMessage";
import { LoadingState } from "../../_components/LoadingState";
import { AnalyzerUnavailableCard } from "../../_components/AnalyzerUnavailableCard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ChatTurnResult } from "@/lib/api";
import type { BuilderTurn } from "@/lib/hooks/useCampaignBuilder";
import { BUILDER_EMPTY_STATE_MESSAGE } from "../../_shared/constants";

export interface BuilderChatThreadProps {
  turns: BuilderTurn[];
  isSending: boolean;
  sendError: Error | null;
  onSend: (message: string) => void;
  allDimensionsConfirmed: boolean;
  onGeneratePlan: () => void;
  isGenerating: boolean;
  className?: string;
}

function renderAiResult(result: ChatTurnResult, onGeneratePlan: () => void, isGenerating: boolean): React.ReactNode {
  switch (result.kind) {
    case "analyzer_unavailable":
      return <AnalyzerUnavailableCard message={result.aiMessage} onRetry={() => {}} />;
    case "reset":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-foreground leading-relaxed">{result.aiMessage}</p>
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Reset to start
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>
        </div>
      );
    case "dimension_proposed":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-foreground leading-relaxed">{result.aiMessage}</p>
          <Badge variant="amber" className="self-start">
            Proposed: {result.dimensionKey}
          </Badge>
        </div>
      );
    case "dimension_confirmed":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-foreground leading-relaxed">{result.aiMessage}</p>
          <Badge variant="green" className="self-start">
            ✓ Confirmed: {result.dimensionKey}
          </Badge>
        </div>
      );
    case "all_dimensions_confirmed":
      return (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-foreground leading-relaxed">{result.aiMessage}</p>
          <Button
            type="button"
            onClick={onGeneratePlan}
            disabled={isGenerating}
            className="self-start gap-2"
          >
            <Sparkles className="h-4 w-4" />
            {isGenerating ? "Generating..." : "Generate Action Plan"}
          </Button>
        </div>
      );
    case "clarification":
    default:
      return <p className="text-sm text-foreground leading-relaxed">{result.aiMessage}</p>;
  }
}

export function BuilderChatThread({
  turns,
  isSending,
  sendError,
  onSend,
  allDimensionsConfirmed: _allDimensionsConfirmed,
  onGeneratePlan,
  isGenerating,
  className,
}: BuilderChatThreadProps) {
  const [draft, setDraft] = useState("");

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || isSending) return;
    onSend(trimmed);
    setDraft("");
  };

  const isEmpty = turns.length === 0;

  return (
    <div
      className={`flex flex-col gap-6 rounded-lg border border-border bg-card ${className ?? ""}`}
    >
      <div className="flex flex-col gap-6 px-6 py-6 min-h-[400px]">
        {isEmpty && (
          <div className="flex flex-col items-center justify-center gap-4 px-6 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-100 text-violet-700">
              <Sparkles className="h-6 w-6" />
            </div>
            <h3 className="text-h3 font-semibold">Start a new Campaign</h3>
            <p className="max-w-md text-body text-muted-foreground">
              {BUILDER_EMPTY_STATE_MESSAGE}
            </p>
          </div>
        )}
        {turns.map((turn, idx) => {
          if (turn.role === "operator") {
            return (
              <OperatorMessage
                key={idx}
                content={turn.content}
                timestamp={turn.timestamp}
              />
            );
          }
          return (
            <AIMessage key={idx} timestamp={turn.timestamp}>
              {turn.aiResult
                ? renderAiResult(turn.aiResult, onGeneratePlan, isGenerating)
                : turn.content}
            </AIMessage>
          );
        })}
        {isSending && (
          <AIMessage>
            <LoadingState />
          </AIMessage>
        )}
        {sendError && (
          <p
            role="alert"
            className="text-sm text-destructive"
          >
            Couldn&apos;t send. Try again.
          </p>
        )}
      </div>
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 border-t border-border bg-background/50 px-4 py-3"
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Describe your campaign…"
          aria-label="Send a message"
          className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          disabled={isSending}
        />
        <Button
          type="submit"
          disabled={isSending || draft.trim().length === 0}
          aria-label="Send message"
          className="gap-2"
        >
          <Send className="h-4 w-4" />
          Send
        </Button>
      </form>
    </div>
  );
}
