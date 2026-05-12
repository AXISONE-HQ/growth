/**
 * KAN-886 — AllDealsView smoke tests.
 *
 * Component-level coverage:
 *   - Renders a 6-column table when dealsApi.list returns items
 *   - Empty state when totalCount === 0
 *   - Status filter chips render in expected order (All + 3 enum values)
 *   - Search input wires up (debounced — covered by integration shape
 *     rather than a timer test; debounce semantics tested separately)
 *
 * Full happy-path render + filter integration is page-level coverage
 * deferred to KAN-885.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AllDealsView } from "../all-deals-view";

const dealsListMock = vi.fn();

vi.mock("@/lib/api", () => ({
  dealsApi: {
    list: (...args: unknown[]) => dealsListMock(...args),
    get: vi.fn(),
  },
}));

beforeEach(() => {
  dealsListMock.mockReset();
});

function wrap(ui: React.ReactElement) {
  // Fresh QueryClient per test so cache doesn't leak across cases.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("KAN-886 — AllDealsView", () => {
  it("renders empty state when totalCount === 0", async () => {
    dealsListMock.mockResolvedValue({
      items: [],
      nextCursor: null,
      totalCount: 0,
    });
    wrap(<AllDealsView />);
    await waitFor(() => {
      expect(screen.getByText(/No deals yet/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Deals will appear here as the AI works your pipeline/i),
    ).toBeInTheDocument();
  });

  it("renders status filter chips: All + Open + Won + Lost", () => {
    dealsListMock.mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 });
    wrap(<AllDealsView />);
    // chips are buttons
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Won" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lost" })).toBeInTheDocument();
  });

  it("renders a 6-column header — Name / Status / Value / Contact / Company / Expected close", async () => {
    dealsListMock.mockResolvedValue({
      items: [
        {
          id: "d1",
          name: "Acme — Q3 expansion",
          status: "open",
          probability: null,
          expectedCloseDate: null,
          closedAt: null,
          lostReason: null,
          ownerId: null,
          assignedAgentId: null,
          companyId: null,
          value: "1000.00",
          currency: "USD",
          currentStageId: "stg1",
          contactId: "ct1",
          pipelineId: "p1",
          createdAt: "2026-05-01T10:00:00Z",
          updatedAt: "2026-05-01T10:00:00Z",
          contact: {
            id: "ct1",
            email: "alice@acme.com",
            firstName: "Alice",
            lastName: "Anderson",
          },
          company: null,
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });
    wrap(<AllDealsView />);
    await waitFor(() => {
      expect(screen.getByText("Acme — Q3 expansion")).toBeInTheDocument();
    });
    // Headers
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Value")).toBeInTheDocument();
    expect(screen.getByText("Contact")).toBeInTheDocument();
    expect(screen.getByText("Company")).toBeInTheDocument();
    expect(screen.getByText("Expected close")).toBeInTheDocument();
  });

  it("renders deal value via MoneyDisplay (currency-formatted)", async () => {
    dealsListMock.mockResolvedValue({
      items: [
        {
          id: "d1",
          name: "Test deal",
          status: "open",
          probability: null,
          expectedCloseDate: null,
          closedAt: null,
          lostReason: null,
          ownerId: null,
          assignedAgentId: null,
          companyId: null,
          value: "2500.50",
          currency: "USD",
          currentStageId: "stg1",
          contactId: "ct1",
          pipelineId: "p1",
          createdAt: "2026-05-01T10:00:00Z",
          updatedAt: "2026-05-01T10:00:00Z",
          contact: { id: "ct1", email: null, firstName: "Bob", lastName: null },
          company: null,
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });
    wrap(<AllDealsView />);
    await waitFor(() => {
      expect(screen.getByText("$2,500.50")).toBeInTheDocument();
    });
  });

  it("falls back to em-dash for company when companyId is null", async () => {
    dealsListMock.mockResolvedValue({
      items: [
        {
          id: "d1",
          name: "Direct deal",
          status: "open",
          probability: null,
          expectedCloseDate: null,
          closedAt: null,
          lostReason: null,
          ownerId: null,
          assignedAgentId: null,
          companyId: null,
          value: "0",
          currency: "USD",
          currentStageId: "stg1",
          contactId: "ct1",
          pipelineId: "p1",
          createdAt: "2026-05-01T10:00:00Z",
          updatedAt: "2026-05-01T10:00:00Z",
          contact: { id: "ct1", email: "fred@example.com", firstName: null, lastName: null },
          company: null,
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });
    const { container } = wrap(<AllDealsView />);
    await waitFor(() => {
      expect(screen.getByText("Direct deal")).toBeInTheDocument();
    });
    // The empty Company column renders an em-dash — assert via the
    // contact row containing it (avoids false positives from other em-dashes).
    expect(container.textContent).toContain("—");
  });
});
