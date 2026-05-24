/**
 * KAN-cohort-3.5 — Page-heading longest-prefix-match regression.
 *
 * Pre-3.5: `pageTitle` was an exact-pathname map; routes like
 * `/companies/[id]/edit` fell through to "Dashboard". 3.5 switched to
 * longest-prefix matching (mirrors findActiveHref).
 *
 * This test pins:
 *   - exact-pathname match still works for list routes
 *   - detail/new/edit routes resolve to the entity title (the fix)
 *   - nested `/settings/account/identity` beats the broader `/settings`
 *   - unknown routes still fall back to "Dashboard"
 */
import { describe, it, expect } from "vitest";
import { resolveTitle } from "../layout";

describe("KAN-cohort-3.5 — resolveTitle (longest-prefix match)", () => {
  // KAN-991 Phase D.1 — display labels renamed Opportunities→Leads,
  // Customers→Contacts. Routes (/opportunities, /customers) stay; only
  // the pageTitle map values change. resolveTitle returns the display
  // title now.
  it("list routes resolve to entity title (exact match)", () => {
    expect(resolveTitle("/companies")).toBe("Companies");
    expect(resolveTitle("/customers")).toBe("Contacts");
    expect(resolveTitle("/opportunities")).toBe("Leads");
    expect(resolveTitle("/orders")).toBe("Orders");
  });

  it("detail routes resolve via prefix match (pre-3.5 fell through to Dashboard)", () => {
    expect(resolveTitle("/companies/abc-123")).toBe("Companies");
    expect(resolveTitle("/customers/u_42")).toBe("Contacts");
    expect(resolveTitle("/opportunities/deal-77")).toBe("Leads");
    expect(resolveTitle("/orders/ord-9")).toBe("Orders");
  });

  it("new routes resolve via prefix match", () => {
    expect(resolveTitle("/companies/new")).toBe("Companies");
    expect(resolveTitle("/customers/new")).toBe("Contacts");
    expect(resolveTitle("/opportunities/new")).toBe("Leads");
    expect(resolveTitle("/orders/new")).toBe("Orders");
  });

  it("edit routes resolve via prefix match (the previously-broken case)", () => {
    expect(resolveTitle("/companies/abc-123/edit")).toBe("Companies");
    expect(resolveTitle("/customers/u_42/edit")).toBe("Contacts");
    expect(resolveTitle("/opportunities/deal-77/edit")).toBe("Leads");
    expect(resolveTitle("/orders/ord-9/edit")).toBe("Orders");
  });

  it("KAN-991 Phase D.1 — /conversations resolves to 'Messages'", () => {
    expect(resolveTitle("/conversations")).toBe("Messages");
  });

  it("KAN-1000 Slice 2 — /campaigns resolves to 'Campaigns'", () => {
    expect(resolveTitle("/campaigns")).toBe("Campaigns");
  });

  it("longest match wins — /settings/account/identity beats /settings", () => {
    expect(resolveTitle("/settings/account/identity")).toBe("Account");
    expect(resolveTitle("/settings")).toBe("Settings");
    expect(resolveTitle("/settings/foo")).toBe("Settings");
  });

  it("/settings/knowledge beats /settings (longest match)", () => {
    expect(resolveTitle("/settings/knowledge")).toBe("Knowledge Center");
    expect(resolveTitle("/settings/knowledge/foo")).toBe("Knowledge Center");
  });

  it("unknown routes fall back to Dashboard", () => {
    expect(resolveTitle("/totally-not-a-route")).toBe("Dashboard");
    expect(resolveTitle("/")).toBe("Dashboard");
  });

  it("prefix collision safety — /companies does NOT match /companies-news (no trailing slash)", () => {
    // Ensures the `startsWith(prefix + '/')` guard works.
    expect(resolveTitle("/companies-archive")).toBe("Dashboard");
  });

  // KAN-992 Phase D.2 — hideFromRail invariant. The 5 movers (Objectives /
  // Imports / Audit Log / Knowledge Center / Account) stay in navItems
  // with hideFromRail:true so direct navigation to their routes still
  // resolves a sensible page title (and findActiveHref still resolves
  // them for the rail-active-state logic, which renders nothing for
  // hidden items but doesn't crash). This test pins that contract.
  it("KAN-992 D.2 — hidden-from-rail routes still resolve their page title (direct nav)", () => {
    expect(resolveTitle("/settings/objectives")).toBe("Objectives");
    expect(resolveTitle("/imports")).toBe("Data Imports");
    expect(resolveTitle("/imports/abc-123")).toBe("Data Imports");
    expect(resolveTitle("/audit")).toBe("Audit Log");
    expect(resolveTitle("/settings/knowledge")).toBe("Knowledge Center");
    expect(resolveTitle("/settings/account/identity")).toBe("Account");
    expect(resolveTitle("/settings/account/contact")).toBe("Account");
  });
});
