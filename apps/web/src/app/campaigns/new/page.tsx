"use client";

/**
 * KAN-1187 — /campaigns/new conversational builder shell.
 *
 * 75/25 desktop layout: chat thread on the left, dimension sidebar on the right.
 * Mobile (<md): sidebar collapses to a single sticky chip strip above the chat.
 *
 * Wires:
 *   - useCampaignBuilder hook (state + turns + chat dispatch + generate plan)
 *   - BuilderChatThread (turn-by-turn render with reset delimiter + inline
 *     Generate Action Plan button on all_dimensions_confirmed turn)
 *   - DimensionSidebar (chip group + sticky Generate Action Plan footer button)
 *
 * Locks honored:
 *   F1 — /campaigns/new route entry
 *   F2 — 75/25 desktop / mobile-responsive
 *   F5 — dual Generate Action Plan button placement (inline + sticky sidebar)
 *   F7 — empty-state cue from BUILDER_EMPTY_STATE_MESSAGE constant
 *   F8 — scope is shell + sidebar + chat thread; ActionPlanCard deferred to KAN-1188
 *   X1 — empty-state copy lives in shared constants module
 *   X3 — reset turn renders inline delimiter; sidebar chips clear
 */
import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";
import { useCampaignBuilder } from "@/lib/hooks/useCampaignBuilder";
import { Button } from "@/components/ui/button";
import { LoadingState } from "../_components/LoadingState";
import { BuilderChatThread } from "./_components/BuilderChatThread";
import { DimensionSidebar } from "./_components/DimensionSidebar";
import { ActionPlanCard } from "./_components/ActionPlanCard";

export default function CampaignBuilderPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // H4 lock — single route, optional ?campaignId=<uuid> triggers restoration
  const restoreCampaignId = searchParams?.get("campaignId") ?? undefined;
  const { user, loading } = useAuth();
  const {
    state,
    turns,
    isSending,
    sendError,
    send,
    isGenerating,
    generateError,
    generatePlanResult,
    generatePlan,
    allDimensionsConfirmed,
    campaignId,
    isLoadingHistory,
    historyError,
    retryLoadHistory,
  } = useCampaignBuilder({ initialCampaignId: restoreCampaignId });

  useEffect(() => {
    document.title = "New Campaign · Campaigns";
  }, []);

  // Mirror existing route protection — list view + [id] pages assume
  // useAuth resolves to a user before consuming protected routes.
  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading) return null;
  if (!user) return null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-col gap-1">
        <h1 className="text-h2 font-semibold">New Campaign</h1>
        <p className="text-sm text-muted-foreground">
          Describe what you want to build. The AI will walk you through Product,
          Objectives, Timeline, and Audience — then propose an Action Plan you
          can edit.
        </p>
      </div>

      {/* KAN-1189 H7 — history fetch state surfacing */}
      {isLoadingHistory && (
        <div className="mb-4 rounded-md border border-border bg-muted/30 p-3">
          <LoadingState />
        </div>
      )}
      {historyError && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">
            <p>Couldn&apos;t load the conversation history. You can still start fresh below.</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={retryLoadHistory}
          >
            Retry
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-4 md:flex-row md:gap-6">
        <BuilderChatThread
          className="flex-1 md:basis-3/4"
          turns={turns}
          isSending={isSending}
          sendError={sendError}
          onSend={send}
          allDimensionsConfirmed={allDimensionsConfirmed}
          onGeneratePlan={generatePlan}
          isGenerating={isGenerating}
        />
        <DimensionSidebar
          className="md:basis-1/4 md:sticky md:top-6 md:self-start"
          state={state}
          allDimensionsConfirmed={allDimensionsConfirmed}
          onGeneratePlan={generatePlan}
          isGenerating={isGenerating}
        />
      </div>

      {/* G10 — ActionPlanCard fills the KAN-1187 F8 placeholder slot once
       *   generatePlanResult returns an action_plan. Card owns refine + revert. */}
      {generatePlanResult?.kind === "action_plan" && campaignId && (
        <ActionPlanCard
          campaignId={campaignId}
          initialPlan={generatePlanResult.plan}
        />
      )}
      {generatePlanResult?.kind === "analyzer_unavailable" && (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          {generatePlanResult.message}
        </div>
      )}
      {generatePlanResult?.kind === "insufficient_dimensions" && (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          {generatePlanResult.message}
        </div>
      )}
      {generateError && (
        <p role="alert" className="mt-6 text-sm text-destructive">
          We couldn&apos;t generate the plan. Try again.
        </p>
      )}
    </div>
  );
}
