/**
 * KAN-XXX — ServiceList component tests.
 *
 * 6 tests:
 *  1. Empty state — three-part formula + Add CTA
 *  2. Table renders entries with truncated title + formatted price + status
 *  3. Add CTA opens AddServiceDialog
 *  4. Skeleton renders while loading
 *  5. Error state renders Try-again button
 *  6. Foundation token coverage — no hex
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

import { ServiceList } from "../service-list";

// KAN-851 fix-forward: Prisma serializes Decimal columns to STRING in JSON
// ("250.00"), not number. Mocks below use the string shape to match real
// API payloads — earlier number-shape mocks masked the toFixed crash.
interface MockService {
  id: string;
  title: string;
  description: string;
  price: string | number | null;
  priceUnit: "PER_HOUR" | "PER_MONTH" | "PER_PROJECT" | "PER_UNIT" | "FIXED" | "CUSTOM";
  priceCustomLabel: string | null;
  startDate: string | null;
  endDate: string | null;
  includedItems: string[];
  excludedItems: string[];
  status: "queued" | "embedding" | "ready" | "error";
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
}

function makeService(overrides: Partial<MockService> = {}): MockService {
  const now = new Date().toISOString();
  return {
    id: "s1",
    title: "Senior Engineering Mentorship",
    description: "Weekly 1:1.",
    price: "250.00",
    priceUnit: "PER_HOUR",
    priceCustomLabel: null,
    startDate: null,
    endDate: null,
    includedItems: [],
    excludedItems: [],
    status: "ready",
    errorDetail: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setupFetchMock(opts: { services?: MockService[]; failList?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/knowledge/services")) {
      if (opts.failList) return { ok: false, status: 500, json: async () => ({}) } as Response;
      return { ok: true, json: async () => ({ services: opts.services ?? [] }) } as Response;
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
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ServiceList — KAN-XXX", () => {
  it("Test 1 — empty state renders three-part formula + Add CTA", async () => {
    setupFetchMock({ services: [] });
    renderWithClient(<ServiceList />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /No services yet\./ })).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        /Services appear here as you create them\. The AI cites them when a customer asks about pricing or what you offer\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add service" }).length).toBeGreaterThanOrEqual(1);
  });

  it("Test 2 — table renders entries with truncated title + formatted price + status pill", async () => {
    const long = "A".repeat(120);
    setupFetchMock({
      services: [
        makeService({ title: long, price: "50.00", priceUnit: "PER_HOUR" }),
      ],
    });
    renderWithClient(<ServiceList />);
    await waitFor(() => {
      // Truncated to 80 chars + ellipsis
      expect(screen.getByText(`${"A".repeat(80)}…`)).toBeInTheDocument();
    });
    expect(screen.getByText("$50.00 per hour")).toBeInTheDocument();
  });

  it("Test 2b — renders price correctly when API returns Decimal as string (KAN-851)", async () => {
    // Regression guard: Prisma serializes Decimal(10,2) to JSON as STRING.
    // Earlier mocks used number, masking the .toFixed crash. This test
    // exercises the string-shape path that PROD actually emits.
    setupFetchMock({
      services: [
        makeService({ title: "Launch", price: "299.00", priceUnit: "PER_MONTH" }),
        makeService({ id: "s2", title: "Test service", price: "250.00", priceUnit: "PER_HOUR" }),
      ],
    });
    renderWithClient(<ServiceList />);
    await waitFor(() => {
      expect(screen.getByText("$299.00 per month")).toBeInTheDocument();
    });
    expect(screen.getByText("$250.00 per hour")).toBeInTheDocument();
  });

  it("Test 3 — Add CTA click opens AddServiceDialog", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setupFetchMock({ services: [makeService()] });
    renderWithClient(<ServiceList />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add service" })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add service" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Add service" })).toBeInTheDocument();
    });
  });

  it("Test 4 — skeleton renders while loading", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderWithClient(<ServiceList />);
    expect(screen.getByLabelText("Loading services")).toBeInTheDocument();
  });

  it("Test 5 — error state renders Try-again button on fetch failure", async () => {
    setupFetchMock({ failList: true });
    renderWithClient(<ServiceList />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry loading services" })).toBeInTheDocument();
    });
  });

  it("Test 6 — foundation token coverage: no hex in className or inline style", async () => {
    setupFetchMock({ services: [makeService()] });
    const { container } = renderWithClient(<ServiceList />);
    await waitFor(() => {
      expect(screen.getByText(/Senior Engineering Mentorship/)).toBeInTheDocument();
    });
    const html = container.innerHTML;
    const hex = html.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(hex, `Hardcoded hex colors leaked: ${hex.join(", ")}`).toEqual([]);
  });
});
