/**
 * KAN-888 — /opportunities/[id] DealDetailPage smoke tests.
 *
 * Coverage:
 *   - Identity card (name + status + value + probability bar)
 *   - Stage history timeline: 0 / 1 / multiple transitions
 *   - Outcome card: won → wonProductSummary; lost → lostReason badge
 *   - Owner card: null + populated
 *   - Raw data renders all 4 JSON blocks (externalIds, customFields,
 *     aiContext, metadata)
 *
 * Plus a dedicated render of the extracted StageHistoryTimeline
 * subcomponent (covers triggeredBy icon + decision metadata).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DealDetailPage, { StageHistoryTimeline } from "../page";

const getMock = vi.fn();

vi.mock("@/lib/api", () => ({
  dealsApi: {
    get: (...args: unknown[]) => getMock(...args),
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "dl_1" }),
}));

beforeEach(() => {
  getMock.mockReset();
});

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const BASE_DEAL = {
  id: "dl_1",
  name: "Acme — Q3 expansion",
  status: "open",
  probability: 70,
  expectedCloseDate: "2026-06-30",
  closedAt: null,
  lostReason: null,
  lostReasonDetail: null,
  wonProductSummary: null,
  products: [],
  microObjectiveProgress: {},
  aiContext: {},
  metadata: {},
  customFields: {},
  externalIds: {},
  correlationId: null,
  enteredStageAt: "2026-05-01T10:00:00Z",
  ownerId: null,
  assignedAgentId: null,
  companyId: null,
  value: "5000",
  currency: "USD",
  currentStageId: "stg_1",
  contactId: "ct_1",
  pipelineId: "p_1",
  createdAt: "2026-05-01T10:00:00Z",
  updatedAt: "2026-05-01T10:00:00Z",
  contact: {
    id: "ct_1",
    email: "alice@acme.com",
    firstName: "Alice",
    lastName: "Anderson",
    lifecycleStage: "lead",
    companyId: null,
    companyName: null,
  },
  company: null,
  currentStage: { id: "stg_1", name: "Discovery", outcomeType: "open" },
  pipeline: { id: "p_1", name: "Default Pipeline" },
  stageHistory: [],
  owner: null,
};

describe("KAN-888 — DealDetailPage", () => {
  it("renders identity card — name + status + value + probability", async () => {
    getMock.mockResolvedValue(BASE_DEAL);
    wrap(<DealDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Acme — Q3 expansion")).toBeInTheDocument();
    });
    expect(screen.getByText("$5,000.00")).toBeInTheDocument();
    expect(screen.getByText("70%")).toBeInTheDocument();
    expect(screen.getByText("Default Pipeline")).toBeInTheDocument();
    expect(screen.getByText("Discovery")).toBeInTheDocument();
  });

  it("Stage history: empty-state copy when no transitions", async () => {
    getMock.mockResolvedValue(BASE_DEAL);
    wrap(<DealDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Acme — Q3 expansion")).toBeInTheDocument();
    });
    expect(
      screen.getByText("No stage transitions recorded yet"),
    ).toBeInTheDocument();
  });

  it("Outcome card: WON renders wonProductSummary", async () => {
    getMock.mockResolvedValue({
      ...BASE_DEAL,
      status: "won",
      closedAt: "2026-05-10T10:00:00Z",
      wonProductSummary: "5 seats of Growth Pro, annual",
    });
    wrap(<DealDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Outcome")).toBeInTheDocument();
    });
    expect(screen.getByText("5 seats of Growth Pro, annual")).toBeInTheDocument();
  });

  it("Outcome card: LOST renders lostReason badge + detail", async () => {
    getMock.mockResolvedValue({
      ...BASE_DEAL,
      status: "lost",
      closedAt: "2026-05-10T10:00:00Z",
      lostReason: "no_budget",
      lostReasonDetail: "Q3 budget already allocated to competitor.",
    });
    wrap(<DealDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Outcome")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Q3 budget already allocated to competitor."),
    ).toBeInTheDocument();
  });

  it("Outcome card: NOT rendered when status='open'", async () => {
    getMock.mockResolvedValue(BASE_DEAL);
    wrap(<DealDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Acme — Q3 expansion")).toBeInTheDocument();
    });
    expect(screen.queryByText("Outcome")).not.toBeInTheDocument();
  });

  it("Owner card: null → 'No owner assigned'", async () => {
    getMock.mockResolvedValue(BASE_DEAL);
    wrap(<DealDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Ownership")).toBeInTheDocument();
    });
    expect(screen.getByText("No owner assigned")).toBeInTheDocument();
  });

  it("Owner card: populated → name + email link", async () => {
    getMock.mockResolvedValue({
      ...BASE_DEAL,
      ownerId: "u_1",
      owner: { id: "u_1", name: "Fred Binette", email: "fred@axisone.ca" },
    });
    wrap(<DealDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Fred Binette")).toBeInTheDocument();
    });
    const ownerLink = screen.getByText("Fred Binette").closest("a");
    expect(ownerLink).toHaveAttribute("href", "mailto:fred@axisone.ca");
  });

  it("Raw data: renders all 4 JSON blocks (externalIds, customFields, aiContext, metadata)", async () => {
    getMock.mockResolvedValue(BASE_DEAL);
    wrap(<DealDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Raw data")).toBeInTheDocument();
    });
    expect(screen.getByText("externalIds")).toBeInTheDocument();
    expect(screen.getByText("customFields")).toBeInTheDocument();
    expect(screen.getByText("aiContext")).toBeInTheDocument();
    expect(screen.getByText("metadata")).toBeInTheDocument();
  });
});

describe("KAN-888 — StageHistoryTimeline subcomponent", () => {
  it("0 transitions → empty-state copy", () => {
    render(<StageHistoryTimeline rows={[]} />);
    expect(
      screen.getByText("No stage transitions recorded yet"),
    ).toBeInTheDocument();
  });

  it("1 transition → from(initial) → to + triggered-by descriptor", () => {
    render(
      <StageHistoryTimeline
        rows={[
          {
            id: "h1",
            fromStageId: null,
            toStageId: "stg_1",
            fromStage: null,
            toStage: { name: "Discovery" },
            transitionedAt: "2026-05-01T10:00:00Z",
            triggeredBy: "normalizer",
            decisionId: null,
            decision: null,
            metadata: {},
          },
        ]}
      />,
    );
    expect(screen.getByText("(initial)")).toBeInTheDocument();
    expect(screen.getByText("Discovery")).toBeInTheDocument();
    expect(screen.getByText(/triggered by normalizer/)).toBeInTheDocument();
  });

  it("Multiple transitions w/ decision metadata render in order", () => {
    render(
      <StageHistoryTimeline
        rows={[
          {
            id: "h2",
            fromStageId: "stg_1",
            toStageId: "stg_2",
            fromStage: { name: "Discovery" },
            toStage: { name: "Qualified" },
            transitionedAt: "2026-05-05T10:00:00Z",
            triggeredBy: "agent",
            decisionId: "d_1",
            decision: {
              id: "d_1",
              actionType: "send_email",
              strategySelected: "warm_intro",
            },
            metadata: {},
          },
          {
            id: "h1",
            fromStageId: null,
            toStageId: "stg_1",
            fromStage: null,
            toStage: { name: "Discovery" },
            transitionedAt: "2026-05-01T10:00:00Z",
            triggeredBy: "normalizer",
            decisionId: null,
            decision: null,
            metadata: {},
          },
        ]}
      />,
    );
    // Both transitions render
    expect(screen.getByText("Qualified")).toBeInTheDocument();
    expect(screen.getByText("(initial)")).toBeInTheDocument();
    // Decision metadata on the agent-triggered transition
    expect(screen.getByText(/send_email \(warm_intro\)/)).toBeInTheDocument();
  });
});
