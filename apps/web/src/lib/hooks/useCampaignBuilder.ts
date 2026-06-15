/**
 * KAN-1187 — Builder chat hook for /campaigns/new.
 *
 * Wraps:
 *   - campaignsApi.chat — turn-by-turn dispatch (KAN-1184 orchestrator);
 *     server creates draft Campaign on first turn (Q-ADD C3 lock)
 *   - campaignsApi.generateActionPlan — operator-initiated dispatch
 *     (Q-ADD NEW-2 lock) once all 4 dimensions Confirmed
 *
 * State management:
 *   - `state`: ConversationState (4 dimensions × {empty, proposed, confirmed})
 *   - `turns`: ordered chat turns for rendering (operator + AI)
 *   - `campaignId`: persists once orchestrator returns it on first turn
 *
 * Reset turn handling (X3 lock): on kind='reset' reply, conversation state
 * resets to emptyConversationState() while turns history stays visible
 * (operator can scroll back). UI surfaces the reset via inline delimiter.
 */
import { useCallback, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  campaignsApi,
  type ActionPlanResult,
  type ChatTurnResult,
  type ConversationState,
} from "@/lib/api";
import { emptyConversationState } from "@growth/shared";

export type BuilderTurnRole = "operator" | "ai";

export interface BuilderTurn {
  role: BuilderTurnRole;
  /** Operator message text OR AI response message text. */
  content: string;
  /** Only present on AI turns — carries the full discriminated result so
   *  the renderer can branch on kind (dimension_confirmed / reset / ...). */
  aiResult?: ChatTurnResult;
  timestamp: string;
}

export interface UseCampaignBuilderResult {
  state: ConversationState;
  turns: BuilderTurn[];
  campaignId: string | undefined;
  isSending: boolean;
  sendError: Error | null;
  send: (message: string) => void;
  isGenerating: boolean;
  generateError: Error | null;
  generatePlanResult: ActionPlanResult | null;
  generatePlan: () => void;
  allDimensionsConfirmed: boolean;
}

export function useCampaignBuilder(): UseCampaignBuilderResult {
  const [state, setState] = useState<ConversationState>(emptyConversationState());
  const [turns, setTurns] = useState<BuilderTurn[]>([]);
  const [campaignId, setCampaignId] = useState<string | undefined>(undefined);
  const [allDimensionsConfirmed, setAllDimensionsConfirmed] = useState(false);
  const [generatePlanResult, setGeneratePlanResult] =
    useState<ActionPlanResult | null>(null);

  const chatMutation = useMutation({
    mutationFn: (message: string) =>
      campaignsApi.chat({
        campaignId,
        message,
        state,
      }),
    onSuccess: (result: ChatTurnResult) => {
      const aiTurn: BuilderTurn = {
        role: "ai",
        content: "aiMessage" in result ? result.aiMessage : "",
        aiResult: result,
        timestamp: new Date().toISOString(),
      };
      setTurns((prev) => [...prev, aiTurn]);

      // Persist campaignId from any non-analyzer-unavailable result
      if ("campaignId" in result && result.campaignId) {
        setCampaignId(result.campaignId);
      }

      // Apply state transitions
      if (result.kind === "reset") {
        // X3 lock — reset clears state but preserves turns history
        setState(emptyConversationState());
        setAllDimensionsConfirmed(false);
      } else if ("state" in result) {
        setState(result.state);
        if (result.kind === "all_dimensions_confirmed") {
          setAllDimensionsConfirmed(true);
        }
      }
    },
  });

  const generateMutation = useMutation({
    mutationFn: () => {
      if (!campaignId) {
        throw new Error("Cannot generate plan before campaignId is set");
      }
      return campaignsApi.generateActionPlan({ campaignId });
    },
    onSuccess: (result: ActionPlanResult) => {
      setGeneratePlanResult(result);
    },
  });

  const send = useCallback(
    (message: string) => {
      const operatorTurn: BuilderTurn = {
        role: "operator",
        content: message,
        timestamp: new Date().toISOString(),
      };
      // Optimistic-append operator turn before mutation fires
      setTurns((prev) => [...prev, operatorTurn]);
      chatMutation.mutate(message);
    },
    [chatMutation],
  );

  const generatePlan = useCallback(() => {
    generateMutation.mutate();
  }, [generateMutation]);

  return {
    state,
    turns,
    campaignId,
    isSending: chatMutation.isPending,
    sendError: (chatMutation.error as Error) ?? null,
    send,
    isGenerating: generateMutation.isPending,
    generateError: (generateMutation.error as Error) ?? null,
    generatePlanResult,
    generatePlan,
    allDimensionsConfirmed,
  };
}
