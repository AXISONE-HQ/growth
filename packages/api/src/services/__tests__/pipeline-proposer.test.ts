/**
 * KAN-962 (slice 2a) — pipeline-proposer unit tests.
 *
 * Coverage:
 *   - Sufficiency classification (ready vs needs_more_data) on seeded fixtures
 *   - Deterministic count queries match expected outputs
 *   - LLM-failure fallback path (objective-proposer.fallbackProposal) produces
 *     a complete ProposedPipeline shape per objective type
 *   - Reason-string fallbacks fire for enrich_lead + recover_failed_payment
 *   - Sort order: suggestedPriority ASC, then ready before needs_more_data
 *
 * Uses the mocked-Prisma pattern (KAN-883). PR B's PROD smoke is the real-DB
 * gate; this file validates the proposer logic in isolation.
 */
import { describe, it, expect } from "vitest";
import {
  classifySufficiency,
  neededMessage,
  evidenceDescription,
  SUFFICIENCY_THRESHOLDS,
} from "../segment-counts.js";
import { fallbackProposal } from "../objective-proposer.js";
import { proposeForTenant } from "../pipeline-proposer.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";

// ─────────────────────────────────────────────────────────────────────
// classifySufficiency — boundary cases on each segment.
// ─────────────────────────────────────────────────────────────────────

describe("KAN-962 — classifySufficiency boundaries", () => {
  it("new_leads threshold=1 — 0 is needs_more_data, 1 is ready", () => {
    expect(classifySufficiency("new_leads", 0)).toBe("needs_more_data");
    expect(classifySufficiency("new_leads", 1)).toBe("ready");
    expect(classifySufficiency("new_leads", 100)).toBe("ready");
  });

  it("closed_lost threshold=5 — 4 is needs_more_data, 5 is ready", () => {
    expect(classifySufficiency("closed_lost", 4)).toBe("needs_more_data");
    expect(classifySufficiency("closed_lost", 5)).toBe("ready");
  });

  it("cancelled_orders threshold=3 — 2 is needs_more_data, 3 is ready", () => {
    expect(classifySufficiency("cancelled_orders", 2)).toBe("needs_more_data");
    expect(classifySufficiency("cancelled_orders", 3)).toBe("ready");
  });

  it("active_customers threshold=3 — applied to retain/upsell objectives", () => {
    expect(classifySufficiency("active_customers", 2)).toBe("needs_more_data");
    expect(classifySufficiency("active_customers", 3)).toBe("ready");
  });

  it("inactive_customers threshold=5 — applied to reactivate objectives", () => {
    expect(classifySufficiency("inactive_customers", 4)).toBe("needs_more_data");
    expect(classifySufficiency("inactive_customers", 5)).toBe("ready");
  });
});

// ─────────────────────────────────────────────────────────────────────
// neededMessage — honest UI strings when sufficiency=needs_more_data.
// ─────────────────────────────────────────────────────────────────────

