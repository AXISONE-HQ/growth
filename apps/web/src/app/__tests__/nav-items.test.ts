/**
 * KAN-992 Phase D.2 — rail-order regression test.
 *
 * Pins the founder-locked IA reorg:
 *   - Top section = exactly 8 items in this order:
 *       Dashboard, Pipelines, Leads, Contacts, Companies, Orders,
 *       Escalations, Messages
 *   - Bottom-pinned = Settings (only)
 *   - hideFromRail items (5 movers — Objectives, Imports, Audit Log,
 *     Knowledge Center, Account) stay in the array (so findActiveHref +
 *     pageTitle still resolve them) but never render in the rail
 *   - No `/notifications` rail item (deferred — no backing surface)
 *
 * The test consumes the visible-rail filter chain used by AppShell:
 *   navItems.filter(!hideFromRail).filter(!demoOnly OR demoMode).filter(!adminOnly OR admin)
 *
 * We pin the non-demo, non-admin filtered output (the prod-default
 * surface) — the founder-locked target rail.
 */
import { describe, it, expect } from "vitest";
import { navItems } from "../layout";

// Reproduce the AppShell filter (skipping demoMode + adminOnly gating —
// the test assumes prod-default = no demo, non-admin user, which is the
// founder-locked baseline).
const visibleProdRail = navItems
  .filter((item) => !item.hideFromRail)
  .filter((item) => !item.demoOnly)
  .filter(
    (item) => !("adminOnly" in item && (item as { adminOnly?: boolean }).adminOnly),
  );

const topSection = visibleProdRail.filter((i) => !i.pinBottom);
const bottomSection = visibleProdRail.filter((i) => i.pinBottom);

describe("KAN-992 Phase D.2 — rail composition", () => {
  it("Top section is exactly the founder-locked target-8 in order", () => {
    expect(topSection.map((i) => i.label)).toEqual([
      "Dashboard",
      "Pipelines",
      "Leads",
      "Contacts",
      "Companies",
      "Orders",
      "Escalations",
      "Messages",
    ]);
  });

  it("Top section hrefs match the founder-locked routes (entity routes unchanged from D.1)", () => {
    expect(topSection.map((i) => i.href)).toEqual([
      "/dashboard",
      "/pipelines",
      "/opportunities", // Leads (entity Deal preserved)
      "/customers", //     Contacts (entity Contact preserved)
      "/companies",
      "/orders",
      "/escalations",
      "/conversations", // Messages (route preserved)
    ]);
  });

  it("Bottom-pinned section is exactly [Settings]", () => {
    expect(bottomSection.map((i) => i.label)).toEqual(["Settings"]);
    expect(bottomSection[0]!.href).toBe("/settings");
  });

  it("Total visible rail = top-8 + Settings bottom = 9 (no Notifications, no Recommendations)", () => {
    expect(visibleProdRail.length).toBe(9);
    expect(visibleProdRail.find((i) => i.label === "Notifications")).toBeUndefined();
    expect(visibleProdRail.find((i) => i.label === "Recommendations")).toBeUndefined();
  });

  it("Messages prod-visibility flip — `/conversations` is NOT demoOnly", () => {
    const messages = navItems.find((i) => i.href === "/conversations");
    expect(messages).toBeDefined();
    expect(messages?.label).toBe("Messages");
    expect(messages?.demoOnly).toBeFalsy();
  });
});

describe("KAN-992 Phase D.2 — hideFromRail movers (preserved for direct nav + D.3 Settings sub-tabs)", () => {
  it("Exactly 5 movers carry hideFromRail:true", () => {
    const hidden = navItems.filter((i) => i.hideFromRail);
    expect(hidden.map((i) => i.label).sort()).toEqual(
      ["Account", "Audit Log", "Imports", "Knowledge Center", "Objectives"].sort(),
    );
  });

  it("Hidden movers retain their original hrefs (no route churn — D.3 wires via router-push)", () => {
    const hiddenByLabel = Object.fromEntries(
      navItems.filter((i) => i.hideFromRail).map((i) => [i.label, i.href]),
    );
    expect(hiddenByLabel["Objectives"]).toBe("/settings/objectives");
    expect(hiddenByLabel["Imports"]).toBe("/imports");
    expect(hiddenByLabel["Audit Log"]).toBe("/audit");
    expect(hiddenByLabel["Knowledge Center"]).toBe("/settings/knowledge");
    expect(hiddenByLabel["Account"]).toBe("/settings/account/identity");
  });
});
