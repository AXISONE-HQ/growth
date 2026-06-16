/**
 * KAN-968 — Pipelines kanban board page smoke tests.
 *
 * Coverage:
 *   - Empty board → EmptyState with CTA to /settings/objectives
 *   - Fixture pipeline (objectiveId=null) is filtered out
 *   - 1-pipeline case still renders the tab strip (no degenerate hiding)
 *   - N-pipeline case renders N tabs, default to the first
 *   - Loading state renders skeleton
 *   - Error state surfaces the message
 *
 * Per-tab kanban rendering is covered separately by stage-column / deal-card
 * tests. This file pins page-level orchestration only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PipelinesPage from "../page";
import type { PipelineWithStages } from "@/lib/api";

const listWithStagesMock = vi.fn();
const listByPipelineMock = vi.fn();

vi.mock("@/lib/api", () => ({
  pipelinesApi: {
    listWithStages: (...args: unknown[]) => listWithStagesMock(...args),
  },
  dealsApi: {
    listByPipeline: (...args: unknown[]) => listByPipelineMock(...args),
  },
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  listWithStagesMock.mockReset();
  listByPipelineMock.mockReset();
  // Default: nested-board fetch returns an empty grouped result so per-tab
  // rendering doesn't block the page-level assertions.
  listByPipelineMock.mockResolvedValue({ stages: [] });
});

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function makePipeline(
  id: string,
  name: string,
  objectiveId: string | null,
  // KAN-1211 — discriminator for chat-flow Pipelines (V3 lock binds them to
  // Campaign, not Objective). Default null preserves backward-compat with
  // existing KAN-968 scenarios that pre-date the chat-flow surface.
  campaignId: string | null = null,
): PipelineWithStages {
  return {
    id,
    name,
    description: null,
    objectiveId,
    campaignId,
    stages: [
      { id: `${id}_s1`, name: "New", order: 0, isInitial: true, isTerminal: false, outcomeType: "open" },
      { id: `${id}_s2`, name: "Won", order: 1, isInitial: false, isTerminal: true, outcomeType: "terminal_won" },
    ],
  };
}

describe("KAN-968 — Pipelines page empty-board state", () => {
  it("renders EmptyState + CTA → /settings/objectives when no objective-bound pipelines exist", async () => {
    listWithStagesMock.mockResolvedValue([]);
    wrap(<PipelinesPage />);
    await waitFor(() => {
      expect(screen.getByText(/No pipelines yet/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Declare an objective and growth will build/i),
    ).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /Go to Objectives/i });
    expect(cta).toHaveAttribute("href", "/settings/objectives");
  });

  it("filters out the fixture (objectiveId=null) — empty-board state renders when only fixture exists", async () => {
    listWithStagesMock.mockResolvedValue([
      makePipeline("pip_fixture", "Default Sales Pipeline", null),
    ]);
    wrap(<PipelinesPage />);
    await waitFor(() => {
      expect(screen.getByText(/No pipelines yet/i)).toBeInTheDocument();
    });
    // Fixture name MUST NOT appear as a tab
    expect(screen.queryByText("Default Sales Pipeline")).not.toBeInTheDocument();
  });
});

describe("KAN-968 — Pipelines page tab-strip rendering", () => {
  it("renders a single tab in the 1-pipeline case (no degenerate hiding)", async () => {
    listWithStagesMock.mockResolvedValue([
      makePipeline("pip_book", "Book Demo — New Leads", "obj_book_appt"),
    ]);
    wrap(<PipelinesPage />);
    await waitFor(() => {
      expect(screen.getByTestId("pipeline-tabs")).toBeInTheDocument();
    });
    const tabs = screen.getAllByTestId("pipeline-tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toHaveTextContent("Book Demo — New Leads");
  });

  it("renders N tabs in the N-pipeline case (sorted by backend order)", async () => {
    listWithStagesMock.mockResolvedValue([
      makePipeline("pip_book", "Book Demo — New Leads", "obj_book_appt"),
      makePipeline("pip_warm", "Warm-Up — New Leads", "obj_warm_up"),
    ]);
    wrap(<PipelinesPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId("pipeline-tab")).toHaveLength(2);
    });
    const tabs = screen.getAllByTestId("pipeline-tab");
    expect(tabs[0]).toHaveTextContent("Book Demo — New Leads");
    expect(tabs[1]).toHaveTextContent("Warm-Up — New Leads");
  });

  it("mixed fixture + objective-bound — only objective-bound surfaces as tabs", async () => {
    listWithStagesMock.mockResolvedValue([
      makePipeline("pip_fixture", "Default Sales Pipeline", null),
      makePipeline("pip_book", "Book Demo — New Leads", "obj_book_appt"),
    ]);
    wrap(<PipelinesPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId("pipeline-tab")).toHaveLength(1);
    });
    expect(screen.queryByText("Default Sales Pipeline")).not.toBeInTheDocument();
    expect(screen.getByText("Book Demo — New Leads")).toBeInTheDocument();
  });
});

describe("KAN-968 — Pipelines page loading + error states", () => {
  it("renders skeleton while pipelines fetch is pending", () => {
    // Pending promise — never resolves during this assertion
    listWithStagesMock.mockReturnValue(new Promise(() => {}));
    wrap(<PipelinesPage />);
    expect(
      document.querySelector('[class*="animate-pulse"]'),
    ).toBeInTheDocument();
  });

  it("renders error message when pipelines fetch fails", async () => {
    listWithStagesMock.mockRejectedValue(new Error("network down"));
    wrap(<PipelinesPage />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/Failed to load pipelines/i);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("network down");
  });
});

// ─────────────────────────────────────────────
// KAN-1211 — chat-flow Pipelines included after filter extension
//
// 9th boundary-integration-gap of the KAN-1184/1190 arc. The original
// KAN-968 filter (`p.objectiveId !== null`) used objectiveId as a proxy
// for "real Pipeline vs KAN-793 fixture (both NULL)." KAN-1190 V3 doctrine
// deliberately binds chat-flow Pipelines to Campaign instead of Objective:
// commit-action-plan.ts:344 sets `objectiveId: null` + `campaignId: <id>`.
//
// Chat-flow Pipelines therefore shared the NULL `objectiveId` shape with
// the KAN-793 fixture and got silently excluded from the operational board.
// Path A: extend filter to `objectiveId !== null || campaignId !== null`.
//
// Doctrine memos cited in code (apps/web/src/app/pipelines/page.tsx:74-94):
//   - `legacy_filter_predicate_doctrine` (37th — KAN-1211 anchor)
//   - `boundary_integration_gap_subclass` (29th — sibling subclass)
//   - `operator_session_reveals_scope_gaps` (parent doctrine)
//
// This describe block asserts the 3-shape partition contract end-to-end at
// the UI layer. The integration test
// (apps/api/src/__tests__/integration/kan-1211-pipelines-filter-extension.test.ts)
// covers the same partition at the server/DB layer.
// ─────────────────────────────────────────────

describe("KAN-1211 — chat-flow Pipelines render at /pipelines", () => {
  it("renders chat-flow Pipeline (campaignId set, objectiveId NULL) — Fred's 8th smoke scenario", async () => {
    // Replicates Fred's exact PROD scenario: brand-new tenant; only the
    // chat-flow commit's Pipeline exists. Pre-KAN-1211 this rendered as
    // empty-board.
    listWithStagesMock.mockResolvedValue([
      makePipeline("pip_chat", "Chat-flow Pipeline", null, "cam_test"),
    ]);
    wrap(<PipelinesPage />);
    await waitFor(() => {
      expect(screen.getByTestId("pipeline-tabs")).toBeInTheDocument();
    });
    const tabs = screen.getAllByTestId("pipeline-tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toHaveTextContent("Chat-flow Pipeline");
    // EmptyState must NOT render
    expect(screen.queryByText(/No pipelines yet/i)).not.toBeInTheDocument();
  });

  it("3-shape partition — KAN-793 fixture excluded; chat-flow + legacy both included", async () => {
    // Mixed-shape scenario that closes the filter doctrine end-to-end.
    listWithStagesMock.mockResolvedValue([
      // Shape 1: KAN-793 fixture (both NULL) — excluded
      makePipeline("pip_fixture", "Default Sales Pipeline", null, null),
      // Shape 2: Chat-flow (campaignId set) — included
      makePipeline("pip_chat", "Chat-flow Pipeline", null, "cam_test"),
      // Shape 3: Legacy (objectiveId set) — included
      makePipeline("pip_legacy", "Legacy Pipeline", "obj_legacy", null),
    ]);
    wrap(<PipelinesPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId("pipeline-tab")).toHaveLength(2);
    });
    expect(screen.queryByText("Default Sales Pipeline")).not.toBeInTheDocument();
    expect(screen.getByText("Chat-flow Pipeline")).toBeInTheDocument();
    expect(screen.getByText("Legacy Pipeline")).toBeInTheDocument();
  });

  it("regression — KAN-793 fixture (both NULL) still excluded post-filter-extension", async () => {
    // The KAN-1211 filter widening must NOT degrade the KAN-793 fixture
    // exclusion. This guards against an over-eager extension that loses
    // the original partitioning intent.
    listWithStagesMock.mockResolvedValue([
      makePipeline("pip_fixture", "Default Sales Pipeline", null, null),
    ]);
    wrap(<PipelinesPage />);
    await waitFor(() => {
      expect(screen.getByText(/No pipelines yet/i)).toBeInTheDocument();
    });
    expect(screen.queryByText("Default Sales Pipeline")).not.toBeInTheDocument();
  });
});
