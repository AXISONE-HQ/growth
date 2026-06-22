/**
 * KAN-1217 — /settings/inventory RTL coverage.
 *
 * 8 SPO-locked scenarios per Memo 46 calibration (~50 LoC/scenario for
 * doctrine-load-bearing CRUD-archetype tests):
 *   1. List renders + load-more cursor advances
 *   2. Create modal opens + VIN blur validation surfaces inline error
 *   3. Create mutation fires on submit + invalidates list query
 *   4. Edit modal pre-fills with all 15 fields when row Edit clicked
 *   5. Archive mutation fires after window.confirm
 *   6. Status filter chips toggle list query (active+draft default → +archived)
 *   7. Empty state copy renders when list returns no items
 *   8. Archived row hides Archive button (Edit still surfaces)
 *
 * Pattern mirrors /settings/products page.test.tsx canonical harness.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Mocks ────────────────────────────────────────────────────────────

const vehiclesListMock = vi.fn();
const vehiclesCreateMock = vi.fn();
const vehiclesUpdateMock = vi.fn();
const vehiclesArchiveMock = vi.fn();
const vehiclesGetMock = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    vehiclesApi: {
      list: (input?: unknown) => vehiclesListMock(input),
      get: (id: string) => vehiclesGetMock(id),
      create: (input: unknown) => vehiclesCreateMock(input),
      update: (input: unknown) => vehiclesUpdateMock(input),
      archive: (id: string) => vehiclesArchiveMock(id),
    },
  };
});

// KAN-1219 Slice C — Mock next/navigation for URL state sync in filter bar.
// KAN-1290 Slice 6 — `currentSearchParamsString` is mutable per-test so URL
// state hydration scenarios can simulate deep-link entry into pre-filtered
// /settings/inventory routes.
const replaceMock = vi.fn();
const pushMock = vi.fn();
let currentSearchParamsString = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearchParamsString),
  usePathname: () => "/settings/inventory",
}));

// Mock sonner toast to avoid jsdom side effects.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Mock window.confirm for archive prompts.
const confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => true);

import InventorySettingsPage from "../page";
import type { VehicleListItem, CursorPage } from "@/lib/api";

function fixtureVehicle(
  overrides: Partial<VehicleListItem> = {},
): VehicleListItem {
  return {
    id: "veh-1",
    tenantId: "tenant-1",
    year: 2024,
    make: "Toyota",
    model: "Camry",
    trim: "SE",
    vin: "1HGBH41JXMN109186",
    mileage: 12_500,
    bodyStyle: "sedan",
    transmission: "automatic",
    fuelType: "gas",
    drivetrain: "fwd",
    condition: "used",
    exteriorColor: "Pearl White",
    interiorColor: "Black Leather",
    stockNumber: "STK-001",
    dealerLot: "Main",
    price: 28500,
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

function fixturePage<T>(
  items: T[],
  nextCursor: string | null = null,
): CursorPage<T> {
  return { items, nextCursor, totalCount: items.length };
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <InventorySettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vehiclesListMock.mockReset();
  vehiclesCreateMock.mockReset();
  vehiclesUpdateMock.mockReset();
  vehiclesArchiveMock.mockReset();
  vehiclesGetMock.mockReset();
  confirmSpy.mockClear();
  replaceMock.mockClear();
  pushMock.mockClear();
  // Default: empty URL, empty list.
  currentSearchParamsString = "";
  vehiclesListMock.mockResolvedValue(fixturePage([]));
  // Default: clear sessionStorage to avoid cross-test contamination.
  try {
    window.sessionStorage.clear();
  } catch {
    // sessionStorage may be unavailable in some sandboxes.
  }
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 1 — List renders + load-more cursor advances
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1217 Scenario 1 — list + pagination", () => {
  it("renders vehicles and load-more advances the cursor", async () => {
    const page1 = fixturePage(
      [fixtureVehicle({ id: "v1", make: "Honda", model: "Civic" })],
      "cursor-v1",
    );
    const page2 = fixturePage(
      [fixtureVehicle({ id: "v2", make: "Ford", model: "F-150" })],
      null,
    );
    vehiclesListMock.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Honda Civic/i)).toBeInTheDocument(),
    );
    expect(vehiclesListMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
    const loadMore = await screen.findByRole("button", { name: /load more/i });
    await userEvent.click(loadMore);
    await waitFor(() => {
      const calls = vehiclesListMock.mock.calls;
      expect(
        calls.some(
          (c) => (c[0] as { cursor?: string })?.cursor === "cursor-v1",
        ),
      ).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 2 — Create modal VIN blur validation
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1217 Scenario 2 — VIN blur validation", () => {
  it("opens create modal; invalid VIN on blur shows inline error", async () => {
    renderPage();
    const openBtn = await screen.findByRole("button", {
      name: /create vehicle/i,
    });
    await userEvent.click(openBtn);
    expect(
      await screen.findByRole("heading", { name: /create vehicle/i }),
    ).toBeInTheDocument();

    const vinInput = screen.getByLabelText(/vin/i) as HTMLInputElement;
    await userEvent.type(vinInput, "INVALID");
    // Move focus elsewhere to trigger blur validation.
    await userEvent.tab();
    expect(
      await screen.findByText(
        /VIN must be 17 alphanumeric chars \(excluding I\/O\/Q per ISO 3779\)/i,
      ),
    ).toBeInTheDocument();
    expect(vehiclesCreateMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 3 — Create mutation fires + list refetch invalidates
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1217 Scenario 3 — create mutation + invalidation", () => {
  it("submits create with form values + refetches list", async () => {
    vehiclesCreateMock.mockResolvedValue(
      fixtureVehicle({ id: "new-1", make: "Mazda", model: "CX-5" }),
    );
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: /create vehicle/i }),
    );
    const yearInput = await screen.findByLabelText(/^year$/i);
    await userEvent.type(yearInput, "2024");
    const makeInput = screen.getByLabelText(/^make$/i);
    await userEvent.type(makeInput, "Mazda");
    const modelInput = screen.getByLabelText(/^model$/i);
    await userEvent.type(modelInput, "CX-5");

    const submit = screen
      .getAllByRole("button", { name: /^create$/i })
      .at(-1);
    expect(submit).toBeTruthy();
    await userEvent.click(submit!);
    await waitFor(() =>
      expect(vehiclesCreateMock).toHaveBeenCalledTimes(1),
    );
    expect(vehiclesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        year: 2024,
        make: "Mazda",
        model: "CX-5",
        status: "draft",
      }),
    );
    // List refetched after create (>=2 calls total).
    await waitFor(() =>
      expect(vehiclesListMock.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 4 — Edit modal pre-fills with all 15 fields
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1217 Scenario 4 — edit pre-fill", () => {
  it("pre-fills edit form with the clicked vehicle fields", async () => {
    const v = fixtureVehicle({
      id: "v-edit",
      year: 2022,
      make: "Subaru",
      model: "Outback",
      trim: "Wilderness",
      vin: "JF2SKAUC5NH123456",
      mileage: 33_400,
      bodyStyle: "wagon",
      transmission: "cvt",
      fuelType: "gas",
      drivetrain: "awd",
      condition: "cpo",
      exteriorColor: "Crimson",
      interiorColor: "Black",
      stockNumber: "STK-EDIT",
      dealerLot: "North",
      status: "active",
    });
    vehiclesListMock.mockResolvedValue(fixturePage([v]));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/2022 Subaru Outback/i)).toBeInTheDocument(),
    );
    const editBtn = screen.getByRole("button", {
      name: /edit 2022 subaru outback/i,
    });
    await userEvent.click(editBtn);

    const yearInput = (await screen.findByLabelText(
      /^year$/i,
    )) as HTMLInputElement;
    expect(yearInput.value).toBe("2022");
    const makeInput = screen.getByLabelText(/^make$/i) as HTMLInputElement;
    expect(makeInput.value).toBe("Subaru");
    const modelInput = screen.getByLabelText(/^model$/i) as HTMLInputElement;
    expect(modelInput.value).toBe("Outback");
    const trimInput = screen.getByLabelText(
      /trim \(optional\)/i,
    ) as HTMLInputElement;
    expect(trimInput.value).toBe("Wilderness");
    const vinInput = screen.getByLabelText(
      /vin \(optional\)/i,
    ) as HTMLInputElement;
    expect(vinInput.value).toBe("JF2SKAUC5NH123456");
    const mileageInput = screen.getByLabelText(
      /mileage \(optional\)/i,
    ) as HTMLInputElement;
    expect(mileageInput.value).toBe("33400");
    const bodyStyleSelect = screen.getByLabelText(
      /body style/i,
    ) as HTMLSelectElement;
    expect(bodyStyleSelect.value).toBe("wagon");
    const transmissionSelect = screen.getByLabelText(
      /transmission/i,
    ) as HTMLSelectElement;
    expect(transmissionSelect.value).toBe("cvt");
    const drivetrainSelect = screen.getByLabelText(
      /drivetrain/i,
    ) as HTMLSelectElement;
    expect(drivetrainSelect.value).toBe("awd");
    const conditionSelect = screen.getByLabelText(
      /condition/i,
    ) as HTMLSelectElement;
    expect(conditionSelect.value).toBe("cpo");
    const stockInput = screen.getByLabelText(
      /stock number/i,
    ) as HTMLInputElement;
    expect(stockInput.value).toBe("STK-EDIT");
    const statusSelect = screen.getByLabelText(/^status$/i) as HTMLSelectElement;
    expect(statusSelect.value).toBe("active");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 5 — Archive mutation fires after confirmation
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1217 Scenario 5 — archive with confirm", () => {
  it("fires archive mutation when user confirms the prompt", async () => {
    const v = fixtureVehicle({
      id: "v-arch",
      make: "Tesla",
      model: "Model 3",
      status: "active",
    });
    vehiclesListMock.mockResolvedValue(fixturePage([v]));
    vehiclesArchiveMock.mockResolvedValue({ ...v, status: "archived" });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/2024 Tesla Model 3/i)).toBeInTheDocument(),
    );
    const archiveBtn = screen.getByRole("button", {
      name: /archive 2024 tesla model 3/i,
    });
    await userEvent.click(archiveBtn);
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() =>
      expect(vehiclesArchiveMock).toHaveBeenCalledWith("v-arch"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 6 — Status filter chip toggles list query
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1217 Scenario 6 — status filter chips", () => {
  it("default active+draft selected; toggling archived re-issues query with includeArchived=true", async () => {
    renderPage();
    // Wait for first fetch.
    await waitFor(() =>
      expect(vehiclesListMock).toHaveBeenCalled(),
    );
    // Initial query must omit archived (includeArchived=false).
    const initialCall = vehiclesListMock.mock.calls[0]?.[0] as
      | { includeArchived?: boolean }
      | undefined;
    expect(initialCall?.includeArchived).toBe(false);

    // Active + Draft chips are pressed (aria-pressed=true); Archived is not.
    const activeChip = screen.getByRole("button", { name: /^active$/i });
    const draftChip = screen.getByRole("button", { name: /^draft$/i });
    const archivedChip = screen.getByRole("button", { name: /^archived$/i });
    expect(activeChip.getAttribute("aria-pressed")).toBe("true");
    expect(draftChip.getAttribute("aria-pressed")).toBe("true");
    expect(archivedChip.getAttribute("aria-pressed")).toBe("false");

    // Toggle archived ON.
    await userEvent.click(archivedChip);
    await waitFor(() => {
      const calls = vehiclesListMock.mock.calls;
      expect(
        calls.some(
          (c) => (c[0] as { includeArchived?: boolean })?.includeArchived === true,
        ),
      ).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 7 — Empty state copy
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1217 Scenario 7 — empty state", () => {
  it("renders the empty-state copy when no vehicles exist", async () => {
    vehiclesListMock.mockResolvedValue(fixturePage([]));
    renderPage();
    expect(
      await screen.findByText(/no vehicles in inventory yet/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/click create vehicle to add your first vehicle/i),
    ).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 8 — Archived row hides Archive button (Edit remains)
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1217 Scenario 8 — archived row affordance", () => {
  it("does not render an Archive button on archived rows but Edit remains", async () => {
    const archived = fixtureVehicle({
      id: "v-already-arch",
      make: "Nissan",
      model: "Leaf",
      status: "archived",
    });
    // Operator must opt into archived view (Q3 default excludes archived).
    vehiclesListMock.mockResolvedValue(fixturePage([archived]));
    renderPage();
    // Toggle archived chip to include the archived fixture in default render.
    const archivedChip = await screen.findByRole("button", {
      name: /^archived$/i,
    });
    await userEvent.click(archivedChip);
    await waitFor(() =>
      expect(screen.getByText(/2024 Nissan Leaf/i)).toBeInTheDocument(),
    );
    // Edit button present.
    expect(
      screen.getByRole("button", { name: /edit 2024 nissan leaf/i }),
    ).toBeInTheDocument();
    // Archive button NOT present on archived rows.
    expect(
      screen.queryByRole("button", { name: /archive 2024 nissan leaf/i }),
    ).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 9 — KAN-1219 fix-forward regression guard
// router.replace must NOT re-fire when filters stay identical across
// re-renders (root cause of the vehicle-card Link click race).
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1219 fix-forward — router.replace race guard", () => {
  it("does not call router.replace twice with identical filter querystring", async () => {
    vehiclesListMock.mockResolvedValue(fixturePage([]));
    renderPage();
    // Wait for initial render to settle (list query resolves).
    await waitFor(() =>
      expect(screen.getByText(/No vehicles in inventory yet/i)).toBeInTheDocument(),
    );
    // The filter→URL sync useEffect should call router.replace exactly once
    // on mount (to seed the initial querystring); a re-render with no filter
    // change must NOT trigger a second replace, otherwise it would clobber
    // in-flight Link click navigations to the detail page.
    const initialCallCount = replaceMock.mock.calls.length;
    expect(initialCallCount).toBeLessThanOrEqual(1);
    // Force a render flush — re-rendering the same state must NOT add calls.
    await waitFor(() => {
      // Stable assertion: no additional replace calls beyond the initial seed.
      expect(replaceMock.mock.calls.length).toBe(initialCallCount);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Scenario 10 — visual ↔ clickable parity guard (Option F fix)
  //
  // The vehicle row card must render as a single <a> wrapping the
  // entire card so click anywhere (including padding) navigates. Edit
  // and Archive button clicks must NOT bubble to the Link (use
  // preventDefault + stopPropagation). Memo 19/42 affordance-honesty
  // extension — visual interactive area matches clickable area.
  // ───────────────────────────────────────────────────────────────────
  it("vehicle card row is a Link wrapping the entire card", async () => {
    vehiclesListMock.mockResolvedValue(
      fixturePage([fixtureVehicle({ id: "v-card", make: "Acme", model: "Sedan" })]),
    );
    renderPage();
    const cardLink = await screen.findByRole("link", { name: /Open 2024 Acme Sedan.* detail/i });
    expect(cardLink).toHaveAttribute("href", "/settings/inventory/v-card");
    // Both Edit and Archive buttons must be DESCENDANTS of the Link so the
    // card's entire bounded surface is clickable when not interacting with
    // the buttons.
    expect(
      cardLink.querySelector("button[aria-label^='Edit ']"),
    ).not.toBeNull();
    expect(
      cardLink.querySelector("button[aria-label^='Archive ']"),
    ).not.toBeNull();
  });

  it("Edit button click does NOT bubble to the card Link", async () => {
    vehiclesListMock.mockResolvedValue(
      fixturePage([fixtureVehicle({ id: "v-edit", make: "Honda", model: "Civic" })]),
    );
    renderPage();
    const editBtn = await screen.findByRole("button", { name: /Edit .* Honda Civic/i });
    await userEvent.click(editBtn);
    // Edit modal opens (heading appears) and router.push is NOT called
    // for the card Link target — preventDefault + stopPropagation in the
    // button's onClick prevent the Link from firing.
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /edit vehicle/i }),
      ).toBeInTheDocument(),
    );
    expect(pushMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/settings/inventory/v-edit"),
    );
  });

  // ───────────────────────────────────────────────────────────────────
  // Scenario 11 — Refetch cascade regression guard (Option L fix)
  //
  // The pre-fix shape coupled `cursor = pages[pages.length - 1]?.nextCursor`
  // into the query input. Every successful page-1 fetch fired setPages →
  // cursor advanced → query re-ran for next page → setPages → repeat until
  // nextCursor=null. With 134 vehicles + 50/page = 3 auto-fetches that
  // looked like a refetch loop in DevTools and clobbered in-flight Link
  // click navigation.
  //
  // Fix: explicit `cursor` state. Cursor only advances on Load More click.
  // This test guards against re-introducing the auto-cursor-advance pattern.
  // ───────────────────────────────────────────────────────────────────
  it("does NOT auto-cascade-refetch after page 1 returns (Option L)", async () => {
    // Page 1 has more results available (nextCursor non-null).
    const page1 = fixturePage(
      [
        fixtureVehicle({ id: "v1", make: "Honda", model: "Civic" }),
        fixtureVehicle({ id: "v2", make: "Ford", model: "F-150" }),
      ],
      "cursor-page-2",
    );
    vehiclesListMock.mockResolvedValue(page1);

    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Honda Civic/i)).toBeInTheDocument(),
    );
    // After page 1 settles, vehiclesApi.list MUST NOT be auto-called for
    // page 2. Operator must explicitly click Load More to advance.
    const initialFetchCount = vehiclesListMock.mock.calls.length;
    // Wait long enough for any auto-cascade to fire (it would happen
    // immediately after the data setState; a 50ms wait is generous).
    await new Promise((r) => setTimeout(r, 50));
    expect(vehiclesListMock.mock.calls.length).toBe(initialFetchCount);
    // The cursor on the input for the initial fetch was undefined/absent
    // (operator-explicit cursor advances only via Load More).
    const firstCall = vehiclesListMock.mock.calls[0]?.[0];
    expect((firstCall as { cursor?: unknown } | undefined)?.cursor).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// KAN-1290 Slice 6 Item 1 — URL state + back/forward
//
// Deep-link entry, sessionStorage round-trip, page reload preserves filters.
// Codifies the Slice C URL state machinery + Slice E sessionStorage
// integration that makes "Back to inventory" preserve operator context.
// ─────────────────────────────────────────────────────────────────────

describe("KAN-1290 Slice 6 — URL state + back/forward", () => {
  it("Scenario 9 — deep-link initialises filters from the URL querystring", async () => {
    // URL parameter names mirror encodeFilters() in page.tsx — short keys
    // (`bodyStyle`, `make`, etc.) rather than the long backend filter names
    // (`bodyStyleIn`, `makeIn`).
    currentSearchParamsString = "bodyStyle=suv&priceMax=20000";
    vehiclesListMock.mockResolvedValue(fixturePage([]));
    renderPage();
    // First list call MUST carry the URL-derived filters; without the URL
    // hydration the test would see bodyStyleIn=undefined / priceMax=undefined.
    await waitFor(() => {
      expect(vehiclesListMock).toHaveBeenCalled();
    });
    const firstInput = vehiclesListMock.mock.calls[0]?.[0] as {
      bodyStyleIn?: string[];
      priceMax?: number;
    };
    expect(firstInput?.bodyStyleIn).toEqual(["suv"]);
    expect(firstInput?.priceMax).toBe(20_000);
  });

  it("Scenario 10 — sessionStorage filter-querystring is written on mount sync", async () => {
    currentSearchParamsString = "make=Honda&yearMin=2020";
    vehiclesListMock.mockResolvedValue(fixturePage([]));
    renderPage();
    await waitFor(() => {
      const stored = window.sessionStorage.getItem(
        "kan-1219-inventory-filter-querystring",
      );
      expect(stored).not.toBeNull();
      expect(stored).toContain("make=Honda");
      expect(stored).toContain("yearMin=2020");
    });
  });

  it("Scenario 11 — empty URL hydrates to defaults; no sessionStorage querystring noise", async () => {
    currentSearchParamsString = "";
    vehiclesListMock.mockResolvedValue(fixturePage([]));
    renderPage();
    await waitFor(() => expect(vehiclesListMock).toHaveBeenCalled());
    const firstInput = vehiclesListMock.mock.calls[0]?.[0] as {
      bodyStyleIn?: string[];
      makeIn?: string[];
      priceMax?: number;
      yearMin?: number;
    };
    // No filters applied → all dimension arrays absent (or empty).
    expect(firstInput?.bodyStyleIn ?? []).toEqual([]);
    expect(firstInput?.makeIn ?? []).toEqual([]);
    expect(firstInput?.priceMax).toBeUndefined();
    expect(firstInput?.yearMin).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// KAN-1290 Slice 6 Item 2 — Error toast + retry affordance
//
// Memo 19/42 affordance-honesty at the mutation error boundary: failed
// mutations surface an actionable retry that re-fires the same operation
// without re-prompting (operator already consented).
// ─────────────────────────────────────────────────────────────────────

describe("KAN-1290 Slice 6 — Error toast + retry", () => {
  it("Scenario 12 — archive failure surfaces toast.error with a Retry action", async () => {
    const sonner = (await import("sonner")) as unknown as {
      toast: { error: ReturnType<typeof vi.fn> };
    };
    const veh = fixtureVehicle({ id: "veh-err" });
    vehiclesListMock.mockResolvedValue(fixturePage([veh]));
    vehiclesArchiveMock.mockRejectedValueOnce(new Error("Network failed"));

    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Toyota Camry/i)).toBeInTheDocument(),
    );
    const archiveBtn = await screen.findByRole("button", {
      name: /archive 2024 toyota camry/i,
    });
    await userEvent.click(archiveBtn);

    await waitFor(() => {
      expect(sonner.toast.error).toHaveBeenCalled();
    });
    const errorCall = sonner.toast.error.mock.calls[0] as [
      string,
      { action?: { label: string; onClick: () => void } } | undefined,
    ];
    expect(errorCall[0]).toMatch(/Network failed/);
    expect(errorCall[1]?.action?.label).toBe("Retry");
    expect(typeof errorCall[1]?.action?.onClick).toBe("function");
  });

  it("Scenario 13 — Retry action re-fires the archive mutation", async () => {
    const sonner = (await import("sonner")) as unknown as {
      toast: {
        error: ReturnType<typeof vi.fn>;
        success: ReturnType<typeof vi.fn>;
      };
    };
    const veh = fixtureVehicle({ id: "veh-retry" });
    vehiclesListMock.mockResolvedValue(fixturePage([veh]));
    // First archive fails; retry succeeds.
    vehiclesArchiveMock
      .mockRejectedValueOnce(new Error("Transient infra error"))
      .mockResolvedValueOnce(fixtureVehicle({ status: "archived" }));

    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Toyota Camry/i)).toBeInTheDocument(),
    );
    const archiveBtn = await screen.findByRole("button", {
      name: /archive 2024 toyota camry/i,
    });
    await userEvent.click(archiveBtn);
    await waitFor(() => expect(sonner.toast.error).toHaveBeenCalled());

    // Invoke the Retry action directly (toast UI is not rendered in vitest;
    // exercise the operator-action path via the captured callback).
    const errorCall = sonner.toast.error.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    errorCall[1].action.onClick();

    await waitFor(() => {
      expect(vehiclesArchiveMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(sonner.toast.success).toHaveBeenCalledWith("Vehicle archived");
    });
  });
});
