/**
 * KAN-883 — Deals router service tests.
 *
 * Coverage:
 *   - Multi-tenant isolation
 *   - Filters: status, companyId, contactId, ownerId
 *   - Search ILIKE on name
 *   - Cursor pagination on createdAt + id tiebreaker
 *   - getDealById returns NOT_FOUND on cross-tenant + nonexistent id
 *   - Cursor + search compose via AND (regression for OR-clobber bug)
 */
import { describe, it, expect } from "vitest";
import { listDeals, getDealById } from "../deals-router.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

interface FakeDeal {
  id: string;
  tenantId: string;
  name: string;
  status: string;
  probability: number | null;
  expectedCloseDate: Date | null;
  closedAt: Date | null;
  lostReason: string | null;
  lostReasonDetail: string | null;
  wonProductSummary: string | null;
  products: unknown;
  ownerId: string | null;
  assignedAgentId: string | null;
  companyId: string | null;
  externalIds: unknown;
  customFields: unknown;
  value: number;
  currency: string;
  currentStageId: string;
  contactId: string;
  pipelineId: string;
  createdAt: Date;
  updatedAt: Date;
}

function deal(overrides: Partial<FakeDeal> = {}): FakeDeal {
  return {
    id: `dl_${Math.random().toString(36).slice(2, 10)}`,
    tenantId: TENANT_A,
    name: "Untitled deal",
    status: "open",
    probability: null,
    expectedCloseDate: null,
    closedAt: null,
    lostReason: null,
    lostReasonDetail: null,
    wonProductSummary: null,
    products: [],
    ownerId: null,
    assignedAgentId: null,
    companyId: null,
    externalIds: {},
    customFields: {},
    value: 0,
    currency: "USD",
    currentStageId: "stg_open",
    contactId: "ct_1",
    pipelineId: "pip_1",
    createdAt: new Date("2026-05-10T10:00:00Z"),
    updatedAt: new Date("2026-05-10T10:00:00Z"),
    ...overrides,
  };
}

function evalWhere(d: FakeDeal, where: Record<string, unknown>): boolean {
  for (const [key, val] of Object.entries(where)) {
    if (key === "AND") {
      const clauses = val as Array<Record<string, unknown>>;
      if (!clauses.every((cl) => evalWhere(d, cl))) return false;
      continue;
    }
    if (key === "OR") {
      const clauses = val as Array<Record<string, unknown>>;
      if (!clauses.some((cl) => evalWhere(d, cl))) return false;
      continue;
    }
    const fieldVal = (d as unknown as Record<string, unknown>)[key];
    // Date equality check must precede the operator-object check (Dates are
    // typeof "object" so they'd silently fall into the operator branch and
    // pass without comparison).
    if (val instanceof Date) {
      if (!(fieldVal instanceof Date) || fieldVal.getTime() !== val.getTime()) return false;
    } else if (val === null) {
      if (fieldVal !== null) return false;
    } else if (typeof val === "object" && val !== null) {
      const op = val as Record<string, unknown>;
      if ("lt" in op) {
        if (fieldVal === null || fieldVal === undefined) return false;
        const opVal = op.lt as Date | string;
        if (opVal instanceof Date) {
          if (!(fieldVal instanceof Date) || fieldVal.getTime() >= opVal.getTime()) return false;
        } else {
          if (typeof fieldVal !== "string" || !(fieldVal < opVal)) return false;
        }
      } else if ("contains" in op) {
        if (typeof fieldVal !== "string") return false;
        if (!fieldVal.toLowerCase().includes((op.contains as string).toLowerCase())) return false;
      }
    } else if (fieldVal !== val) {
      return false;
    }
  }
  return true;
}

interface FakeUser {
  id: string;
  tenantId: string;
  name: string | null;
  email: string;
}

