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
  it("list routes resolve to entity title (exact match)", () => {
    expect(resolveTitle("/companies")).toBe("Companies");
    expect(resolveTitle("/customers")).toBe("Customers");
    expect(resolveTitle("/opportunities")).toBe("Opportunities");
    expect(resolveTitle("/orders")).toBe("Orders");
  });

  it("detail routes resolve via prefix match (pre-3.5 fell through to Dashboard)", () => {
    expect(resolveTitle("/companies/abc-123")).toBe("Companies");
    expect(resolveTitle("/customers/u_42")).toBe("Customers");
    expect(resolveTitle("/opportunities/deal-77")).toBe("Opportunities");
    expect(resolveTitle("/orders/ord-9")).toBe("Orders");
  });

  it("new routes resolve via prefix match", () => {
    expect(resolveTitle("/companies/new")).toBe("Companies");
    expect(resolveTitle("/customers/new")).toBe("Customers");
    expect(resolveTitle("/opportunities/new")).toBe("Opportunities");
    expect(resolveTitle("/orders/new")).toBe("Orders");
  });

  it("edit routes resolve via prefix match (the previously-broken case)", () => {
    expect(resolveTitle("/companies/abc-123/edit")).toBe("Companies");
    expect(resolveTitle("/customers/u_42/edit")).toBe("Customers");
    expect(resolveTitle("/opportunities/deal-77/edit")).toBe("Opportunities");
    expect(resolveTitle("/orders/ord-9/edit")).toBe("Orders");
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
});
