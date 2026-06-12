/**
 * KAN-1166 PR 3-core-shell — Chat substrate hook for /campaigns/[id].
 *
 * Wraps:
 *   - useQuery({ queryKey: ['campaigns', 'get', campaignId] }) reading the
 *     Campaign + its feasibility snapshot
 *   - useMutation around campaigns.analyzeFeasibility, auto-triggered once
 *     when the Campaign has a goal triplet (goalType + goalTarget +
 *     goalDescription) but feasibilityAnalysis is still null
 *
 * Auto-trigger rules (Phase 1 Decision 2 lock):
 *   - skip if campaign not loaded yet
 *   - skip if feasibilityAnalysis already populated (idempotent re-runs are
 *     operator-initiated only; auto-trigger fires once on first visit)
 *   - skip if any goal-triplet field missing (goal-setting UX happens
 *     elsewhere first; chat UI shows EmptyState when triplet incomplete)
 *   - skip while mutation already pending
 *
 * On mutation success the query cache row is updated locally (the server
 * has persisted feasibilityAnalysis + proposedPlan to the Campaign row,
 * but we mirror the new counsel client-side so the next render reflects
 * it without a refetch round-trip).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { campaignsApi, type CampaignDetail } from "@/lib/api";
import type { FeasibilityCounselResult } from "@growth/shared";

export interface UseCampaignChatResult {
  campaign: CampaignDetail | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  feasibility: FeasibilityCounselResult | null;
  isAnalyzing: boolean;
  analyzeError: Error | null;
  triggerAnalyze: () => void;
}

export function useCampaignChat(campaignId: string | undefined): UseCampaignChatResult {
  const queryClient = useQueryClient();

  const queryKey = ["campaigns", "get", campaignId] as const;

  const {
    data: campaign,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey,
    queryFn: () => campaignsApi.get(campaignId as string),
    enabled: !!campaignId,
  });

  const mutation = useMutation({
    mutationFn: async (id: string): Promise<FeasibilityCounselResult> => {
      return campaignsApi.analyzeFeasibility(id);
    },
    onSuccess: (result) => {
      queryClient.setQueryData<CampaignDetail | undefined>(queryKey, (prev) =>
        prev ? { ...prev, feasibilityAnalysis: result } : prev,
      );
    },
  });

  useEffect(() => {
    if (!campaign) return;
    if (campaign.feasibilityAnalysis !== null) return;
    if (!campaign.goalType || campaign.goalTarget == null || !campaign.goalDescription) {
      return;
    }
    if (mutation.isPending) return;
    mutation.mutate(campaign.id);
  }, [campaign, mutation]);

  return {
    campaign,
    isLoading,
    isError,
    error: (error as Error | null) ?? null,
    feasibility: campaign?.feasibilityAnalysis ?? null,
    isAnalyzing: mutation.isPending,
    analyzeError: (mutation.error as Error | null) ?? null,
    triggerAnalyze: () => {
      if (campaign) mutation.mutate(campaign.id);
    },
  };
}
