"use client";

/**
 * KAN-1166 PR 3-core-shell — /campaigns/[id] Campaign-as-Conversation route.
 * KAN-1206 — Status-branching destination view: draft → existing
 * FeasibilityChat substrate; all other statuses → CommittedCampaignView.
 *
 * For draft: renders the chat substrate for an outcome Campaign. The hook
 * (useCampaignChat) loads the Campaign + auto-triggers feasibility analysis
 * on first visit when goal triplet is set and feasibilityAnalysis is null.
 *
 * For committed / active / paused / archived / completed: renders the
 * CommittedCampaignView (Action Plan snapshot + LIVE Pipelines list +
 * status-dispatched action header). Surface-completeness doctrine — every
 * Campaign.status enum value has a destination view, so an operator never
 * lands on the pre-Action-Plan chat surface after Pipelines have been
 * materialized. See `surface_completeness_doctrine` + `operator_session_reveals_scope_gaps`.
 */
import { useEffect, useState } from "react";
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
import { CommittedCampaignView } from "./_components/CommittedCampaignView";

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

  // KAN-1206 — locally-overridden status so the badge updates immediately
  // after an Activate/Pause/Resume mutation without a Campaign refetch.
  // Resets when `campaign.status` from the server changes (e.g., page revisit).
  const [statusOverride, setStatusOverride] = useState<
    CampaignStatus | null
  >(null);
  useEffect(() => {
    setStatusOverride(null);
  }, [campaign?.status]);

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
  const effectiveStatus: CampaignStatus = statusOverride ?? campaign.status;

  // KAN-1206 — Status branching: draft → existing FeasibilityChat surface;
  // all other statuses → CommittedCampaignView. Surface-completeness
  // doctrine: every Campaign.status enum value has a destination view.
  if (effectiveStatus !== "draft") {
    return (
      <DetailPageShell
        backHref="/campaigns"
        backLabel="Back to Campaigns"
        title={campaign.name}
        logoMark={MessageSquare}
        headerBadge={
          <Badge variant={campaignStatusVariant(effectiveStatus)}>
            {effectiveStatus}
          </Badge>
        }
        mainSlot={
          <CommittedCampaignView
            campaign={{ ...campaign, status: effectiveStatus }}
            onStatusChanged={(next) => setStatusOverride(next)}
          />
        }
        sideSlot={null}
      />
    );
  }

  return (
    <DetailPageShell
      backHref="/campaigns"
      backLabel="Back to Campaigns"
      title={campaign.name}
      logoMark={MessageSquare}
      headerBadge={
        <Badge variant={campaignStatusVariant(effectiveStatus)}>
          {effectiveStatus}
        </Badge>
      }
      mainSlot={
        <SectionCard title="Conversation">
          {hasGoalTriplet ? (
            <ChatThread
              goalDescription={campaign.goalDescription as string}
              goalTarget={campaign.goalTarget as number}
              campaignId={campaign.id}
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
