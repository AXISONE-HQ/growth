/**
 * KAN-884 — EmptyState primitive tests.
 *
 * Coverage:
 *   - Renders icon + heading + body
 *   - Optional action slot is hidden when not provided
 *   - Action slot renders when supplied (e.g. a "Create" CTA)
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Building2 } from "lucide-react";
import { EmptyState } from "../empty-state";

describe("KAN-884 — EmptyState", () => {
  it("renders icon + heading + body", () => {
    render(
      <EmptyState
        icon={Building2}
        heading="No companies yet"
        body="Companies will appear here once ingestion is wired up."
      />,
    );
    expect(screen.getByText("No companies yet")).toBeInTheDocument();
    expect(screen.getByText(/ingestion is wired up/i)).toBeInTheDocument();
  });

  it("omits action slot when no action prop is provided", () => {
    const { container } = render(
      <EmptyState icon={Building2} heading="No data" body="Nothing here." />,
    );
    // No <button> or <a> should appear in the body
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });

  it("renders action slot when provided", () => {
    render(
      <EmptyState
        icon={Building2}
        heading="No data"
        body="Nothing here."
        action={<button type="button">Create one</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Create one" })).toBeInTheDocument();
  });
});
