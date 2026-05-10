/**
 * KAN-866 — DriftBanner unit tests. Verifies the no-render-when-empty +
 * count copy + sheet open on CTA click.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));

import { DriftBanner } from "../drift-banner";

const PROPOSAL = {
  id: "d1",
  fieldPath: "primaryPhone",
  proposedValue: '"+15551112222"',
  confidence: 0.9,
  sourceUrl: "https://example.com/contact",
  sourceSnippet: "Phone: +1 555 111 2222",
  createdAt: new Date().toISOString(),
};

function renderWithClient(ui: React.ReactElement, proposals: unknown[]) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ result: { data: { proposals } } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DriftBanner — KAN-866", () => {
  it("renders nothing when there are zero proposals", async () => {
    const { container } = renderWithClient(<DriftBanner />, []);
    // Wait one tick so the fetch resolves and the component re-renders the null branch.
    await waitFor(() => {
      expect(container.querySelector("[role='region']")).toBeNull();
    });
  });

  it("renders pluralized count + CTA when proposals exist", async () => {
    renderWithClient(<DriftBanner />, [PROPOSAL, { ...PROPOSAL, id: "d2" }]);
    await waitFor(() => {
      expect(
        screen.getByText(/2 fields ready to review/),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: "Review detected proposals" }),
    ).toBeInTheDocument();
  });

  it("uses singular copy for exactly 1 proposal", async () => {
    renderWithClient(<DriftBanner />, [PROPOSAL]);
    await waitFor(() => {
      expect(screen.getByText(/1 field ready to review/)).toBeInTheDocument();
    });
  });

  it("opens the ReviewProposalsSheet when CTA is clicked", async () => {
    renderWithClient(<DriftBanner />, [PROPOSAL]);
    const cta = await screen.findByRole("button", {
      name: "Review detected proposals",
    });
    await userEvent.click(cta);
    // Sheet content lives in a Radix portal. Wait for the dialog +
    // assert against the unique "Accept all proposals" button inside it
    // (Radix's aria-labelledby pulls SheetTitle into the dialog accessible
    // name, but querying by name introduces collisions with the banner's
    // own copy — use a sheet-only landmark instead).
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: "Accept all proposals" }),
    ).toBeInTheDocument();
  });

  it("region has accessible label for screen readers", async () => {
    renderWithClient(<DriftBanner />, [PROPOSAL]);
    await waitFor(() => {
      expect(
        screen.getByRole("region", {
          name: "Detected account fields awaiting review",
        }),
      ).toBeInTheDocument();
    });
  });
});
