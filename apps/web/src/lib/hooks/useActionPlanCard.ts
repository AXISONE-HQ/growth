/**
 * KAN-1188 — Action Plan card hook.
 * KAN-1190 — Extended with commit mutation (J9 + J11 + J10 locks).
 *
 * Wraps:
 *   - campaignsApi.refineActionPlan (KAN-1186 — operator-NL classification)
 *   - campaignsApi.revertLastActionPlanRefinement (KAN-1186 E8 rollback)
 *   - campaignsApi.commitActionPlan (KAN-1190 — multi-Pipeline materialization)
 *
 * State:
 *   - `plan`: current ActionPlan (mutates on successful refinement/revert)
 *   - `commitResult`: discriminated CommitActionPlanResult after Commit click;
 *      drives J10 in-card success state + N-variant error rendering
 *
 * Doctrine:
 *   Y3 — NO optimistic update. Plan state updates ONLY on response.
 *   Send disabled while pending; LoadingState rendered in the consumer.
 *   G4 — On concurrent_edit_conflict, expose currentPlan via refineResult so
 *     the UI can offer a "Reload to current" affordance.
 *   J11 — Pass plan.generatedAt as expectedUpdatedAt on commit; mismatch
 *     surfaces concurrent_edit_conflict variant.
 */
import { useCallback, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  campaignsApi,
  type ActionPlan,
  type CommitActionPlanResult,
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

  // Commit (KAN-1190)
  isCommitting: boolean;
  commitError: Error | null;
  commitResult: CommitActionPlanResult | null;
  commit: () => void;
  /** Clear commit state — used to dismiss bounds_violation / conflict banners. */
  clearCommitResult: () => void;
}

export function useActionPlanCard(
  params: UseActionPlanCardParams,
): UseActionPlanCardResult {
  const [plan, setPlan] = useState<ActionPlan>(params.initialPlan);
  const [refineResult, setRefineResult] = useState<RefineActionPlanResult | null>(null);
  const [revertResult, setRevertResult] =
    useState<RevertActionPlanRefinementResult | null>(null);
  const [commitResult, setCommitResult] =
    useState<CommitActionPlanResult | null>(null);

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

  // KAN-1190 — Commit mutation. J11 optimistic concurrency via plan.generatedAt
  // (same token refine + revert use). On committed/already_committed the J10
  // success state is rendered from commitResult; plan state itself is
  // unchanged (Campaign.status is the source of truth post-commit, not the
  // in-memory plan).
  const commitMutation = useMutation({
    mutationFn: () =>
      campaignsApi.commitActionPlan({
        campaignId: params.campaignId,
        expectedUpdatedAt: plan.generatedAt,
      }),
    onSuccess: (result: CommitActionPlanResult) => {
      setCommitResult(result);
    },
  });

  const commit = useCallback(() => {
    commitMutation.mutate();
  }, [commitMutation]);

  const clearCommitResult = useCallback(() => {
    setCommitResult(null);
  }, []);

  const applyExternalPlan = useCallback((next: ActionPlan) => {
    setPlan(next);
    setRefineResult(null);
    setCommitResult(null);
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
    isCommitting: commitMutation.isPending,
    commitError: (commitMutation.error as Error) ?? null,
    commitResult,
    commit,
    clearCommitResult,
  };
}
