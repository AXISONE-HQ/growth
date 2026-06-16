"use client";

/**
 * KAN-1206 — Committed Action Plan snapshot card.
 *
 * Renders the historical snapshot of what was committed at commit time.
 * Atomic source: `Campaign.committedPlan` (CommittedPlanSnapshot JSON written
 * inside the J2 transaction at commit-action-plan.ts:367-372).
 *
 * Snapshot doctrine (KAN-1190 V3): the committed view shows the plan as
 * agreed-to at commit time. Per-Pipeline edits AFTER commit (operator
 * adjustments via /settings/pipelines/[id]) are reflected by the LIVE
 * CommittedPipelineCard list, not by this card. This card is the
 * "what we agreed to" record.
 *
 * Sibling doctrine memos:
 *   - `surface_completeness_doctrine` — KAN-1206 Phase 1 (this PR)
 *   - `operator_session_reveals_scope_gaps` — KAN-1206 root cause
 */
import { GapAnalysisCard } from "@/app/campaigns/new/_components/GapAnalysisCard";
import { ActionPlanConfidenceBadge } from "@/app/campaigns/_components/ActionPlanConfidenceBadge";
import type { CommittedPlanSnapshot } from "@growth/shared";

export interface ActionPlanSnapshotCardProps {
  committedPlan: CommittedPlanSnapshot;
  goalType: string;
}

function formatCommittedAt(iso: string): string {
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

export function ActionPlanSnapshotCard({
  committedPlan,
  goalType,
}: ActionPlanSnapshotCardProps) {
  const { plan } = committedPlan;
  return (
    <section
      aria-label="Committed Action Plan snapshot"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-6"
    >
      <header className="flex flex-col gap-3 border-b border-border pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="text-h3 font-semibold">Committed Action Plan</h3>
            <p className="text-xs text-muted-foreground">
              Snapshot from {formatCommittedAt(committedPlan.committedAt)} ·{" "}
              {plan.modelUsed}
            </p>
          </div>
          <ActionPlanConfidenceBadge
            confidence={plan.confidence}
            reason={plan.confidenceReason}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Plan as agreed at commit. Per-pipeline edits after commit appear in
          the live Pipelines section below.
        </p>
      </header>

      <GapAnalysisCard plan={plan} goalType={goalType} />
    </section>
  );
}
