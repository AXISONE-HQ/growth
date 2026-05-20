/**
 * Orders router service.
 *
 * History:
 *   - KAN-883 — read surface (listOrders, getOrderById)
 *   - KAN-945 — Sub-cohort 3.4 mutations (createOrder, updateOrder) for
 *     manual CRUD forms. 22 form-eligible fields across 5 cards. Path β
 *     build from scratch.
 *
 * Ordering by `placedAt DESC` (not `createdAt`) — the spec's intent is
 * recency of business event, not record creation.
 *
 * Multi-tenant safety: TRPCError NOT_FOUND on miss in `get`; list always
 * filters by tenantId. Update uses double-guard (id + tenantId) — Order
 * lacks `deletedAt` (see KAN-946 follow-up).
 *
 * Time-preservation invariant (KAN-945 Q6.1): on update, fields the user
 * did NOT change must preserve their original DateTime byte-for-byte.
 * The partial-update pattern (`if (input.X !== undefined) data.X = ...`)
 * delivers this — callers omit untouched fields.
 *
 * Unique-collision UX (KAN-945 Q8): @@unique([tenantId, orderNumber])
 * violations from Prisma (P2002) surface as friendly BAD_REQUEST errors,
 * NOT raw 500s.
 */
import { TRPCError } from "@trpc/server";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  buildCursorWhere,
  decodeCursor,
  encodeCursor,
} from "./_pagination.js";
import {
  assertCompanyInTenant,
  assertContactInTenant,
  assertDealInTenant,
  toDate,
} from "./canonical-lookups.js";

export interface ListInput {
  search?: string;
  status?: string;
  contactId?: string;
  companyId?: string;
  dealId?: string;
  limit: number;
  cursor?: string;
}

export interface GetInput {
  id: string;
}

/**
 * KAN-945 — Sub-cohort 3.4 form-eligible field surface.
 *
 * 22 user-editable fields across 5 cards. Deferred from V1: lineItems
 * (Json, opaque; read-only on detail page; full editor = Cohort 4),
 * externalIds / customFields / aiContext / providerData (Sub-cohort 3.x
 * extension pattern), and the system-managed fields (id, tenantId,
 * correlationId, createdAt, updatedAt).
 *
 * Date fields are full DateTime in the schema (not @db.Date). The form
 * uses native <input type="date">; backend's `toDate()` coerces yyyy-mm-dd
 * → Date. Time-preservation (Q6.1): callers MUST omit date fields the user
 * did not change so the original timestamp is preserved byte-for-byte.
 *
 * `orderNumber` is unique per tenant via @@unique([tenantId, orderNumber]).
 * Create path catches P2002 collisions and surfaces them as BAD_REQUEST
 * with a friendly message (KAN-945 Q8).
 */
export interface CreateInput {
  // Card 1 — Core Order
  orderNumber: string;
  status?: string;
  source?: string;
  // Card 2 — Money
  totalAmount?: string;
  taxAmount?: string;
  discountAmount?: string;
  grandTotal?: string;
  currency?: string;
  // Card 3 — Payment & Timeline
  paymentMethod?: string | null;
  paymentProvider?: string | null;
  providerOrderId?: string | null;
  placedAt?: string | null;
  paidAt?: string | null;
  refundedAt?: string | null;
  cancelledAt?: string | null;
  // Card 4 — Relationships (REQUIRED contactId)
  contactId: string;
  companyId?: string | null;
  dealId?: string | null;
  // Card 5 — Attribution & Notes
  attributionFirstSource?: string | null;
  attributionLastSource?: string | null;
  customerNotes?: string | null;
  internalNotes?: string | null;
}

export interface UpdateInput {
  id: string;
  // All fields optional on update — partial-update semantics. The form omits
  // unchanged date fields entirely so the backend's omission preserves the
  // original Date (Q6.1 time-preservation invariant).
  //
  // NOTE: orderNumber is NOT in the update surface — read-only on edit
  // (KAN-945 Q8 decision). Users cannot rename existing orders to avoid
  // breaking external-system identifier mappings.
  status?: string;
  source?: string;
  totalAmount?: string;
  taxAmount?: string;
  discountAmount?: string;
  grandTotal?: string;
  currency?: string;
  paymentMethod?: string | null;
  paymentProvider?: string | null;
  providerOrderId?: string | null;
  placedAt?: string | null;
  paidAt?: string | null;
  refundedAt?: string | null;
  cancelledAt?: string | null;
  contactId?: string;
  companyId?: string | null;
  dealId?: string | null;
  attributionFirstSource?: string | null;
  attributionLastSource?: string | null;
  customerNotes?: string | null;
  internalNotes?: string | null;
}

const LIST_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  totalAmount: true,
  grandTotal: true,
  currency: true,
  placedAt: true,
  paidAt: true,
  paymentMethod: true,
  paymentProvider: true,
  source: true,
  createdAt: true,
  updatedAt: true,
  contact: {
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
    },
  },
  company: {
    select: { id: true, name: true },
  },
  deal: {
    select: { id: true, name: true },
  },
} as const;

