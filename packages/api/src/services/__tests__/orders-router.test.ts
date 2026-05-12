/**
 * KAN-883 — Orders router service tests.
 *
 * Coverage:
 *   - Multi-tenant isolation
 *   - Cursor pagination on placedAt (not createdAt) — order-specific
 *   - Filters: status, contactId, companyId, dealId
 *   - Search ILIKE on orderNumber
 *   - getOrderById returns NOT_FOUND on cross-tenant + nonexistent id
 */
import { describe, it, expect } from "vitest";
import { listOrders, getOrderById } from "../orders-router.js";
import { decodeCursor } from "../_pagination.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

interface FakeOrder {
  id: string;
  tenantId: string;
  contactId: string;
  companyId: string | null;
  dealId: string | null;
  orderNumber: string;
  status: string;
  totalAmount: number;
  grandTotal: number;
  currency: string;
  placedAt: Date;
  paidAt: Date | null;
  paymentMethod: string | null;
  paymentProvider: string | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

function order(overrides: Partial<FakeOrder> = {}): FakeOrder {
  return {
    id: `ord_${Math.random().toString(36).slice(2, 10)}`,
    tenantId: TENANT_A,
    contactId: "ct_1",
    companyId: null,
    dealId: null,
    orderNumber: "ORD-001",
    status: "pending",
    totalAmount: 100,
    grandTotal: 100,
    currency: "USD",
    placedAt: new Date("2026-05-10T10:00:00Z"),
    paidAt: null,
    paymentMethod: null,
    paymentProvider: null,
    source: "manual",
    createdAt: new Date("2026-05-10T10:00:00Z"),
    updatedAt: new Date("2026-05-10T10:00:00Z"),
    ...overrides,
  };
}

function evalWhere(o: FakeOrder, where: Record<string, unknown>): boolean {
  for (const [key, val] of Object.entries(where)) {
    if (key === "AND") {
      const clauses = val as Array<Record<string, unknown>>;
      if (!clauses.every((cl) => evalWhere(o, cl))) return false;
      continue;
    }
    if (key === "OR") {
      const clauses = val as Array<Record<string, unknown>>;
      if (!clauses.some((cl) => evalWhere(o, cl))) return false;
      continue;
    }
    const fieldVal = (o as unknown as Record<string, unknown>)[key];
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

function makePrisma(rows: FakeOrder[]) {
  return {
    order: {
      findMany: async ({
        where,
        take,
      }: {
        where: Record<string, unknown>;
        take: number;
      }) => {
        const matched = rows.filter((r) => evalWhere(r, where));
        matched.sort((a, b) => {
          const aT = a.placedAt.getTime();
          const bT = b.placedAt.getTime();
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
  } as never;
}

describe("KAN-883 — listOrders", () => {
  it("excludes cross-tenant rows", async () => {
    const data = [
      order({ id: "ord_a", tenantId: TENANT_A }),
      order({ id: "ord_b", tenantId: TENANT_B }),
    ];
    const prisma = makePrisma(data);
    const result = await listOrders(prisma, TENANT_A, { limit: 50 });
    expect(result.items.map((i) => i.id)).toEqual(["ord_a"]);
    expect(result.totalCount).toBe(1);
  });

  it("filters by status", async () => {
    const data = [
      order({ id: "a", status: "paid" }),
      order({ id: "b", status: "pending" }),
      order({ id: "c", status: "paid" }),
    ];
    const prisma = makePrisma(data);
    const result = await listOrders(prisma, TENANT_A, { status: "paid", limit: 50 });
    expect(result.items.map((i) => i.id).sort()).toEqual(["a", "c"]);
  });

  it("filters by contactId + companyId + dealId compose as AND", async () => {
    const CO = "11111111-1111-1111-1111-aaaaaaaaaaaa";
    const DEAL = "22222222-2222-2222-2222-bbbbbbbbbbbb";
    const data = [
      order({ id: "match", contactId: "ct_1", companyId: CO, dealId: DEAL }),
      order({ id: "wrong-contact", contactId: "ct_2", companyId: CO, dealId: DEAL }),
      order({ id: "no-company", contactId: "ct_1", companyId: null, dealId: DEAL }),
      order({ id: "no-deal", contactId: "ct_1", companyId: CO, dealId: null }),
    ];
    const prisma = makePrisma(data);
    const result = await listOrders(prisma, TENANT_A, {
      contactId: "ct_1",
      companyId: CO,
      dealId: DEAL,
      limit: 50,
    });
    expect(result.items.map((i) => i.id)).toEqual(["match"]);
  });

  it("search ILIKE matches orderNumber", async () => {
    const data = [
      order({ id: "a", orderNumber: "INV-2026-001" }),
      order({ id: "b", orderNumber: "INV-2026-002" }),
      order({ id: "c", orderNumber: "RMA-001" }),
    ];
    const prisma = makePrisma(data);
    const result = await listOrders(prisma, TENANT_A, {
      search: "inv-2026",
      limit: 50,
    });
    expect(result.items.map((i) => i.id).sort()).toEqual(["a", "b"]);
  });

  it("orders by placedAt DESC + cursor encodes placedAt (not createdAt)", async () => {
    // Distinct createdAt vs placedAt to prove the cursor uses placedAt.
    const data = [
      order({
        id: "ord_recent_placed",
        placedAt: new Date("2026-05-12T10:00:00Z"),
        createdAt: new Date("2025-01-01T10:00:00Z"), // ancient createdAt
      }),
      order({
        id: "ord_older_placed",
        placedAt: new Date("2026-05-10T10:00:00Z"),
        createdAt: new Date("2026-05-12T10:00:00Z"), // newer createdAt
      }),
    ];
    const prisma = makePrisma(data);
    const page1 = await listOrders(prisma, TENANT_A, { limit: 1 });
    // ord_recent_placed comes first by placedAt DESC, despite older createdAt
    expect(page1.items.map((i) => i.id)).toEqual(["ord_recent_placed"]);
    const decoded = decodeCursor(page1.nextCursor!);
    expect(decoded?.id).toBe("ord_recent_placed");
    // The cursor's createdAt slot carries placedAt (not the row's literal
    // createdAt) — see _pagination.ts module docs.
    expect(decoded?.createdAt).toBe("2026-05-12T10:00:00.000Z");
  });

  it("cursor pagination round-trips (no overlap, no skip)", async () => {
    const data = Array.from({ length: 4 }, (_, i) =>
      order({
        id: `ord_${i}`,
        placedAt: new Date(`2026-05-${15 - i}T10:00:00Z`),
      }),
    );
    const prisma = makePrisma(data);

    const page1 = await listOrders(prisma, TENANT_A, { limit: 2 });
    expect(page1.items.map((i) => i.id)).toEqual(["ord_0", "ord_1"]);
    expect(page1.totalCount).toBe(4);

    const page2 = await listOrders(prisma, TENANT_A, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items.map((i) => i.id)).toEqual(["ord_2", "ord_3"]);
    expect(page2.nextCursor).toBeNull();
  });
});

describe("KAN-883 — getOrderById", () => {
  it("returns own-tenant row", async () => {
    const data = [order({ id: "ord_a", tenantId: TENANT_A })];
    const prisma = makePrisma(data);
    const result = await getOrderById(prisma, TENANT_A, { id: "ord_a" });
    expect((result as { id: string }).id).toBe("ord_a");
  });

  it("cross-tenant → NOT_FOUND", async () => {
    const data = [order({ id: "ord_a", tenantId: TENANT_B })];
    const prisma = makePrisma(data);
    await expect(
      getOrderById(prisma, TENANT_A, { id: "ord_a" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("nonexistent id → NOT_FOUND", async () => {
    const prisma = makePrisma([]);
    await expect(
      getOrderById(prisma, TENANT_A, { id: "ord_missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
