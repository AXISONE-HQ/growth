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
): PipelineWithStages {
  return {
    id,
    name,
    description: null,
    objectiveId,
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
