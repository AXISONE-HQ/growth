/**
 * KAN-866 — DetectButton unit tests. Covers the dual-label state, the
 * 60s cooldown countdown, and the onScanStarted callback wiring.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
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

import { DetectButton } from "../detect-button";

function renderBtn(opts: {
  websiteUrl: string;
  hasScannedBefore: boolean;
  onScanStarted?: ReturnType<typeof vi.fn>;
  fetchOk?: boolean;
}) {
  const onScanStarted = opts.onScanStarted ?? vi.fn();
  const fetchMock = vi.fn(async () =>
    opts.fetchOk === false
      ? new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 })
      : new Response(
          JSON.stringify({
            result: { data: { jobId: "job-xyz", estimatedSeconds: 12 } },
          }),
          { status: 200 },
        ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    onScanStarted,
    fetchMock,
    ...render(
      <QueryClientProvider client={qc}>
        <DetectButton
          websiteUrl={opts.websiteUrl}
          hasScannedBefore={opts.hasScannedBefore}
          onScanStarted={onScanStarted}
        />
      </QueryClientProvider>,
    ),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("DetectButton — KAN-866", () => {
  it("labels itself 'Detect from website' when never scanned before", () => {
    renderBtn({ websiteUrl: "https://acme.com", hasScannedBefore: false });
    expect(
      screen.getByRole("button", { name: "Detect from website" }),
    ).toBeInTheDocument();
  });

  it("labels itself 'Re-scan website' after a previous successful scan", () => {
    renderBtn({ websiteUrl: "https://acme.com", hasScannedBefore: true });
    expect(
      screen.getByRole("button", { name: "Re-scan website" }),
    ).toBeInTheDocument();
  });

  it("disables itself when websiteUrl is empty", () => {
    renderBtn({ websiteUrl: "   ", hasScannedBefore: false });
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("fires onScanStarted with jobId on successful mutation + enters cooldown", async () => {
    const { onScanStarted } = renderBtn({
      websiteUrl: "https://acme.com",
      hasScannedBefore: false,
    });
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => {
      expect(onScanStarted).toHaveBeenCalledWith({ jobId: "job-xyz" });
    });
    // After success, cooldown text should appear (60s start)
    await waitFor(() => {
      expect(screen.getByRole("button")).toHaveTextContent(/Re-scan in 60s/);
    });
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("respects parent `disabled` prop (e.g. while a scan is mounted)", () => {
    const onScanStarted = vi.fn();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ result: { data: { jobId: "job-x", estimatedSeconds: 12 } } }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <DetectButton
          websiteUrl="https://acme.com"
          hasScannedBefore={false}
          disabled
          onScanStarted={onScanStarted}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button")).toBeDisabled();
  });
});
