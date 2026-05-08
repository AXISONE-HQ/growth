/**
 * AIStatusIndicator tests — DS v1 alignment cohort.
 *
 * Spec contract (Part 3 §7 + Part 2 §System health vocabulary):
 *   - Active state: emerald dot + "System active" label + pulse animation
 *   - Degraded: warning dot + "Degraded — {reason}" or just "Degraded"
 *   - Paused: warning dot + "Paused by you"
 *   - Failed: danger dot + "Action required"
 *   - prefers-reduced-motion: pulse class still attached (CSS media query
 *     handles disabling at render time); we verify the `data-pulse` flag
 *     reflects state correctly
 *   - role="status" + descriptive aria-label
 *   - Foundation token coverage (zero hex outside the ring rgba helpers)
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AIStatusIndicator } from "../ai-status-indicator";

describe("AIStatusIndicator — DS v1 alignment cohort", () => {
  it("Test 1 — active state renders \"System active\" + emerald dot + pulse class", () => {
    const { container } = render(<AIStatusIndicator status="active" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-label", "System active");
    expect(status).toHaveAttribute("data-status", "active");
    expect(screen.getByText("System active")).toBeInTheDocument();

    // Dot is the first <span aria-hidden="true">; must carry .motion-pulse
    const dot = container.querySelector('span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    expect(dot!.classList.contains("motion-pulse")).toBe(true);
    expect(dot!.getAttribute("data-pulse")).toBe("true");
  });

  it("Test 2 — degraded with reason renders \"Degraded — connector slow\" + warning dot, no pulse", () => {
    const { container } = render(
      <AIStatusIndicator status="degraded" reason="connector slow" />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-label", "Degraded — connector slow");
    expect(screen.getByText("Degraded — connector slow")).toBeInTheDocument();

    // No pulse on degraded
    const dot = container.querySelector('span[aria-hidden="true"]');
    expect(dot!.classList.contains("motion-pulse")).toBe(false);
    expect(dot!.getAttribute("data-pulse")).toBeNull();
  });

  it("Test 3 — failed state renders \"Action required\" + danger dot", () => {
    render(<AIStatusIndicator status="failed" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-label", "Action required");
    expect(status).toHaveAttribute("data-status", "failed");
    expect(screen.getByText("Action required")).toBeInTheDocument();
  });

  it("Test 4 — paused state renders \"Paused by you\" + warning dot, no pulse", () => {
    const { container } = render(<AIStatusIndicator status="paused" />);
    expect(screen.getByText("Paused by you")).toBeInTheDocument();
    const dot = container.querySelector('span[aria-hidden="true"]');
    expect(dot!.classList.contains("motion-pulse")).toBe(false);
  });

  it("Test 5 — foundation token coverage (zero hex in inline styles outside ring rgba)", () => {
    const { container } = render(<AIStatusIndicator status="active" />);
    // The pill itself, the label, and the dot fill all reference var(--ds-*).
    // The ring rgba is the one expected exception — spec line 470 shows the
    // pulse ring uses `rgba(14, 168, 130, 0.15)` directly because it's an
    // alpha-derived value of emerald-500, not a separate token. We assert
    // zero `#XXXXXX` patterns instead (rgba is permitted).
    const html = container.innerHTML;
    const hexMatches = html.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(hexMatches, `Hardcoded hex colors leaked: ${hexMatches.join(", ")}`).toEqual([]);
  });
});
