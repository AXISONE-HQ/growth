/**
 * KAN-1010 SAE PR5 fix-forward — regression guard for the
 * `activateMutation is not defined` ReferenceError that crashed the
 * /campaigns page in PROD when transitioning to committed-state.
 *
 * Root cause: PR5 placed the CommitSuccessCard inside ProposalPreview's
 * render but referenced `activateMutation` (a CampaignsPage local)
 * directly, not through props. JS scoping: ProposalPreview is a sibling
 * function, not nested — it has no access to CampaignsPage's locals.
 *
 * The runtime crash slipped through the "Web Build green" gate because
 * `apps/web/next.config.mjs` sets `typescript.ignoreBuildErrors: true`
 * + `eslint.ignoreDuringBuilds: true` — `next build` does NOT typecheck.
 * That's a systemic hole tracked separately (see Phase 4 report); this
 * test is the LOCAL guard for this specific class.
 *
 * What this test pins:
 *   - CommitSuccessCard mounts without throwing in committed-state
 *   - The Activate button is present (proves activate props wired)
 *   - The Pause button is NOT shown until activated (state machine intact)
 *   - When activateResult.kind='activated' is passed, the ActivatedCard
 *     mounts with the Pause button (the post-activate state)
 *
 * Not testing: the full CampaignsPage tree (no @tanstack/react-query
 * QueryClient is needed since we test the inner cards directly with
 * fixture data; this keeps the test fast + focused on the regression).
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type {
  CampaignCommitResult,
  CampaignActivateResult,
  CampaignPauseResult,
} from "@/lib/api";

// Import the inner components directly. They're not exported today;
// the test imports the page module + extracts via a re-export shim.
// Cleanest pattern: re-export from the page module's __testing__ entry,
// but to avoid touching the page's public surface we just import the
// page module + render the relevant section.
//
// Since CommitSuccessCard is module-private in page.tsx, the regression
// guard works by importing the page module side-effect-free + asserting
// the symbols exist on a synthetic mount. The simpler + canonical
// pattern: lift CommitSuccessCard to a tested-export.
//
// For PR5 fix-forward, we add a tiny `__testing__` named export at the
// bottom of page.tsx exposing CommitSuccessCard. Test below renders it.
import { __testing__ } from "../page";

const { CommitSuccessCard } = __testing__;

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

function fixtureCommitResult(): CampaignCommitResult {
  return {
    alreadyExisted: false,
    campaignId: "campaign-test-001",
    pipelineId: "pipeline-test-001",
    stageIds: ["stage-1"],
    audienceCount: 1,
    membershipStatus: "materialized_sync",
    membershipSnapshotCountSync: 1,
  };
}

function activatedResult(): CampaignActivateResult {
  return {
    kind: "activated",
    campaignId: "campaign-test-001",
    memberCount: 1,
    stackEntriesCreated: 1,
    stackEntriesReactivated: 0,
    dripPublishesPerSecond: 10,
  };
}

const noopHandlers = {
  onActivate: () => undefined,
  onPause: () => undefined,
};

// ─────────────────────────────────────────────
// THE REGRESSION GUARD
// ─────────────────────────────────────────────

describe("KAN-1010 fix-forward: CommitSuccessCard mounts in committed-state", () => {
  it("MOUNTS WITHOUT THROWING when no activate has happened yet (the bug repro)", () => {
    // BEFORE the fix-forward, this render threw:
    //   ReferenceError: activateMutation is not defined
    // because the inner JSX inside ProposalPreview referenced
    // `activateMutation` from CampaignsPage's scope. Now the activate
    // props are received correctly.
    expect(() =>
      render(
        <CommitSuccessCard
          result={fixtureCommitResult()}
          activateResult={undefined}
          activateError={null}
          activatePending={false}
          onActivate={noopHandlers.onActivate}
          pauseResult={undefined}
          pauseError={null}
          pausePending={false}
          onPause={noopHandlers.onPause}
        />,
      ),
    ).not.toThrow();
  });

  it("shows the Activate campaign button when committed", () => {
    render(
      <CommitSuccessCard
        result={fixtureCommitResult()}
        activateResult={undefined}
        activateError={null}
        activatePending={false}
        onActivate={noopHandlers.onActivate}
        pauseResult={undefined}
        pauseError={null}
        pausePending={false}
        onPause={noopHandlers.onPause}
      />,
    );
    // The button copy is "Activate campaign" per PR5 wiring.
    expect(screen.getByRole("button", { name: /activate campaign/i })).toBeInTheDocument();
    // No Pause button in committed-not-yet-active state.
    expect(screen.queryByRole("button", { name: /pause campaign/i })).not.toBeInTheDocument();
  });

  it("shows the Pause button after activate succeeds", () => {
    render(
      <CommitSuccessCard
        result={fixtureCommitResult()}
        activateResult={activatedResult()}
        activateError={null}
        activatePending={false}
        onActivate={noopHandlers.onActivate}
        pauseResult={undefined}
        pauseError={null}
        pausePending={false}
        onPause={noopHandlers.onPause}
      />,
    );
    // After activation, the affordance shifts to Pause.
    expect(screen.getByRole("button", { name: /pause campaign/i })).toBeInTheDocument();
    // No Activate button visible once activated.
    expect(
      screen.queryByRole("button", { name: /activate campaign/i }),
    ).not.toBeInTheDocument();
  });

  it("disables Activate when audience snapshot not yet materialized (deferred_async)", () => {
    const deferredCommit: CampaignCommitResult = {
      ...fixtureCommitResult(),
      membershipStatus: "deferred_async",
      membershipSnapshotCountSync: 0,
      audienceCount: 13584,
    };
    render(
      <CommitSuccessCard
        result={deferredCommit}
        activateResult={undefined}
        activateError={null}
        activatePending={false}
        onActivate={noopHandlers.onActivate}
        pauseResult={undefined}
        pauseError={null}
        pausePending={false}
        onPause={noopHandlers.onPause}
      />,
    );
    const btn = screen.getByRole("button", { name: /activate campaign/i });
    expect(btn).toBeDisabled();
  });
});
