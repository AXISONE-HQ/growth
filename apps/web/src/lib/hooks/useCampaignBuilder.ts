/**
 * KAN-1187 — Builder chat hook for /campaigns/new.
 * KAN-1189 — Extended for /campaigns/new?campaignId= restoration mode.
 *
 * Wraps:
 *   - campaignsApi.chat — turn-by-turn dispatch (KAN-1184 orchestrator);
 *     server creates draft Campaign on first turn (Q-ADD C3 lock)
 *   - campaignsApi.generateActionPlan — operator-initiated dispatch
 *     (Q-ADD NEW-2 lock) once all 4 dimensions Confirmed
 *   - campaignsApi.getConversationHistory — KAN-1189 H1/H2 lock; fetched
 *     when `initialCampaignId` provided; replays state via the Z1 shared
 *     helper (replayConversationState) from @growth/shared
 *
 * State management:
 *   - `state`: ConversationState (4 dimensions × {empty, proposed, confirmed})
 *   - `turns`: ordered chat turns for rendering (operator + AI)
 *   - `campaignId`: persists once orchestrator returns it OR set from
 *     `initialCampaignId` on restoration
 *
 * Reset turn handling (X3 lock): on kind='reset' reply, conversation state
 * resets to emptyConversationState() while turns history stays visible
 * (operator can scroll back). UI surfaces the reset via inline delimiter.
 * On restoration, the Z1 helper preserves this — turns with all-empty
 * `dimensionsExtracted` mark resets in the replay.
 *
 * Z2 lock: history query enables `refetchOnWindowFocus` so tabs auto-sync.
 */
import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  campaignsApi,
  type ActionPlanResult,
  type ChatTurnResult,
  type ConversationState,
} from "@/lib/api";
import {
  emptyConversationState,
  replayConversationState,
  type ConversationTurn,
} from "@growth/shared";

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

export interface UseCampaignBuilderParams {
  /** When set, hook fetches conversation history + replays state on mount. */
  initialCampaignId?: string;
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
  // Restoration state (KAN-1189)
  isLoadingHistory: boolean;
  historyError: Error | null;
  retryLoadHistory: () => void;
}

/** Best-effort projection from a persisted turn row (server shape) into
 *  the ConversationTurn shape that replayConversationState consumes. The
 *  server doesn't currently persist `dimensionsExtracted` as a dedicated
 *  column — the rebuild is approximate per H3 lock. We surface the row
 *  shape we DO have (turnType + content + createdAt) so the chat thread
 *  still renders historically, even when chip-group derivation is partial. */
function rowToBuilderTurn(row: {
  turnType: string;
  content: string;
  createdAt: string;
}): BuilderTurn {
  const role: BuilderTurnRole = row.turnType === "operator" ? "operator" : "ai";
  return {
    role,
    content: row.content,
    timestamp: row.createdAt,
  };
}

/** Project server-side persisted turn into the ConversationTurn shape the
 *  Z1 replayConversationState helper expects. dimensionsExtracted is not
 *  persisted today — empty state replay returns emptyConversationState(),
 *  which is correct: operator can read the chat thread to see prior state. */
function rowToConversationTurn(row: {
  turnType: string;
  content: string;
  createdAt: string;
}): ConversationTurn {
  return {
    turnType: row.turnType as ConversationTurn["turnType"],
    content: row.content,
    createdAt: row.createdAt,
  };
}

export function useCampaignBuilder(
  params: UseCampaignBuilderParams = {},
): UseCampaignBuilderResult {
  const [state, setState] = useState<ConversationState>(emptyConversationState());
  const [turns, setTurns] = useState<BuilderTurn[]>([]);
  const [campaignId, setCampaignId] = useState<string | undefined>(
    params.initialCampaignId,
  );
  const [allDimensionsConfirmed, setAllDimensionsConfirmed] = useState(false);
  const [generatePlanResult, setGeneratePlanResult] =
    useState<ActionPlanResult | null>(null);

  // KAN-1189 — history fetch + replay (H1/H2/Z2 locks)
  const historyQuery = useQuery({
    queryKey: ["campaigns", "history", params.initialCampaignId] as const,
    queryFn: () =>
      campaignsApi.getConversationHistory({
        campaignId: params.initialCampaignId!,
      }),
    enabled: Boolean(params.initialCampaignId),
    refetchOnWindowFocus: true, // Z2 lock — auto-sync across tabs
  });

  // Apply history once on successful fetch (or refetch)
  useEffect(() => {
    if (!historyQuery.data) return;
    const conversationTurns = historyQuery.data.items.map(rowToConversationTurn);
    setState(replayConversationState(conversationTurns));
    setTurns(historyQuery.data.items.map(rowToBuilderTurn));
    // If history is non-empty + all 4 dimensions confirmed, the inline
    // Generate Action Plan button should be live (matches the orchestrator
    // result-kind path that surfaces it on live turns).
    const restoredState = replayConversationState(conversationTurns);
    const allConfirmed = (["product", "objectives", "timeline", "audience"] as const).every(
      (k) => restoredState[k].kind === "confirmed",
    );
    setAllDimensionsConfirmed(allConfirmed);
  }, [historyQuery.data]);

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

  const retryLoadHistory = useCallback(() => {
    historyQuery.refetch();
  }, [historyQuery]);

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
    isLoadingHistory: historyQuery.isLoading,
    historyError: (historyQuery.error as Error) ?? null,
    retryLoadHistory,
  };
}
