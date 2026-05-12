/**
 * KAN-886 — AiSegmentsView regression-protection snapshots.
 *
 * The Cohort 1 PR 3 Tabs refactor moved the entire prior /opportunities
 * page body into this subcomponent. These snapshots pin the rendered
 * output across the 3 sub-states (empty / found / launched) so a
 * future edit can't accidentally drop content or change copy without
 * the diff surfacing in CI.
 *
 * Strategy: mock the `@/lib/api` `trpcQuery` + `trpcMutation` exports
 * to return canned wedge.opportunities + outcomes payloads, then
 * snapshot the rendered tree. Each test waits for the async fetch to
 * resolve before snapshotting (the view's state machine starts in
 * "isLoading" and transitions to one of the 3 sub-states).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { AiSegmentsView } from "../ai-segments-view";

// ─────────────────────────────────────────────
// lib/api mocks — minimal stub of trpcQuery + trpcMutation
// ─────────────────────────────────────────────

const trpcQueryMock = vi.fn();
const trpcMutationMock = vi.fn();

vi.mock("@/lib/api", () => ({
  trpcQuery: (...args: unknown[]) => trpcQueryMock(...args),
  trpcMutation: (...args: unknown[]) => trpcMutationMock(...args),
}));

beforeEach(() => {
  trpcQueryMock.mockReset();
  trpcMutationMock.mockReset();
});

// ─────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────

const SAMPLE_OPPORTUNITY = {
  type: "dormant_reactivation" as const,
  displayName: "Reactivate dormant leads",
  entityIds: ["c1", "c2"],
  estimatedPopulation: 7,
  reasoning: "7 contacts went 30+ days without engagement.",
  signalSource: "engagement_recency",
  playbookSlug: "dormant-3-touch",
  playbook: {
    slug: "dormant-3-touch",
    name: "Dormant Reactivation — 3-touch",
    description: "Email + SMS + Email over 5 days.",
    steps: [
      { day: 0, channel: "email" as const, intent: "ask_open_question" },
      { day: 2, channel: "sms" as const, intent: "soft_check_in" },
      { day: 5, channel: "email" as const, intent: "final_value_offer" },
    ],
  },
  sampleContacts: [
    { id: "c1", name: "Sample One", email: "s1@example.com", lifecycleStage: "lead" },
    { id: "c2", name: "Sample Two", email: "s2@example.com", lifecycleStage: "mql" },
  ],
};

// Wire trpcQuery so the opportunities call returns the canned payload
// and outcomes.summaryForOpportunity returns null (skipped). Two
// fixture shapes per test: empty + found.
function wireQuery(opportunities: typeof SAMPLE_OPPORTUNITY[] | [], totalContacts: number) {
  trpcQueryMock.mockImplementation((procedure: string) => {
    if (procedure === "wedge.opportunities") {
      return Promise.resolve({
        opportunities,
        summary: { totalContacts },
      });
    }
    if (procedure === "outcomes.summaryForOpportunity") {
      return Promise.resolve({
        sent: 0,
        failed: 0,
        suppressed: 0,
        delivered: 0,
        total: 0,
        lastLaunchedAt: null,
      });
    }
    return Promise.reject(new Error(`Unmocked trpcQuery: ${procedure}`));
  });
}

describe("KAN-886 — AiSegmentsView regression snapshots", () => {
  it("Sub-state 1: empty — 'No opportunities right now' + scan count", async () => {
    wireQuery([], 5);
    const { container } = render(<AiSegmentsView />);
    await waitFor(() => {
      expect(screen.getByText(/No opportunities right now/i)).toBeInTheDocument();
    });
    // Verify the count copy renders the scanned-contact count
    expect(
      screen.getByText(/We scanned 5 contacts and didn't find any signals/i),
    ).toBeInTheDocument();
    expect(container.firstChild).toMatchSnapshot();
  });

  it("Sub-state 2: found — header copy + opportunity card structure", async () => {
    wireQuery([SAMPLE_OPPORTUNITY], 12);
    const { container } = render(<AiSegmentsView />);
    await waitFor(() => {
      expect(screen.getByText("Reactivate dormant leads")).toBeInTheDocument();
    });
    // Header copy: "growth found N opportunit{y|ies} across X contacts."
    expect(
      screen.getByText(/growth found 1 opportunity across 12 contacts\./i),
    ).toBeInTheDocument();
    // Playbook + sample contacts render
    expect(screen.getByText("Dormant Reactivation — 3-touch")).toBeInTheDocument();
    expect(screen.getByText("Sample One")).toBeInTheDocument();
    expect(container.firstChild).toMatchSnapshot();
  });

  it("Sub-state 3: launched — success banner appears after launch", async () => {
    wireQuery([SAMPLE_OPPORTUNITY], 12);
    trpcMutationMock.mockResolvedValue({
      opportunityType: "dormant_reactivation",
      launched: 7,
      errors: 0,
      dryRun: false,
    });
    const { container } = render(<AiSegmentsView />);
    await waitFor(() => {
      expect(screen.getByText("Reactivate dormant leads")).toBeInTheDocument();
    });

    // Click "Launch for 7" — triggers the wedge.launch mutation
    const launchBtn = screen.getByRole("button", { name: /Launch for 7/i });
    await act(async () => {
      launchBtn.click();
    });

    await waitFor(() => {
      expect(screen.getByText(/Launched/i)).toBeInTheDocument();
    });
    // Success banner copy: "7 contacts enrolled"
    expect(screen.getByText(/7 contacts enrolled — first message queued\./i)).toBeInTheDocument();
    expect(container.firstChild).toMatchSnapshot();
  });
});
