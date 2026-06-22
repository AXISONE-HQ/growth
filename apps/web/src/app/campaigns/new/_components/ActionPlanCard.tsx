"use client";

/**
 * KAN-1188 G1 + G10 — ActionPlanCard composition + page slot fill.
 * KAN-1190 J9 + J10 + V2 — Commit affordance + confidence modal + success state.
 *
 * Composes:
 *   - ActionPlanHeaderCard (campaign name + confidence + gap summary + Undo + Commit)
 *   - GapAnalysisCard (concrete numbers, G7 honest counsel)
 *   - PipelineCard × N (collapsed-by-default; Y2 useState expansion)
 *   - ChatRefinementInput (4-family chips + textarea + send + alert banners)
 *   - V2 confidence-gated commit modal — low confidence triggers a "are you
 *     sure?" confirmation BEFORE the mutation fires. AI counsels, doesn't gate
 *     (per Q-ADD V2 doctrine — no disabled-on-low-confidence anti-pattern).
 *   - J10 in-card success state — committed Plan renders a green panel +
 *     "Open Campaign" button. No auto-redirect. Operator stays in builder
 *     surface until they explicitly navigate.
 *
 * State management via useActionPlanCard hook:
 *   - plan: ActionPlan (mutates on refine/revert)
 *   - refine + revert + commit mutations + result discriminated unions
 *   - applyExternalPlan: used by G4/V2-conflict Reload-to-current affordance
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { ActionPlanHeaderCard } from "./ActionPlanHeaderCard";
import { GapAnalysisCard } from "./GapAnalysisCard";
import { PipelineCard } from "./PipelineCard";
import { ChatRefinementInput } from "./ChatRefinementInput";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useActionPlanCard } from "@/lib/hooks/useActionPlanCard";
import type { ActionPlan } from "@/lib/api";

export interface ActionPlanCardProps {
  campaignId: string;
  initialPlan: ActionPlan;
  campaignName?: string;
  goalType?: string;
  /**
   * KAN-1219 Slice G3 — operator-committed target entities. When set,
   * surfaces a "Target: N {entityType}s" affordance above the header so
   * the operator sees exactly what the Action Plan is targeting. Memo
   * 19/42 affordance-honesty.
   */
  targetEntityType?: "product" | "vehicle" | null;
  targetEntityCount?: number;
}

