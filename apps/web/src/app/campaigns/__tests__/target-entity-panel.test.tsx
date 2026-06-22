/**
 * KAN-1219 Slice G2 — TargetEntityPanel RTL coverage.
 *
 * 6 scenarios covering the operator-facing surface:
 *
 *   1. Product mode renders ProductTargetCard for each entity
 *   2. Vehicle mode renders VehicleTargetCard for each entity
 *   3. Toggling a card updates selection + notifies parent
 *   4. "Select all matching" + counts behaviour
 *   5. Empty state copy when result set is empty
 *   6. Removed vehicles show amber Removed badge (Slice F1 lifecycle)
 *
 * Built against dark G1 substrate — panel is not yet wired into the
 * BuilderChatThread (G3 lands that). Tests render the panel standalone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Mocks ────────────────────────────────────────────────────────────

const productsSearchMock = vi.fn();
const vehiclesSearchMock = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    productsApi: {
      ...actual.productsApi,
      searchForCampaignTarget: (input: unknown) => productsSearchMock(input),
    },
    vehiclesApi: {
      ...actual.vehiclesApi,
      searchForCampaignTarget: (input: unknown) => vehiclesSearchMock(input),
    },
  };
});

import { TargetEntityPanel } from "../_components/TargetEntityPanel";
import type { ProductListItem, VehicleListItem } from "@/lib/api";

function fixtureProduct(overrides: Partial<ProductListItem> = {}): ProductListItem {
  return {
    id: "prod-1",
    tenantId: "tenant-1",
    name: "Growth Platform Pro",
    description: null,
    status: "active",
    price: 199,
    currency: "USD",
    externalUrl: null,
    primaryImageUrl: null,
    customFields: null,
    archivedAt: null,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

function fixtureVehicle(overrides: Partial<VehicleListItem> = {}): VehicleListItem {
  return {
    id: "veh-1",
    tenantId: "tenant-1",
    year: 2023,
    make: "Toyota",
    model: "Camry",
    trim: "SE",
    vin: "1HGCM82633A123456",
    mileage: 18_500,
    bodyStyle: "sedan",
    transmission: "automatic",
    fuelType: "gas",
    drivetrain: "fwd",
    condition: "used",
    exteriorColor: "Black",
    interiorColor: "Black",
    stockNumber: "STK-001",
    dealerLot: null,
    price: 24_995,
    photoUrls: [],
    description: null,
    features: [],
    status: "active",
    archivedAt: null,
    firstSeenAt: "2026-06-01T00:00:00Z",
    lastSeenAt: "2026-06-15T00:00:00Z",
    removedAt: null,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-15T00:00:00Z",
    ...overrides,
  };
}

function renderPanel(props: Parameters<typeof TargetEntityPanel>[0]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <TargetEntityPanel {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  productsSearchMock.mockReset();
  vehiclesSearchMock.mockReset();
});

describe("KAN-1219 Slice G2 — TargetEntityPanel", () => {
  it("Scenario 1 — Product mode renders ProductTargetCard for each entity", async () => {
    productsSearchMock.mockResolvedValue({
      entities: [
        fixtureProduct({ id: "p-1", name: "Growth Pro" }),
        fixtureProduct({ id: "p-2", name: "Growth Starter", price: 49 }),
      ],
      totalCount: 2,
      filterSpec: {},
    });
    renderPanel({ entityType: "product" });
    await waitFor(() => {
      expect(screen.getByText("Growth Pro")).toBeInTheDocument();
      expect(screen.getByText("Growth Starter")).toBeInTheDocument();
    });
    expect(screen.getByText(/Selected: 0 \/ matching: 2/i)).toBeInTheDocument();
  });

  it("Scenario 2 — Vehicle mode renders VehicleTargetCard for each entity", async () => {
    vehiclesSearchMock.mockResolvedValue({
      entities: [
        fixtureVehicle({ id: "v-1" }),
        fixtureVehicle({
          id: "v-2",
          year: 2024,
          make: "Honda",
          model: "Accord",
        }),
      ],
      totalCount: 2,
      filterSpec: {},
    });
    renderPanel({ entityType: "vehicle" });
    await waitFor(() => {
      expect(screen.getByText(/2023 Toyota Camry SE/i)).toBeInTheDocument();
      expect(screen.getByText(/2024 Honda Accord SE/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Selected: 0 \/ matching: 2/i)).toBeInTheDocument();
  });

  it("Scenario 3 — Toggling a card updates selection + notifies parent", async () => {
    productsSearchMock.mockResolvedValue({
      entities: [fixtureProduct({ id: "p-1", name: "Pick Me" })],
      totalCount: 1,
      filterSpec: {},
    });
    const onSelection = vi.fn();
    renderPanel({ entityType: "product", onSelectionChange: onSelection });
    const card = await screen.findByRole("button", { name: /Select Pick Me/i });
    await userEvent.click(card);
    await waitFor(() => {
      expect(onSelection).toHaveBeenLastCalledWith(["p-1"]);
    });
    expect(screen.getByText(/Selected: 1 \/ matching: 1/i)).toBeInTheDocument();
  });

  it("Scenario 4 — Select all matching + clear", async () => {
    productsSearchMock.mockResolvedValue({
      entities: [
        fixtureProduct({ id: "p-1", name: "A" }),
        fixtureProduct({ id: "p-2", name: "B" }),
        fixtureProduct({ id: "p-3", name: "C" }),
      ],
      totalCount: 3,
      filterSpec: {},
    });
    const onSelection = vi.fn();
    renderPanel({ entityType: "product", onSelectionChange: onSelection });
    const selectAllBtn = await screen.findByRole("button", {
      name: /Select all matching/i,
    });
    await userEvent.click(selectAllBtn);
    await waitFor(() => {
      expect(onSelection).toHaveBeenLastCalledWith(["p-1", "p-2", "p-3"]);
    });
    expect(screen.getByText(/Selected: 3 \/ matching: 3/i)).toBeInTheDocument();
    // Toggle to clear.
    const clearBtn = screen.getByRole("button", { name: /^Clear/i });
    await userEvent.click(clearBtn);
    await waitFor(() => {
      expect(onSelection).toHaveBeenLastCalledWith([]);
    });
  });

  it("Scenario 5 — Empty state copy when result set is empty", async () => {
    vehiclesSearchMock.mockResolvedValue({
      entities: [],
      totalCount: 0,
      filterSpec: {},
    });
    renderPanel({ entityType: "vehicle" });
    await waitFor(() => {
      expect(
        screen.getByText(/No vehicles match the current filters/i),
      ).toBeInTheDocument();
    });
  });

  it("Scenario 6 — Removed vehicle shows amber Removed badge", async () => {
    vehiclesSearchMock.mockResolvedValue({
      entities: [
        fixtureVehicle({
          id: "v-removed",
          removedAt: "2026-06-22T13:00:00Z",
        }),
      ],
      totalCount: 1,
      filterSpec: {},
    });
    renderPanel({ entityType: "vehicle" });
    await waitFor(() => {
      expect(screen.getByText(/^Removed$/)).toBeInTheDocument();
    });
  });
});
