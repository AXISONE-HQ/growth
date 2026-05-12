/**
 * KAN-887 — /customers/[id] ContactDetailPage smoke tests.
 *
 * Component-level coverage:
 *   - Identity card renders name + lifecycle badge + Contact ID
 *   - Customer card SKIPS when customer relation is null
 *   - Customer card RENDERS when present (mrr / ltv / status)
 *   - Linked Deals: empty state copy when none, table when present
 *   - Raw data block renders externalIds even when empty
 *   - Company link rendered when company relation populated
 *
 * Page-level routing + tRPC integration deferred to KAN-885 (page-test
 * infra cohort).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ContactDetailPage from "../[id]/page";

const getByIdMock = vi.fn();
const routerPushMock = vi.fn();

vi.mock("@/lib/api", () => ({
  contactsApi: {
    getById: (...args: unknown[]) => getByIdMock(...args),
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "ct_1" }),
  useRouter: () => ({ push: routerPushMock }),
}));

beforeEach(() => {
  getByIdMock.mockReset();
  routerPushMock.mockReset();
});

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const BASE_CONTACT = {
  id: "ct_1",
  email: "alice@example.com",
  phone: null,
  firstName: "Alice",
  lastName: "Anderson",
  segment: "smb",
  lifecycleStage: "lead",
  source: "email_inbox",
  dataQualityScore: 75,
  companyId: null,
  companyName: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  region: null,
  postalCode: null,
  country: null,
  company: null,
  externalIds: {},
  customFields: {},
  deletedAt: null,
  customer: null,
  deals: [],
  engagements: [],
  outcomes: [],
  decisions: [],
  escalations: [],
  createdAt: "2026-05-01T10:00:00Z",
  updatedAt: "2026-05-01T10:00:00Z",
};

describe("KAN-887 — ContactDetailPage", () => {
  it("renders identity card — name + Contact ID + email link", async () => {
    getByIdMock.mockResolvedValue(BASE_CONTACT);
    wrap(<ContactDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Alice Anderson")).toBeInTheDocument();
    });
    expect(screen.getByText(/Contact ID: ct_1/)).toBeInTheDocument();
    const emailLink = screen.getByText("alice@example.com").closest("a");
    expect(emailLink).toHaveAttribute("href", "mailto:alice@example.com");
  });

  it("SKIPS customer card when contact.customer is null", async () => {
    getByIdMock.mockResolvedValue(BASE_CONTACT);
    wrap(<ContactDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Alice Anderson")).toBeInTheDocument();
    });
    expect(screen.queryByText("Customer status")).not.toBeInTheDocument();
  });

  it("RENDERS customer card when contact.customer is present", async () => {
    getByIdMock.mockResolvedValue({
      ...BASE_CONTACT,
      customer: {
        mrr: 250,
        ltv: 3000,
        healthScore: 82,
        status: "active",
        since: "2025-12-01T00:00:00Z",
        plan: "growth",
      },
    });
    wrap(<ContactDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Customer status")).toBeInTheDocument();
    });
    expect(screen.getByText("$250.00")).toBeInTheDocument();
    expect(screen.getByText("$3,000.00")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("Linked deals: empty-state copy when contact has no deals", async () => {
    getByIdMock.mockResolvedValue(BASE_CONTACT);
    wrap(<ContactDetailPage />);
    await waitFor(() => {
      expect(screen.getByText(/Linked deals/)).toBeInTheDocument();
    });
    expect(screen.getByText("No linked deals")).toBeInTheDocument();
  });

  it("Linked deals: row renders when contact has deals", async () => {
    getByIdMock.mockResolvedValue({
      ...BASE_CONTACT,
      deals: [
        {
          id: "dl_1",
          name: "Acme expansion",
          status: "open",
          value: "5000",
          currency: "USD",
          expectedCloseDate: null,
        },
      ],
    });
    wrap(<ContactDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Acme expansion")).toBeInTheDocument();
    });
    expect(screen.getByText("$5,000.00")).toBeInTheDocument();
  });

  it("Company card: renders link to /companies/[id] when company is populated", async () => {
    getByIdMock.mockResolvedValue({
      ...BASE_CONTACT,
      companyId: "co_1",
      companyName: "Acme",
      company: { id: "co_1", name: "Acme Inc", domain: "acme.com" },
    });
    wrap(<ContactDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Acme Inc")).toBeInTheDocument();
    });
    const link = screen.getByText("Acme Inc").closest("a");
    expect(link).toHaveAttribute("href", "/companies/co_1");
    expect(screen.getByText("acme.com")).toBeInTheDocument();
  });

  it("Raw data: renders externalIds block even when empty {}", async () => {
    getByIdMock.mockResolvedValue(BASE_CONTACT);
    const { container } = wrap(<ContactDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Raw data")).toBeInTheDocument();
    });
    expect(screen.getByText("externalIds")).toBeInTheDocument();
    expect(screen.getByText("customFields")).toBeInTheDocument();
    // Confirm a <pre> block with the empty-object JSON is present.
    const pres = container.querySelectorAll("pre");
    const hasEmptyObj = Array.from(pres).some((p) => p.textContent?.trim() === "{}");
    expect(hasEmptyObj).toBe(true);
  });

  it("Not-found: renders error card when route throws 'not found'", async () => {
    getByIdMock.mockRejectedValue(new Error("Contact not found"));
    wrap(<ContactDetailPage />);
    // Title h2 + muted error message both render "Contact not found", so
    // use getAllByText. Confirm the h2 specifically renders the heading.
    await waitFor(() => {
      expect(screen.getAllByText("Contact not found").length).toBeGreaterThan(0);
    });
    const heading = screen.getAllByText("Contact not found").find(
      (el) => el.tagName === "H2",
    );
    expect(heading).toBeTruthy();
    const back = screen.getByText(/Back to Customers/).closest("a");
    expect(back).toHaveAttribute("href", "/customers");
  });
});
