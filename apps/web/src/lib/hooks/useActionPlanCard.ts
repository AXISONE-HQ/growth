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
 *   J11 — KAN-1205: this hook NO LONGER passes expectedUpdatedAt. Original
 *     KAN-1186/KAN-1190 wiring sent plan.generatedAt as the token, but that's
 *     the LLM's generation timestamp (T1) — not Campaign.updatedAt (T2 — set
 *     by Prisma @updatedAt on the row write that came AFTER generation).
 *     T1 < T2 always → every operator-driven refine + commit false-positived
 *     as concurrent_edit_conflict. Server-side J11/NEW-B check remains for
 *     direct API consumers; UI relies on J8 idempotency (already_committed)
 *     for double-click protection. See j11_j8_redundancy_doctrine memo.
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

  // KAN-1205 — DO NOT pass `expectedUpdatedAt` from this hook. The original
  // KAN-1186/KAN-1190 wiring sent `plan.generatedAt`, but that's the LLM's
  // generation timestamp embedded in the ActionPlan JSON — NOT
  // `Campaign.updatedAt`, which the server's J11 / NEW-B check compares
  // against. Prisma's `@updatedAt` directive sets Campaign.updatedAt at
  // persist time (when the generator wrote `Campaign.update({proposedPlan})`),
  // which is microseconds AFTER `plan.generatedAt` was computed.
  // Result: `plan.generatedAt !== Campaign.updatedAt` always → every
  // operator-driven refine + commit returned `concurrent_edit_conflict`
  // even on the happy path. Fred's PROD smoke surfaced this as "Commit
  // does nothing" — the amber banner rendered but at the bottom of the
  // section; easy to miss.
  //
  // Per `j11_j8_redundancy_doctrine`: J11/NEW-B is for direct API consumers
  // that can compute the correct token (admin tools, third-party
  // integrations reading Campaign.updatedAt from a getCampaign response).
  // The UI relies on J8 idempotency (`already_committed`) for double-click
  // protection. Single-operator double-click + two-tab concurrent commit
  // both resolve via J8. System-modified state mid-flow is out of scope
  // pre-launch.
  //
  // Per `ui_hook_layer_test_family`: the UI hook ↔ server boundary is its
  // own test family; KAN-1205 integration test asserts commit-after-generate
  // succeeds without the false-positive that this hook used to emit.
  const refineMutation = useMutation({
    mutationFn: (message: string) =>
      campaignsApi.refineActionPlan({
        campaignId: params.campaignId,
        refinementMessage: message,
        // expectedUpdatedAt intentionally omitted (KAN-1205)
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

  // KAN-1190 / KAN-1205 — Commit mutation.
  //
  // J11 optimistic concurrency was originally wired via `plan.generatedAt`,
  // but per KAN-1205 (see refine comment above) that conflates two
  // semantically different timestamps. UI relies on J8 idempotency
  // (`already_committed`) for double-click protection — server returns the
  // same Pipeline IDs on re-commit, so the J10 success state still renders
  // correctly via the existing `committed | already_committed` branch in
  // ActionPlanCard.
  //
  // On committed/already_committed the J10 success state is rendered from
  // commitResult; plan state itself is unchanged (Campaign.status is the
  // source of truth post-commit, not the in-memory plan).
  const commitMutation = useMutation({
    mutationFn: () =>
      campaignsApi.commitActionPlan({
        campaignId: params.campaignId,
        // expectedUpdatedAt intentionally omitted (KAN-1205)
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
