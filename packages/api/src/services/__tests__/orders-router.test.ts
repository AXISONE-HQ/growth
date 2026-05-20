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
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { listOrders, getOrderById, createOrder, updateOrder } from "../orders-router.js";
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
  // KAN-945 — money fields (Decimal as string when set via mutation)
  totalAmount: number | string;
  taxAmount?: number | string;
  discountAmount?: number | string;
  grandTotal: number | string;
  currency: string;
  // KAN-945 — datetime fields
  placedAt: Date;
  paidAt: Date | null;
  refundedAt?: Date | null;
  cancelledAt?: Date | null;
  paymentMethod: string | null;
  paymentProvider: string | null;
  providerOrderId?: string | null;
  source: string;
  attributionFirstSource?: string | null;
  attributionLastSource?: string | null;
  customerNotes?: string | null;
  internalNotes?: string | null;
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

// KAN-945 — FK validation fixtures + call tracker for type-shape assertions.
interface FakeContact {
  id: string;
  tenantId: string;
}
interface FakeCompany {
  id: string;
  tenantId: string;
}
interface FakeDeal {
  id: string;
  tenantId: string;
}
interface CallTracker {
  createArgs: Array<Record<string, unknown>>;
  updateArgs: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
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

function makePrisma(
  rows: FakeOrder[],
  contacts: FakeContact[] = [],
  companies: FakeCompany[] = [],
  deals: FakeDeal[] = [],
  tracker: CallTracker = { createArgs: [], updateArgs: [] },
) {
  let nextId = rows.length;
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
      // KAN-945 — create + update support. Tracks exact args for type-shape
      // assertions on data reaching Prisma. Simulates P2002 unique-collision
      // on @@unique([tenantId, orderNumber]).
      create: async ({ data }: { data: Partial<FakeOrder> & { tenantId: string; contactId: string; orderNumber: string } }) => {
        tracker.createArgs.push(data as Record<string, unknown>);
        // Simulate @@unique([tenantId, orderNumber]) collision.
        const dup = rows.find(
          (r) => r.tenantId === data.tenantId && r.orderNumber === data.orderNumber,
        );
        if (dup) {
          throw new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed on the fields: (`tenant_id`, `order_number`)",
            {
              code: "P2002",
              clientVersion: "test",
              meta: { target: ["tenant_id", "order_number"] },
            },
          );
        }
        const newRow = order({
          id: `ord_${++nextId}`,
          ...data,
        } as Partial<FakeOrder>);
        rows.push(newRow);
        return newRow;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        tracker.updateArgs.push({ where, data });
        const r = rows.find((row) => row.id === where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      },
    },
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
    deal: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; tenantId: string };
      }) =>
        deals.find((d) => d.id === where.id && d.tenantId === where.tenantId) ?? null,
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

// ─────────────────────────────────────────────────────────────────────
// KAN-893 — tRPC validator regression: CUID-shaped ids + FK filters
// accepted. Mirrors apps/api/src/router.ts:489 (orders.get),
// router.ts:477 (companyId filter), and router.ts:478 (dealId filter).
// Pre-KAN-893, all three were `.uuid()` which rejected every real PROD
// Order/Company/Deal id (all three use @default(cuid()) — KAN-879).
// ─────────────────────────────────────────────────────────────────────
describe("KAN-893 — orders.get tRPC input validator", () => {
  const inputSchema = z.object({ id: z.string().cuid() });

  it("accepts CUID-shaped id (e.g. PROD Order.id format)", () => {
    const result = inputSchema.safeParse({ id: "cmou3yc2o0002a9tnt34f5q81" });
    expect(result.success).toBe(true);
  });
});

describe("KAN-893 — orders.list?companyId tRPC input validator", () => {
  const inputSchema = z.object({
    companyId: z.string().cuid().optional(),
  });

  it("accepts CUID-shaped companyId filter", () => {
    const result = inputSchema.safeParse({ companyId: "cmou3yc2o0002a9tnt34f5q81" });
    expect(result.success).toBe(true);
  });
});

