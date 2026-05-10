/**
 * KAN-866 — ScanningStateCard SSE consumer tests. Drives the EventSource
 * stub from test-setup.ts to verify phase progression + cleanup +
 * terminal-event handling.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ScanningStateCard } from "../scanning-state-card";
import { MockEventSource } from "../../../../../../test-setup";

afterEach(() => {
  MockEventSource.lastInstance = null;
});

describe("ScanningStateCard — KAN-866", () => {
  it("opens an EventSource at /api/account/detect-events with jobId", () => {
    render(<ScanningStateCard jobId="job-123" />);
    expect(MockEventSource.lastInstance).not.toBeNull();
    expect(MockEventSource.lastInstance?.url).toContain(
      "/api/account/detect-events?jobId=job-123",
    );
    // Title + step row both render the same copy — count both.
    expect(screen.getAllByText(/Reading website pages/).length).toBeGreaterThan(0);
  });

  it("advances to extracting phase on a 'progress' event with phase='extracting'", () => {
    render(<ScanningStateCard jobId="job-2" />);
    act(() => {
      MockEventSource.lastInstance?.dispatch("progress", { phase: "extracting" });
    });
    // Title flips to "Identifying account fields"
    expect(
      screen.getByRole("heading", { name: /Identifying account fields/ }),
    ).toBeInTheDocument();
  });

  it("renders completion summary + fires onCompleted on terminal 'completed' event", () => {
    const onCompleted = vi.fn();
    render(<ScanningStateCard jobId="job-3" onCompleted={onCompleted} />);
    act(() => {
      MockEventSource.lastInstance?.dispatch("completed", {
        proposalCount: 4,
        durationMs: 9_000,
      });
    });
    expect(screen.getByText(/Found 4 proposals for review\./)).toBeInTheDocument();
    expect(onCompleted).toHaveBeenCalledWith({ proposalCount: 4, durationMs: 9_000 });
    expect(MockEventSource.lastInstance?.readyState).toBe(MockEventSource.CLOSED);
  });

  it("renders humanized error + fires onFailed on terminal 'failed' event", () => {
    const onFailed = vi.fn();
    render(<ScanningStateCard jobId="job-4" onFailed={onFailed} />);
    act(() => {
      MockEventSource.lastInstance?.dispatch("failed", {
        errorCode: "fetch_failed",
        errorMessage: "no pages reachable",
      });
    });
    expect(
      screen.getByText(/Couldn't reach that website\. Check the URL and try again\./),
    ).toBeInTheDocument();
    expect(onFailed).toHaveBeenCalled();
  });

  it("closes the EventSource on unmount", () => {
    const { unmount } = render(<ScanningStateCard jobId="job-5" />);
    const es = MockEventSource.lastInstance;
    expect(es?.readyState).toBe(MockEventSource.OPEN);
    unmount();
    expect(es?.readyState).toBe(MockEventSource.CLOSED);
  });

  it("re-opens against a new EventSource when jobId changes", () => {
    const { rerender } = render(<ScanningStateCard jobId="job-6a" />);
    const first = MockEventSource.lastInstance;
    expect(first?.url).toContain("jobId=job-6a");
    rerender(<ScanningStateCard jobId="job-6b" />);
    const second = MockEventSource.lastInstance;
    expect(second).not.toBe(first);
    expect(second?.url).toContain("jobId=job-6b");
    expect(first?.readyState).toBe(MockEventSource.CLOSED);
  });
});