function makePrisma(rows: FakeDeal[], users: FakeUser[] = []) {
  return {
    deal: {
      findMany: async ({
        where,
        take,
      }: {
        where: Record<string, unknown>;
        take: number;
      }) => {
        const matched = rows.filter((r) => evalWhere(r, where));
        matched.sort((a, b) => {
          const aT = a.createdAt.getTime();
          const bT = b.createdAt.getTime();
          if (aT !== bT) return bT - aT;
          return a.id < b.id ? 1 : -1;
        });
        return matched.slice(0, take);
      },
      count: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => evalWhere(r, where)).length,
      findFirst: async ({
        where,
      }: {
        where: { id: string; tenantId: string };
      }) =>
        rows.find((r) => r.id === where.id && r.tenantId === where.tenantId) ?? null,
    },
    // KAN-888 — manual owner hydration calls prisma.user.findFirst with
    // tenantId scoping + a `select` clause. Fake mirrors both: tenantId
    // filter for multi-tenant isolation, and `select` projection so the
    // returned shape matches what real Prisma would return (id/name/email
    // only, not the full FakeUser including tenantId).
    user: {
      findFirst: async ({
        where,
        select,
      }: {
        where: { id: string; tenantId: string };
        select?: Record<string, true>;
      }) => {
        const u = users.find(
          (u) => u.id === where.id && u.tenantId === where.tenantId,
        );
        if (!u) return null;
        if (!select) return u;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(select)) out[k] = (u as Record<string, unknown>)[k];
        return out;
      },
    },
  } as never;
}

describe("KAN-883 — listDeals", () => {
  it("excludes cross-tenant rows", async () => {
    const data = [
      deal({ id: "dl_a", tenantId: TENANT_A }),
      deal({ id: "dl_b", tenantId: TENANT_B }),
    ];
    const prisma = makePrisma(data);
    const result = await listDeals(prisma, TENANT_A, { limit: 50 });
    expect(result.items.map((i) => i.id)).toEqual(["dl_a"]);
  });

  it("filters by status enum", async () => {
    const data = [
      deal({ id: "a", status: "open" }),
      deal({ id: "b", status: "won" }),
      deal({ id: "c", status: "open" }),
      deal({ id: "d", status: "lost" }),
    ];
    const prisma = makePrisma(data);
    const result = await listDeals(prisma, TENANT_A, { status: "open", limit: 50 });
    expect(result.items.map((i) => i.id).sort()).toEqual(["a", "c"]);
  });

  it("filters by companyId + contactId + ownerId compose as AND", async () => {
    const CO = "11111111-1111-1111-1111-aaaaaaaaaaaa";
    const data = [
      deal({ id: "match", companyId: CO, contactId: "ct_1", ownerId: "user_1" }),
      deal({ id: "wrong-co", companyId: null, contactId: "ct_1", ownerId: "user_1" }),
      deal({ id: "wrong-owner", companyId: CO, contactId: "ct_1", ownerId: "user_2" }),
    ];
    const prisma = makePrisma(data);
    const result = await listDeals(prisma, TENANT_A, {
      companyId: CO,
      contactId: "ct_1",
      ownerId: "user_1",
      limit: 50,
    });
    expect(result.items.map((i) => i.id)).toEqual(["match"]);
  });

  it("search ILIKE matches name", async () => {
    const data = [
      deal({ id: "a", name: "Acme Q3 expansion" }),
      deal({ id: "b", name: "Globex pilot" }),
      deal({ id: "c", name: "acme renewal" }),
    ];
    const prisma = makePrisma(data);
    const result = await listDeals(prisma, TENANT_A, { search: "acme", limit: 50 });
    expect(result.items.map((i) => i.id).sort()).toEqual(["a", "c"]);
  });

  it("cursor pagination round-trips with stable createdAt+id ordering", async () => {
    const data = Array.from({ length: 4 }, (_, i) =>
      deal({
        id: `dl_${i}`,
        createdAt: new Date(`2026-05-${15 - i}T10:00:00Z`),
      }),
    );
    const prisma = makePrisma(data);

    const page1 = await listDeals(prisma, TENANT_A, { limit: 2 });
    expect(page1.items.map((i) => i.id)).toEqual(["dl_0", "dl_1"]);
    expect(page1.totalCount).toBe(4);

    const page2 = await listDeals(prisma, TENANT_A, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.map((i) => i.id)).toEqual(["dl_2", "dl_3"]);
    expect(page2.nextCursor).toBeNull();
  });

  it("cursor + search compose via AND — search filter applies past the cursor", async () => {
    const data = [
      deal({
        id: "dl_1",
        name: "Acme One",
        createdAt: new Date("2026-05-10T10:00:00Z"),
      }),
      deal({
        id: "dl_2",
        name: "Globex Match",
        createdAt: new Date("2026-05-09T10:00:00Z"),
      }),
      deal({
        id: "dl_3",
        name: "Acme Three",
        createdAt: new Date("2026-05-08T10:00:00Z"),
      }),
    ];
    const prisma = makePrisma(data);

    const page1 = await listDeals(prisma, TENANT_A, { search: "acme", limit: 1 });
    expect(page1.items.map((i) => i.id)).toEqual(["dl_1"]);

    const page2 = await listDeals(prisma, TENANT_A, {
      search: "acme",
      limit: 1,
      cursor: page1.nextCursor!,
    });
    // Globex must NOT leak through after the cursor.
    expect(page2.items.map((i) => i.id)).toEqual(["dl_3"]);
  });
});

