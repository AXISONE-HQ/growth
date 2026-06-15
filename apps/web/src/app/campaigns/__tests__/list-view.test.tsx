/**
 * KAN-1183 — /campaigns list view RTL coverage.
 *
 * Six SPO-locked scenarios + one defensive doctrine guard (negative
 * assertion that prevents Slice 2 framing from re-emerging via stale
 * copy regression).
 *
 * Approach: mock the network layer (campaignsApi.list) with deterministic
 * fixtures and exercise the page render + interactions through RTL +
 * user-event. No router mock — `useRouter().push` is captured via a thin
 * `next/navigation` stub for the row-click assertion.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Capture router.push calls for the row-click assertion. Defined OUT of
// the vi.mock factory so each test can read it directly.
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: pushMock, prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

// Mock the network layer — campaignsApi.list returns deterministic fixtures
// keyed by input args, so per-test scenarios can set the next response.
const listMock = vi.fn();
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    campaignsApi: {
      ...actual.campaignsApi,
      list: (input: unknown) => listMock(input),
    },
  };
});

import CampaignsPage from "../page";
import type { CampaignListItem, CursorPage } from "@/lib/api";

function fixtureItem(overrides: Partial<CampaignListItem> = {}): CampaignListItem {
  return {
    id: "camp-1",
    name: "Spring Reactivation",
    status: "active",
    goalType: "deals",
    goalTarget: 50,
    goalDescription: "Close 50 deals by Q2",
    feasibilityAnalysisKind: "feasibility_counsel",
    achievability: "stretch",
    activatedAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-15T00:00:00Z",
    ...overrides,
  };
}

function fixturePage(
  items: CampaignListItem[],
  overrides: Partial<CursorPage<CampaignListItem>> = {},
): CursorPage<CampaignListItem> {
  return {
    items,
    nextCursor: null,
    totalCount: items.length,
    ...overrides,
  };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CampaignsPage />
    </QueryClientProvider>,
  );
}

describe("KAN-1183 — /campaigns list view", () => {
  beforeEach(() => {
    pushMock.mockClear();
    listMock.mockReset();
  });

  it("renders the list with a Campaign row", async () => {
    listMock.mockResolvedValueOnce(
      fixturePage([fixtureItem({ name: "Spring Reactivation" })]),
    );
    renderPage();
    expect(await screen.findByText("Spring Reactivation")).toBeInTheDocument();
  });

  it("filter chip click triggers a re-fetch with status filter", async () => {
    listMock.mockResolvedValue(fixturePage([fixtureItem()]));
    renderPage();
    await screen.findByText("Spring Reactivation");
    // First call has no status; clicking the Active chip refetches with
    // status='active'. DataTable chips expose aria-label="Status: <Label>".
    const activeChip = await screen.findByRole("button", {
      name: /Status: Active/i,
    });
    await userEvent.click(activeChip);
    await waitFor(() => {
      const lastInput = listMock.mock.calls[listMock.mock.calls.length - 1]?.[0];
      expect(lastInput?.status).toBe("active");
    });
  });

  it("[+ New Campaign] CTA is disabled with the KAN-1188 tooltip", async () => {
    listMock.mockResolvedValueOnce(fixturePage([]));
    renderPage();
    const cta = await screen.findByRole("button", { name: /New Campaign/i });
    expect(cta).toBeDisabled();
    expect(cta).toHaveAttribute(
      "title",
      "Coming soon — conversational builder lands in KAN-1188",
    );
  });

  it("empty state renders the locked verbatim copy", async () => {
    listMock.mockResolvedValueOnce(fixturePage([]));
    renderPage();
    expect(
      await screen.findByText("Create your first Campaign"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Tell growth what you want to accomplish."),
    ).toBeInTheDocument();
  });

  it("row click navigates to /campaigns/[id]", async () => {
    listMock.mockResolvedValueOnce(
      fixturePage([fixtureItem({ id: "camp-xyz", name: "Click target" })]),
    );
    renderPage();
    const cell = await screen.findByText("Click target");
    await userEvent.click(cell);
    expect(pushMock).toHaveBeenCalledWith("/campaigns/camp-xyz");
  });

  it("Always-On default exclusion — first list call omits includeAlwaysOn", async () => {
    listMock.mockResolvedValueOnce(fixturePage([fixtureItem()]));
    renderPage();
    await screen.findByText("Spring Reactivation");
    const firstInput = listMock.mock.calls[0]?.[0];
    // Either undefined or false is acceptable; what matters is the page never
    // sets includeAlwaysOn=true unprompted.
    expect(firstInput?.includeAlwaysOn).toBeFalsy();
  });

  it("AI counsel chip renders per discriminated kind", async () => {
    listMock.mockResolvedValueOnce(
      fixturePage([
        fixtureItem({
          id: "a",
          name: "Cold start row",
          feasibilityAnalysisKind: "cold_start_counsel",
          achievability: null,
        }),
        fixtureItem({
          id: "b",
          name: "Feasible row",
          feasibilityAnalysisKind: "feasibility_counsel",
          achievability: "feasible",
        }),
        fixtureItem({
          id: "c",
          name: "Unavailable row",
          feasibilityAnalysisKind: "analyzer_unavailable",
          achievability: null,
        }),
      ]),
    );
    renderPage();
    await screen.findByText("Cold start row");
    expect(screen.getByText(/needs data/i)).toBeInTheDocument();
    expect(screen.getByText(/^Feasible$/)).toBeInTheDocument();
    expect(screen.getByText(/retry needed/i)).toBeInTheDocument();
  });

  // Defensive doctrine guard — Slice 2 framing copy must not appear.
  it("doctrine guard — no 'INTERNAL PREVIEW' or 'SLICE 2' copy renders anywhere", async () => {
    listMock.mockResolvedValueOnce(
      fixturePage([fixtureItem({ name: "Spring Reactivation" })]),
    );
    const { container } = renderPage();
    await screen.findByText("Spring Reactivation");
    expect(container.textContent ?? "").not.toMatch(/internal preview/i);
    expect(container.textContent ?? "").not.toMatch(/slice 2/i);
    expect(container.textContent ?? "").not.toMatch(
      /NEXT_PUBLIC_CAMPAIGN_LAYER_DEMO/,
    );
  });
});

// within import preserved for future expansion
void within;
