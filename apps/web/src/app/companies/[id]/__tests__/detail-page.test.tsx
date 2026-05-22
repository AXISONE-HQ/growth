/**
 * KAN-989 Phase C.5 — /companies/[id] CompanyDetailPage render tests.
 *
 * Light coverage focused on the shell convergence:
 *   - Title + StatusBadge surface in the header
 *   - Identity fields (Domain, Industry) render via FieldRow
 *   - Linked-entity sections render rows for contacts / deals / orders
 *   - Linked-entity rows carry correct href to /customers, /opportunities,
 *     /orders (no cross-link 404s)
 *   - Empty states preserve the original copy ("No linked contacts" etc.)
 *   - Not-found error path still surfaces "Back to Companies"
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CompanyDetailPage from "../page";

const getMock = vi.fn();

vi.mock("@/lib/api", () => ({
  companiesApi: {
    get: (...args: unknown[]) => getMock(...args),
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "co_1" }),
}));

beforeEach(() => {
  getMock.mockReset();
});

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const BASE_COMPANY = {
  id: "co_1",
  name: "Acme Corp",
  legalName: null,
  domain: "acme.com",
  website: "https://acme.com",
  industry: "SaaS",
  sizeRange: null,
  phone: null,
  email: null,
  annualRevenue: null,
  description: null,
  lifecycleStage: "customer",
  billingAddressLine1: null,
  billingAddressLine2: null,
  billingCity: null,
  billingRegion: null,
  billingPostalCode: null,
  billingCountry: null,
  mailingAddressLine1: null,
  mailingAddressLine2: null,
  mailingCity: null,
  mailingRegion: null,
  mailingPostalCode: null,
  mailingCountry: null,
  taxId: null,
  taxIdType: null,
  businessRegistrationNumber: null,
  incorporationJurisdiction: null,
  isTaxExempt: false,
  taxExemptionCertificate: null,
  contacts: [],
  deals: [],
  orders: [],
  _count: { contacts: 0, deals: 0, orders: 0 },
};

describe("KAN-989 — CompanyDetailPage (DetailPageShell convergence)", () => {
  it("renders title + lifecycle StatusBadge in the header", async () => {
    getMock.mockResolvedValue(BASE_COMPANY);
    wrap(<CompanyDetailPage />);
    await waitFor(() => {
      const h1 = screen.getByRole("heading", { level: 1, name: "Acme Corp" });
      expect(h1).toBeInTheDocument();
    });
    // StatusBadge surfaces the lifecycle value as visible text (e.g.,
    // "Customer"). We assert on the badge presence by looking for the
    // capitalized label which the StatusBadge renders.
    expect(screen.getByText(/customer/i)).toBeInTheDocument();
  });

  it("renders identity FieldRows: Domain, Industry", async () => {
    getMock.mockResolvedValue(BASE_COMPANY);
    wrap(<CompanyDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Domain")).toBeInTheDocument();
    });
    expect(screen.getByText("acme.com")).toBeInTheDocument();
    expect(screen.getByText("Industry")).toBeInTheDocument();
    expect(screen.getByText("SaaS")).toBeInTheDocument();
  });

  it("empty linked sections preserve original copy", async () => {
    getMock.mockResolvedValue(BASE_COMPANY);
    wrap(<CompanyDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("No linked contacts")).toBeInTheDocument();
    });
    expect(screen.getByText("No linked deals")).toBeInTheDocument();
    expect(screen.getByText("No linked orders")).toBeInTheDocument();
  });

  it("populated linked sections: LinkedEntityRow href points at correct [id] page", async () => {
    getMock.mockResolvedValue({
      ...BASE_COMPANY,
      contacts: [
        {
          id: "ct_1",
          firstName: "Alice",
          lastName: "Anderson",
          email: "alice@acme.com",
          lifecycleStage: "lead",
        },
      ],
      deals: [
        {
          id: "dl_1",
          name: "Acme — Q3 expansion",
          value: "5000",
          currency: "USD",
          status: "open",
        },
      ],
      orders: [
        {
          id: "or_1",
          orderNumber: "ORD-1234",
          grandTotal: "1200",
          currency: "USD",
          status: "paid",
        },
      ],
      _count: { contacts: 1, deals: 1, orders: 1 },
    });
    wrap(<CompanyDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Alice Anderson")).toBeInTheDocument();
    });
    // Cross-link hrefs — each entity must navigate to its own [id] page,
    // never back to /companies/co_1.
    const contactLink = screen.getByText("Alice Anderson").closest("a");
    expect(contactLink).toHaveAttribute("href", "/customers/ct_1");

    const dealLink = screen.getByText("Acme — Q3 expansion").closest("a");
    expect(dealLink).toHaveAttribute("href", "/opportunities/dl_1");

    const orderLink = screen.getByText("ORD-1234").closest("a");
    expect(orderLink).toHaveAttribute("href", "/orders/or_1");
  });

  it("Not-found error path: 'Back to Companies' link present", async () => {
    getMock.mockRejectedValue(new Error("Company not found"));
    wrap(<CompanyDetailPage />);
    await waitFor(() => {
      expect(screen.getAllByText("Company not found").length).toBeGreaterThan(0);
    });
    const back = screen.getByText(/Back to Companies/).closest("a");
    expect(back).toHaveAttribute("href", "/companies");
  });

  it("Edit affordance: link points to /companies/[id]/edit", async () => {
    getMock.mockResolvedValue(BASE_COMPANY);
    wrap(<CompanyDetailPage />);
    await waitFor(() => {
      expect(screen.getByText("Edit")).toBeInTheDocument();
    });
    const editLink = screen.getByText("Edit").closest("a");
    expect(editLink).toHaveAttribute("href", "/companies/co_1/edit");
  });
});
