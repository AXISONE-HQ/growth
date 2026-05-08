/**
 * MetricStrip tests — DS v1 alignment cohort.
 *
 * Covers the spec Part 3 §8 contract:
 *   - cells render label + value + optional delta
 *   - tabular-nums applied to numeric values
 *   - humanizeBytes formats correctly across B / KB / MB / GB ranges
 *   - relativeTime formatter integration
 *   - empty/zero data handled gracefully
 *   - skeleton loading state matches final shape
 *   - foundation token coverage (zero hex)
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MetricStrip, humanizeBytes } from "../metric-strip";
import { relativeTime } from "@/lib/relative-time";

describe("MetricStrip — DS v1 alignment cohort", () => {
  it("Test 1 — renders cells from metrics prop with correct labels + values", () => {
    render(
      <MetricStrip
        metrics={[
          { label: "Total sources", value: 5 },
          { label: "Chunks indexed", value: 142 },
          { label: "Storage used", value: "2.3 MB" },
          { label: "Last source added", value: "5 min ago" },
        ]}
      />,
    );
    expect(screen.getByText("Total sources")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("Chunks indexed")).toBeInTheDocument();
    expect(screen.getByText("142")).toBeInTheDocument();
    expect(screen.getByText("Storage used")).toBeInTheDocument();
    expect(screen.getByText("2.3 MB")).toBeInTheDocument();
    expect(screen.getByText("Last source added")).toBeInTheDocument();
    expect(screen.getByText("5 min ago")).toBeInTheDocument();

    // role=list with 4 listitems
    const list = screen.getByRole("list", { name: "Knowledge center metrics" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
  });

  it("Test 2 — tabular-nums applied to every value cell", () => {
    render(
      <MetricStrip
        metrics={[
          { label: "A", value: 1 },
          { label: "B", value: 2 },
        ]}
      />,
    );
    // Each value div carries the .tabular-nums class
    const a = screen.getByText("1");
    const b = screen.getByText("2");
    expect(a).toHaveClass("tabular-nums");
    expect(b).toHaveClass("tabular-nums");
  });

  it("Test 3 — humanizeBytes formats correctly across B / KB / MB / GB ranges", () => {
    expect(humanizeBytes(0)).toBe("0 B");
    expect(humanizeBytes(512)).toBe("512 B");
    expect(humanizeBytes(1024)).toBe("1.0 KB");
    expect(humanizeBytes(1536)).toBe("1.5 KB");
    expect(humanizeBytes(1024 * 1024)).toBe("1.0 MB");
    expect(humanizeBytes(1024 * 1024 * 2.3)).toBe("2.3 MB");
    expect(humanizeBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    // Defensive — negative + non-finite
    expect(humanizeBytes(-1)).toBe("0 B");
    expect(humanizeBytes(NaN)).toBe("0 B");
  });

  it("Test 4 — relativeTime formatter integration with MetricStrip", () => {
    const now = new Date("2026-05-07T12:00:00Z");
    expect(relativeTime(new Date("2026-05-07T11:55:00Z"), now)).toBe("5 min ago");
    expect(relativeTime(new Date("2026-05-07T11:59:30Z"), now)).toBe("just now");
    expect(relativeTime(new Date("2026-05-07T08:00:00Z"), now)).toBe("4h ago");
    expect(relativeTime(new Date("2026-05-05T12:00:00Z"), now)).toBe("2d ago");
    // Render integration — relativeTime output flows into a MetricStrip cell
    render(
      <MetricStrip metrics={[{ label: "Last source added", value: relativeTime(new Date("2026-05-07T11:55:00Z"), now) }]} />,
    );
    expect(screen.getByText("5 min ago")).toBeInTheDocument();
  });

  it("Test 5 — empty/zero data renders \"0\" not \"—\" (per spec Part 5: numbers wherever possible)", () => {
    render(
      <MetricStrip
        metrics={[
          { label: "Total sources", value: 0 },
          { label: "Storage used", value: humanizeBytes(0) },
        ]}
      />,
    );
    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.getByText("0 B")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
    expect(screen.queryByText("N/A")).not.toBeInTheDocument();
  });

  it("Test 6 — loading state renders skeleton cells matching final shape", () => {
    const { rerender } = render(
      <MetricStrip
        metrics={[
          { label: "A", value: 1 },
          { label: "B", value: 2 },
          { label: "C", value: 3 },
          { label: "D", value: 4 },
        ]}
        loading
      />,
    );
    // 4 cells render with aria-label="Loading metric"
    expect(screen.getAllByLabelText("Loading metric")).toHaveLength(4);
    // No actual values shown
    expect(screen.queryByText("1")).not.toBeInTheDocument();
    expect(screen.queryByText("A")).not.toBeInTheDocument();

    // After loading=false, real cells render
    rerender(
      <MetricStrip
        metrics={[
          { label: "A", value: 1 },
          { label: "B", value: 2 },
          { label: "C", value: 3 },
          { label: "D", value: 4 },
        ]}
      />,
    );
    expect(screen.queryByLabelText("Loading metric")).not.toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("Test 7 — delta arrow direction + token coverage (no hex in inline styles)", () => {
    const { container } = render(
      <MetricStrip
        metrics={[
          { label: "Up", value: 10, delta: 5 },
          { label: "Down", value: 3, delta: -8 },
          { label: "Flat", value: 0, delta: 0 },
        ]}
      />,
    );
    expect(screen.getByText(/↑\s+5%/)).toBeInTheDocument();
    expect(screen.getByText(/↓\s+8%/)).toBeInTheDocument();
    expect(screen.getByText(/·\s+0%/)).toBeInTheDocument();

    // No hardcoded hex values in inline styles — every color comes from --ds-* tokens
    const html = container.innerHTML;
    // strict: zero `#XXXXXX` patterns inside the rendered DOM (excluding any
    // accidental aria-* attributes — there are none here)
    const hexMatches = html.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(hexMatches, `Hardcoded hex colors leaked: ${hexMatches.join(", ")}`).toEqual([]);
  });
});
