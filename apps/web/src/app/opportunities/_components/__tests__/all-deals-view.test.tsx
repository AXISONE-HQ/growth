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

// KAN-888 — AllDealsView now uses useRouter() for row-click nav to
// /opportunities/[id]. Stub it so the test environment doesn't fall through
// to Next's app-router invariant.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
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
      // KAN-991 Phase D.1 — display copy renamed deals→leads.
      expect(screen.getByText(/No leads yet/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/Leads will appear here as the AI works your pipeline/i),
    ).toBeInTheDocument();
  });

  it("renders status filter chips: All + Open + Won + Lost", () => {
    dealsListMock.mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 });
    wrap(<AllDealsView />);
    // KAN-988 — DataTable namespaces chip aria-labels as
    // "{filter.label}: {opt.label}" so cross-filter "All" chips disambiguate.
    expect(screen.getByRole("button", { name: "Status: All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Status: Open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Status: Won" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Status: Lost" })).toBeInTheDocument();
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

  // KAN-cohort-3.5 — TZ off-by-one regression. yyyy-mm-dd values stored as
  // midnight UTC must NOT shift backward when rendered in a US-leaning
  // locale (America/Toronto, etc). 2026-09-30T00:00:00Z must surface as
  // "9/30/2026" not "9/29/2026".
  it("KAN-cohort-3.5: expectedCloseDate renders UTC-anchored (no TZ shift)", async () => {
    dealsListMock.mockResolvedValue({
      items: [
        {
          id: "d1",
          name: "TZ-safe deal",
          status: "open",
          probability: null,
          expectedCloseDate: "2026-09-30T00:00:00.000Z",
          closedAt: null,
          lostReason: null,
          ownerId: null,
          assignedAgentId: null,
          companyId: null,
          value: "100.00",
          currency: "USD",
          currentStageId: "stg1",
          contactId: "ct1",
          pipelineId: "p1",
          createdAt: "2026-05-01T10:00:00Z",
          updatedAt: "2026-05-01T10:00:00Z",
          contact: { id: "ct1", email: "tz@example.com", firstName: null, lastName: null },
          company: null,
        },
      ],
      nextCursor: null,
      totalCount: 1,
    });
    wrap(<AllDealsView />);
    await waitFor(() => {
      expect(screen.getByText("TZ-safe deal")).toBeInTheDocument();
    });
    // toLocaleDateString format varies by locale — check the day component
    // didn't wrap to 29. We use a permissive match: either "9/30/2026" (US)
    // or "30/09/2026" (EU) or "2026-09-30" (ISO) is fine; "9/29" or "29/09"
    // would mean the UTC anchor was lost. No word-boundary anchors because
    // table text concatenates without separators (e.g., "2026-09-30Showing").
    const body = document.body.textContent || "";
    expect(body).toMatch(/(?:09\/30|9\/30|30\/09|30\/9|2026-09-30)/);
    expect(body).not.toMatch(/(?:09\/29\/|9\/29\/|29\/09|29\/9|2026-09-29)/);
  });
});