export async function listOrders(
  prisma: PrismaClient,
  tenantId: string,
  input: ListInput,
) {
  const cursor = decodeCursor(input.cursor);

  // KAN-946 — soft-delete filter. Exclude tombstones from list by default.
  // getOrderById still returns tombstones for audit-trail use (matches
  // getCompanyById's pattern).
  const where: Record<string, unknown> = { tenantId, deletedAt: null };
  if (input.status) where.status = input.status;
  if (input.contactId) where.contactId = input.contactId;
  if (input.companyId) where.companyId = input.companyId;
  if (input.dealId) where.dealId = input.dealId;

  const searchOr = input.search
    ? [
        { orderNumber: { contains: input.search, mode: "insensitive" as const } },
      ]
    : null;

  // Compose cursor + search via AND. Cursor field is `placedAt` for orders
  // (see _pagination.ts docs — cursor timestamp slot maps to the table's
  // ORDER BY column, not literally createdAt).
  const andClauses: Array<Record<string, unknown>> = [];
  if (cursor) andClauses.push(buildCursorWhere(cursor, "placedAt"));
  if (searchOr) andClauses.push({ OR: searchOr });
  if (andClauses.length > 0) where.AND = andClauses;

  const totalCountWhere: Record<string, unknown> = { tenantId, deletedAt: null };
  if (input.status) totalCountWhere.status = input.status;
  if (input.contactId) totalCountWhere.contactId = input.contactId;
  if (input.companyId) totalCountWhere.companyId = input.companyId;
  if (input.dealId) totalCountWhere.dealId = input.dealId;
  if (searchOr) totalCountWhere.OR = searchOr;

  const [rowsPlusOne, totalCount] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: [{ placedAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      select: LIST_SELECT,
    }),
    prisma.order.count({ where: totalCountWhere }),
  ]);

  const hasNext = rowsPlusOne.length > input.limit;
  const items = hasNext ? rowsPlusOne.slice(0, input.limit) : rowsPlusOne;
  const last = items[items.length - 1];
  // For orders, cursor encodes `placedAt` (mapped onto the cursor's
  // `createdAt` slot — see _pagination.ts module docs for rationale).
  const nextCursor =
    hasNext && last
      ? encodeCursor({ id: last.id, createdAt: last.placedAt })
      : null;

  return {
    items,
    nextCursor,
    totalCount,
  };
}

export async function getOrderById(
  prisma: PrismaClient,
  tenantId: string,
  input: GetInput,
) {
  const order = await prisma.order.findFirst({
    where: { id: input.id, tenantId },
    include: {
      contact: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          companyId: true,
          companyName: true,
        },
      },
      company: true,
      deal: {
        select: {
          id: true,
          name: true,
          status: true,
          value: true,
          currency: true,
        },
      },
    },
  });

  if (!order) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
  }

  return order;
}

/**
 * KAN-945 — Map Prisma P2002 unique-constraint violations on
 * @@unique([tenantId, orderNumber]) to a friendly BAD_REQUEST error
 * (Q8 acceptance). Re-throws anything else unchanged.
 */
function wrapOrderNumberUniqueCollision(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    const target = (error.meta?.target as string[] | string | undefined) ?? "";
    const targetStr = Array.isArray(target) ? target.join(",") : String(target);
    if (targetStr.includes("order_number") || targetStr.includes("orderNumber")) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Order number already exists. Pick a different number.",
      });
    }
  }
  throw error;
}

/**
 * KAN-945 — Create an Order with full FK validation.
 *
 * Required FK: contactId. Optional FKs: companyId, dealId — validated
 * (when non-null) against the caller's tenant via canonical-lookups
 * helpers.
 *
 * Date fields (placedAt, paidAt, refundedAt, cancelledAt) are coerced
 * from yyyy-mm-dd strings to Date objects via `toDate()` (KAN-942 helper,
 * lifted to canonical-lookups.ts in KAN-945). `placedAt` defaults to
 * now() if not provided.
 *
 * Decimal fields (totalAmount, taxAmount, discountAmount, grandTotal)
 * arrive as strings and Prisma coerces to Decimal.
 *
 * @@unique([tenantId, orderNumber]) violations are caught + wrapped as
 * BAD_REQUEST with a friendly message (Q8).
 */
