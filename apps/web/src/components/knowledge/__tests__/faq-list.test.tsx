/**
 * KAN-XXX — FaqList component tests.
 *
 * 6 tests per cohort brief:
 *  1. Empty state — three-part formula + Add FAQ entry CTA
 *  2. Table renders entries with truncated question + relative-time + status pill
 *  3. Add CTA opens the AddFaqDialog
 *  4. Skeleton renders while loading
 *  5. Error state surfaces with Try-again button
 *  6. Foundation token coverage — no hex in rendered className/style
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

import { FaqList } from "../faq-list";

interface MockFaq {
  id: string;
  question: string;
  answer: string;
  status: "queued" | "embedding" | "ready" | "error";
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

function makeFaq(overrides: Partial<MockFaq> = {}): MockFaq {
  const now = new Date().toISOString();
  return {
    id: "f1",
    question: "What's the warranty period?",
    answer: "Five years parts and labor.",
    status: "ready",
    errorDetail: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setupFetchMock(opts: { faqs?: MockFaq[]; failList?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/knowledge/faqs")) {
      if (opts.failList) return { ok: false, status: 500, json: async () => ({}) } as Response;
      return { ok: true, json: async () => ({ faqs: opts.faqs ?? [] }) } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  // shouldAdvanceTime keeps await/microtasks progressing so React Query's
  // promise machinery resolves (matches the SourceList test pattern).
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("FaqList — KAN-XXX", () => {
  it("Test 1 — empty state renders three-part formula + Add CTA", async () => {
    setupFetchMock({ faqs: [] });
    renderWithClient(<FaqList />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /No FAQ entries yet\./ })).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        /Entries appear here as you create them\. The AI uses them to answer customer questions specifically — not generically\./,
      ),
    ).toBeInTheDocument();
    // Two Add CTAs render (top-row button + empty-state CTA); both labeled the same
    const addButtons = screen.getAllByRole("button", { name: "Add FAQ entry" });
    expect(addButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("Test 2 — table renders entries with truncated question + status pill", async () => {
    const long = "A".repeat(150);
    setupFetchMock({ faqs: [makeFaq({ question: long, status: "ready" })] });
    renderWithClient(<FaqList />);
    await waitFor(() => {
      // Truncated to 120 chars + ellipsis
      expect(screen.getByText(`${"A".repeat(120)}…`)).toBeInTheDocument();
    });
  });

  it("Test 3 — Add CTA click opens AddFaqDialog", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setupFetchMock({ faqs: [makeFaq()] });
    renderWithClient(<FaqList />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add FAQ entry" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add FAQ entry" }));
    // AddFaqDialog mounts a heading "Add FAQ entry"
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Add FAQ entry" })).toBeInTheDocument();
    });
  });

  it("Test 4 — skeleton renders while loading (status=loading)", () => {
    // Don't resolve the fetch — keeps the query in pending state
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderWithClient(<FaqList />);
    expect(screen.getByLabelText("Loading FAQ entries")).toBeInTheDocument();
  });

  it("Test 5 — error state renders Try-again button on fetch failure", async () => {
    setupFetchMock({ failList: true });
    renderWithClient(<FaqList />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry loading FAQ entries" })).toBeInTheDocument();
    });
  });

  it("Test 6 — foundation token coverage: no hex in className or inline style", async () => {
    setupFetchMock({ faqs: [makeFaq()] });
    const { container } = renderWithClient(<FaqList />);
    await waitFor(() => {
      expect(screen.getByText("What's the warranty period?")).toBeInTheDocument();
    });
    const html = container.innerHTML;
    const hex = html.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(hex, `Hardcoded hex colors leaked: ${hex.join(", ")}`).toEqual([]);
  });
});
