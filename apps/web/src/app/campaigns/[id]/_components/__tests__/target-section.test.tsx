/**
 * KAN-1229 — TargetSection RTL coverage. Destination-view section showing the
 * committed vehicle target (descriptor summary + ACTUAL committed VINs).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CampaignTargetVehicle } from "@/lib/api";

const getByIdsMock = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    vehiclesApi: { ...actual.vehiclesApi, getByIds: (ids: string[]) => getByIdsMock(ids) },
  };
});

import { TargetSection } from "../TargetSection";

function vehicle(o: Partial<CampaignTargetVehicle> & { id: string }): CampaignTargetVehicle {
  return {
    year: 2016, make: "Volvo", model: "S60", trim: "T5 Premier", vin: "YV1A22M",
    price: 9995, condition: "used", status: "active", removedAt: null, ...o,
  };
}

function renderSection(props: Parameters<typeof TargetSection>[0]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TargetSection {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => getByIdsMock.mockReset());

describe("KAN-1229 — TargetSection", () => {
  it("product mode → renders nothing (existing display unchanged)", () => {
    const { container } = renderSection({
      targetEntityType: "product",
      targetEntityIds: ["p-1"],
      proposedPlan: null,
    });
    expect(container).toBeEmptyDOMElement();
    expect(getByIdsMock).not.toHaveBeenCalled();
  });

  it("vehicle target → descriptor summary + actual committed vehicles", async () => {
    getByIdsMock.mockResolvedValue({
      entities: [
        vehicle({ id: "v-1", year: 2016, make: "Volvo", model: "S60", vin: "VIN-AAA" }),
        vehicle({ id: "v-2", year: 2016, make: "Kia", model: "Soul EV+", vin: "VIN-BBB", price: 7450 }),
      ],
    });
    renderSection({
      targetEntityType: "vehicle",
      targetEntityIds: ["v-1", "v-2"],
      proposedPlan: { vehicleTargetDescriptor: { condition: "used", maxCount: 10 } },
    });
    // descriptor summary uses the ACTUAL committed count (2) + condition
    expect(screen.getByText(/2 vehicles · condition: used/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/2016 Volvo S60/)).toBeInTheDocument());
    expect(screen.getByText(/VIN-AAA/)).toBeInTheDocument();
    expect(screen.getByText(/2016 Kia Soul EV\+/)).toBeInTheDocument();
    expect(getByIdsMock).toHaveBeenCalledWith(["v-1", "v-2"]);
  });

  it("> 5 vehicles → collapses with View all affordance", async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `v-${i}`);
    getByIdsMock.mockResolvedValue({
      entities: ids.map((id, i) => vehicle({ id, model: `Model${i}` })),
    });
    renderSection({
      targetEntityType: "vehicle",
      targetEntityIds: ids,
      proposedPlan: { vehicleTargetDescriptor: { condition: "used" } },
    });
    await waitFor(() => expect(screen.getByText(/Model0/)).toBeInTheDocument());
    // only first 5 shown
    expect(screen.queryByText(/Model5/)).toBeNull();
    const viewAll = screen.getByRole("button", { name: /View all 7/i });
    await userEvent.click(viewAll);
    expect(screen.getByText(/Model5/)).toBeInTheDocument();
    expect(screen.getByText(/Model6/)).toBeInTheDocument();
  });

  it("removed vehicle → amber Removed badge (Memo 19/42)", async () => {
    getByIdsMock.mockResolvedValue({
      entities: [vehicle({ id: "v-1", removedAt: "2026-06-22T00:00:00Z" })],
    });
    renderSection({
      targetEntityType: "vehicle",
      targetEntityIds: ["v-1"],
      proposedPlan: { vehicleTargetDescriptor: { condition: "used" } },
    });
    await waitFor(() => expect(screen.getByText(/^Removed$/)).toBeInTheDocument());
  });
});
