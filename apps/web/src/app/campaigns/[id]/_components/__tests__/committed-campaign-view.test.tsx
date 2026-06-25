/**
 * KAN-1191 — CommittedCampaignView RTL coverage.
 *
 * Load-bearing test of the 11-file batch (N12 lock):
 * every handler-with-rejected-branch is asserted to prevent the KAN-1208
 * silent-fall-through bug class from recurring. handleActivate (rejected),
 * handlePause (rejected), and handleResume (rejected — variant of activate
 * from paused) are explicitly covered with `kind === 'rejected'` mocks and
 * setStatusError assertion via `Activate rejected: <reason>` / `Pause rejected: <reason>`.
 *
 * Memos cited:
 *   - discriminated_union_rejected_variant_doctrine (handler symmetry — L3)
 *   - surface_completeness_doctrine (status header dispatch — L2)
 *   - operator_session_reveals_scope_gaps (KAN-1206 parent doctrine)
 *
 * Scope:
 *   (a) Status-dispatched action header (committed → Activate; active → Pause;
 *       paused → Resume; archived/completed → no action button)
 *   (b) handleActivate happy path → onStatusChanged('active') called
 *   (c) handleActivate rejected → setStatusError 'Activate rejected: audience_not_evaluated'
 *   (d) handlePause happy path → onStatusChanged('paused') called
 *   (e) handlePause rejected → setStatusError 'Pause rejected: status_committed'
 *   (f) handleResume happy path (paused → active via activate handler)
 *   (g) handleResume rejected → setStatusError 'Activate rejected: status_paused'
 *   (h) KAN-1206 statusOverride wiring — onStatusChanged callback invoked
 *   (i) read-only notice on archived + completed
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const activateMock = vi.fn();
const pauseMock = vi.fn();
const listWithStagesMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useParams: () => ({ id: "campaign-1" }),
  usePathname: () => "/campaigns/campaign-1",
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    campaignsApi: {
      ...(actual as { campaignsApi?: Record<string, unknown> }).campaignsApi,
      activate: (id: string) => activateMock(id),
      pause: (id: string) => pauseMock(id),
    },
    pipelinesApi: {
      ...(actual as { pipelinesApi?: Record<string, unknown> }).pipelinesApi,
      listWithStages: (input?: { campaignId?: string }) =>
        listWithStagesMock(input),
    },
  };
});

import { CommittedCampaignView } from "../CommittedCampaignView";
import type { CampaignDetail } from "@/lib/api";
import {
  actionPlanFixture,
  committedPlanSnapshotFixture,
} from "./fixtures";

beforeEach(() => {
  activateMock.mockReset();
  pauseMock.mockReset();
  listWithStagesMock.mockReset();
  // Default: pipelines fetch resolves to empty list — keeps test focused on
  // header dispatch + handler symmetry; pipeline rendering covered in
  // committed-pipeline-card.test.tsx.
  listWithStagesMock.mockResolvedValue([]);
});

function baseCampaign(
  overrides: Partial<CampaignDetail> = {},
): CampaignDetail {
  return {
    id: "campaign-1",
    tenantId: "tenant-1",
    name: "Q3 Push",
    status: "committed",
    objectiveId: "obj-1",
    strategy: "direct",
    audienceConditions: null,
    audienceMode: "static",
    audienceSnapshotCount: 300,
    windowStart: "2026-06-01T00:00:00.000Z",
    windowEnd: "2026-08-30T00:00:00.000Z",
    goalType: "units",
    goalTarget: 50,
    goalProductId: null,
    targetEntityType: null,
    targetEntityIds: [],
    goalDescription: "Sell 50 units in 90 days",
    feasibilityAnalysis: null,
    proposedPlan: null,
    committedPlan: committedPlanSnapshotFixture({ plan: actionPlanFixture() }),
    conversationThreadId: null,
    activatedAt: null,
    completedAt: null,
    createdAt: "2026-06-15T18:00:00.000Z",
    updatedAt: "2026-06-15T20:00:00.000Z",
    ...overrides,
  };
}

function renderView(
  campaign: CampaignDetail,
  onStatusChanged?: (next: CampaignDetail["status"]) => void,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CommittedCampaignView
        campaign={campaign}
        onStatusChanged={onStatusChanged}
      />
    </QueryClientProvider>,
  );
}

// ─────────────────────────────────────────────
// (a) Status-dispatched action header (L2 surface-completeness)
// ─────────────────────────────────────────────

describe("CommittedCampaignView — status header dispatch (L2 surface-completeness)", () => {
  it("committed status shows Activate button", () => {
    renderView(baseCampaign({ status: "committed" }));
    expect(
      screen.getByRole("button", { name: /Activate Campaign/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pause$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Resume$/i })).toBeNull();
  });

  it("active status shows Pause button", () => {
    renderView(baseCampaign({ status: "active" }));
    expect(screen.getByRole("button", { name: /Pause/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Activate Campaign/i }),
    ).toBeNull();
  });

  it("paused status shows Resume button", () => {
    renderView(baseCampaign({ status: "paused" }));
    expect(screen.getByRole("button", { name: /Resume/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Pause$/i })).toBeNull();
  });

  it("archived status shows no action button + read-only notice", () => {
    renderView(baseCampaign({ status: "archived" }));
    expect(
      screen.queryByRole("button", { name: /Activate|Pause|Resume/i }),
    ).toBeNull();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });

  it("completed status shows no action button + read-only notice", () => {
    renderView(baseCampaign({ status: "completed" }));
    expect(
      screen.queryByRole("button", { name: /Activate|Pause|Resume/i }),
    ).toBeNull();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────
// (b)+(c) handleActivate — happy + REJECTED (L3 handler symmetry)
// ─────────────────────────────────────────────

describe("handleActivate — happy + rejected branches (L3 N12 lock)", () => {
  it("happy path: click Activate → activateMock called → onStatusChanged('active')", async () => {
    activateMock.mockResolvedValueOnce({
      kind: "activated",
      campaignId: "campaign-1",
      memberCount: 300,
      stackEntriesCreated: 300,
      stackEntriesReactivated: 0,
      dripPublishesPerSecond: 5,
    });
    const onStatusChanged = vi.fn();
    renderView(baseCampaign({ status: "committed" }), onStatusChanged);
    await userEvent.click(
      screen.getByRole("button", { name: /Activate Campaign/i }),
    );
    await waitFor(() => {
      expect(activateMock).toHaveBeenCalledWith("campaign-1");
      expect(onStatusChanged).toHaveBeenCalledWith("active");
    });
  });

  // N12 LOAD-BEARING — KAN-1208 silent-fall-through prevention. Without the
  // `kind === 'rejected'` branch in the handler, the variant fell through
  // silently and the operator saw NOTHING change on click. This test
  // explicitly asserts setStatusError surfaces the reason verbatim.
  it("rejected branch: audience_not_evaluated → setStatusError 'Activate rejected: audience_not_evaluated'", async () => {
    activateMock.mockResolvedValueOnce({
      kind: "rejected",
      campaignId: "campaign-1",
      reason: "audience_not_evaluated",
      currentStatus: "committed",
    });
    const onStatusChanged = vi.fn();
    renderView(baseCampaign({ status: "committed" }), onStatusChanged);
    await userEvent.click(
      screen.getByRole("button", { name: /Activate Campaign/i }),
    );
    expect(
      await screen.findByText(/Activate rejected: audience_not_evaluated/i),
    ).toBeInTheDocument();
    // onStatusChanged MUST NOT fire on rejected — status stays committed.
    expect(onStatusChanged).not.toHaveBeenCalled();
  });

  it("already_active variant: flips status to active (idempotent re-click)", async () => {
    activateMock.mockResolvedValueOnce({
      kind: "already_active",
      campaignId: "campaign-1",
      memberCount: 300,
    });
    const onStatusChanged = vi.fn();
    renderView(baseCampaign({ status: "committed" }), onStatusChanged);
    await userEvent.click(
      screen.getByRole("button", { name: /Activate Campaign/i }),
    );
    await waitFor(() => {
      expect(onStatusChanged).toHaveBeenCalledWith("active");
    });
  });
});

// ─────────────────────────────────────────────
// (d)+(e) handlePause — happy + REJECTED (L3 handler symmetry)
// ─────────────────────────────────────────────

describe("handlePause — happy + rejected branches (L3 N12 lock)", () => {
  it("happy path: click Pause → pauseMock called → onStatusChanged('paused')", async () => {
    pauseMock.mockResolvedValueOnce({
      kind: "paused",
      campaignId: "campaign-1",
      stackEntriesPaused: 300,
    });
    const onStatusChanged = vi.fn();
    renderView(baseCampaign({ status: "active" }), onStatusChanged);
    await userEvent.click(screen.getByRole("button", { name: /Pause/i }));
    await waitFor(() => {
      expect(pauseMock).toHaveBeenCalledWith("campaign-1");
      expect(onStatusChanged).toHaveBeenCalledWith("paused");
    });
  });

  // N12 LOAD-BEARING — handlePause was the source pattern for handler
  // symmetry; this test asserts the rejected branch we already had stays
  // protected (prevents accidental removal of the working pattern).
  it("rejected branch: status_committed → setStatusError 'Pause rejected: status_committed'", async () => {
    pauseMock.mockResolvedValueOnce({
      kind: "rejected",
      campaignId: "campaign-1",
      reason: "status_committed",
      currentStatus: "active",
    });
    const onStatusChanged = vi.fn();
    renderView(baseCampaign({ status: "active" }), onStatusChanged);
    await userEvent.click(screen.getByRole("button", { name: /Pause/i }));
    expect(
      await screen.findByText(/Pause rejected: status_committed/i),
    ).toBeInTheDocument();
    expect(onStatusChanged).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// (f)+(g) handleResume — happy + REJECTED (variant of handleActivate)
// ─────────────────────────────────────────────

describe("handleResume — happy + rejected branches (L3 N12 lock)", () => {
  it("happy path: paused → click Resume → activateMock called → onStatusChanged('active')", async () => {
    activateMock.mockResolvedValueOnce({
      kind: "activated",
      campaignId: "campaign-1",
      memberCount: 300,
      stackEntriesCreated: 0,
      stackEntriesReactivated: 300,
      dripPublishesPerSecond: 5,
    });
    const onStatusChanged = vi.fn();
    renderView(baseCampaign({ status: "paused" }), onStatusChanged);
    await userEvent.click(screen.getByRole("button", { name: /Resume/i }));
    await waitFor(() => {
      expect(activateMock).toHaveBeenCalledWith("campaign-1");
      expect(onStatusChanged).toHaveBeenCalledWith("active");
    });
  });

  // N12 LOAD-BEARING — Resume reuses handleActivate; the rejected branch
  // covers a different `reason` value (status_paused vs audience_not_evaluated)
  // to assert formatting works across reason enum values.
  it("rejected branch: status_paused → setStatusError 'Activate rejected: status_paused'", async () => {
    activateMock.mockResolvedValueOnce({
      kind: "rejected",
      campaignId: "campaign-1",
      reason: "status_paused",
      currentStatus: "paused",
    });
    const onStatusChanged = vi.fn();
    renderView(baseCampaign({ status: "paused" }), onStatusChanged);
    await userEvent.click(screen.getByRole("button", { name: /Resume/i }));
    expect(
      await screen.findByText(/Activate rejected: status_paused/i),
    ).toBeInTheDocument();
    expect(onStatusChanged).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// (h) KAN-1206 statusOverride wiring
// ─────────────────────────────────────────────

describe("KAN-1206 — onStatusChanged callback contract", () => {
  it("happy-path Activate invokes onStatusChanged synchronously with 'active'", async () => {
    activateMock.mockResolvedValueOnce({
      kind: "activated",
      campaignId: "campaign-1",
      memberCount: 300,
      stackEntriesCreated: 300,
      stackEntriesReactivated: 0,
      dripPublishesPerSecond: 5,
    });
    const onStatusChanged = vi.fn();
    renderView(baseCampaign({ status: "committed" }), onStatusChanged);
    await userEvent.click(
      screen.getByRole("button", { name: /Activate Campaign/i }),
    );
    await waitFor(() => {
      expect(onStatusChanged).toHaveBeenCalledTimes(1);
      expect(onStatusChanged).toHaveBeenCalledWith("active");
    });
  });

  it("status badge shows current status value", () => {
    renderView(baseCampaign({ status: "active" }));
    // The header status badge renders campaign.status text — assert presence
    expect(screen.getAllByText(/active/).length).toBeGreaterThanOrEqual(1);
  });
});
