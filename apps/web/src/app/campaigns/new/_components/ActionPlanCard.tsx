"use client";

/**
 * KAN-1188 G1 + G10 — ActionPlanCard composition + page slot fill.
 *
 * Composes:
 *   - ActionPlanHeaderCard (campaign name + confidence + gap summary + undo)
 *   - GapAnalysisCard (concrete numbers, G7 honest counsel)
 *   - PipelineCard × N (collapsed-by-default; Y2 useState expansion)
 *   - ChatRefinementInput (4-family chips + textarea + send + alert banners)
 *
 * State management via useActionPlanCard hook:
 *   - plan: ActionPlan (mutates on refine/revert)
 *   - refine + revert mutations + result discriminated unions
 *   - applyExternalPlan: used by G4 Reload-to-current affordance
 *
 * Mounted at /campaigns/new/page.tsx in place of the F8 placeholder
 * block once generatePlanResult.kind === 'action_plan' (G10 slot-and-fill).
 */
import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { ActionPlanHeaderCard } from "./ActionPlanHeaderCard";
import { GapAnalysisCard } from "./GapAnalysisCard";
import { PipelineCard } from "./PipelineCard";
import { ChatRefinementInput } from "./ChatRefinementInput";
import { useActionPlanCard } from "@/lib/hooks/useActionPlanCard";
import type { ActionPlan } from "@/lib/api";

export interface ActionPlanCardProps {
  campaignId: string;
  initialPlan: ActionPlan;
  campaignName?: string;
  goalType?: string;
}

export function ActionPlanCard({
  campaignId,
  initialPlan,
  campaignName,
  goalType,
}: ActionPlanCardProps) {
  const {
    plan,
    applyExternalPlan,
    isRefining,
    refineResult,
    refine,
    isReverting,
    revertResult,
    revert,
  } = useActionPlanCard({ campaignId, initialPlan });
  const [revertedToast, setRevertedToast] = useState<string | null>(null);

  // G9 revert success → small confirmation toast
  if (
    revertResult?.kind === "action_plan_reverted" &&
    revertedToast !== revertResult.plan.generatedAt
  ) {
    setRevertedToast(revertResult.plan.generatedAt);
    setTimeout(() => setRevertedToast(null), 4000);
  }

  const revertDisabled = revertResult?.kind === "no_refinement_to_revert";

  return (
    <section
      aria-label="Action Plan"
      className="mt-6 flex flex-col gap-4 rounded-lg border border-border bg-card p-6"
    >
      <ActionPlanHeaderCard
        plan={plan}
        campaignName={campaignName}
        onRevert={revert}
        isReverting={isReverting}
        revertDisabled={revertDisabled}
        revertDisabledReason={
          revertDisabled ? "Nothing to undo yet." : undefined
        }
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
    </section>
  );
}
