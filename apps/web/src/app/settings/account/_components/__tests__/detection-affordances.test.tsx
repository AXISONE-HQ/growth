/**
 * KAN-866 — DetectionAffordances unit tests. Verifies null-render +
 * per-field accept/reject mutation wiring + a11y region label.
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

import { DetectionAffordances, type DetectionRow } from "../detection-affordances";

const DETECTION: DetectionRow = {
  id: "d1",
  fieldPath: "primaryPhone",
  proposedValue: '"+15551112222"',
  confidence: 0.87,
  sourceUrl: "https://example.com/contact",
  sourceSnippet: "Phone: +1 555 111 2222",
};

function renderHook(detection: DetectionRow | null) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ result: { data: { ok: true } } }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    fetchMock,
    ...render(
      <QueryClientProvider client={qc}>
        <DetectionAffordances detection={detection} />
      </QueryClientProvider>,
    ),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe("DetectionAffordances — KAN-866", () => {
  it("renders nothing when detection is null", () => {
    const { container } = renderHook(null);
    expect(container.firstChild).toBeNull();
  });

  it("renders the AI label + ConfidenceBadge with the rounded percent", () => {
    renderHook(DETECTION);
    expect(screen.getByText("Proposed by AI")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "87 percent confidence, high",
    );
  });

  it("region label includes the humanized field name for screen readers", () => {
    renderHook(DETECTION);
    expect(
      screen.getByRole("region", { name: "AI proposal for Primary phone" }),
    ).toBeInTheDocument();
  });

  it("fires acceptDetection on Accept click", async () => {
    const { fetchMock } = renderHook(DETECTION);
    await userEvent.click(
      screen.getByRole("button", { name: "Accept proposal for Primary phone" }),
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const url =
      ((fetchMock.mock.calls as unknown as unknown[][])[0]?.[0] as string | undefined) ?? "";
    expect(url).toContain("account.acceptDetection");
  });

  it("fires rejectDetection on Reject click", async () => {
    const { fetchMock } = renderHook(DETECTION);
    await userEvent.click(
      screen.getByRole("button", { name: "Reject proposal for Primary phone" }),
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const url =
      ((fetchMock.mock.calls as unknown as unknown[][])[0]?.[0] as string | undefined) ?? "";
    expect(url).toContain("account.rejectDetection");
  });

  it("renders source URL link when present", () => {
    renderHook(DETECTION);
    expect(
      screen.getByRole("link", { name: "Source for Primary phone" }),
    ).toHaveAttribute("href", "https://example.com/contact");
  });
});
