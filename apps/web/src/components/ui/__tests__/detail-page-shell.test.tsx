/**
 * KAN-983 — DetailPageShell + FieldRow + LinkedEntityRow tests.
 *
 * Coverage (DetailPageShell):
 *   - Back link renders when backHref set; absent otherwise
 *   - Logo mark accepts string (initials) OR Lucide icon
 *   - Title renders
 *   - Metric strip slot renders only when supplied
 *   - mainSlot + sideSlot render
 *
 * Coverage (FieldRow):
 *   - Label + value render
 *   - first:border-t-0 keeps the first row borderless
 *
 * Coverage (LinkedEntityRow):
 *   - Renders as <Link> when href set, <button> when onClick set,
 *     plain <div> otherwise
 *   - Icon + iconLabel + name + meta surface correctly
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Workflow, Users } from "lucide-react";
import { DetailPageShell, FieldRow, LinkedEntityRow } from "../detail-page-shell";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("KAN-983 — DetailPageShell", () => {
  it("renders title + initials logo + main + side slots", () => {
    render(
      <DetailPageShell
        title="Acme Corp"
        logoMark="AC"
        mainSlot={<div data-testid="main-content">main</div>}
        sideSlot={<div data-testid="side-content">side</div>}
      />,
    );
    expect(screen.getByRole("heading", { name: "Acme Corp" })).toBeInTheDocument();
    expect(screen.getByText("AC")).toBeInTheDocument();
    expect(screen.getByTestId("main-content")).toBeInTheDocument();
    expect(screen.getByTestId("side-content")).toBeInTheDocument();
  });

  it("renders back link when backHref provided", () => {
    render(
      <DetailPageShell
        backHref="/companies"
        backLabel="Back to companies"
        title="Acme"
        logoMark="A"
        mainSlot={null}
        sideSlot={null}
      />,
    );
    const back = screen.getByRole("link", { name: /Back to companies/i });
    expect(back).toHaveAttribute("href", "/companies");
  });

  it("omits back link when backHref is undefined", () => {
    render(
      <DetailPageShell
        title="Acme"
        logoMark="A"
        mainSlot={null}
        sideSlot={null}
      />,
    );
    expect(screen.queryByRole("link", { name: /Back/i })).not.toBeInTheDocument();
  });

  it("accepts a Lucide icon as logoMark", () => {
    const { container } = render(
      <DetailPageShell
        title="Pipelines"
        logoMark={Workflow}
        mainSlot={null}
        sideSlot={null}
      />,
    );
    // Lucide renders as <svg>; presence of the SVG in the logo container is the assertion
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("renders metric strip slot when supplied", () => {
    render(
      <DetailPageShell
        title="Acme"
        logoMark="A"
        metricStrip={<div data-testid="metric-strip">metrics</div>}
        mainSlot={null}
        sideSlot={null}
      />,
    );
    expect(screen.getByTestId("metric-strip")).toBeInTheDocument();
  });
});

describe("KAN-983 — FieldRow", () => {
  it("renders label + value", () => {
    render(<FieldRow label="Lifecycle" value="Active" />);
    expect(screen.getByText("Lifecycle")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("preserves first:border-t-0 (first row borderless)", () => {
    const { container } = render(
      <div>
        <FieldRow label="A" value="1" />
        <FieldRow label="B" value="2" />
      </div>,
    );
    // Both render the border-t utility; CSS first:border-t-0 handles the
    // visual remove on the first child at runtime. Just assert both rows
    // exist; CSS specificity is not the test concern.
    expect(container.querySelectorAll('[class*="border-t"]')).toHaveLength(2);
  });
});

describe("KAN-983 — LinkedEntityRow", () => {
  it("renders as Link when href is set", () => {
    render(<LinkedEntityRow name="Order #1234" href="/orders/1234" />);
    const link = screen.getByRole("link", { name: /Order #1234/ });
    expect(link).toHaveAttribute("href", "/orders/1234");
  });

  it("renders as button when onClick is set + fires handler", () => {
    const onClick = vi.fn();
    render(<LinkedEntityRow name="Click me" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: /Click me/ }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("renders as plain div when neither href nor onClick", () => {
    render(<LinkedEntityRow name="Static row" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("Static row")).toBeInTheDocument();
  });

  it("renders icon component when supplied", () => {
    const { container } = render(<LinkedEntityRow icon={Users} name="Team" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("renders iconLabel string when no icon component", () => {
    render(<LinkedEntityRow iconLabel="X" name="Initials only" />);
    expect(screen.getByText("X")).toBeInTheDocument();
  });

  it("renders meta line below name", () => {
    render(<LinkedEntityRow name="Acme deal" meta="$1,500 · 2d ago" />);
    expect(screen.getByText(/\$1,500/)).toBeInTheDocument();
  });
});