export async function createOrder(
  prisma: PrismaClient,
  tenantId: string,
  input: CreateInput,
) {
  // FK validations — required contact + optional company/deal.
  await assertContactInTenant(prisma, tenantId, input.contactId);
  await assertCompanyInTenant(prisma, tenantId, input.companyId);
  await assertDealInTenant(prisma, tenantId, input.dealId);

  try {
    return await prisma.order.create({
      data: {
        tenantId,
        // Required FK
        contactId: input.contactId,
        // Card 1
        orderNumber: input.orderNumber,
        ...(input.status !== undefined ? { status: input.status as never } : {}),
        ...(input.source !== undefined ? { source: input.source as never } : {}),
        // Card 2 — Decimal as string, Prisma coerces
        ...(input.totalAmount !== undefined ? { totalAmount: input.totalAmount } : {}),
        ...(input.taxAmount !== undefined ? { taxAmount: input.taxAmount } : {}),
        ...(input.discountAmount !== undefined ? { discountAmount: input.discountAmount } : {}),
        ...(input.grandTotal !== undefined ? { grandTotal: input.grandTotal } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        // Card 3 — Payment & Timeline (date coercion)
        paymentMethod: (input.paymentMethod ?? null) as never,
        paymentProvider: (input.paymentProvider ?? null) as never,
        providerOrderId: input.providerOrderId ?? null,
        // placedAt: if not provided, let schema default to now(). If provided
        // (even as null), coerce. Required on the column — null would fail.
        ...(input.placedAt !== undefined
          ? { placedAt: toDate(input.placedAt) ?? new Date() }
          : {}),
        paidAt: toDate(input.paidAt),
        refundedAt: toDate(input.refundedAt),
        cancelledAt: toDate(input.cancelledAt),
        // Card 4 — Relationships
        companyId: input.companyId ?? null,
        dealId: input.dealId ?? null,
        // Card 5
        attributionFirstSource: input.attributionFirstSource ?? null,
        attributionLastSource: input.attributionLastSource ?? null,
        customerNotes: input.customerNotes ?? null,
        internalNotes: input.internalNotes ?? null,
      },
    });
  } catch (error) {
    wrapOrderNumberUniqueCollision(error);
  }
}

/**
 * KAN-945 — Update an Order with partial-update semantics.
 *
 * Double-guard on existence: `id + tenantId` (Order lacks `deletedAt`;
 * see KAN-946 for the soft-delete migration follow-up).
 *
 * **Time-preservation invariant (Q6.1)**: only date fields explicitly
 * provided in `input` are re-coerced + written. Fields omitted (i.e.,
 * `undefined`) are NOT touched — Prisma preserves the existing DateTime
 * byte-for-byte, including time-of-day precision on webhook-sourced rows.
 * This is the load-bearing guarantee: a user editing `customerNotes` on
 * an order created by a Stripe webhook must NOT silently truncate the
 * placedAt timestamp to UTC midnight.
 *
 * `orderNumber` is NOT in the input surface — read-only on edit per Q8.
 */
export async function updateOrder(
  prisma: PrismaClient,
  tenantId: string,
  input: UpdateInput,
) {
  // KAN-946 — Triple-guard: id + tenantId + deletedAt: null. Soft-deleted
  // rows surface as NOT_FOUND alongside cross-tenant access (uniform error
  // shape, no existence leak). Mirrors Company's updateCompany pattern.
  const existing = await prisma.order.findFirst({
    where: { id: input.id, tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!existing) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Order not found" });
  }

  // FK validations — only for fields explicitly being updated.
  await assertContactInTenant(prisma, tenantId, input.contactId);
  await assertCompanyInTenant(prisma, tenantId, input.companyId);
  await assertDealInTenant(prisma, tenantId, input.dealId);

  // Build a strict partial-update payload. `if (input.X !== undefined)` is
  // the Q6.1 time-preservation invariant — omitted date fields stay
  // untouched in the DB.
  const data: Record<string, unknown> = {};
  if (input.status !== undefined) data.status = input.status;
  if (input.source !== undefined) data.source = input.source;
  if (input.totalAmount !== undefined) data.totalAmount = input.totalAmount;
  if (input.taxAmount !== undefined) data.taxAmount = input.taxAmount;
  if (input.discountAmount !== undefined) data.discountAmount = input.discountAmount;
  if (input.grandTotal !== undefined) data.grandTotal = input.grandTotal;
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.paymentMethod !== undefined) data.paymentMethod = input.paymentMethod;
  if (input.paymentProvider !== undefined) data.paymentProvider = input.paymentProvider;
  if (input.providerOrderId !== undefined) data.providerOrderId = input.providerOrderId;
  // Q6.1 — coerce dates ONLY when explicitly provided.
  if (input.placedAt !== undefined) data.placedAt = toDate(input.placedAt);
  if (input.paidAt !== undefined) data.paidAt = toDate(input.paidAt);
  if (input.refundedAt !== undefined) data.refundedAt = toDate(input.refundedAt);
  if (input.cancelledAt !== undefined) data.cancelledAt = toDate(input.cancelledAt);
  if (input.contactId !== undefined) data.contactId = input.contactId;
  if (input.companyId !== undefined) data.companyId = input.companyId;
  if (input.dealId !== undefined) data.dealId = input.dealId;
  if (input.attributionFirstSource !== undefined) data.attributionFirstSource = input.attributionFirstSource;
  if (input.attributionLastSource !== undefined) data.attributionLastSource = input.attributionLastSource;
  if (input.customerNotes !== undefined) data.customerNotes = input.customerNotes;
  if (input.internalNotes !== undefined) data.internalNotes = input.internalNotes;

  return prisma.order.update({
    where: { id: input.id },
    data,
  });
}
