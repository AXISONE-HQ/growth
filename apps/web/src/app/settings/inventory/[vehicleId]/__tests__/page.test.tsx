/**
 * KAN-1219 Slice E — Vehicle detail page RTL coverage.
 *
 * 5 scenarios covering the detail page surface:
 *   1. Renders all vehicle fields (year/make/model/trim/VIN/mileage/price/colors/specs)
 *   2. PhotoCarousel: thumbnail click changes main photo
 *   3. PhotoCarousel: empty photoUrls renders "No photos available" placeholder
 *   4. Features section: humanized chip rendering from semantic tokens
 *   5. Archive button fires after window.confirm + toast success
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Mocks ────────────────────────────────────────────────────────────

const vehiclesGetMock = vi.fn();
const vehiclesArchiveMock = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    vehiclesApi: {
      list: vi.fn(),
      get: (id: string) => vehiclesGetMock(id),
      create: vi.fn(),
      update: vi.fn(),
      archive: (id: string) => vehiclesArchiveMock(id),
    },
  };
});

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings/inventory/veh-1",
  useParams: () => ({ vehicleId: "veh-1" }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => true);

import VehicleDetailPage from "../page";
import type { VehicleListItem } from "@/lib/api";

function fixtureVehicle(overrides: Partial<VehicleListItem> = {}): VehicleListItem {
  return {
    id: "veh-1",
    tenantId: "tenant-1",
    year: 2020,
    make: "Nissan",
    model: "Rogue",
    trim: "SV",
    vin: "5N1AT2MVXLC790807",
    mileage: 75_613,
    bodyStyle: "suv",
    transmission: "automatic",
    fuelType: "gas",
    drivetrain: "awd",
    condition: "used",
    exteriorColor: "Black",
    interiorColor: "Black",
    stockNumber: "790807",
    dealerLot: null,
    price: 17995,
    photoUrls: [
      "https://cdn.drivegood.com/photo-1.jpg",
      "https://cdn.drivegood.com/photo-2.jpg",
      "https://cdn.drivegood.com/photo-3.jpg",
    ],
    description: "Toute équipée. Vitres et miroirs électriques.",
    features: ["remote_start", "rear_camera", "leather_seats"],
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

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <VehicleDetailPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vehiclesGetMock.mockReset();
  vehiclesArchiveMock.mockReset();
  confirmSpy.mockClear();
  pushMock.mockClear();
});

describe("KAN-1219 Slice E — Vehicle detail page", () => {
  it("Scenario 1 — renders all vehicle fields", async () => {
    vehiclesGetMock.mockResolvedValue(fixtureVehicle());
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /2020 Nissan Rogue SV/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/5N1AT2MVXLC790807/i)).toBeInTheDocument();
    expect(screen.getByText(/Stock #790807/i)).toBeInTheDocument();
    expect(screen.getByText(/\$17,995/)).toBeInTheDocument();
    expect(screen.getByText(/75,613 mi/i)).toBeInTheDocument();
    // Spec cells.
    expect(screen.getByText("Suv")).toBeInTheDocument();
    expect(screen.getByText("Automatic")).toBeInTheDocument();
    expect(screen.getByText("Awd")).toBeInTheDocument();
  });

  it("Scenario 2 — carousel thumbnail click changes main photo", async () => {
    vehiclesGetMock.mockResolvedValue(fixtureVehicle());
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/1 \/ 3/i)).toBeInTheDocument(),
    );
    const thumb3 = screen.getByRole("button", { name: /View photo 3/i });
    await userEvent.click(thumb3);
    expect(screen.getByText(/3 \/ 3/i)).toBeInTheDocument();
  });

  it("Scenario 3 — empty photoUrls renders 'No photos available'", async () => {
    vehiclesGetMock.mockResolvedValue(fixtureVehicle({ photoUrls: [] }));
    renderPage();

    await waitFor(() =>
      expect(screen.getByText(/No photos available/i)).toBeInTheDocument(),
    );
  });

  it("Scenario 4 — features render as humanized chips", async () => {
    vehiclesGetMock.mockResolvedValue(fixtureVehicle());
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /Features/i })).toBeInTheDocument(),
    );
    const featuresHeading = screen.getByRole("heading", { name: /Features/i });
    const featuresCard = featuresHeading.closest("div[data-slot='card']") ?? featuresHeading.parentElement!.parentElement!;
    const featuresSection = within(featuresCard as HTMLElement);
    expect(featuresSection.getByText(/Remote start/i)).toBeInTheDocument();
    expect(featuresSection.getByText(/Rear camera/i)).toBeInTheDocument();
    expect(featuresSection.getByText(/Leather seats/i)).toBeInTheDocument();
  });

  it("Scenario 5 — Archive button fires after window.confirm + navigates back", async () => {
    vehiclesGetMock.mockResolvedValue(fixtureVehicle());
    vehiclesArchiveMock.mockResolvedValue(fixtureVehicle({ status: "archived" }));
    renderPage();

    const archiveBtn = await screen.findByRole("button", { name: /Archive vehicle/i });
    await userEvent.click(archiveBtn);
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(vehiclesArchiveMock).toHaveBeenCalledWith("veh-1"));
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
  });
});