export function ActionPlanCard({
  campaignId,
  initialPlan,
  campaignName,
  goalType,
  targetEntityType,
  targetEntityCount,
}: ActionPlanCardProps) {
  const router = useRouter();
  const {
    plan,
    applyExternalPlan,
    isRefining,
    refineResult,
    refine,
    isReverting,
    revertResult,
    revert,
    isCommitting,
    commitResult,
    commit,
    clearCommitResult,
  } = useActionPlanCard({ campaignId, initialPlan });
  const [revertedToast, setRevertedToast] = useState<string | null>(null);
  // V2 lock — confidence-gated confirmation modal state. AI counsels, doesn't
  // gate: low-confidence plans get a "review math first" dialog instead of a
  // disabled button. Operator can still ship after acknowledging.
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);

  // G9 revert success → small confirmation toast
  if (
    revertResult?.kind === "action_plan_reverted" &&
    revertedToast !== revertResult.plan.generatedAt
  ) {
    setRevertedToast(revertResult.plan.generatedAt);
    setTimeout(() => setRevertedToast(null), 4000);
  }

  const revertDisabled = revertResult?.kind === "no_refinement_to_revert";

  // J10 — committed/already_committed both render success state. The two
  // branches differ semantically (fresh commit vs idempotent re-commit) but
  // operator UI shows the same panel + Open Campaign affordance.
  const committedSuccessfully =
    commitResult?.kind === "committed" ||
    commitResult?.kind === "already_committed";

  function handleCommitClick() {
    // V2 — surface confirmation modal for low/medium confidence; high confidence
    // commits directly. Honest counsel: operator must acknowledge the risk
    // signal verbatim before mutation fires.
    if (plan.confidence === "high") {
      commit();
    } else {
      setConfirmModalOpen(true);
    }
  }

  function handleConfirmModalCommit() {
    setConfirmModalOpen(false);
    commit();
  }

  return (
    <>
      <section
        aria-label="Action Plan"
        className="mt-6 flex flex-col gap-4 rounded-lg border border-border bg-card p-6"
      >
        {/* J10 — in-card success state. Renders ABOVE the header so the
            commit-then-Open-Campaign affordance reads top-down. */}
        {committedSuccessfully && commitResult && (
          <div
            role="status"
            className="flex items-start gap-3 rounded-md border border-emerald-300 bg-emerald-50 p-4"
          >
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
            <div className="flex flex-1 flex-col gap-1">
              <p className="text-sm font-semibold text-emerald-900">
                {commitResult.kind === "already_committed"
                  ? "Campaign already committed."
                  : "Campaign committed."}
              </p>
              <p className="text-xs text-emerald-800">
                {commitResult.kind === "committed"
                  ? `Materialized ${commitResult.pipelineIds.length} ${commitResult.pipelineIds.length === 1 ? "pipeline" : "pipelines"}.`
                  : "Earlier commit detected — no new pipelines created."}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => router.push(`/campaigns/${campaignId}`)}
            >
              Open Campaign
            </Button>
          </div>
        )}

        {/* KAN-1219 Slice G3 — target entity badge above the header.
         *   Renders only when commitTarget has fired (parent passes count). */}
        {targetEntityType && targetEntityCount != null && targetEntityCount > 0 && (
          <div className="inline-flex items-center gap-2 self-start rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-900">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Target: {targetEntityCount} {targetEntityType}
            {targetEntityCount === 1 ? "" : "s"}
          </div>
        )}

        <ActionPlanHeaderCard
          plan={plan}
          campaignName={campaignName}
          onRevert={revert}
          isReverting={isReverting}
          revertDisabled={revertDisabled || committedSuccessfully}
          revertDisabledReason={
            committedSuccessfully
              ? "Campaign already committed."
              : revertDisabled
                ? "Nothing to undo yet."
                : undefined
          }
          onCommit={handleCommitClick}
          isCommitting={isCommitting}
          commitHidden={committedSuccessfully}
        />

        <GapAnalysisCard plan={plan} goalType={goalType ?? "units"} />

        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Pipelines ({plan.pipelines.length})
          </h4>
          <div className="flex flex-col gap-2">
            {plan.pipelines.map((p, idx) => (
              <PipelineCard
                key={idx}
                pipeline={p}
                index={idx}
                goalType={goalType ?? "units"}
              />
            ))}
          </div>
        </div>

        {/* Chat refinement hidden after successful commit — refining a
            committed plan is a future affordance (operator must explicitly
            navigate to /campaigns/[id] to make further changes). */}
        {!committedSuccessfully && (
          <div className="border-t border-border pt-4">
            <ChatRefinementInput
              onSend={refine}
              isRefining={isRefining}
              refineResult={refineResult}
              onReloadFromConflict={() => {
                if (refineResult?.kind === "concurrent_edit_conflict") {
                  applyExternalPlan(refineResult.currentPlan);
                }
              }}
            />
          </div>
        )}

        {revertedToast && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
          >
            <CheckCircle2 className="h-4 w-4" />
            Reverted to {revertedToast}.
          </div>
        )}
        {revertResult?.kind === "no_refinement_to_revert" && (
          <p className="text-xs text-muted-foreground">
            {revertResult.message}
          </p>
        )}
        {revertResult?.kind === "analyzer_unavailable" && (
          <p role="alert" className="text-sm text-amber-700">
            {revertResult.message}
          </p>
        )}

        {/* KAN-1190 commit error variants — 4 discriminated banners + retry.
            Memo 38 N-variant rendering archetype (~25 LoC per variant). */}
        {commitResult?.kind === "bounds_violation" && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">Can&apos;t commit this plan yet</p>
              <p className="mt-0.5 text-xs">{commitResult.message}</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={clearCommitResult}
            >
              Dismiss
            </Button>
          </div>
        )}
        {commitResult?.kind === "concurrent_edit_conflict" && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">Plan changed since you last saw it</p>
              <p className="mt-0.5 text-xs">{commitResult.message}</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                if (commitResult.kind === "concurrent_edit_conflict") {
                  applyExternalPlan(commitResult.currentPlan);
                }
              }}
            >
              Reload latest
            </Button>
          </div>
        )}
        {commitResult?.kind === "analyzer_unavailable" && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1">
              <p className="font-medium">Couldn&apos;t commit right now</p>
              <p className="mt-0.5 text-xs">{commitResult.message}</p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={commit}>
              Retry
            </Button>
          </div>
        )}
      </section>

      {/* V2 — confidence-gated confirmation modal. AI counsels, doesn't gate. */}
      <Dialog open={confirmModalOpen} onOpenChange={setConfirmModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Commit with {plan.confidence} confidence?</DialogTitle>
            <DialogDescription>
              {plan.confidenceReason}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-medium">Review the projection math first.</p>
            <p className="mt-1 text-xs">
              Projected {plan.gapAnalysis.projectedOrganic} of {plan.gapAnalysis.goalTarget} goal
              ({plan.gapAnalysis.gapPercent.toFixed(0)}% short).
              You can still refine the plan before committing.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmModalOpen(false)}
            >
              Keep refining
            </Button>
            <Button
              type="button"
              variant="gradient"
              onClick={handleConfirmModalCommit}
            >
              Commit anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
