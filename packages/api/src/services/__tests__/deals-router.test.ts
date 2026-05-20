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
import { z } from "zod";
import { listDeals, getDealById, createDeal, updateDeal } from "../deals-router.js";

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
  // KAN-940 — soft-delete column
  deletedAt: Date | null;
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
    // KAN-940 — soft-delete column (null = not soft-deleted)
    deletedAt: null,
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

// KAN-938 — FK validation fixtures for createDeal/updateDeal tests.
interface FakeContact {
  id: string;
  tenantId: string;
}
interface FakeCompany {
  id: string;
  tenantId: string;
}
interface FakePipeline {
  id: string;
  tenantId: string;
}
interface FakeStage {
  id: string;
  pipelineId: string;
}

function makePrisma(
  rows: FakeDeal[],
  users: FakeUser[] = [],
  contacts: FakeContact[] = [],
  companies: FakeCompany[] = [],
  pipelines: FakePipeline[] = [],
  stages: FakeStage[] = [],
) {
  let nextId = rows.length;
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
      // KAN-940 — findFirst routes through evalWhere so it honors the
      // full where shape (e.g., the triple-guard's `deletedAt: null`
      // filter, not just id + tenantId).
      findFirst: async ({
        where,
      }: {
        where: Record<string, unknown>;
      }) =>
        rows.find((r) => evalWhere(r, where)) ?? null,
      // KAN-938 — create + update support for Sub-cohort 3.3 tests
      create: async ({ data }: { data: Partial<FakeDeal> & { tenantId: string; contactId: string; pipelineId: string; currentStageId: string } }) => {
        const newRow = deal({ id: `dl_${++nextId}`, ...data } as Partial<FakeDeal>);
        rows.push(newRow);
        return newRow;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeDeal>;
      }) => {
        const r = rows.find((row) => row.id === where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      },
    },
    // KAN-938 — FK validation tables for assertContact/Pipeline/Stage helpers
    contact: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; tenantId: string };
      }) =>
        contacts.find((c) => c.id === where.id && c.tenantId === where.tenantId) ?? null,
    },
    company: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; tenantId: string };
      }) =>
        companies.find((c) => c.id === where.id && c.tenantId === where.tenantId) ?? null,
    },
    pipeline: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; tenantId: string };
      }) =>
        pipelines.find((p) => p.id === where.id && p.tenantId === where.tenantId) ?? null,
    },
    stage: {
      // KAN-938 hardening — assertStageInPipeline now joins through
      // `pipeline: { id, tenantId }` for self-contained defense-in-depth.
      // Mock returns the stage only when (a) stage.pipelineId === where.pipeline.id
      // AND (b) the pipeline lives in where.pipeline.tenantId.
      findFirst: async ({
        where,
      }: {
        where: { id: string; pipeline: { id: string; tenantId: string } };
      }) => {
        const stage = stages.find((s) => s.id === where.id);
        if (!stage) return null;
        if (stage.pipelineId !== where.pipeline.id) return null;
        const pipeline = pipelines.find((p) => p.id === stage.pipelineId);
        if (!pipeline || pipeline.tenantId !== where.pipeline.tenantId) return null;
        return { id: stage.id };
      },
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

// ─────────────────────────────────────────────────────────────────────
// KAN-893 — tRPC validator regression: CUID-shaped id + FK filter
// accepted. Mirrors apps/api/src/router.ts:546 (deals.get) and
// router.ts:533 (companyId filter). Pre-KAN-893 both were `.uuid()`
// which rejected every real PROD Deal/Company id.
// ─────────────────────────────────────────────────────────────────────
describe("KAN-893 — deals.get tRPC input validator", () => {
  const inputSchema = z.object({ id: z.string().cuid() });

  it("accepts CUID-shaped id (e.g. PROD Deal.id format)", () => {
    const result = inputSchema.safeParse({ id: "cmou3yc2o0002a9tnt34f5q81" });
    expect(result.success).toBe(true);
  });
});

describe("KAN-893 — deals.list?companyId tRPC input validator", () => {
  const inputSchema = z.object({
    companyId: z.string().cuid().optional(),
  });

  it("accepts CUID-shaped companyId filter", () => {
    const result = inputSchema.safeParse({ companyId: "cmou3yc2o0002a9tnt34f5q81" });
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// KAN-938 — Sub-cohort 3.3 Deal CRUD: createDeal + updateDeal.
// 8 tests covering happy paths + FK validation + cross-tenant + partial
// update + pipeline/stage coupled-update invariant.
// ─────────────────────────────────────────────────────────────────────
const C_1 = "ct_1";
const CO_1 = "co_1";
const P_1 = "pip_1";
const S_1 = "stg_open";
const S_OTHER_PIPELINE = "stg_other";

describe("KAN-938 — createDeal", () => {
  it("creates a deal with all required FKs + optional companyId", async () => {
    const data: FakeDeal[] = [];
    const prisma = makePrisma(
      data,
      [],
      [{ id: C_1, tenantId: TENANT_A }],
      [{ id: CO_1, tenantId: TENANT_A }],
      [{ id: P_1, tenantId: TENANT_A }],
      [{ id: S_1, pipelineId: P_1 }],
    );

    await createDeal(prisma, TENANT_A, {
      name: "Acme Q3 expansion",
      value: "125000.00",
      currency: "USD",
      probability: 60,
      status: "open",
      expectedCloseDate: "2026-09-30",
      lostReason: null,
      lostReasonDetail: null,
      wonProductSummary: null,
      pipelineId: P_1,
      currentStageId: S_1,
      contactId: C_1,
      companyId: CO_1,
    });

    expect(data).toHaveLength(1);
    const row = data[0];
    expect(row.tenantId).toBe(TENANT_A);
    expect(row.name).toBe("Acme Q3 expansion");
    expect(row.value).toBe("125000.00");
    expect(row.probability).toBe(60);
    expect(row.status).toBe("open");
    // KAN-942 — expectedCloseDate must arrive at Prisma as a Date object
    // (not a yyyy-mm-dd string). The native <input type="date"> returns
    // yyyy-mm-dd; the backend coerces via toDate() helper.
    expect(row.expectedCloseDate).toBeInstanceOf(Date);
    expect((row.expectedCloseDate as unknown as Date).toISOString()).toBe(
      "2026-09-30T00:00:00.000Z",
    );
    expect(row.contactId).toBe(C_1);
    expect(row.pipelineId).toBe(P_1);
    expect(row.currentStageId).toBe(S_1);
    expect(row.companyId).toBe(CO_1);
  });

  // KAN-942 — explicit regression test for the PROD 500. Prisma rejects
  // yyyy-mm-dd strings on @db.Date columns; require Date object at the
  // service boundary. Pre-fix this test would have caught the failure mode
  // without requiring real Prisma.
  it("KAN-942: expectedCloseDate yyyy-mm-dd string coerced to Date before Prisma", async () => {
    const data: FakeDeal[] = [];
    const prisma = makePrisma(
      data,
      [],
      [{ id: C_1, tenantId: TENANT_A }],
      [],
      [{ id: P_1, tenantId: TENANT_A }],
      [{ id: S_1, pipelineId: P_1 }],
    );
    await createDeal(prisma, TENANT_A, {
      pipelineId: P_1,
      currentStageId: S_1,
      contactId: C_1,
      expectedCloseDate: "2026-12-31",
    });
    expect(data[0].expectedCloseDate).toBeInstanceOf(Date);
    expect((data[0].expectedCloseDate as unknown as Date).toISOString()).toBe(
      "2026-12-31T00:00:00.000Z",
    );
  });

  it("KAN-942: null expectedCloseDate persists as null (no coercion)", async () => {
    const data: FakeDeal[] = [];
    const prisma = makePrisma(
      data,
      [],
      [{ id: C_1, tenantId: TENANT_A }],
      [],
      [{ id: P_1, tenantId: TENANT_A }],
      [{ id: S_1, pipelineId: P_1 }],
    );
    await createDeal(prisma, TENANT_A, {
      pipelineId: P_1,
      currentStageId: S_1,
      contactId: C_1,
      expectedCloseDate: null,
    });
    expect(data[0].expectedCloseDate).toBeNull();
  });

  it("KAN-942: empty-string expectedCloseDate persists as null", async () => {
    const data: FakeDeal[] = [];
    const prisma = makePrisma(
      data,
      [],
      [{ id: C_1, tenantId: TENANT_A }],
      [],
      [{ id: P_1, tenantId: TENANT_A }],
      [{ id: S_1, pipelineId: P_1 }],
    );
    await createDeal(prisma, TENANT_A, {
      pipelineId: P_1,
      currentStageId: S_1,
      contactId: C_1,
      expectedCloseDate: "",
    });
    expect(data[0].expectedCloseDate).toBeNull();
  });

  it("rejects cross-tenant contactId with BAD_REQUEST", async () => {
    const data: FakeDeal[] = [];
    const prisma = makePrisma(
      data,
      [],
      [{ id: C_1, tenantId: TENANT_B }], // wrong tenant
      [],
      [{ id: P_1, tenantId: TENANT_A }],
      [{ id: S_1, pipelineId: P_1 }],
    );
    await expect(
      createDeal(prisma, TENANT_A, {
        pipelineId: P_1,
        currentStageId: S_1,
        contactId: C_1,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/contact not found/i),
    });
    expect(data).toHaveLength(0);
  });

  it("rejects stage that doesn't belong to the selected pipeline", async () => {
    const data: FakeDeal[] = [];
    const prisma = makePrisma(
      data,
      [],
      [{ id: C_1, tenantId: TENANT_A }],
      [],
      [{ id: P_1, tenantId: TENANT_A }],
      [{ id: S_OTHER_PIPELINE, pipelineId: "pip_other" }], // wrong pipeline
    );
    await expect(
      createDeal(prisma, TENANT_A, {
        pipelineId: P_1,
        currentStageId: S_OTHER_PIPELINE,
        contactId: C_1,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/stage does not belong/i),
    });
    expect(data).toHaveLength(0);
  });
});

describe("KAN-938 — updateDeal", () => {
  it("partial update only sets provided fields (doesn't clobber others to null)", async () => {
    const data = [
      deal({
        id: "dl_1",
        tenantId: TENANT_A,
        name: "Original name",
        value: 50000 as never, // mock fixture
        probability: 30,
        contactId: C_1,
        pipelineId: P_1,
        currentStageId: S_1,
      }),
    ];
    const prisma = makePrisma(
      data,
      [],
      [{ id: C_1, tenantId: TENANT_A }],
      [],
      [{ id: P_1, tenantId: TENANT_A }],
      [{ id: S_1, pipelineId: P_1 }],
    );
    await updateDeal(prisma, TENANT_A, {
      id: "dl_1",
      name: "Updated name",
      // probability, value, contactId NOT provided — must NOT be cleared
    });
    expect(data[0].name).toBe("Updated name");
    expect(data[0].probability).toBe(30);
    expect(data[0].contactId).toBe(C_1);
  });

  it("cross-tenant → NOT_FOUND (no existence leak)", async () => {
    const data = [deal({ id: "dl_1", tenantId: TENANT_B, name: "Original" })];
    const prisma = makePrisma(data);
    await expect(
      updateDeal(prisma, TENANT_A, { id: "dl_1", name: "Hijack Attempt" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(data[0].name).toBe("Original");
  });

  it("rejects pipelineId without currentStageId (coupled-update invariant)", async () => {
    const data = [deal({ id: "dl_1", tenantId: TENANT_A })];
    const prisma = makePrisma(data);
    await expect(
      updateDeal(prisma, TENANT_A, { id: "dl_1", pipelineId: "pip_new" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/must be updated together/i),
    });
  });

  it("rejects currentStageId without pipelineId (symmetric invariant)", async () => {
    const data = [deal({ id: "dl_1", tenantId: TENANT_A })];
    const prisma = makePrisma(data);
    await expect(
      updateDeal(prisma, TENANT_A, { id: "dl_1", currentStageId: "stg_new" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/must be updated together/i),
    });
  });

  it("accepts pipelineId + currentStageId together when both valid", async () => {
    const P_NEW = "pip_new";
    const S_NEW = "stg_new";
    const data = [deal({ id: "dl_1", tenantId: TENANT_A })];
    const prisma = makePrisma(
      data,
      [],
      [],
      [],
      [{ id: P_NEW, tenantId: TENANT_A }],
      [{ id: S_NEW, pipelineId: P_NEW }],
    );
    await updateDeal(prisma, TENANT_A, {
      id: "dl_1",
      pipelineId: P_NEW,
      currentStageId: S_NEW,
    });
    expect(data[0].pipelineId).toBe(P_NEW);
    expect(data[0].currentStageId).toBe(S_NEW);
  });

  // KAN-942 — Date coercion applies symmetrically on the update path.
  it("KAN-942: updateDeal coerces yyyy-mm-dd expectedCloseDate to Date", async () => {
    const data = [deal({ id: "dl_1", tenantId: TENANT_A })];
    const prisma = makePrisma(data);
    await updateDeal(prisma, TENANT_A, {
      id: "dl_1",
      expectedCloseDate: "2027-03-15",
    });
    expect(data[0].expectedCloseDate).toBeInstanceOf(Date);
    expect((data[0].expectedCloseDate as unknown as Date).toISOString()).toBe(
      "2027-03-15T00:00:00.000Z",
    );
  });

  it("KAN-942: updateDeal with explicit null clears expectedCloseDate", async () => {
    const data = [
      deal({
        id: "dl_1",
        tenantId: TENANT_A,
        expectedCloseDate: new Date("2026-09-30T00:00:00.000Z"),
      }),
    ];
    const prisma = makePrisma(data);
    await updateDeal(prisma, TENANT_A, {
      id: "dl_1",
      expectedCloseDate: null,
    });
    expect(data[0].expectedCloseDate).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// KAN-940 — Deal soft-delete (deletedAt column).
//
// Coverage:
//   - listDeals excludes soft-deleted rows by default
//   - getDealById still returns tombstones (audit-trail parity with
//     getCompanyById)
//   - updateDeal triple-guard rejects soft-deleted rows as NOT_FOUND
//     (uniform error shape alongside cross-tenant; no existence leak)
// ─────────────────────────────────────────────────────────────────────
describe("KAN-940 — Deal soft-delete", () => {
  it("listDeals excludes soft-deleted rows by default", async () => {
    const data = [
      deal({ id: "dl_live", deletedAt: null }),
      deal({ id: "dl_tombstone", deletedAt: new Date("2026-05-15") }),
    ];
    const prisma = makePrisma(data);
    const result = await listDeals(prisma, TENANT_A, { limit: 50 });
    expect(result.items.map((i) => i.id)).toEqual(["dl_live"]);
    expect(result.totalCount).toBe(1);
  });

  it("getDealById returns tombstones (audit-trail parity)", async () => {
    const data = [
      deal({
        id: "dl_tombstone",
        tenantId: TENANT_A,
        deletedAt: new Date("2026-05-15"),
      }),
    ];
    const prisma = makePrisma(data);
    const result = await getDealById(prisma, TENANT_A, { id: "dl_tombstone" });
    expect((result as { id: string }).id).toBe("dl_tombstone");
    expect((result as { deletedAt: Date | null }).deletedAt).toBeInstanceOf(Date);
  });

  it("updateDeal rejects soft-deleted rows → NOT_FOUND (triple-guard)", async () => {
    const data = [
      deal({
        id: "dl_tombstone",
        tenantId: TENANT_A,
        name: "Original",
        deletedAt: new Date("2026-05-15"),
      }),
    ];
    const prisma = makePrisma(data);
    await expect(
      updateDeal(prisma, TENANT_A, { id: "dl_tombstone", name: "resurrect" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Original row untouched
    expect(data[0].name).toBe("Original");
  });
});

// ─────────────────────────────────────────────────────────────────────
// KAN-936 — Deal owner FK formalized as @relation + cross-tenant guard.
//
// Coverage:
//   - createDeal persists ownerId when the user is in-tenant
//   - createDeal rejects cross-tenant ownerId → BAD_REQUEST (no row written)
//   - updateDeal persists ownerId when in-tenant
//   - updateDeal rejects cross-tenant ownerId → BAD_REQUEST
//   - updateDeal explicit null clears ownerId
// ─────────────────────────────────────────────────────────────────────
describe("KAN-936 — Deal owner FK + cross-tenant guard", () => {
  const U_A = "u_in_tenant_A";
  const U_B = "u_in_tenant_B";

  it("createDeal persists ownerId when user is in the same tenant", async () => {
    const data: FakeDeal[] = [];
    const prisma = makePrisma(
      data,
      [{ id: U_A, tenantId: TENANT_A, name: "Alice", email: "alice@a.com" }],
      [{ id: C_1, tenantId: TENANT_A }],
      [],
      [{ id: P_1, tenantId: TENANT_A }],
      [{ id: S_1, pipelineId: P_1 }],
    );

    await createDeal(prisma, TENANT_A, {
      pipelineId: P_1,
      currentStageId: S_1,
      contactId: C_1,
      ownerId: U_A,
    });

    expect(data).toHaveLength(1);
    expect(data[0].ownerId).toBe(U_A);
  });

  it("createDeal rejects cross-tenant ownerId → BAD_REQUEST, no row written", async () => {
    const data: FakeDeal[] = [];
    const prisma = makePrisma(
      data,
      [{ id: U_B, tenantId: TENANT_B, name: "Spy", email: "spy@b.com" }], // wrong tenant
      [{ id: C_1, tenantId: TENANT_A }],
      [],
      [{ id: P_1, tenantId: TENANT_A }],
      [{ id: S_1, pipelineId: P_1 }],
    );

    await expect(
      createDeal(prisma, TENANT_A, {
        pipelineId: P_1,
        currentStageId: S_1,
        contactId: C_1,
        ownerId: U_B,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/owner.*not found/i),
    });
    expect(data).toHaveLength(0);
  });

  it("updateDeal persists ownerId when user is in the same tenant", async () => {
    const data = [deal({ id: "dl_1", tenantId: TENANT_A, ownerId: null })];
    const prisma = makePrisma(
      data,
      [{ id: U_A, tenantId: TENANT_A, name: "Alice", email: "alice@a.com" }],
    );
    await updateDeal(prisma, TENANT_A, { id: "dl_1", ownerId: U_A });
    expect(data[0].ownerId).toBe(U_A);
  });

  it("updateDeal rejects cross-tenant ownerId → BAD_REQUEST", async () => {
    const data = [deal({ id: "dl_1", tenantId: TENANT_A, ownerId: null })];
    const prisma = makePrisma(
      data,
      [{ id: U_B, tenantId: TENANT_B, name: "Spy", email: "spy@b.com" }],
    );
    await expect(
      updateDeal(prisma, TENANT_A, { id: "dl_1", ownerId: U_B }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/owner.*not found/i),
    });
    expect(data[0].ownerId).toBeNull();
  });

  it("updateDeal explicit null clears ownerId (and bypasses user existence check)", async () => {
    const data = [deal({ id: "dl_1", tenantId: TENANT_A, ownerId: U_A })];
    const prisma = makePrisma(data, []); // no users — null bypasses the lookup
    await updateDeal(prisma, TENANT_A, { id: "dl_1", ownerId: null });
    expect(data[0].ownerId).toBeNull();
  });
});
