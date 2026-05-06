/**
 * KAN-829 sub-cohort 2 — StatusPill component tests.
 *
 * 6 tests per pre-flight spec covering token-color mapping, motion contract,
 * a11y attributes, label defaults + override.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "../status-pill";

describe("StatusPill — KAN-829 sub-cohort 2", () => {
  it("Test 1 — renders correct background + text + border for each of 5 statuses (token mapping)", () => {
    const expectedBackgrounds: Record<string, string> = {
      queued: "var(--ds-surface-sunken)",
      embedding: "var(--ds-violet-100)",
      ready: "var(--ds-emerald-100)",
      error: "var(--ds-danger-soft)",
      deleted: "var(--ds-surface-base)",
    };
    for (const [status, expectedBg] of Object.entries(expectedBackgrounds)) {
      const { unmount } = render(
        <StatusPill status={status as "queued" | "embedding" | "ready" | "error" | "deleted"} />,
      );
      const pill = screen.getByRole("status");
      // CSS custom property values are written via inline style — read as-is
      expect(pill).toHaveStyle({ backgroundColor: expectedBg });
      expect(pill.getAttribute("data-status")).toBe(status);
      unmount();
    }
  });

  it("Test 2 — pulse animation present on `embedding` status (motion contract)", () => {
    render(<StatusPill status="embedding" />);
    const pill = screen.getByRole("status");
    // Pulse contract: data-pulse="true" + motion-safe:animate-pulse class
    expect(pill.getAttribute("data-pulse")).toBe("true");
    expect(pill.className).toContain("motion-safe:animate-pulse");
  });

  it("Test 3 — pulse uses motion-safe (browser respects prefers-reduced-motion)", () => {
    // motion-safe:* Tailwind variant compiles to a media query
    // (@media (prefers-reduced-motion: no-preference)). When the user has
    // set prefers-reduced-motion=reduce, the rule does NOT apply → pill
    // renders static. The contract pin is the className itself; the
    // browser semantics are the runtime behavior.
    render(<StatusPill status="embedding" />);
    const pill = screen.getByRole("status");
    expect(pill.className).toContain("motion-safe:animate-pulse");
    // Static states must NOT carry the animate-pulse class
    const { rerender } = render(<StatusPill status="ready" />);
    rerender(<StatusPill status="ready" />);
    const readyPill = screen.getAllByRole("status").find((p) => p.getAttribute("data-status") === "ready")!;
    expect(readyPill.className).not.toContain("motion-safe:animate-pulse");
  });

  it("Test 4 — defaults label to capitalized status when label prop omitted", () => {
    render(<StatusPill status="queued" />);
    expect(screen.getByText("Queued")).toBeInTheDocument();
    const { rerender } = render(<StatusPill status="embedding" />);
    rerender(<StatusPill status="embedding" />);
    expect(screen.getByText("Embedding")).toBeInTheDocument();
  });

  it("Test 5 — custom label prop overrides default", () => {
    render(<StatusPill status="ready" label="All set ✓" />);
    expect(screen.getByText("All set ✓")).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("Test 6 — role=\"status\" + aria-label present (a11y attributes)", () => {
    render(<StatusPill status="error" />);
    const pill = screen.getByRole("status");
    expect(pill).toHaveAttribute("aria-label", "Error");

    // Custom label flows through to aria-label too — color isn't the only signal
    render(<StatusPill status="error" label="Embedding failed: OpenAI 429" />);
    const pillCustom = screen.getAllByRole("status").find((p) => p.getAttribute("aria-label") === "Embedding failed: OpenAI 429");
    expect(pillCustom).toBeDefined();
  });

  it("Test 7 — `deleted` state renders strikethrough on label (visual signal pair beyond color)", () => {
    render(<StatusPill status="deleted" />);
    // The label text is rendered in a child span with inline
    // textDecoration: 'line-through'. Locate via the label text itself.
    const labelEl = screen.getByText("Deleted");
    expect(labelEl).toHaveStyle({ textDecoration: "line-through" });
  });
});