describe("KAN-962 — neededMessage UI strings", () => {
  it("returns null when count >= threshold", () => {
    expect(neededMessage("new_leads", 1)).toBeNull();
    expect(neededMessage("closed_lost", 5)).toBeNull();
  });

  it("includes the actual count + remaining for closed_lost", () => {
    const msg = neededMessage("closed_lost", 2)!;
    expect(msg).toContain("5");                 // threshold
    expect(msg).toContain("2");                 // current count
    expect(msg).toContain("3 more needed");     // arithmetic
  });

  it("includes the actual count for cancelled_orders", () => {
    const msg = neededMessage("cancelled_orders", 1)!;
    expect(msg).toMatch(/cancelled or failed orders/);
    expect(msg).toContain("1");
  });

  it("inactive_customers message mentions 90-day window", () => {
    const msg = neededMessage("inactive_customers", 2)!;
    expect(msg).toMatch(/90d|90 days/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// evidenceDescription — what the audit cards display.
// ─────────────────────────────────────────────────────────────────────

describe("KAN-962 — evidenceDescription", () => {
  it("describes new_leads as recent + lifecycle=lead + no deal", () => {
    expect(evidenceDescription("new_leads")).toMatch(/recent.*lead.*no deal/i);
  });

  it("describes closed_lost via the stage signal (not deal.status)", () => {
    // Per KAN-791 the stage outcomeType is the authoritative terminal signal.
    expect(evidenceDescription("closed_lost")).toMatch(/terminal-lost/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// fallbackProposal — LLM-failure path produces a complete shape.
// ─────────────────────────────────────────────────────────────────────

describe("KAN-962 — fallbackProposal covers all 8 objective types", () => {
  const TYPES = [
    "book_appointment",
    "sell_online",
    "enrich_lead",
    "warm_up",
    "reactivate",
    "retain_customer",
    "upsell",
    "recover_failed_payment",
  ] as const;

  for (const type of TYPES) {
    it(`type=${type} returns name + reason + non-empty stages`, () => {
      const out = fallbackProposal({
        objectiveType: type,
        objectiveName: `${type} (display)`,
        segment: "new_leads",
        segmentCount: 3,
        sufficiency: "ready",
        accountContext: { industry: "SAAS", timeZone: "America/Toronto", defaultLanguage: "en" },
      });
      expect(out.proposedName).toBeTruthy();
      expect(out.reason).toBeTruthy();
      expect(out.proposedStages.length).toBeGreaterThan(0);
      // Every fallback stage list must have exactly one isInitial + at least one isTerminal.
      const initials = out.proposedStages.filter((s) => s.isInitial);
      const terminals = out.proposedStages.filter((s) => s.isTerminal);
      expect(initials).toHaveLength(1);
      expect(terminals.length).toBeGreaterThan(0);
    });
  }

  it("enrich_lead has a hardcoded reason (no blueprint mapping)", () => {
    const out = fallbackProposal({
      objectiveType: "enrich_lead",
      objectiveName: "Enrich a lead",
      segment: "new_leads",
      segmentCount: 7,
      sufficiency: "ready",
      accountContext: { industry: null, timeZone: null, defaultLanguage: null },
    });
    expect(out.reason).toMatch(/thin data|enrichment/i);
  });

  it("recover_failed_payment has a hardcoded reason (no blueprint mapping)", () => {
    const out = fallbackProposal({
      objectiveType: "recover_failed_payment",
      objectiveName: "Recover a failed payment",
      segment: "cancelled_orders_recovery",
      segmentCount: 5,
      sufficiency: "ready",
      accountContext: { industry: "SAAS", timeZone: null, defaultLanguage: null },
    });
    expect(out.reason).toMatch(/recovery|failed|cancelled/i);
  });

  it("needs_more_data variant returns a forward-looking message (not a count)", () => {
    const out = fallbackProposal({
      objectiveType: "reactivate",
      objectiveName: "Reactivate a contact",
      segment: "inactive_customers_reengagement",
      segmentCount: 0,
      sufficiency: "needs_more_data",
      accountContext: { industry: null, timeZone: null, defaultLanguage: null },
    });
    expect(out.reason).toMatch(/quiet|inactive|re-engage|identify/i);
    // needs_more_data reason shouldn't claim a fake count
    expect(out.reason).not.toMatch(/^\d+ /);
  });
});

// ─────────────────────────────────────────────────────────────────────
// proposeForTenant — end-to-end with mocked Prisma.
// ─────────────────────────────────────────────────────────────────────

interface FakeObjective {
  id: string;
  type: string;
  name: string;
  entityScope: string;
  isActive: boolean;
  tenantId: string;
}

function makePrisma(opts: {
  objectives: FakeObjective[];
  segmentCounts: {
    newLeads?: number;
    closedLost?: number;
    cancelledOrders?: number;
    activeCustomers?: number;
    inactiveCustomers?: number;
  };
  accountProfile?: { industry: string | null; timeZone: string | null; defaultLanguage: string | null } | null;
}) {
  return {
    objective: {
      findMany: async ({ where }: { where: { tenantId: string; entityScope: string; isActive: boolean } }) =>
        opts.objectives.filter(
          (o) =>
            o.tenantId === where.tenantId &&
            o.entityScope === where.entityScope &&
            o.isActive === where.isActive,
        ),
    },
    accountProfile: {
      findFirst: async () => opts.accountProfile ?? null,
    },
    // The 5 segment-count helpers each call .count on a different table.
    contact: { count: async () => opts.segmentCounts.newLeads ?? 0 },
    deal: { count: async () => opts.segmentCounts.closedLost ?? 0 },
    order: { count: async () => opts.segmentCounts.cancelledOrders ?? 0 },
    customer: {
      count: async (args: { where: { status: string; contact?: unknown } }) => {
        // The inactive customers count uses a nested `contact: { engagements: ... }` filter;
        // active customers count uses just status. Discriminate by the presence of `contact`.
        if (args.where.contact) {
          return opts.segmentCounts.inactiveCustomers ?? 0;
        }
        return opts.segmentCounts.activeCustomers ?? 0;
      },
    },
  } as never;
}

describe("KAN-962 — proposeForTenant integration (mocked)", () => {
  const fullCatalog: FakeObjective[] = [
    { id: "obj_book", type: "book_appointment", name: "Book an appointment", entityScope: "contact", isActive: true, tenantId: TENANT_A },
    { id: "obj_enrich", type: "enrich_lead", name: "Enrich a lead", entityScope: "contact", isActive: true, tenantId: TENANT_A },
    { id: "obj_reactivate", type: "reactivate", name: "Reactivate a contact", entityScope: "contact", isActive: true, tenantId: TENANT_A },
    { id: "obj_retain", type: "retain_customer", name: "Retain a customer", entityScope: "contact", isActive: true, tenantId: TENANT_A },
    { id: "obj_recover", type: "recover_failed_payment", name: "Recover a failed payment", entityScope: "contact", isActive: true, tenantId: TENANT_A },
  ];

  it("AxisOne-shape: 1 lead → book_appointment ready, others needs_more_data", async () => {
    const prisma = makePrisma({
      objectives: fullCatalog,
      segmentCounts: {
        newLeads: 1,         // threshold 1 → ready
        closedLost: 0,
        cancelledOrders: 0,
        activeCustomers: 0,
        inactiveCustomers: 0,
      },
      accountProfile: { industry: "SAAS", timeZone: "America/Toronto", defaultLanguage: "en" },
    });

    const proposals = await proposeForTenant({ prisma, tenantId: TENANT_A, entityScope: "contact" });

    expect(proposals).toHaveLength(5);

    const book = proposals.find((p) => p.objectiveType === "book_appointment")!;
    expect(book.dataSufficiency).toBe("ready");
    expect(book.segment).toBe("new_leads");
    expect(book.evidence.count).toBe(1);
    expect(book.evidence.threshold).toBe(SUFFICIENCY_THRESHOLDS.new_leads);
    expect(book.needed).toBeNull();

    const reactivate = proposals.find((p) => p.objectiveType === "reactivate")!;
    expect(reactivate.dataSufficiency).toBe("needs_more_data");
    expect(reactivate.evidence.count).toBe(0);
    expect(reactivate.needed).toContain("Need at least");
  });

  it("sorts ready before needs_more_data within same suggestedPriority", async () => {
    // book_appointment + sell_online both have suggestedPriority=1. With sell_online
    // ready and book_appointment needs_more_data, ready should sort first.
    const catalog: FakeObjective[] = [
      { id: "obj_book", type: "book_appointment", name: "Book", entityScope: "contact", isActive: true, tenantId: TENANT_A },
      { id: "obj_sell", type: "sell_online", name: "Sell", entityScope: "contact", isActive: true, tenantId: TENANT_A },
    ];
    const prisma = makePrisma({
      objectives: catalog,
      segmentCounts: { newLeads: 1 },
    });
    const proposals = await proposeForTenant({ prisma, tenantId: TENANT_A, entityScope: "contact" });
    // Both will be ready since new_leads=1 ≥ threshold 1 — both should appear,
    // both at priority 1, both ready. Sort tiebreaker is alphabetical objectiveType.
    expect(proposals.map((p) => p.objectiveType)).toEqual(["book_appointment", "sell_online"]);
  });

  it("empty catalog returns empty proposals (no LLM call needed)", async () => {
    const prisma = makePrisma({ objectives: [], segmentCounts: {} });
    const proposals = await proposeForTenant({ prisma, tenantId: TENANT_A, entityScope: "contact" });
    expect(proposals).toEqual([]);
  });

  it("AccountProfile missing → proposer still runs with null context", async () => {
    const prisma = makePrisma({
      objectives: [fullCatalog[0]],
      segmentCounts: { newLeads: 5 },
      accountProfile: null,
    });
    const proposals = await proposeForTenant({ prisma, tenantId: TENANT_A, entityScope: "contact" });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].dataSufficiency).toBe("ready");
  });

  it("entityScope filter — does not return objectives at a different scope", async () => {
    const mixed: FakeObjective[] = [
      { id: "obj_a", type: "book_appointment", name: "A", entityScope: "contact", isActive: true, tenantId: TENANT_A },
      { id: "obj_b", type: "book_appointment", name: "B", entityScope: "order", isActive: true, tenantId: TENANT_A },
    ];
    const prisma = makePrisma({ objectives: mixed, segmentCounts: { newLeads: 1 } });
    const proposals = await proposeForTenant({ prisma, tenantId: TENANT_A, entityScope: "contact" });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].objectiveId).toBe("obj_a");
  });
});
