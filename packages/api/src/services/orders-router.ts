/**
 * KAN-883 — Orders router service (read-only).
 *
 * Pure service logic for the Orders tRPC list/get routes introduced by
 * cohort 1 of the read-only CRM UI sequence. Schema landed in KAN-879.
 *
 * Ordering by `placedAt DESC` (not `createdAt`) — the spec's intent is
 * recency of business event, not record creation. The shared cursor helper
 * accepts a `placedAtField` override so we can keep one encode/decode
 * surface across all 3 new routes.
 *
 * Cross-tenant safety: TRPCError NOT_FOUND on miss in `get`; list always
 * filters by tenantId.
 */
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";
import {
  buildCursorWhere,
  decodeCursor,
  encodeCursor,
} from "./_pagination.js";

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

  const where: Record<string, unknown> = { tenantId };
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

  const totalCountWhere: Record<string, unknown> = { tenantId };
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
