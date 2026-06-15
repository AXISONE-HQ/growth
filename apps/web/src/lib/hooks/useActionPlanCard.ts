/**
 * KAN-1188 — Action Plan card hook.
 *
 * Wraps:
 *   - campaignsApi.refineActionPlan (KAN-1186 — operator-NL classification)
 *   - campaignsApi.revertLastActionPlanRefinement (KAN-1186 E8 rollback)
 *
 * State:
 *   - `plan`: current ActionPlan (mutates on successful refinement/revert)
 *   - `expectedUpdatedAt`: optimistic concurrency token (NEW-B). Tracked
 *     locally; updated after every successful refinement
 *
 * Doctrine:
 *   Y3 — NO optimistic update. Plan state updates ONLY on refiner response.
 *   Send disabled while pending; LoadingState rendered in the consumer.
 *   G4 — On concurrent_edit_conflict, expose currentPlan via refineResult so
 *     the UI can offer a "Reload to current" affordance.
 */
import { useCallback, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  campaignsApi,
  type ActionPlan,
  type RefineActionPlanResult,
  type RevertActionPlanRefinementResult,
} from "@/lib/api";

export interface UseActionPlanCardParams {
  campaignId: string;
  initialPlan: ActionPlan;
}

export interface UseActionPlanCardResult {
  plan: ActionPlan;
  /** Update plan state directly (used by concurrent_edit_conflict Reload). */
  applyExternalPlan: (next: ActionPlan) => void;

  // Refine
  isRefining: boolean;
  refineError: Error | null;
  refineResult: RefineActionPlanResult | null;
  refine: (message: string) => void;

  // Revert
  isReverting: boolean;
  revertError: Error | null;
  revertResult: RevertActionPlanRefinementResult | null;
  revert: () => void;
}

export function useActionPlanCard(
  params: UseActionPlanCardParams,
): UseActionPlanCardResult {
  const [plan, setPlan] = useState<ActionPlan>(params.initialPlan);
  const [refineResult, setRefineResult] = useState<RefineActionPlanResult | null>(null);
  const [revertResult, setRevertResult] =
    useState<RevertActionPlanRefinementResult | null>(null);

  const refineMutation = useMutation({
    mutationFn: (message: string) =>
      campaignsApi.refineActionPlan({
        campaignId: params.campaignId,
        refinementMessage: message,
        expectedUpdatedAt: plan.generatedAt,
      }),
    onSuccess: (result: RefineActionPlanResult) => {
      setRefineResult(result);
      if (result.kind === "action_plan_refined") {
        setPlan(result.plan);
      }
      // concurrent_edit_conflict / bounds_violation / no_plan_to_refine /
      // analyzer_unavailable: plan state unchanged; UI renders the variant.
    },
  });

  const revertMutation = useMutation({
    mutationFn: () =>
      campaignsApi.revertLastActionPlanRefinement({
        campaignId: params.campaignId,
      }),
    onSuccess: (result: RevertActionPlanRefinementResult) => {
      setRevertResult(result);
      if (result.kind === "action_plan_reverted") {
        setPlan(result.plan);
      }
    },
  });

  const refine = useCallback(
    (message: string) => {
      refineMutation.mutate(message);
    },
    [refineMutation],
  );

  const revert = useCallback(() => {
    revertMutation.mutate();
  }, [revertMutation]);

  const applyExternalPlan = useCallback((next: ActionPlan) => {
    setPlan(next);
    setRefineResult(null);
  }, []);

  return {
    plan,
    applyExternalPlan,
    isRefining: refineMutation.isPending,
    refineError: (refineMutation.error as Error) ?? null,
    refineResult,
    refine,
    isReverting: revertMutation.isPending,
    revertError: (revertMutation.error as Error) ?? null,
    revertResult,
    revert,
  };
}
