"use client";

/**
 * KAN-1188 G1 — ActionPlan header sub-card.
 * KAN-1190 J9 — Extended with Commit button placed next to Undo.
 *
 * Surfaces: campaign name + tenant-level confidence badge + brief gap
 * summary + generatedAt + Undo (G9 rollback) + Commit (J9 — materializes
 * N Pipelines + flips Campaign.status → committed).
 */
import { Undo2, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionPlanConfidenceBadge } from "../../_components/ActionPlanConfidenceBadge";
import type { ActionPlan } from "@/lib/api";

export interface ActionPlanHeaderCardProps {
  plan: ActionPlan;
  campaignName?: string;
  onRevert: () => void;
  isReverting: boolean;
  revertDisabled: boolean;
  revertDisabledReason?: string;
  // KAN-1190 J9 — Commit affordance
  onCommit: () => void;
  isCommitting: boolean;
  /** True when Campaign.status is already 'committed' — header surfaces
   *  the success state above this card, but we still hide Commit here. */
  commitHidden?: boolean;
}

function formatGeneratedAt(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function ActionPlanHeaderCard({
  plan,
  campaignName,
  onRevert,
  isReverting,
  revertDisabled,
  revertDisabledReason,
  onCommit,
  isCommitting,
  commitHidden,
}: ActionPlanHeaderCardProps) {
  const gapSummary = `Goal ${plan.gapAnalysis.goalTarget} · projected ${plan.gapAnalysis.projectedOrganic} (${plan.gapAnalysis.gapPercent.toFixed(0)}% short)`;
  return (
    <div className="flex flex-col gap-3 border-b border-border pb-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-h3 font-semibold">
            {campaignName ?? "Action Plan"}
          </h3>
          <p className="text-xs text-muted-foreground">
            Generated {formatGeneratedAt(plan.generatedAt)} · {plan.modelUsed}
          </p>
        </div>
        <ActionPlanConfidenceBadge
          confidence={plan.confidence}
          reason={plan.confidenceReason}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-foreground">{gapSummary}</p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRevert}
            disabled={revertDisabled || isReverting || isCommitting}
            title={revertDisabledReason}
            className="gap-1.5"
          >
            <Undo2 className="h-3.5 w-3.5" />
            {isReverting ? "Reverting…" : "Undo last edit"}
          </Button>
          {!commitHidden && (
            <Button
              type="button"
              variant="gradient"
              size="sm"
              onClick={onCommit}
              disabled={isCommitting || isReverting}
              className="gap-1.5"
            >
              <CheckCheck className="h-3.5 w-3.5" />
              {isCommitting ? "Committing…" : "Commit plan"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