describe("KAN-893 — orders.list?dealId tRPC input validator", () => {
  const inputSchema = z.object({
    dealId: z.string().cuid().optional(),
  });

  it("accepts CUID-shaped dealId filter", () => {
    const result = inputSchema.safeParse({ dealId: "cmou3yc2o0002a9tnt34f5q81" });
    expect(result.success).toBe(true);
  });
});

// KAN-944 — orders.list?contactId Zod validator. Contact.id is
// @default(uuid()) (verified directly in schema.prisma — KAN-944 sweep).
//
// History:
//  - KAN-893 originally fixed Deal/Order/Company `.uuid() → .cuid()` for
//    cuid-defaulted entity ids. KAN-893 did NOT touch contactId because
//    Contact.id is uuid (correctly).
//  - KAN-945 Q9 (2026-05-20) erroneously flipped contactId from .uuid()
//    to .cuid() based on a wrong-premise audit claim. The smoke didn't
//    catch this because the orders.list?contactId filter wasn't exercised.
//  - KAN-944 (this revert, 2026-05-20) restores .uuid(). Per-procedure
//    sweep of all 82 .uuid()/.cuid() in router.ts confirmed this was the
//    ONLY validator mismatch.
describe("KAN-944 — orders.list?contactId tRPC input validator", () => {
  const inputSchema = z.object({
    contactId: z.string().uuid().optional(),
  });

  it("accepts UUID-shaped contactId filter (Contact.id is uuid)", () => {
    const result = inputSchema.safeParse({
      contactId: "11111111-1111-1111-1111-111111111111",
    });
    expect(result.success).toBe(true);
  });

  it("rejects CUID-shaped contactId (KAN-945 Q9 misfire would have accepted)", () => {
    // Post-revert, the validator rejects CUID. KAN-945 Q9 had inverted this.
    const result = inputSchema.safeParse({
      contactId: "cmou3yc2o0002a9tnt34f5q81",
    });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// KAN-945 — Sub-cohort 3.4 Order CRUD: createOrder + updateOrder.
//
// Coverage per Phase 4 acceptance gate:
//   - Happy path with all FKs validated
//   - Cross-tenant rejection for contactId (req) + companyId/dealId (opt)
//   - Duplicate orderNumber (P2002 → friendly BAD_REQUEST, Q8)
//   - Type-shape assertions on data reaching prisma.order.create:
//     * Date instances for placedAt / paidAt / refundedAt / cancelledAt
//     * Decimal as string for totalAmount / taxAmount / discountAmount /
//       grandTotal
//   - Q6.1 time-preservation: updateOrder must NOT include omitted date
//     fields in the data argument to prisma.order.update — proves
//     original DateTime is preserved byte-for-byte (load-bearing
//     guarantee against silently truncating webhook-sourced timestamps).
// ─────────────────────────────────────────────────────────────────────
const C_1 = "ct_1";
const CO_1 = "co_1";
const D_1 = "dl_1";

describe("KAN-945 — createOrder", () => {
  it("happy path: creates an order with all FKs validated + type-shape correct", async () => {
    const data: FakeOrder[] = [];
    const tracker: CallTracker = { createArgs: [], updateArgs: [] };
    const prisma = makePrisma(
      data,
      [{ id: C_1, tenantId: TENANT_A }],
      [{ id: CO_1, tenantId: TENANT_A }],
      [{ id: D_1, tenantId: TENANT_A }],
      tracker,
    );

    await createOrder(prisma, TENANT_A, {
      orderNumber: "ORD-2026-001",
      status: "paid",
      source: "manual",
      totalAmount: "100.00",
      taxAmount: "8.50",
      discountAmount: "0.00",
      grandTotal: "108.50",
      currency: "USD",
      paymentMethod: "card",
      paymentProvider: "stripe",
      providerOrderId: "ch_test_123",
      placedAt: "2026-05-20",
      paidAt: "2026-05-20",
      refundedAt: null,
      cancelledAt: null,
      contactId: C_1,
      companyId: CO_1,
      dealId: D_1,
      attributionFirstSource: "organic_search",
      attributionLastSource: "direct",
      customerNotes: "Customer asked about extended warranty",
      internalNotes: "Approved by sales lead",
    });

    expect(data).toHaveLength(1);
    const row = data[0];
    expect(row.orderNumber).toBe("ORD-2026-001");
    expect(row.contactId).toBe(C_1);
    expect(row.companyId).toBe(CO_1);
    expect(row.dealId).toBe(D_1);

    // Q-acceptance: type-shape assertions on data reaching Prisma.
    // The 3.3 / KAN-942 lesson — mock-passed/prod-500 gap. These assertions
    // would have caught the date-string failure mode without real Prisma.
    const args = tracker.createArgs[0];
    expect(args.placedAt).toBeInstanceOf(Date);
    expect((args.placedAt as Date).toISOString()).toBe("2026-05-20T00:00:00.000Z");
    expect(args.paidAt).toBeInstanceOf(Date);
    expect(args.refundedAt).toBeNull();
    expect(args.cancelledAt).toBeNull();
    // Decimal fields arrive as strings; Prisma coerces.
    expect(args.totalAmount).toBe("100.00");
    expect(args.taxAmount).toBe("8.50");
    expect(args.discountAmount).toBe("0.00");
    expect(args.grandTotal).toBe("108.50");
  });

  it("rejects cross-tenant contactId (required FK)", async () => {
    const data: FakeOrder[] = [];
    const prisma = makePrisma(
      data,
      [{ id: C_1, tenantId: TENANT_B }], // wrong tenant
    );
    await expect(
      createOrder(prisma, TENANT_A, {
        orderNumber: "ORD-1",
        contactId: C_1,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/contact not found/i),
    });
    expect(data).toHaveLength(0);
  });

  it("rejects cross-tenant companyId (optional FK, when provided)", async () => {
    const data: FakeOrder[] = [];
    const prisma = makePrisma(
      data,
      [{ id: C_1, tenantId: TENANT_A }],
      [{ id: CO_1, tenantId: TENANT_B }], // wrong tenant
    );
    await expect(
      createOrder(prisma, TENANT_A, {
        orderNumber: "ORD-1",
        contactId: C_1,
        companyId: CO_1,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/company not found/i),
    });
  });

  it("rejects cross-tenant dealId (optional FK, when provided)", async () => {
    const data: FakeOrder[] = [];
    const prisma = makePrisma(
      data,
      [{ id: C_1, tenantId: TENANT_A }],
      [],
      [{ id: D_1, tenantId: TENANT_B }], // wrong tenant
    );
    await expect(
      createOrder(prisma, TENANT_A, {
        orderNumber: "ORD-1",
        contactId: C_1,
        dealId: D_1,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/deal not found/i),
    });
  });

  it("Q8: duplicate orderNumber (P2002) → friendly BAD_REQUEST (not 500)", async () => {
    const data: FakeOrder[] = [
      order({ id: "existing", tenantId: TENANT_A, orderNumber: "ORD-DUP" }),
    ];
    const prisma = makePrisma(data, [{ id: C_1, tenantId: TENANT_A }]);
    await expect(
      createOrder(prisma, TENANT_A, {
        orderNumber: "ORD-DUP",
        contactId: C_1,
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/order number already exists/i),
    });
  });

  it("Q8: unique-collision in a DIFFERENT tenant succeeds (per-tenant uniqueness)", async () => {
    // Tenant B has ORD-DUP. Tenant A creating ORD-DUP must succeed (the
    // uniqueness is per-tenant via @@unique([tenantId, orderNumber])).
    const data: FakeOrder[] = [
      order({ id: "tenant_b_dup", tenantId: TENANT_B, orderNumber: "ORD-DUP" }),
    ];
    const prisma = makePrisma(data, [{ id: C_1, tenantId: TENANT_A }]);
    await createOrder(prisma, TENANT_A, {
      orderNumber: "ORD-DUP",
      contactId: C_1,
    });
    expect(data).toHaveLength(2);
  });
});

describe("KAN-945 — updateOrder", () => {
  // Q6.1 — load-bearing time-preservation invariant. Edit a non-date field;
  // assert that prisma.order.update receives data WITHOUT placedAt — so the
  // original timestamp (with time-of-day precision from a webhook source)
  // is preserved byte-for-byte by Prisma.
  it("Q6.1: edit non-date field → omitted date fields NOT in Prisma data arg", async () => {
    const ORIGINAL_PLACED = new Date("2026-05-10T19:30:00.000Z"); // not midnight!
    const data = [
      order({
        id: "ord_1",
        tenantId: TENANT_A,
        placedAt: ORIGINAL_PLACED,
      }),
    ];
    const tracker: CallTracker = { createArgs: [], updateArgs: [] };
    const prisma = makePrisma(data, [], [], [], tracker);

    await updateOrder(prisma, TENANT_A, {
      id: "ord_1",
      internalNotes: "Just adding a note — no date fields touched",
    });

    expect(tracker.updateArgs).toHaveLength(1);
    const args = tracker.updateArgs[0]!;
    // The critical assertion: placedAt MUST NOT be in the data arg.
    // Prisma's partial-update semantics preserve the existing DateTime
    // value (including time-of-day precision) when a field is omitted.
    expect(args.data).not.toHaveProperty("placedAt");
    expect(args.data).not.toHaveProperty("paidAt");
    expect(args.data).not.toHaveProperty("refundedAt");
    expect(args.data).not.toHaveProperty("cancelledAt");
    // internalNotes IS in the data arg.
    expect(args.data.internalNotes).toBe("Just adding a note — no date fields touched");
    // Row's placedAt remains byte-for-byte the original.
    expect((data[0].placedAt as Date).toISOString()).toBe(ORIGINAL_PLACED.toISOString());
  });

  it("Q6.1: explicit date update coerces yyyy-mm-dd → Date (overrides original)", async () => {
    const data = [order({ id: "ord_1", tenantId: TENANT_A })];
    const tracker: CallTracker = { createArgs: [], updateArgs: [] };
    const prisma = makePrisma(data, [], [], [], tracker);

    await updateOrder(prisma, TENANT_A, {
      id: "ord_1",
      placedAt: "2027-03-15",
    });

    const args = tracker.updateArgs[0]!;
    expect(args.data.placedAt).toBeInstanceOf(Date);
    expect((args.data.placedAt as Date).toISOString()).toBe("2027-03-15T00:00:00.000Z");
  });

  it("Q6.1: explicit null clears the date field", async () => {
    const data = [
      order({
        id: "ord_1",
        tenantId: TENANT_A,
        paidAt: new Date("2026-05-10T10:00:00Z"),
      }),
    ];
    const tracker: CallTracker = { createArgs: [], updateArgs: [] };
    const prisma = makePrisma(data, [], [], [], tracker);

    await updateOrder(prisma, TENANT_A, {
      id: "ord_1",
      paidAt: null,
    });

    const args = tracker.updateArgs[0]!;
    expect(args.data.paidAt).toBeNull();
  });

  it("cross-tenant → NOT_FOUND (no existence leak)", async () => {
    const data = [order({ id: "ord_1", tenantId: TENANT_B })];
    const prisma = makePrisma(data);
    await expect(
      updateOrder(prisma, TENANT_A, { id: "ord_1", internalNotes: "hijack" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Original row unchanged.
    expect(data[0].internalNotes).toBeUndefined();
  });

  it("only sets provided fields (doesn't clobber other fields to null)", async () => {
    const data = [
      order({
        id: "ord_1",
        tenantId: TENANT_A,
        customerNotes: "original",
        internalNotes: "original-internal",
      }),
    ];
    const prisma = makePrisma(data);
    await updateOrder(prisma, TENANT_A, {
      id: "ord_1",
      customerNotes: "updated",
    });
    expect(data[0].customerNotes).toBe("updated");
    expect(data[0].internalNotes).toBe("original-internal");
  });
});
