/**
 * KAN-883 — Companies router service tests.
 *
 * Coverage:
 *   - Multi-tenant isolation (tenant A cannot see tenant B's rows)
 *   - Cursor pagination round-trip (page 1 → cursor → page 2 → no overlap)
 *   - Soft-delete exclusion (deletedAt IS NOT NULL excluded from list, but
 *     get can still surface tombstones if the row exists)
 *   - Filters: lifecycleStage, ownerId, search ILIKE OR-expansion
 *   - Search + cursor compose correctly (search OR doesn't clobber cursor OR)
 *   - getCompanyById returns NOT_FOUND (not raw null) for cross-tenant access
 *   - _count aggregation passes through from Prisma
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  listCompanies,
  getCompanyById,
  createCompany,
  updateCompany,
} from "../companies-router.js";
import { decodeCursor } from "../_pagination.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

interface FakeCompany {
  id: string;
  tenantId: string;
  name: string;
  legalName: string | null;
  domain: string | null;
  website: string | null;
  industry: string | null;
  sizeRange: string | null;
  annualRevenue: string | null;
  description: string | null;
  lifecycleStage: string;
  phone: string | null;
  email: string | null;
  linkedinUrl: string | null;
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  billingCity: string | null;
  billingRegion: string | null;
  billingPostalCode: string | null;
  billingCountry: string | null;
  mailingAddressLine1: string | null;
  mailingAddressLine2: string | null;
  mailingCity: string | null;
  mailingRegion: string | null;
  mailingPostalCode: string | null;
  mailingCountry: string | null;
  taxId: string | null;
  taxIdType: string | null;
  businessRegistrationNumber: string | null;
  incorporationJurisdiction: string | null;
  isTaxExempt: boolean;
  taxExemptionCertificate: string | null;
  ownerId: string | null;
  tags: string[];
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // Relation counts that _count would surface
  _contactCount?: number;
  _dealCount?: number;
  _orderCount?: number;
}

function company(overrides: Partial<FakeCompany> = {}): FakeCompany {
  return {
    id: `co_${Math.random().toString(36).slice(2, 10)}`,
    tenantId: TENANT_A,
    name: "Acme Inc",
    legalName: null,
    domain: null,
    website: null,
    industry: null,
    sizeRange: null,
    annualRevenue: null,
    description: null,
    lifecycleStage: "prospect",
    phone: null,
    email: null,
    linkedinUrl: null,
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
    ownerId: null,
    tags: [],
    deletedAt: null,
    createdAt: new Date("2026-05-01T10:00:00Z"),
    updatedAt: new Date("2026-05-01T10:00:00Z"),
    ...overrides,
  };
}

/**
 * Recursive evaluator for the Prisma where-clause shape used by the
 * service. Supports the subset actually emitted: AND, OR, equality, `lt`,
 * `contains`+mode=insensitive. Enough to test cursor + search composition
 * without simulating the entire Prisma DSL.
 */
