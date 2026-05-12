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
  createdAt: Date;
  updatedAt: Date;
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
    createdAt: new Date("2026-04-29T18:00:00Z"),
    updatedAt: new Date("2026-04-29T18:00:00Z"),
    ...overrides,
  };
}

function whereMatches(c: FakeContact, where: Record<string, unknown>): boolean {
  if (where.tenantId && c.tenantId !== where.tenantId) return false;
  if (where.lifecycleStage && c.lifecycleStage !== where.lifecycleStage) return false;
  const or = where.OR as Array<Record<string, { contains: string }>> | undefined;
  if (or) {
    const anyMatch = or.some((cond) => {
      const [field, m] = Object.entries(cond)[0];
      const val = (c as unknown as Record<string, string | null>)[field];
      return typeof val === "string" && val.toLowerCase().includes(m.contains.toLowerCase());
    });
    if (!anyMatch) return false;
  }
  return true;
}

function makePrisma(rows: FakeContact[]) {
  let nextId = rows.length;
  return {
    contact: {
      findMany: async ({
        where,
        skip = 0,
        take = 50,
      }: {
        where: Record<string, unknown>;
        skip?: number;
        take?: number;
      }) => rows.filter((r) => whereMatches(r, where)).slice(skip, skip + take),
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
    expect(result.total).toBe(1);
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

  it("paginates via limit + offset", async () => {
    const data = Array.from({ length: 5 }, (_, i) => contact({ id: `c${i}` }));
    const prisma = makePrisma(data);

    const page1 = await listContacts(prisma, TENANT_A, { limit: 2, offset: 0 });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(5);

    const page2 = await listContacts(prisma, TENANT_A, { limit: 2, offset: 4 });
    expect(page2.items).toHaveLength(1);
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
