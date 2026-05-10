/**
 * KAN-866 — ReviewProposalsSheet unit tests. Verifies the sheet open
 * state, per-row Accept/Reject mutations + the "Accept all" bulk action.
 * Sheet is rendered via Radix Dialog Portal — queries hit document.body.
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

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
    message: vi.fn(),
  },
}));

import {
  ReviewProposalsSheet,
  humanizeFieldPath,
  renderProposedValue,
} from "../review-proposals-sheet";

const PROPOSALS = [
  {
    id: "d1",
    fieldPath: "primaryPhone",
    proposedValue: '"+15551112222"',
    confidence: 0.92,
    sourceUrl: "https://example.com/contact",
    sourceSnippet: "Phone: +1 555 111 2222",
    createdAt: new Date().toISOString(),
  },
  {
    id: "d2",
    fieldPath: "legalName",
    proposedValue: '"Acme Corp"',
    confidence: 0.71,
    sourceUrl: null,
    sourceSnippet: null,
    createdAt: new Date().toISOString(),
  },
];

function renderSheet(open = true) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ result: { data: { ok: true, acceptedCount: 2 } } }), {
      status: 200,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    fetchMock,
    ...render(
      <QueryClientProvider client={qc}>
        <ReviewProposalsSheet open={open} onOpenChange={vi.fn()} proposals={PROPOSALS} />
      </QueryClientProvider>,
    ),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe("ReviewProposalsSheet — KAN-866", () => {
  it("renders one row per proposal with humanized field labels", () => {
    renderSheet();
    expect(screen.getByText("Primary phone")).toBeInTheDocument();
    expect(screen.getByText("Legal name")).toBeInTheDocument();
  });

  it("renders ConfidenceBadge per row with rounded percent", () => {
    renderSheet();
    const badges = screen.getAllByRole("status");
    // First proposal = 92 (high), second = 71 (normal)
    expect(badges.some((b) => b.getAttribute("aria-label")?.includes("92"))).toBe(true);
    expect(badges.some((b) => b.getAttribute("aria-label")?.includes("71"))).toBe(true);
  });

  it("fires acceptDetection mutation when per-row Accept is clicked", async () => {
    const { fetchMock } = renderSheet();
    const acceptBtn = screen.getByRole("button", { name: "Accept Primary phone" });
    await userEvent.click(acceptBtn);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const callUrl =
      ((fetchMock.mock.calls as unknown as unknown[][])[0]?.[0] as string | undefined) ?? "";
    expect(callUrl).toContain("account.acceptDetection");
  });

  it("fires rejectDetection mutation when per-row Reject is clicked", async () => {
    const { fetchMock } = renderSheet();
    const rejectBtn = screen.getByRole("button", { name: "Reject Legal name" });
    await userEvent.click(rejectBtn);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const callUrl =
      ((fetchMock.mock.calls as unknown as unknown[][])[0]?.[0] as string | undefined) ?? "";
    expect(callUrl).toContain("account.rejectDetection");
  });

  it("fires acceptAllDetections mutation when 'Accept all' clicked", async () => {
    const { fetchMock } = renderSheet();
    const allBtn = screen.getByRole("button", { name: "Accept all proposals" });
    await userEvent.click(allBtn);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const callUrl =
      ((fetchMock.mock.calls as unknown as unknown[][])[0]?.[0] as string | undefined) ?? "";
    expect(callUrl).toContain("account.acceptAllDetections");
  });

  it("renders source URL link when sourceUrl is present", () => {
    renderSheet();
    const link = screen.getByRole("link", { name: /example\.com\/contact/ });
    expect(link).toHaveAttribute("href", "https://example.com/contact");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("humanizeFieldPath converts dot-camelCase to sentence-case", () => {
    expect(humanizeFieldPath("primaryPhone")).toBe("Primary phone");
    expect(humanizeFieldPath("weeklyHours.monday.open")).toBe("Open");
    expect(humanizeFieldPath("oneLineDescription")).toBe("One line description");
  });

  it("renderProposedValue handles strings, objects, and malformed JSON", () => {
    expect(renderProposedValue('"hello"')).toBe("hello");
    expect(renderProposedValue('{"a":1}')).toContain('"a": 1');
    expect(renderProposedValue("not-json")).toBe("not-json");
    expect(renderProposedValue("null")).toBe("(empty)");
  });
});