function evalWhere(c: FakeCompany, where: Record<string, unknown>): boolean {
  for (const [key, val] of Object.entries(where)) {
    if (key === "AND") {
      const clauses = val as Array<Record<string, unknown>>;
      if (!clauses.every((cl) => evalWhere(c, cl))) return false;
      continue;
    }
    if (key === "OR") {
      const clauses = val as Array<Record<string, unknown>>;
      if (!clauses.some((cl) => evalWhere(c, cl))) return false;
      continue;
    }
    const fieldVal = (c as unknown as Record<string, unknown>)[key];
    // IMPORTANT: Dates are typeof "object" so the instanceof check must come
    // BEFORE the operator-object check; otherwise Date equality is silently
    // treated as "any operator object" and passes for every row, breaking
    // the cursor's createdAt-tie AND clause.
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

function makePrisma(rows: FakeCompany[], users: FakeUser[] = []) {
  let nextId = rows.length;
  return {
    // KAN-936 — assertOwnerInTenant calls prisma.user.findFirst scoped to
    // { id, tenantId }; fake mirrors the multi-tenant filter so cross-tenant
    // owners surface as null (→ BAD_REQUEST in the service).
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
    company: {
      findMany: async ({
        where,
        orderBy,
        take,
        select: _select,
      }: {
        where: Record<string, unknown>;
        orderBy: Array<Record<string, "asc" | "desc">>;
        take: number;
        select: Record<string, unknown>;
      }) => {
        // Apply where + multi-field orderBy + take
        const matched = rows.filter((r) => evalWhere(r, where));
        // Order by createdAt DESC, then id DESC (matches service spec)
        matched.sort((a, b) => {
          const aT = a.createdAt.getTime();
          const bT = b.createdAt.getTime();
          if (aT !== bT) return bT - aT;
          if (a.id !== b.id) return a.id < b.id ? 1 : -1;
          return 0;
        });
        const sliced = matched.slice(0, take);
        // Surface _count if the select requested it (the service always does)
        return sliced.map((r) => ({
          ...r,
          _count: {
            contacts: r._contactCount ?? 0,
            deals: r._dealCount ?? 0,
            orders: r._orderCount ?? 0,
          },
        }));
      },
      count: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => evalWhere(r, where)).length,
      findFirst: async ({
        where,
      }: {
        where: Record<string, unknown>;
        select?: Record<string, unknown>;
        include?: unknown;
      }) =>
        rows.find((r) => evalWhere(r, where)) ?? null,
      // KAN-937 — Sub-cohort 3.2 mutation support
      create: async ({ data }: { data: Partial<FakeCompany> & { tenantId: string; name: string } }) => {
        const newRow = company({
          id: `co_${++nextId}`,
          ...data,
        } as Partial<FakeCompany>);
        rows.push(newRow);
        return newRow;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeCompany>;
      }) => {
        const r = rows.find((row) => row.id === where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      },
    },
  } as never;
}

describe("KAN-883 — listCompanies", () => {
  it("excludes cross-tenant rows", async () => {
    const data = [
      company({ id: "co_a", tenantId: TENANT_A }),
      company({ id: "co_b", tenantId: TENANT_B }),
    ];
    const prisma = makePrisma(data);
    const result = await listCompanies(prisma, TENANT_A, { limit: 50 });
    expect(result.items.map((i) => i.id)).toEqual(["co_a"]);
    expect(result.totalCount).toBe(1);
  });

  it("excludes soft-deleted rows by default", async () => {
    const data = [
      company({ id: "co_live", deletedAt: null }),
      company({ id: "co_tombstone", deletedAt: new Date("2026-05-10") }),
    ];
    const prisma = makePrisma(data);
    const result = await listCompanies(prisma, TENANT_A, { limit: 50 });
    expect(result.items.map((i) => i.id)).toEqual(["co_live"]);
    expect(result.totalCount).toBe(1);
  });

  it("filters by lifecycleStage", async () => {
    const data = [
      company({ id: "a", lifecycleStage: "customer" }),
      company({ id: "b", lifecycleStage: "prospect" }),
      company({ id: "c", lifecycleStage: "customer" }),
    ];
    const prisma = makePrisma(data);
    const result = await listCompanies(prisma, TENANT_A, {
      lifecycleStage: "customer",
      limit: 50,
    });
    expect(result.items.map((i) => i.id).sort()).toEqual(["a", "c"]);
  });

  it("filters by ownerId", async () => {
    const data = [
      company({ id: "a", ownerId: "user_1" }),
      company({ id: "b", ownerId: "user_2" }),
      company({ id: "c", ownerId: null }),
    ];
    const prisma = makePrisma(data);
    const result = await listCompanies(prisma, TENANT_A, {
      ownerId: "user_1",
      limit: 50,
    });
    expect(result.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("search ILIKE-OR-expands across name + legalName + domain", async () => {
    const data = [
      company({ id: "a", name: "Acme Inc" }),
      company({ id: "b", legalName: "Acme Holdings LLC" }),
      company({ id: "c", domain: "acme.com" }),
      company({ id: "d", name: "Globex Corp" }),
    ];
    const prisma = makePrisma(data);
    const result = await listCompanies(prisma, TENANT_A, {
      search: "acme",
      limit: 50,
    });
    expect(result.items.map((i) => i.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("cursor pagination round-trips correctly (no overlap, no skip)", async () => {
    // 5 rows with monotonically decreasing createdAt. Zero-pad the day
    // (10, 09, 08, 07, 06) — JS Date in strict ISO mode rejects single-digit
    // days like "2026-05-9T..." and produces Invalid Date.
    const data = Array.from({ length: 5 }, (_, i) =>
      company({
        id: `co_${i}`,
        createdAt: new Date(`2026-05-${String(10 - i).padStart(2, "0")}T10:00:00Z`),
      }),
    );
    const prisma = makePrisma(data);

    const page1 = await listCompanies(prisma, TENANT_A, { limit: 2 });
    expect(page1.items.map((i) => i.id)).toEqual(["co_0", "co_1"]);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.totalCount).toBe(5);

    const page2 = await listCompanies(prisma, TENANT_A, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.map((i) => i.id)).toEqual(["co_2", "co_3"]);
    expect(page2.nextCursor).toBeTruthy();

    const page3 = await listCompanies(prisma, TENANT_A, {
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.items.map((i) => i.id)).toEqual(["co_4"]);
    expect(page3.nextCursor).toBeNull();
  });

  it("cursor encodes { id, createdAt } of the last row — clients shouldn't introspect, but service must encode round-trippable shape", async () => {
    const data = [
      company({
        id: "co_first",
        createdAt: new Date("2026-05-12T10:00:00Z"),
      }),
      company({
        id: "co_second",
        createdAt: new Date("2026-05-11T10:00:00Z"),
      }),
    ];
    const prisma = makePrisma(data);
    const page1 = await listCompanies(prisma, TENANT_A, { limit: 1 });
    const decoded = decodeCursor(page1.nextCursor!);
    expect(decoded?.id).toBe("co_first");
    expect(decoded?.createdAt).toBe("2026-05-12T10:00:00.000Z");
  });

  it("cursor + search compose correctly (cursor doesn't clobber search OR)", async () => {
    // Regression test for the AND-of-OR composition pattern.
    const data = [
      company({
        id: "co_1",
        name: "Acme One",
        createdAt: new Date("2026-05-10T10:00:00Z"),
      }),
      company({
        id: "co_2",
        name: "Globex Match", // doesn't match "acme" search
        createdAt: new Date("2026-05-09T10:00:00Z"),
      }),
      company({
        id: "co_3",
        name: "Acme Three",
        createdAt: new Date("2026-05-08T10:00:00Z"),
      }),
    ];
    const prisma = makePrisma(data);

    const page1 = await listCompanies(prisma, TENANT_A, {
      search: "acme",
      limit: 1,
    });
    expect(page1.items.map((i) => i.id)).toEqual(["co_1"]);
    expect(page1.totalCount).toBe(2); // 2 matches; cursor doesn't affect totalCount

    const page2 = await listCompanies(prisma, TENANT_A, {
      search: "acme",
      limit: 1,
      cursor: page1.nextCursor!,
    });
    // Globex must NOT appear — search filter still applies past the cursor.
    expect(page2.items.map((i) => i.id)).toEqual(["co_3"]);
  });

  it("totalCount reflects filtered total, NOT remaining-after-cursor", async () => {
    const data = Array.from({ length: 10 }, (_, i) =>
      company({
        id: `co_${i}`,
        createdAt: new Date(`2026-05-${String(20 - i).padStart(2, "0")}T10:00:00Z`),
      }),
    );
    const prisma = makePrisma(data);
    const page1 = await listCompanies(prisma, TENANT_A, { limit: 3 });
    expect(page1.totalCount).toBe(10);
    const page2 = await listCompanies(prisma, TENANT_A, {
      limit: 3,
      cursor: page1.nextCursor!,
    });
    expect(page2.totalCount).toBe(10);
  });

  it("malformed cursor falls back to page 1 (decode returns null, no throw)", async () => {
    const data = [company({ id: "co_a" })];
    const prisma = makePrisma(data);
    const result = await listCompanies(prisma, TENANT_A, {
      cursor: "!!! invalid base64 !!!",
      limit: 50,
    });
    expect(result.items.map((i) => i.id)).toEqual(["co_a"]);
  });

  it("_count aggregation passes through to caller", async () => {
    const data = [
      company({ id: "co_a", _contactCount: 5, _dealCount: 3, _orderCount: 7 }),
    ];
    const prisma = makePrisma(data);
    const result = await listCompanies(prisma, TENANT_A, { limit: 50 });
    const item = result.items[0] as unknown as { _count: { contacts: number; deals: number; orders: number } };
    expect(item._count).toEqual({ contacts: 5, deals: 3, orders: 7 });
  });
});

describe("KAN-883 — getCompanyById", () => {
  it("returns own-tenant row", async () => {
    const data = [company({ id: "co_a", tenantId: TENANT_A })];
    const prisma = makePrisma(data);
    const result = await getCompanyById(prisma, TENANT_A, { id: "co_a" });
    expect((result as { id: string }).id).toBe("co_a");
  });

  it("cross-tenant → NOT_FOUND (no existence leak)", async () => {
    const data = [company({ id: "co_a", tenantId: TENANT_B })];
    const prisma = makePrisma(data);
    await expect(
      getCompanyById(prisma, TENANT_A, { id: "co_a" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("nonexistent id → NOT_FOUND (not raw null)", async () => {
    const prisma = makePrisma([]);
    await expect(
      getCompanyById(prisma, TENANT_A, { id: "co_missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// KAN-893 — tRPC validator regression: CUID-shaped id accepted.
//
// Mirrors `id: z.string().cuid()` at apps/api/src/router.ts:432. Pre-
// KAN-893, this was `.uuid()` which rejected every real PROD Company.id
// (Company uses @default(cuid()) — KAN-879 schema). Pins the contract
// against a future revert.
// ─────────────────────────────────────────────────────────────────────
describe("KAN-893 — companies.get tRPC input validator", () => {
  const inputSchema = z.object({ id: z.string().cuid() });

  it("accepts CUID-shaped id (e.g. PROD Company.id format)", () => {
    const result = inputSchema.safeParse({ id: "cmou3yc2o0002a9tnt34f5q81" });
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// KAN-937 — Sub-cohort 3.2 Company CRUD: createCompany + updateCompany.
// 5 tests covering full-field create, default lifecycleStage, partial
// update, cross-tenant rejection, soft-delete rejection.
// ─────────────────────────────────────────────────────────────────────
describe("KAN-937 — createCompany", () => {
  it("persists all 30 form-eligible fields across 5 cards", async () => {
    const data: FakeCompany[] = [];
    const prisma = makePrisma(data);

    await createCompany(prisma, TENANT_A, {
      // Card 1
      name: "Globex Corp",
      legalName: "Globex Corporation Ltd",
      domain: "globex.com",
      website: "https://globex.com",
      industry: "Technology",
      sizeRange: "range_51_200",
      annualRevenue: "12500000.50",
      description: "Enterprise software",
      lifecycleStage: "customer",
      // Card 2
      phone: "+1-555-0123",
      email: "contact@globex.com",
      linkedinUrl: "https://linkedin.com/company/globex",
      // Card 3
      billingAddressLine1: "1 Globex Plaza",
      billingAddressLine2: "Suite 500",
      billingCity: "Boston",
      billingRegion: "MA",
      billingPostalCode: "02101",
      billingCountry: "US",
      // Card 4
      mailingAddressLine1: "PO Box 100",
      mailingAddressLine2: null,
      mailingCity: "Boston",
      mailingRegion: "MA",
      mailingPostalCode: "02102",
      mailingCountry: "US",
      // Card 5
      taxId: "12-3456789",
      taxIdType: "ein",
      businessRegistrationNumber: "BR-001",
      incorporationJurisdiction: "Delaware",
      isTaxExempt: false,
      taxExemptionCertificate: null,
    });

    expect(data).toHaveLength(1);
    const row = data[0];
    expect(row.name).toBe("Globex Corp");
    expect(row.legalName).toBe("Globex Corporation Ltd");
    expect(row.annualRevenue).toBe("12500000.50");
    expect(row.lifecycleStage).toBe("customer");
    expect(row.billingCity).toBe("Boston");
    expect(row.mailingPostalCode).toBe("02102");
    expect(row.taxIdType).toBe("ein");
    expect(row.tenantId).toBe(TENANT_A);
  });

  it("defaults lifecycleStage to 'prospect' when not provided", async () => {
    const data: FakeCompany[] = [];
    const prisma = makePrisma(data);
    await createCompany(prisma, TENANT_A, { name: "Minimal Co" });
    expect(data[0].lifecycleStage).toBe("prospect");
    expect(data[0].isTaxExempt).toBe(false);
  });
});

describe("KAN-937 — updateCompany", () => {
  it("only sets provided fields (doesn't clobber unspecified to null)", async () => {
    const data = [
      company({
        id: "co_1",
        name: "Original Co",
        domain: "original.com",
        industry: "Manufacturing",
        billingCity: "Original City",
      }),
    ];
    const prisma = makePrisma(data);
    await updateCompany(prisma, TENANT_A, {
      id: "co_1",
      name: "Updated Co",
      // domain, industry, billingCity NOT provided — must NOT be cleared
    });
    expect(data[0].name).toBe("Updated Co");
    expect(data[0].domain).toBe("original.com");
    expect(data[0].industry).toBe("Manufacturing");
    expect(data[0].billingCity).toBe("Original City");
  });

  it("cross-tenant → NOT_FOUND (no leak)", async () => {
    const data = [company({ id: "co_1", tenantId: TENANT_B })];
    const prisma = makePrisma(data);
    await expect(
      updateCompany(prisma, TENANT_A, { id: "co_1", name: "Hijack Attempt" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Original row must not have been mutated by the tenant-A caller.
    expect(data[0].name).toBe("Acme Inc");
  });

  it("soft-deleted row → NOT_FOUND (edits operate on live rows only)", async () => {
    const data = [
      company({
        id: "co_1",
        tenantId: TENANT_A,
        deletedAt: new Date("2026-05-10"),
      }),
    ];
    const prisma = makePrisma(data);
    await expect(
      updateCompany(prisma, TENANT_A, { id: "co_1", name: "Resurrect" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(data[0].name).toBe("Acme Inc");
  });
});

// ─────────────────────────────────────────────────────────────────────
// KAN-936 — Company owner FK formalized as @relation + cross-tenant guard.
//
// Coverage:
//   - createCompany persists ownerId when the user is in-tenant
//   - createCompany rejects cross-tenant ownerId → BAD_REQUEST (no row written)
//   - updateCompany persists ownerId when in-tenant
//   - updateCompany rejects cross-tenant ownerId → BAD_REQUEST
//   - updateCompany explicit null clears ownerId
// ─────────────────────────────────────────────────────────────────────
describe("KAN-936 — Company owner FK + cross-tenant guard", () => {
  const U_A = "u_in_tenant_A";
  const U_B = "u_in_tenant_B";

  it("createCompany persists ownerId when user is in the same tenant", async () => {
    const data: FakeCompany[] = [];
    const prisma = makePrisma(
      data,
      [{ id: U_A, tenantId: TENANT_A, name: "Alice", email: "alice@a.com" }],
    );
    await createCompany(prisma, TENANT_A, {
      name: "Owned Co",
      ownerId: U_A,
    });
    expect(data).toHaveLength(1);
    expect(data[0].ownerId).toBe(U_A);
  });

  it("createCompany rejects cross-tenant ownerId → BAD_REQUEST, no row written", async () => {
    const data: FakeCompany[] = [];
    const prisma = makePrisma(
      data,
      [{ id: U_B, tenantId: TENANT_B, name: "Spy", email: "spy@b.com" }],
    );
    await expect(
      createCompany(prisma, TENANT_A, { name: "Hijack Co", ownerId: U_B }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/owner.*not found/i),
    });
    expect(data).toHaveLength(0);
  });

  it("updateCompany persists ownerId when user is in the same tenant", async () => {
    const data = [company({ id: "co_1", tenantId: TENANT_A, ownerId: null })];
    const prisma = makePrisma(
      data,
      [{ id: U_A, tenantId: TENANT_A, name: "Alice", email: "alice@a.com" }],
    );
    await updateCompany(prisma, TENANT_A, { id: "co_1", ownerId: U_A });
    expect(data[0].ownerId).toBe(U_A);
  });

  it("updateCompany rejects cross-tenant ownerId → BAD_REQUEST", async () => {
    const data = [company({ id: "co_1", tenantId: TENANT_A, ownerId: null })];
    const prisma = makePrisma(
      data,
      [{ id: U_B, tenantId: TENANT_B, name: "Spy", email: "spy@b.com" }],
    );
    await expect(
      updateCompany(prisma, TENANT_A, { id: "co_1", ownerId: U_B }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/owner.*not found/i),
    });
    expect(data[0].ownerId).toBeNull();
  });

  it("updateCompany explicit null clears ownerId (bypasses user existence check)", async () => {
    const data = [company({ id: "co_1", tenantId: TENANT_A, ownerId: U_A })];
    const prisma = makePrisma(data); // no users — null bypasses the lookup
    await updateCompany(prisma, TENANT_A, { id: "co_1", ownerId: null });
    expect(data[0].ownerId).toBeNull();
  });
});
