/**
 * KAN-1191 — /campaigns/[id] page L2 surface-completeness coverage.
 *
 * Load-bearing scenario: ALL 6 Campaign.status enum values
 * (draft / committed / active / paused / archived / completed) must render
 * a destination view. No status falls through to a "blank" or pre-Action-Plan
 * surface after Pipelines have been materialized.
 *
 * Memos cited:
 *   - surface_completeness_doctrine (L2 6-status enforcement — KAN-1206)
 *   - operator_session_reveals_scope_gaps (KAN-1206 root cause)
 *   - discriminated_union_rejected_variant_doctrine (status header dispatches)
 *
 * Scope:
 *   draft       → ChatThread visible (not CommittedCampaignView)
 *   committed   → CommittedCampaignView + 'committed' badge + Activate button
 *   active      → CommittedCampaignView + 'active' badge + Pause button
 *   paused      → CommittedCampaignView + 'paused' badge + Resume button
 *   archived    → CommittedCampaignView + 'archived' badge + read-only notice
 *   completed   → CommittedCampaignView + 'completed' badge + read-only notice
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CampaignDetail } from "@/lib/api";

const useCampaignChatMock = vi.fn();
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

vi.mock("@/lib/hooks/useCampaignChat", () => ({
  useCampaignChat: (id: string | undefined) => useCampaignChatMock(id),
}));

vi.mock("@/lib/api", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    pipelinesApi: {
      ...(actual as { pipelinesApi?: Record<string, unknown> }).pipelinesApi,
      listWithStages: (input?: { campaignId?: string }) =>
        listWithStagesMock(input),
    },
  };
});

import CampaignChatPage from "../page";
import {
  actionPlanFixture,
  committedPlanSnapshotFixture,
} from "../_components/__tests__/fixtures";

function makeCampaign(
  status: CampaignDetail["status"],
  overrides: Partial<CampaignDetail> = {},
): CampaignDetail {
  return {
    id: "campaign-1",
    tenantId: "tenant-1",
    name: "Q3 Push",
    status,
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
    committedPlan:
      status === "draft"
        ? null
        : committedPlanSnapshotFixture({ plan: actionPlanFixture() }),
    conversationThreadId: null,
    activatedAt: status === "active" ? "2026-06-15T20:00:00.000Z" : null,
    completedAt: null,
    createdAt: "2026-06-15T18:00:00.000Z",
    updatedAt: "2026-06-15T20:00:00.000Z",
    ...overrides,
  };
}

function setupChatHookReturn(
  status: CampaignDetail["status"],
  campaignOverrides: Partial<CampaignDetail> = {},
) {
  useCampaignChatMock.mockReturnValue({
    campaign: makeCampaign(status, campaignOverrides),
    isLoading: false,
    isError: false,
    error: null,
    feasibility: null,
    isAnalyzing: false,
    analyzeError: null,
    triggerAnalyze: vi.fn(),
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CampaignChatPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useCampaignChatMock.mockReset();
  listWithStagesMock.mockReset();
  listWithStagesMock.mockResolvedValue([]);
});

// L2 LOAD-BEARING — every Campaign.status enum value MUST surface a
// destination view. Distinct it() per status per the L2 lock.
describe("/campaigns/[id] — L2 surface-completeness (6-status doctrine)", () => {
  it("draft → renders ChatThread (existing FeasibilityChat surface)", () => {
    setupChatHookReturn("draft");
    renderPage();
    // ChatThread renders the operator goal as an OperatorMessage line
    expect(
      screen.getByText(/Sell 50 units in 90 days/i),
    ).toBeInTheDocument();
    // CommittedCampaignView markers are absent
    expect(screen.queryByText(/Committed Action Plan/i)).toBeNull();
  });

  it("committed → renders CommittedCampaignView + 'committed' badge + Activate button", () => {
    setupChatHookReturn("committed");
    renderPage();
    expect(
      screen.getByRole("button", { name: /Activate Campaign/i }),
    ).toBeInTheDocument();
    // "committed" appears in the header status badge + DetailPageShell badge
    expect(screen.getAllByText(/^committed$/).length).toBeGreaterThanOrEqual(1);
  });

  it("active → renders CommittedCampaignView + 'active' badge + Pause button", () => {
    setupChatHookReturn("active");
    renderPage();
    expect(screen.getByRole("button", { name: /Pause/i })).toBeInTheDocument();
    expect(screen.getAllByText(/^active$/).length).toBeGreaterThanOrEqual(1);
  });

  it("paused → renders CommittedCampaignView + 'paused' badge + Resume button", () => {
    setupChatHookReturn("paused");
    renderPage();
    expect(screen.getByRole("button", { name: /Resume/i })).toBeInTheDocument();
    expect(screen.getAllByText(/^paused$/).length).toBeGreaterThanOrEqual(1);
  });

  it("archived → renders CommittedCampaignView + 'archived' badge + read-only notice + no action button", () => {
    setupChatHookReturn("archived");
    renderPage();
    expect(
      screen.queryByRole("button", { name: /Activate Campaign|^Pause$|^Resume$/i }),
    ).toBeNull();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getAllByText(/^archived$/).length).toBeGreaterThanOrEqual(1);
  });

  it("completed → renders CommittedCampaignView + 'completed' badge + read-only notice + no action button", () => {
    setupChatHookReturn("completed");
    renderPage();
    expect(
      screen.queryByRole("button", { name: /Activate Campaign|^Pause$|^Resume$/i }),
    ).toBeNull();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getAllByText(/^completed$/).length).toBeGreaterThanOrEqual(1);
  });
});
