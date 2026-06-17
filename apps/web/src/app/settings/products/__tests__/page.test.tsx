/**
 * KAN-1218 — /settings/products RTL coverage.
 *
 * 8 SPO-locked scenarios per Memo 46 calibration (~50 LoC/scenario for
 * doctrine-load-bearing CRUD-archetype tests):
 *   1. List renders + load-more cursor advances
 *   2. Create modal opens + form validation (empty name -> error)
 *   3. Create mutation fires on submit + invalidates list query
 *   4. Edit modal pre-fills with product fields when row Edit clicked
 *   5. Archive mutation fires after confirmation
 *   6. Variant expansion toggle reveals nested variant table
 *   7. Category dropdown lists parents + create category modal submits
 *   8. Empty state renders when query returns empty array
 *
 * Pattern follows /campaigns/__tests__/list-view.test.tsx canonical RTL +
 * QueryClient wrapper.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// ── Mocks ────────────────────────────────────────────────────────────

const productsListMock = vi.fn();
const productsCreateMock = vi.fn();
const productsUpdateMock = vi.fn();
const productsArchiveMock = vi.fn();
const variantsListMock = vi.fn();
const variantsCreateMock = vi.fn();
const categoriesListMock = vi.fn();
const categoriesCreateMock = vi.fn();
const categoriesUpdateMock = vi.fn();
const categoriesArchiveMock = vi.fn();
const marketingDomainGetMock = vi.fn();
const marketingDomainSetMock = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    productsApi: {
      list: (input?: unknown) => productsListMock(input),
      create: (input: unknown) => productsCreateMock(input),
      update: (input: unknown) => productsUpdateMock(input),
      archive: (id: string) => productsArchiveMock(id),
    },
    productVariantsApi: {
      list: (input: unknown) => variantsListMock(input),
      create: (input: unknown) => variantsCreateMock(input),
      update: (input: unknown) => productsUpdateMock(input),
    },
    productCategoriesApi: {
      list: (input?: unknown) => categoriesListMock(input),
      create: (input: unknown) => categoriesCreateMock(input),
      update: (input: unknown) => categoriesUpdateMock(input),
      archive: (id: string) => categoriesArchiveMock(id),
    },
    marketingDomainApi: {
      get: () => marketingDomainGetMock(),
      set: (domain: string) => marketingDomainSetMock(domain),
    },
  };
});

// Mock sonner toast to avoid jsdom side effects.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// Mock window.confirm for archive prompts.
const confirmSpy = vi.spyOn(window, "confirm").mockImplementation(() => true);

import ProductsSettingsPage from "../page";
import type {
  ProductListItem,
  ProductVariantListItem,
  ProductCategoryListItem,
  CursorPage,
} from "@/lib/api";

function fixtureProduct(overrides: Partial<ProductListItem> = {}): ProductListItem {
  return {
    id: "prod-1",
    tenantId: "tenant-1",
    name: "Growth Suite Pro",
    description: "Flagship SaaS plan",
    status: "active",
    price: 299,
    currency: "USD",
    externalUrl: null,
    primaryImageUrl: null,
    customFields: null,
    archivedAt: null,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-15T00:00:00Z",
    ...overrides,
  };
}

function fixturePage<T>(items: T[], nextCursor: string | null = null): CursorPage<T> {
  return { items, nextCursor, totalCount: items.length };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProductsSettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  productsListMock.mockReset();
  productsCreateMock.mockReset();
  productsUpdateMock.mockReset();
  productsArchiveMock.mockReset();
  variantsListMock.mockReset();
  variantsCreateMock.mockReset();
  categoriesListMock.mockReset();
  categoriesCreateMock.mockReset();
  categoriesUpdateMock.mockReset();
  categoriesArchiveMock.mockReset();
  marketingDomainGetMock.mockReset();
  marketingDomainSetMock.mockReset();
  confirmSpy.mockClear();

  // Defaults — marketing domain configured (banner suppressed); empty lists.
  marketingDomainGetMock.mockResolvedValue({ marketingDomain: "example.com" });
  productsListMock.mockResolvedValue(fixturePage([]));
  variantsListMock.mockResolvedValue(fixturePage([]));
  categoriesListMock.mockResolvedValue(fixturePage([]));
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 1 — List renders + load-more cursor advances
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1218 Scenario 1 — list + pagination", () => {
  it("renders products and load-more advances the cursor", async () => {
    const page1 = fixturePage([fixtureProduct({ id: "p1", name: "Alpha" })], "cursor-p1");
    const page2 = fixturePage([fixtureProduct({ id: "p2", name: "Beta" })], null);
    productsListMock.mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    renderPage();
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    expect(productsListMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
    // First page has nextCursor — Load more button surfaces.
    const loadMore = await screen.findByRole("button", { name: /load more/i });
    await userEvent.click(loadMore);
    await waitFor(() => {
      // Second call must include cursor=cursor-p1.
      const calls = productsListMock.mock.calls;
      expect(calls.some((c) => (c[0] as { cursor?: string })?.cursor === "cursor-p1")).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 2 — Create modal opens + form validation
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1218 Scenario 2 — create modal validation", () => {
  it("opens create modal and rejects empty name with error message", async () => {
    productsListMock.mockResolvedValue(fixturePage([]));
    renderPage();
    const createBtn = await screen.findByRole("button", { name: /create product/i });
    await userEvent.click(createBtn);
    // Modal title visible.
    expect(await screen.findByRole("heading", { name: /create product/i })).toBeInTheDocument();
    // Submit without name -> name error.
    const submit = screen.getAllByRole("button", { name: /create/i }).at(-1)!;
    await userEvent.click(submit);
    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
    expect(productsCreateMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 3 — Create mutation fires + list refetch invalidates
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1218 Scenario 3 — create mutation + invalidation", () => {
  it("submits create with form values + refetches list", async () => {
    productsListMock.mockResolvedValue(fixturePage([]));
    productsCreateMock.mockResolvedValue(fixtureProduct({ id: "new-1", name: "Gamma" }));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /create product/i }));
    const nameInput = await screen.findByLabelText(/name/i);
    await userEvent.type(nameInput, "Gamma");
    const priceInput = screen.getByLabelText(/^price$/i);
    await userEvent.type(priceInput, "49.99");
    const submit = screen.getAllByRole("button", { name: /create/i }).at(-1)!;
    await userEvent.click(submit);
    await waitFor(() => expect(productsCreateMock).toHaveBeenCalledTimes(1));
    expect(productsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Gamma", price: 49.99 }),
    );
    // List query refetched after create — at least 2 calls total.
    await waitFor(() => expect(productsListMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 4 — Edit modal pre-fills with product fields
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1218 Scenario 4 — edit pre-fill", () => {
  it("pre-fills edit form with the clicked product fields", async () => {
    const p = fixtureProduct({ id: "p1", name: "Delta", description: "Delta desc", price: 199 });
    productsListMock.mockResolvedValue(fixturePage([p]));
    renderPage();
    await waitFor(() => expect(screen.getByText("Delta")).toBeInTheDocument());
    const editBtn = screen.getByRole("button", { name: /edit delta/i });
    await userEvent.click(editBtn);
    const nameInput = (await screen.findByLabelText(/name/i)) as HTMLInputElement;
    expect(nameInput.value).toBe("Delta");
    const descTextarea = screen.getByLabelText(/description/i) as HTMLTextAreaElement;
    expect(descTextarea.value).toBe("Delta desc");
    const priceInput = screen.getByLabelText(/^price$/i) as HTMLInputElement;
    expect(priceInput.value).toBe("199");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 5 — Archive mutation fires after confirmation
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1218 Scenario 5 — archive with confirm", () => {
  it("fires archive mutation when user confirms the prompt", async () => {
    const p = fixtureProduct({ id: "p-arch", name: "Epsilon", status: "active" });
    productsListMock.mockResolvedValue(fixturePage([p]));
    productsArchiveMock.mockResolvedValue({ ...p, status: "archived" });
    renderPage();
    await waitFor(() => expect(screen.getByText("Epsilon")).toBeInTheDocument());
    const archiveBtn = screen.getByRole("button", { name: /archive epsilon/i });
    await userEvent.click(archiveBtn);
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(productsArchiveMock).toHaveBeenCalledWith("p-arch"));
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 6 — Variant expansion reveals nested variant table
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1218 Scenario 6 — variant inline expansion", () => {
  it("expands a row and lists variants from productVariantsApi.list", async () => {
    const p = fixtureProduct({ id: "p-var", name: "Zeta" });
    const v: ProductVariantListItem = {
      id: "v-1",
      tenantId: "tenant-1",
      productId: "p-var",
      attributes: { size: "M" },
      price: 25,
      effectivePrice: 25,
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
      product: { id: "p-var", price: 299 },
    };
    productsListMock.mockResolvedValue(fixturePage([p]));
    variantsListMock.mockResolvedValue(fixturePage([v]));
    renderPage();
    await waitFor(() => expect(screen.getByText("Zeta")).toBeInTheDocument());
    // Row toggle is the button wrapping the chevron + name.
    const toggle = screen.getByRole("button", { name: /Zeta/i });
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(variantsListMock).toHaveBeenCalledWith(
        expect.objectContaining({ productId: "p-var" }),
      ),
    );
    await screen.findByRole("button", { name: /add variant/i });
    // Effective-price column rendered.
    expect(await screen.findByText(/Effective/i)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 7 — Category dropdown + create category submit
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1218 Scenario 7 — category dropdown + create", () => {
  it("lists existing categories in parent dropdown and submits create", async () => {
    const c1: ProductCategoryListItem = {
      id: "cat-1",
      tenantId: "tenant-1",
      name: "Apparel",
      description: null,
      parentId: null,
      status: "active",
      archivedAt: null,
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
    };
    categoriesListMock.mockResolvedValue(fixturePage([c1]));
    categoriesCreateMock.mockResolvedValue({ ...c1, id: "cat-2", name: "Shirts", parentId: "cat-1" });
    renderPage();
    // Switch to Categories tab.
    await userEvent.click(screen.getByRole("button", { name: /^categories$/i }));
    await waitFor(() => expect(screen.getByText("Apparel")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /create category/i }));
    const nameInput = await screen.findByLabelText(/name/i);
    await userEvent.type(nameInput, "Shirts");
    const parentSelect = screen.getByLabelText(/parent/i) as HTMLSelectElement;
    // Existing category appears as an option.
    expect(within(parentSelect).getByRole("option", { name: "Apparel" })).toBeInTheDocument();
    await userEvent.selectOptions(parentSelect, "cat-1");
    const submit = screen.getAllByRole("button", { name: /create/i }).at(-1)!;
    await userEvent.click(submit);
    await waitFor(() => expect(categoriesCreateMock).toHaveBeenCalledTimes(1));
    expect(categoriesCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Shirts", parentId: "cat-1" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Scenario 8 — Empty state when query returns empty array
// ─────────────────────────────────────────────────────────────────────
describe("KAN-1218 Scenario 8 — empty state", () => {
  it("renders the empty-state copy when no products exist", async () => {
    productsListMock.mockResolvedValue(fixturePage([]));
    renderPage();
    expect(await screen.findByText(/no products yet/i)).toBeInTheDocument();
    expect(screen.getByText(/click create to add your first product/i)).toBeInTheDocument();
  });
});