describe("KAN-883 — getDealById", () => {
  it("returns own-tenant row", async () => {
    const data = [deal({ id: "dl_a", tenantId: TENANT_A })];
    const prisma = makePrisma(data);
    const result = await getDealById(prisma, TENANT_A, { id: "dl_a" });
    expect((result as { id: string }).id).toBe("dl_a");
  });

  it("cross-tenant → NOT_FOUND", async () => {
    const data = [deal({ id: "dl_a", tenantId: TENANT_B })];
    const prisma = makePrisma(data);
    await expect(
      getDealById(prisma, TENANT_A, { id: "dl_a" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("nonexistent id → NOT_FOUND", async () => {
    const prisma = makePrisma([]);
    await expect(
      getDealById(prisma, TENANT_A, { id: "dl_missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// KAN-888 — owner hydration coverage. Deal.ownerId has no Prisma @relation
// to User; the route does a manual `prisma.user.findFirst` post-fetch,
// scoped to the same tenant. These tests pin all three legs:
//   null ownerId → owner: null
//   matching tenant user → owner populated
//   cross-tenant user → owner: null (multi-tenant isolation on the user query)
describe("KAN-888 — getDealById owner hydration", () => {
  it("ownerId null → owner: null", async () => {
    const prisma = makePrisma([deal({ id: "dl_1", ownerId: null })], []);
    const result = (await getDealById(prisma, TENANT_A, { id: "dl_1" })) as {
      owner: unknown;
    };
    expect(result.owner).toBeNull();
  });

  it("ownerId set + user in same tenant → owner populated", async () => {
    const prisma = makePrisma(
      [deal({ id: "dl_1", ownerId: "u_1" })],
      [{ id: "u_1", tenantId: TENANT_A, name: "Alice", email: "alice@a.com" }],
    );
    const result = (await getDealById(prisma, TENANT_A, { id: "dl_1" })) as {
      owner: unknown;
    };
    expect(result.owner).toEqual({
      id: "u_1",
      name: "Alice",
      email: "alice@a.com",
    });
  });

  it("ownerId set + user in different tenant → owner: null (cross-tenant scoping)", async () => {
    const prisma = makePrisma(
      [deal({ id: "dl_1", ownerId: "u_1" })],
      [{ id: "u_1", tenantId: TENANT_B, name: "Spy", email: "spy@b.com" }],
    );
    const result = (await getDealById(prisma, TENANT_A, { id: "dl_1" })) as {
      owner: unknown;
    };
    expect(result.owner).toBeNull();
  });

  it("ownerId set + user nonexistent → owner: null", async () => {
    const prisma = makePrisma([deal({ id: "dl_1", ownerId: "u_missing" })], []);
    const result = (await getDealById(prisma, TENANT_A, { id: "dl_1" })) as {
      owner: unknown;
    };
    expect(result.owner).toBeNull();
  });
});
