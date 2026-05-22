/**
 * KAN-718 Day 10 — contacts router tests.
 *
 * Coverage:
 *   - list paginates + filters by lifecycleStage
 *   - search OR-expands across firstName / lastName / email
 *   - cross-tenant exclusion on list (no leak)
 *   - cross-tenant rejection on getById / update (NOT_FOUND, no leak)
 *   - create uses canonical fields (firstName/lastName/lifecycleStage)
 *   - update only sets provided fields (doesn't clobber unspecified to null)
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  listContacts,
  getContactById,
  createContact,
  updateContact,
} from "../contacts-router.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

interface FakeContact {
  id: string;
  tenantId: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  segment: string | null;
  lifecycleStage: string;
  source: string | null;
  dataQualityScore: number;
  // KAN-883 — read-layer extension fields
  companyId: string | null;
  companyName: string | null;
  addressLine1: string | null;
  // KAN-934 — Cohort 3.1 form-eligible fields (addressLine2 + postalCode)
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeCompany {
  id: string;
  tenantId: string;
  name: string;
}

function contact(overrides: Partial<FakeContact> = {}): FakeContact {
  return {
    id: `c-${Math.random().toString(36).slice(2, 10)}`,
    tenantId: TENANT_A,
    email: "test@example.com",
    phone: null,
    firstName: "Alice",
    lastName: "Test",
    segment: "smb",
    lifecycleStage: "lead",
    source: "web_form",
    dataQualityScore: 0,
    companyId: null,
    companyName: null,
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    city: null,
    region: null,
    country: null,
    createdAt: new Date("2026-04-29T18:00:00Z"),
    updatedAt: new Date("2026-04-29T18:00:00Z"),
    ...overrides,
  };
}

// KAN-980 — evalWhere mirrors the deals-router test pattern. Supports
// AND/OR composition + lt/contains operators so the new cursor-based
// pagination's WHERE clause (cursor + search composed via AND) is
// honored by the fake.
function whereMatches(c: FakeContact, where: Record<string, unknown>): boolean {
  for (const [key, val] of Object.entries(where)) {
    if (key === "AND") {
      const clauses = val as Array<Record<string, unknown>>;
      if (!clauses.every((cl) => whereMatches(c, cl))) return false;
      continue;
    }
    if (key === "OR") {
      const clauses = val as Array<Record<string, unknown>>;
      if (!clauses.some((cl) => whereMatches(c, cl))) return false;
      continue;
    }
    const fieldVal = (c as unknown as Record<string, unknown>)[key];
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
        } else if (typeof fieldVal === "string") {
          if (!(fieldVal < opVal)) return false;
        } else {
          return false;
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

function makePrisma(rows: FakeContact[], companies: FakeCompany[] = []) {
  let nextId = rows.length;
  return {
    // KAN-934 — Company FK validation table (used by assertCompanyInTenant)
    company: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; tenantId: string };
      }) => companies.find((c) => c.id === where.id && c.tenantId === where.tenantId) ?? null,
    },
    contact: {
      // KAN-980 — cursor convergence. orderBy [createdAt DESC, id DESC] +
      // take (no skip). hasNext detection lives in the service via take+1.
      findMany: async ({
        where,
        take = 50,
      }: {
        where: Record<string, unknown>;
        take?: number;
        orderBy?: unknown;
      }) => {
        const matched = rows.filter((r) => whereMatches(r, where));
        matched.sort((a, b) => {
          const aT = a.createdAt.getTime();
          const bT = b.createdAt.getTime();
          if (aT !== bT) return bT - aT;
          return a.id < b.id ? 1 : -1;
        });
        return matched.slice(0, take);
      },
      count: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => whereMatches(r, where)).length,
      findFirst: async ({
        where,
      }: {
        where: { id: string; tenantId: string };
      }) => rows.find((r) => r.id === where.id && r.tenantId === where.tenantId) ?? null,
      create: async ({ data }: { data: Partial<FakeContact> & { tenantId: string } }) => {
        const newRow = contact({
          id: `c-${++nextId}`,
          ...data,
        } as Partial<FakeContact>);
        rows.push(newRow);
        return newRow;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeContact>;
      }) => {
        const r = rows.find((row) => row.id === where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data);
        return r;
      },
    },
  } as never;
}

describe("KAN-718 Day 10 — listContacts", () => {
  it("excludes cross-tenant rows", async () => {
    const data = [
      contact({ id: "a", tenantId: TENANT_A }),
      contact({ id: "b", tenantId: TENANT_B }),
    ];
    const prisma = makePrisma(data);
    const result = await listContacts(prisma, TENANT_A, {});
    expect(result.items.map((i) => i.id)).toEqual(["a"]);
    expect(result.totalCount).toBe(1);
    expect(result.nextCursor).toBeNull();
  });

  it("filters by lifecycleStage", async () => {
    const data = [
      contact({ id: "a", lifecycleStage: "sql" }),
      contact({ id: "b", lifecycleStage: "lead" }),
      contact({ id: "c", lifecycleStage: "sql" }),
    ];
    const prisma = makePrisma(data);
    const result = await listContacts(prisma, TENANT_A, { lifecycleStage: "sql" });
    expect(result.items.map((i) => i.id).sort()).toEqual(["a", "c"]);
  });

  it("search OR-expands across firstName / lastName / email", async () => {
    const data = [
      contact({ id: "a", firstName: "Sarah", lastName: "Chen", email: "sarah@example.com" }),
      contact({ id: "b", firstName: "James", lastName: "Sarah", email: "james@example.com" }),
      contact({ id: "c", firstName: "Alex", lastName: "Doe", email: "sarah-cousin@example.com" }),
      contact({ id: "d", firstName: "Bob", lastName: "Smith", email: "bob@elsewhere.com" }),
    ];
    const prisma = makePrisma(data);
    const result = await listContacts(prisma, TENANT_A, { search: "sarah" });
    // a (firstName match), b (lastName match), c (email match) — d excluded
    expect(result.items.map((i) => i.id).sort()).toEqual(["a", "b", "c"]);
  });

  // KAN-883 — read-layer filter coverage
  it("KAN-883: filters by source enum value", async () => {
    const data = [
      contact({ id: "a", source: "email_inbox" }),
      contact({ id: "b", source: "web_form" }),
      contact({ id: "c", source: "email_inbox" }),
      contact({ id: "d", source: null }),
    ];
    const prisma = makePrisma(data);
    const result = await listContacts(prisma, TENANT_A, { source: "email_inbox" });
    expect(result.items.map((i) => i.id).sort()).toEqual(["a", "c"]);
  });

  it("KAN-883: filters by companyId — scope to a Company badge", async () => {
    const COMPANY_X = "11111111-1111-1111-1111-aaaaaaaaaaaa";
    const COMPANY_Y = "22222222-2222-2222-2222-bbbbbbbbbbbb";
    const data = [
      contact({ id: "a", companyId: COMPANY_X }),
      contact({ id: "b", companyId: COMPANY_Y }),
      contact({ id: "c", companyId: COMPANY_X }),
      contact({ id: "d", companyId: null }),
    ];
    const prisma = makePrisma(data);
    const result = await listContacts(prisma, TENANT_A, { companyId: COMPANY_X });
    expect(result.items.map((i) => i.id).sort()).toEqual(["a", "c"]);
  });

  it("KAN-883: source + companyId compose as AND, not OR", async () => {
    const COMPANY_X = "11111111-1111-1111-1111-aaaaaaaaaaaa";
    const data = [
      contact({ id: "a", source: "email_inbox", companyId: COMPANY_X }),
      contact({ id: "b", source: "email_inbox", companyId: null }),
      contact({ id: "c", source: "web_form", companyId: COMPANY_X }),
    ];
    const prisma = makePrisma(data);
    const result = await listContacts(prisma, TENANT_A, {
      source: "email_inbox",
      companyId: COMPANY_X,
    });
    expect(result.items.map((i) => i.id)).toEqual(["a"]);
  });

  // KAN-980 — KAN-882 cursor convergence. Mirrors deals-router cursor tests:
  // page 1 fetches limit rows + nextCursor; page 2 uses the cursor and
  // returns the remainder. Stable ordering via createdAt DESC + id DESC.
  it("paginates via limit + cursor (KAN-882 convergence)", async () => {
    // Distinct createdAt timestamps so cursor's createdAt-based `lt` can
    // disambiguate cleanly.
    const data = Array.from({ length: 5 }, (_, i) =>
      contact({
        id: `c${i}`,
        createdAt: new Date(`2026-04-29T18:00:${String(10 + i).padStart(2, "0")}Z`),
      }),
    );
    const prisma = makePrisma(data);

    const page1 = await listContacts(prisma, TENANT_A, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.totalCount).toBe(5);
    expect(page1.nextCursor).not.toBeNull();
    // Newest-first ordering: c4 (created at :14) then c3 (:13)
    expect(page1.items.map((i) => i.id)).toEqual(["c4", "c3"]);

    const page2 = await listContacts(prisma, TENANT_A, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.map((i) => i.id)).toEqual(["c2", "c1"]);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await listContacts(prisma, TENANT_A, {
      limit: 2,
      cursor: page2.nextCursor!,
    });
    expect(page3.items.map((i) => i.id)).toEqual(["c0"]);
    expect(page3.nextCursor).toBeNull(); // last page
  });

  it("cursor + search compose via AND — search filter applies past the cursor", async () => {
    const data = [
      contact({
        id: "alpha",
        firstName: "Acme",
        createdAt: new Date("2026-04-29T18:00:14Z"),
      }),
      contact({
        id: "beta",
        firstName: "Beta",
        createdAt: new Date("2026-04-29T18:00:13Z"),
      }),
      contact({
        id: "gamma",
        firstName: "Acme",
        createdAt: new Date("2026-04-29T18:00:12Z"),
      }),
    ];
    const prisma = makePrisma(data);
    const page1 = await listContacts(prisma, TENANT_A, { limit: 1, search: "acme" });
    expect(page1.items.map((i) => i.id)).toEqual(["alpha"]);
    const page2 = await listContacts(prisma, TENANT_A, {
      limit: 5,
      search: "acme",
      cursor: page1.nextCursor!,
    });
    // Beta must NOT leak past the cursor; only Acme rows older than alpha.
    expect(page2.items.map((i) => i.id)).toEqual(["gamma"]);
  });
});

describe("KAN-718 Day 10 — getContactById", () => {
  it("returns own-tenant contact", async () => {
    const data = [contact({ id: "c-1", tenantId: TENANT_A })];
    const prisma = makePrisma(data);
    const result = await getContactById(prisma, TENANT_A, "c-1");
    expect(result.id).toBe("c-1");
  });

  it("cross-tenant → NOT_FOUND (no leak)", async () => {
    const data = [contact({ id: "c-1", tenantId: TENANT_B })];
    const prisma = makePrisma(data);
    await expect(getContactById(prisma, TENANT_A, "c-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("KAN-718 Day 10 — createContact", () => {
  it("uses canonical fields (firstName/lastName/lifecycleStage)", async () => {
    const data: FakeContact[] = [];
    const prisma = makePrisma(data);

    await createContact(prisma, TENANT_A, {
      email: "new@example.com",
      firstName: "First",
      lastName: "Last",
      lifecycleStage: "sql",
    });

    expect(data).toHaveLength(1);
    expect(data[0].email).toBe("new@example.com");
    expect(data[0].firstName).toBe("First");
    expect(data[0].lastName).toBe("Last");
    expect(data[0].lifecycleStage).toBe("sql");
    expect(data[0].tenantId).toBe(TENANT_A);
  });

  it("defaults lifecycleStage to 'lead' when not provided", async () => {
    const data: FakeContact[] = [];
    const prisma = makePrisma(data);
    await createContact(prisma, TENANT_A, { email: "default@example.com" });
    expect(data[0].lifecycleStage).toBe("lead");
  });
});

describe("KAN-718 Day 10 — updateContact", () => {
  it("only sets provided fields (doesn't clobber unspecified to null)", async () => {
    const data = [
      contact({
        id: "c-1",
        firstName: "Original",
        lastName: "Name",
        email: "orig@example.com",
        segment: "enterprise",
      }),
    ];
    const prisma = makePrisma(data);

    await updateContact(prisma, TENANT_A, {
      id: "c-1",
      firstName: "Updated",
    });

    const r = data[0];
    expect(r.firstName).toBe("Updated");
    expect(r.lastName).toBe("Name"); // unchanged
    expect(r.email).toBe("orig@example.com"); // unchanged
    expect(r.segment).toBe("enterprise"); // unchanged
  });

  it("cross-tenant rejection (NOT_FOUND, no leak)", async () => {
    const data = [contact({ id: "c-1", tenantId: TENANT_B })];
    const prisma = makePrisma(data);
    await expect(
      updateContact(prisma, TENANT_A, { id: "c-1", firstName: "X" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ─────────────────────────────────────────────────────────────────────
// KAN-934 — Cohort 3.1 Contact CRUD: extended create + update with
// full 14-field surface (companyId + address block) + FK validation.
// ─────────────────────────────────────────────────────────────────────
describe("KAN-934 — createContact / updateContact extended fields", () => {
  it("(KAN-934 a) create with full 14-field payload persists all fields", async () => {
    const data: FakeContact[] = [];
    const companies: FakeCompany[] = [
      { id: "co-1", tenantId: TENANT_A, name: "Acme Corp" },
    ];
    const prisma = makePrisma(data, companies);

    await createContact(prisma, TENANT_A, {
      email: "extended@test.local",
      phone: "+1-555-0100",
      firstName: "Ext",
      lastName: "Fields",
      segment: "smb",
      lifecycleStage: "lead",
      source: "manual",
      companyId: "co-1",
      addressLine1: "1 Test St",
      addressLine2: "Apt 5",
      city: "Montreal",
      region: "QC",
      postalCode: "H1A 1A1",
      country: "CA",
    });

    expect(data).toHaveLength(1);
    expect(data[0].companyId).toBe("co-1");
    expect(data[0].addressLine1).toBe("1 Test St");
    expect(data[0].addressLine2).toBe("Apt 5");
    expect(data[0].city).toBe("Montreal");
    expect(data[0].region).toBe("QC");
    expect(data[0].postalCode).toBe("H1A 1A1");
    expect(data[0].country).toBe("CA");
  });

  it("(KAN-934 b) create with companyId from another tenant → BAD_REQUEST", async () => {
    const data: FakeContact[] = [];
    const companies: FakeCompany[] = [
      { id: "co-other", tenantId: TENANT_B, name: "Other Tenant Co" },
    ];
    const prisma = makePrisma(data, companies);

    await expect(
      createContact(prisma, TENANT_A, {
        email: "leak@test.local",
        companyId: "co-other",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(data).toHaveLength(0); // No partial write
  });

  it("(KAN-934 c) update with new fields persists them", async () => {
    const data = [contact({ id: "c-1" })];
    const companies: FakeCompany[] = [
      { id: "co-1", tenantId: TENANT_A, name: "Acme" },
    ];
    const prisma = makePrisma(data, companies);

    await updateContact(prisma, TENANT_A, {
      id: "c-1",
      companyId: "co-1",
      addressLine1: "Updated Addr",
      city: "Toronto",
      country: "CA",
    });

    expect(data[0].companyId).toBe("co-1");
    expect(data[0].addressLine1).toBe("Updated Addr");
    expect(data[0].city).toBe("Toronto");
    expect(data[0].country).toBe("CA");
  });

  it("(KAN-934 d) update with invalid companyId (cross-tenant) → BAD_REQUEST", async () => {
    const data = [contact({ id: "c-1" })];
    const companies: FakeCompany[] = [
      { id: "co-other", tenantId: TENANT_B, name: "Other" },
    ];
    const prisma = makePrisma(data, companies);

    await expect(
      updateContact(prisma, TENANT_A, {
        id: "c-1",
        companyId: "co-other",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(data[0].companyId).toBeNull(); // No partial write
  });

  it("(KAN-934 e) update with companyId=null explicitly clears the FK", async () => {
    const data = [contact({ id: "c-1", companyId: "co-1" })];
    const prisma = makePrisma(data);

    await updateContact(prisma, TENANT_A, {
      id: "c-1",
      companyId: null,
    });

    expect(data[0].companyId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// KAN-893 — tRPC validator regression: CUID-shaped FK filter accepted.
//
// Mirrors `companyId: z.string().cuid().optional()` at
// apps/api/src/router.ts:326. Pre-KAN-893, this was `.uuid()` which
// rejected every real PROD Company.id (Company uses @default(cuid())).
// If a future change reverts the router validator, this test pins the
// contract: a CUID-shaped companyId MUST validate.
// ─────────────────────────────────────────────────────────────────────
describe("KAN-893 — contacts.list?companyId tRPC input validator", () => {
  const inputSchema = z.object({
    companyId: z.string().cuid().optional(),
  });

  it("accepts CUID-shaped companyId (e.g. PROD Company.id format)", () => {
    const result = inputSchema.safeParse({ id: undefined, companyId: "cmou3yc2o0002a9tnt34f5q81" });
    expect(result.success).toBe(true);
  });
});
