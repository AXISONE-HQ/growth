"use client";

/**
 * KAN-1206 — Post-commit Campaign destination view.
 *
 * Renders for ANY `campaign.status !== 'draft'` per surface-completeness
 * doctrine (6 statuses covered: committed / active / paused / archived /
 * completed; draft falls through to the existing FeasibilityChat surface).
 *
 * Three sub-surfaces:
 *   1. Status-dispatched action header (Activate / Pause / Resume).
 *      Reuses existing `campaignsApi.activate` + `campaignsApi.pause`
 *      mutations. Per `feature_affordance_honesty_doctrine` memo: Activate
 *      DOES flip status; engine engagement (KAN-1199 enqueue) is deferred
 *      and surfaces as a separate scope gap if/when the operator notices.
 *   2. ActionPlanSnapshotCard — `Campaign.committedPlan` as committed.
 *   3. CommittedPipelineCard list — LIVE Pipelines from
 *      `pipelines.listWithStages({campaignId})`.
 *
 * Out-of-scope (per Phase 1 L8):
 *   - Uncommit flow / refine post-commit
 *   - First-action execute affordance (KAN-1199 scope)
 *   - Audit trail visibility (KAN-1207 candidate)
 *   - In-page Pipeline editing (deep-link to /settings/pipelines/[id])
 *
 * Sibling doctrine memos:
 *   - `operator_session_reveals_scope_gaps` (parent doctrine — KAN-1206 cause)
 *   - `surface_completeness_doctrine` (Phase 1 enforcement)
 *   - `feature_affordance_honesty_doctrine` (Activate forward-looking gap)
 */
import { useEffect, useState } from "react";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  campaignsApi,
  pipelinesApi,
  type CampaignDetail,
  type PipelineWithStages,
} from "@/lib/api";
import type { ActionPlan, CommittedPlanSnapshot } from "@growth/shared";
import { ActionPlanSnapshotCard } from "./ActionPlanSnapshotCard";
import { CommittedPipelineCard } from "./CommittedPipelineCard";

export interface CommittedCampaignViewProps {
  campaign: CampaignDetail;
  /** Bubble status changes up so the page badge updates without refetch. */
  onStatusChanged?: (next: CampaignDetail["status"]) => void;
}

function isCommittedPlan(value: unknown): value is CommittedPlanSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "plan" in value &&
    "committedAt" in value
  );
}

