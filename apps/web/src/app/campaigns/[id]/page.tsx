"use client";

/**
 * KAN-1166 PR 3-core-shell — /campaigns/[id] Campaign-as-Conversation route.
 *
 * Renders the chat substrate for an outcome Campaign. The hook
 * (useCampaignChat) loads the Campaign + auto-triggers feasibility analysis
 * on first visit when goal triplet is set and feasibilityAnalysis is null.
 *
 * MVP scope (PR 3-core-shell): one operator message (goalDescription) + one
 * AI message rendering one of LoadingState | AnalyzerUnavailableCard |
 * cold_start_counsel.message | feasibility_counsel.honestAssessment. The
 * full counsel cards + achievable-paths grid land in PR 3-variants.
 */
import { useEffect } from "react";
import { useParams } from "next/navigation";
import { MessageSquare } from "lucide-react";
import {
  DetailPageShell,
  SectionCard,
} from "@/components/ui/detail-page-shell";
import { Badge } from "@/components/ui/badge";
import { useCampaignChat } from "@/lib/hooks/useCampaignChat";
import { ChatThread } from "./_components/ChatThread";
import { EmptyState } from "./_components/EmptyState";

type CampaignStatus =
  | "draft"
  | "committed"
  | "active"
  | "paused"
  | "archived"
  | "completed";

function campaignStatusVariant(
  status: CampaignStatus,
): "muted" | "ai" | "green" | "amber" | "rose" | "positive" {
  switch (status) {
    case "active":
      return "green";
    case "committed":
      return "ai";
    case "paused":
      return "amber";
    case "archived":
      return "rose";
    case "completed":
      return "positive";
    case "draft":
    default:
      return "muted";
  }
}

export default function CampaignChatPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const {
    campaign,
    isLoading,
    isError,
    error,
    feasibility,
    isAnalyzing,
    analyzeError,
    triggerAnalyze,
  } = useCampaignChat(id);

  useEffect(() => {
    if (campaign?.name) document.title = `${campaign.name} · Campaigns`;
  }, [campaign?.name]);

  if (!id) return null;

  if (isLoading) {
    return (
      <DetailPageShell
        backHref="/campaigns"
        backLabel="Back to Campaigns"
        title="Loading…"
        logoMark={MessageSquare}
        mainSlot={
          <SectionCard title="Campaign">
            <p className="text-body text-muted-foreground">Loading campaign…</p>
          </SectionCard>
        }
        sideSlot={null}
      />
    );
  }

  if (isError || !campaign) {
    const message = error?.message ?? "Campaign not found";
    return (
      <DetailPageShell
        backHref="/campaigns"
        backLabel="Back to Campaigns"
        title="Campaign not found"
        logoMark={MessageSquare}
        mainSlot={
          <SectionCard title="Error">
            <p className="text-body text-muted-foreground">{message}</p>
          </SectionCard>
        }
        sideSlot={null}
      />
    );
  }

  const hasGoalTriplet =
    !!campaign.goalType &&
    campaign.goalTarget != null &&
    !!campaign.goalDescription;

  return (
    <DetailPageShell
      backHref="/campaigns"
      backLabel="Back to Campaigns"
      title={campaign.name}
      logoMark={MessageSquare}
      headerBadge={<Badge variant={campaignStatusVariant(campaign.status)}>{campaign.status}</Badge>}
      mainSlot={
        <SectionCard title="Conversation">
          {hasGoalTriplet ? (
            <ChatThread
              goalDescription={campaign.goalDescription as string}
              feasibility={feasibility}
              isAnalyzing={isAnalyzing}
              analyzeError={analyzeError}
              onRetry={triggerAnalyze}
            />
          ) : (
            <EmptyState campaignId={campaign.id} />
          )}
        </SectionCard>
      }
      sideSlot={null}
    />
  );
}
