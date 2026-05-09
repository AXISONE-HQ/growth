/**
 * KAN-857 — ServiceAreaPicker unit tests.
 *
 * Covers conditional sub-input rendering per area type + Decision B
 * radius validation (positive integer ≤10000 km).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

import { ServiceAreaPicker } from "../service-area-picker";

const NOOP_PROPS = {
  onTypeChange: () => undefined,
  onRadiusChange: () => undefined,
  onRegionsChange: () => undefined,
};

describe("ServiceAreaPicker — conditional sub-inputs", () => {
  it("Local → renders radius input only", () => {
    render(
      <ServiceAreaPicker
        type="local"
        radiusKm={null}
        regions={[]}
        {...NOOP_PROPS}
      />,
    );
    expect(screen.getByLabelText("Radius (km)")).toBeInTheDocument();
    expect(screen.queryAllByText("United States")).toHaveLength(0);
  });

  it("Regional → renders region grid grouped by country (US + CA)", () => {
    render(
      <ServiceAreaPicker
        type="regional"
        radiusKm={null}
        regions={[]}
        {...NOOP_PROPS}
      />,
    );
    // Each country label appears twice — once in <legend class="sr-only">
    // (a11y) and once in the visible <span> heading. Assert ≥1 of each.
    expect(screen.getAllByText("United States").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Canada").length).toBeGreaterThanOrEqual(1);
    // Decision 4: ISO 3166-2 codes — Florida = US-FL
    expect(screen.getByLabelText("Florida")).toBeInTheDocument();
    expect(screen.getByLabelText("Ontario")).toBeInTheDocument();
    // Empty placeholder per Fred's brief
    expect(screen.getByText("Pick the regions you serve.")).toBeInTheDocument();
  });

  it("Regional with selections → empty placeholder hidden", () => {
    render(
      <ServiceAreaPicker
        type="regional"
        radiusKm={null}
        regions={["US-FL"]}
        {...NOOP_PROPS}
      />,
    );
    expect(screen.queryByText("Pick the regions you serve.")).not.toBeInTheDocument();
  });

  it("National / International → no sub-inputs", () => {
    const { rerender } = render(
      <ServiceAreaPicker
        type="national"
        radiusKm={null}
        regions={[]}
        {...NOOP_PROPS}
      />,
    );
    expect(screen.queryByLabelText("Radius (km)")).not.toBeInTheDocument();
    expect(screen.queryAllByText("United States")).toHaveLength(0);

    rerender(
      <ServiceAreaPicker
        type="international"
        radiusKm={null}
        regions={[]}
        {...NOOP_PROPS}
      />,
    );
    expect(screen.queryByLabelText("Radius (km)")).not.toBeInTheDocument();
    expect(screen.queryAllByText("United States")).toHaveLength(0);
  });
});

describe("ServiceAreaPicker — Decision B (radius validation)", () => {
  it("rejects negative radius with inline error", () => {
    const onRadiusChange = vi.fn();
    render(
      <ServiceAreaPicker
        type="local"
        radiusKm={null}
        regions={[]}
        onTypeChange={vi.fn()}
        onRadiusChange={onRadiusChange}
        onRegionsChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Radius (km)"), { target: { value: "-5" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/positive whole number/);
    expect(onRadiusChange).not.toHaveBeenCalled();
  });

  it("rejects non-integer radius (e.g., 50.5)", () => {
    const onRadiusChange = vi.fn();
    render(
      <ServiceAreaPicker
        type="local"
        radiusKm={null}
        regions={[]}
        onTypeChange={vi.fn()}
        onRadiusChange={onRadiusChange}
        onRegionsChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Radius (km)"), { target: { value: "50.5" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(onRadiusChange).not.toHaveBeenCalled();
  });

  it("rejects radius >10000 km", () => {
    const onRadiusChange = vi.fn();
    render(
      <ServiceAreaPicker
        type="local"
        radiusKm={null}
        regions={[]}
        onTypeChange={vi.fn()}
        onRadiusChange={onRadiusChange}
        onRegionsChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Radius (km)"), { target: { value: "10001" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/10,000 km or less/);
    expect(onRadiusChange).not.toHaveBeenCalled();
  });

  it("accepts a valid radius and calls onRadiusChange with the integer", () => {
    const onRadiusChange = vi.fn();
    render(
      <ServiceAreaPicker
        type="local"
        radiusKm={null}
        regions={[]}
        onTypeChange={vi.fn()}
        onRadiusChange={onRadiusChange}
        onRegionsChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Radius (km)"), { target: { value: "50" } });
    expect(onRadiusChange).toHaveBeenCalledWith(50);
  });

  it("clearing the input passes null upstream", () => {
    const onRadiusChange = vi.fn();
    render(
      <ServiceAreaPicker
        type="local"
        radiusKm={50}
        regions={[]}
        onTypeChange={vi.fn()}
        onRadiusChange={onRadiusChange}
        onRegionsChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Radius (km)"), { target: { value: "" } });
    expect(onRadiusChange).toHaveBeenCalledWith(null);
  });
});

describe("ServiceAreaPicker — region toggle", () => {
  it("toggling a region adds/removes it from the codes array", async () => {
    const onRegionsChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ServiceAreaPicker
        type="regional"
        radiusKm={null}
        regions={[]}
        onTypeChange={vi.fn()}
        onRadiusChange={vi.fn()}
        onRegionsChange={onRegionsChange}
      />,
    );
    await user.click(screen.getByLabelText("Florida"));
    expect(onRegionsChange).toHaveBeenLastCalledWith(["US-FL"]);
  });
});