export function CommittedCampaignView({
  campaign,
  onStatusChanged,
}: CommittedCampaignViewProps) {
  const [pipelines, setPipelines] = useState<PipelineWithStages[] | null>(null);
  const [pipelinesError, setPipelinesError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [isTransitioning, setIsTransitioning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    pipelinesApi
      .listWithStages({ campaignId: campaign.id })
      .then((rows) => {
        if (!cancelled) setPipelines(rows);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setPipelinesError(
            e instanceof Error ? e.message : "Failed to load pipelines",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [campaign.id]);

  const committedPlan = isCommittedPlan(campaign.committedPlan)
    ? campaign.committedPlan
    : null;
  const snapshotPipelines: ActionPlan["pipelines"] | undefined =
    committedPlan?.plan.pipelines;
  const goalType = campaign.goalType ?? "items";

  const matchSnapshot = (
    livePipeline: PipelineWithStages,
    index: number,
  ): ActionPlan["pipelines"][number] | undefined => {
    if (!snapshotPipelines) return undefined;
    return (
      snapshotPipelines.find((p) => p.name === livePipeline.name) ??
      snapshotPipelines[index]
    );
  };

  const handleActivate = async () => {
    setIsTransitioning(true);
    setStatusError(null);
    try {
      const res = await campaignsApi.activate(campaign.id);
      if (res.kind === "activated" || res.kind === "already_active") {
        onStatusChanged?.("active");
      } else if (res.kind === "rejected") {
        // KAN-1208 — discriminated_union_rejected_variant_doctrine. The
        // server returns `kind: 'rejected'` (HTTP 200, not thrown) for
        // pre-activation guard failures (e.g. audience_not_evaluated,
        // status_paused). Without this branch the variant fell through
        // silently and the operator saw NOTHING change on click. The
        // sibling handlePause handler already had this pattern;
        // handleActivate now matches for symmetry. Every handler that
        // consumes a discriminated-union mutation result MUST branch on
        // rejected and surface res.reason to the operator.
        setStatusError(`Activate rejected: ${res.reason}`);
      }
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : "Activation failed");
    } finally {
      setIsTransitioning(false);
    }
  };

  const handlePause = async () => {
    setIsTransitioning(true);
    setStatusError(null);
    try {
      const res = await campaignsApi.pause(campaign.id);
      if (res.kind === "paused") {
        onStatusChanged?.("paused");
      } else if (res.kind === "rejected") {
        setStatusError(`Pause rejected: ${res.reason}`);
      }
      // already_inactive: no-op — the status already reflects a non-active
      // state, so we trust whatever Campaign.status is on next refetch.
    } catch (e) {
      setStatusError(e instanceof Error ? e.message : "Pause failed");
    } finally {
      setIsTransitioning(false);
    }
  };

  const isReadOnly =
    campaign.status === "archived" || campaign.status === "completed";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Campaign status
          </span>
          <Badge
            variant={
              campaign.status === "active"
                ? "green"
                : campaign.status === "paused"
                  ? "amber"
                  : campaign.status === "archived"
                    ? "rose"
                    : campaign.status === "completed"
                      ? "positive"
                      : "ai"
            }
            className="w-fit text-xs"
          >
            {campaign.status}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          {campaign.status === "committed" && (
            <Button
              type="button"
              variant="gradient"
              size="sm"
              onClick={handleActivate}
              disabled={isTransitioning}
              className="gap-1.5"
            >
              <Play className="h-3.5 w-3.5" />
              {isTransitioning ? "Activating…" : "Activate Campaign"}
            </Button>
          )}
          {campaign.status === "active" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handlePause}
              disabled={isTransitioning}
              className="gap-1.5"
            >
              <Pause className="h-3.5 w-3.5" />
              {isTransitioning ? "Pausing…" : "Pause"}
            </Button>
          )}
          {campaign.status === "paused" && (
            <Button
              type="button"
              variant="gradient"
              size="sm"
              onClick={handleActivate}
              disabled={isTransitioning}
              className="gap-1.5"
            >
              <Play className="h-3.5 w-3.5" />
              {isTransitioning ? "Resuming…" : "Resume"}
            </Button>
          )}
        </div>
      </header>

      {statusError && (
        <p className="text-xs text-destructive">{statusError}</p>
      )}

      {committedPlan ? (
        <ActionPlanSnapshotCard
          committedPlan={committedPlan}
          goalType={goalType}
        />
      ) : (
        <p className="rounded-md border border-border bg-muted/30 p-4 text-xs text-muted-foreground">
          No committed plan snapshot recorded for this Campaign.
        </p>
      )}

      <section
        aria-label="Pipelines"
        className="flex flex-col gap-3 rounded-lg border border-border bg-card p-6"
      >
        <header className="flex items-center justify-between gap-3">
          <h3 className="text-h3 font-semibold">Pipelines</h3>
          {pipelines && (
            <span className="text-xs text-muted-foreground">
              {pipelines.length} live
            </span>
          )}
        </header>
        {pipelinesError && (
          <p className="text-xs text-destructive">{pipelinesError}</p>
        )}
        {!pipelines && !pipelinesError && (
          <p className="text-xs text-muted-foreground">Loading pipelines…</p>
        )}
        {pipelines && pipelines.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No live pipelines bound to this Campaign.
          </p>
        )}
        {pipelines && pipelines.length > 0 && (
          <div className="flex flex-col gap-3">
            {pipelines.map((p, i) => (
              <CommittedPipelineCard
                key={p.id}
                pipeline={p}
                snapshot={matchSnapshot(p, i)}
                index={i}
                goalType={goalType}
              />
            ))}
          </div>
        )}
      </section>

      {isReadOnly && (
        <p className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          This Campaign is {campaign.status}. View is read-only.
        </p>
      )}
    </div>
  );
}
