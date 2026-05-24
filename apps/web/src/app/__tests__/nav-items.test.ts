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
// KAN-1000 — Campaigns rail entry is gated by NEXT_PUBLIC_CAMPAIGN_LAYER_DEMO
// at module-load time. To keep this test deterministic regardless of the
// runtime env, we filter the Campaigns entry out of the "target-8 baseline"
// view + assert its config separately below. With the flag OFF (prod
// default), Campaigns is hideFromRail anyway, so this filter is a no-op
// in CI; with the flag ON (Slice 1+2 internal preview), the filter
// preserves the founder-locked target-8 assertion.
const visibleProdRail = navItems
  .filter((item) => item.href !== "/campaigns")
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
  it("Exactly 5 D.2 movers carry hideFromRail:true (KAN-1000 — Campaigns excluded; conditional)", () => {
    // KAN-1000 adjustment — Campaigns also has hideFromRail (env-gated)
    // but it's a Slice 2 conditional, not a D.2 mover. Filter by href to
    // pin only the D.2 mover set.
    const hidden = navItems
      .filter((i) => i.hideFromRail)
      .filter((i) => i.href !== "/campaigns");
    expect(hidden.map((i) => i.label).sort()).toEqual(
      ["Account", "Audit Log", "Imports", "Knowledge Center", "Objectives"].sort(),
    );
  });

  it("Hidden movers retain their original hrefs (no route churn — D.3 wires via router-push)", () => {
    const hiddenByLabel = Object.fromEntries(
      navItems
        .filter((i) => i.hideFromRail)
        .filter((i) => i.href !== "/campaigns")
        .map((i) => [i.label, i.href]),
    );
    expect(hiddenByLabel["Objectives"]).toBe("/settings/objectives");
    expect(hiddenByLabel["Imports"]).toBe("/imports");
    expect(hiddenByLabel["Audit Log"]).toBe("/audit");
    expect(hiddenByLabel["Knowledge Center"]).toBe("/settings/knowledge");
    expect(hiddenByLabel["Account"]).toBe("/settings/account/identity");
  });
});

describe("KAN-1000 Slice 2 — Campaigns rail entry (env-gated)", () => {
  it("Campaigns entry exists in navItems with the founder-locked href + label + icon slot", () => {
    const campaigns = navItems.find((i) => i.href === "/campaigns");
    expect(campaigns).toBeDefined();
    expect(campaigns?.label).toBe("Campaigns");
    // hideFromRail is computed from NEXT_PUBLIC_CAMPAIGN_LAYER_DEMO at
    // module-load. Either boolean is acceptable; what matters is the
    // entry is present so direct nav + pageTitle resolution work
    // regardless of flag state.
    expect(typeof campaigns?.hideFromRail).toBe("boolean");
  });

  it("Campaigns slotted after Dashboard, before Pipelines (per founder lock)", () => {
    const dashIdx = navItems.findIndex((i) => i.href === "/dashboard");
    const campIdx = navItems.findIndex((i) => i.href === "/campaigns");
    const pipeIdx = navItems.findIndex((i) => i.href === "/pipelines");
    expect(dashIdx).toBeGreaterThanOrEqual(0);
    expect(campIdx).toBe(dashIdx + 1);
    expect(pipeIdx).toBe(campIdx + 1);
  });

  it("Pipelines NOT renamed (founder explicitly forbade renaming Pipelines)", () => {
    const pipelines = navItems.find((i) => i.href === "/pipelines");
    expect(pipelines?.label).toBe("Pipelines");
  });
});
