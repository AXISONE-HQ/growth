/**
 * KAN-883 — Deals router service (read-only).
 *
 * Net-new tRPC list/get surface for Deals. No prior Deal router existed —
 * Deal was managed entirely via the lead-received subscriber and the brain
 * pipeline. Surfacing it now for the CRM UI cohort.
 *
 * Architecture mirrors companies-router.ts: pure functions here, thin tRPC
 * layer in apps/api/src/router.ts, cursor pagination from _pagination.ts.
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
  companyId?: string;
  contactId?: string;
  ownerId?: string;
  limit: number;
  cursor?: string;
}

export interface GetInput {
  id: string;
}

const LIST_SELECT = {
  id: true,
  name: true,
  status: true,
  probability: true,
  expectedCloseDate: true,
  closedAt: true,
  lostReason: true,
  lostReasonDetail: true,
  wonProductSummary: true,
  products: true,
  ownerId: true,
  assignedAgentId: true,
  companyId: true,
  externalIds: true,
  customFields: true,
  value: true,
  currency: true,
  currentStageId: true,
  contactId: true,
  pipelineId: true,
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
} as const;

export async function listDeals(
  prisma: PrismaClient,
  tenantId: string,
  input: ListInput,
) {
  const cursor = decodeCursor(input.cursor);

  const where: Record<string, unknown> = { tenantId };
  if (input.status) where.status = input.status;
  if (input.companyId) where.companyId = input.companyId;
  if (input.contactId) where.contactId = input.contactId;
  if (input.ownerId) where.ownerId = input.ownerId;

  const searchOr = input.search
    ? [{ name: { contains: input.search, mode: "insensitive" as const } }]
    : null;

  // Compose cursor + search via AND so the OR-groups don't clobber each other.
  const andClauses: Array<Record<string, unknown>> = [];
  if (cursor) andClauses.push(buildCursorWhere(cursor));
  if (searchOr) andClauses.push({ OR: searchOr });
  if (andClauses.length > 0) where.AND = andClauses;

  const totalCountWhere: Record<string, unknown> = { tenantId };
  if (input.status) totalCountWhere.status = input.status;
  if (input.companyId) totalCountWhere.companyId = input.companyId;
  if (input.contactId) totalCountWhere.contactId = input.contactId;
  if (input.ownerId) totalCountWhere.ownerId = input.ownerId;
  if (searchOr) totalCountWhere.OR = searchOr;

  const [rowsPlusOne, totalCount] = await Promise.all([
    prisma.deal.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      select: LIST_SELECT,
    }),
    prisma.deal.count({ where: totalCountWhere }),
  ]);

  const hasNext = rowsPlusOne.length > input.limit;
  const items = hasNext ? rowsPlusOne.slice(0, input.limit) : rowsPlusOne;
  const last = items[items.length - 1];
  const nextCursor =
    hasNext && last
      ? encodeCursor({ id: last.id, createdAt: last.createdAt })
      : null;

  return {
    items,
    nextCursor,
    totalCount,
  };
}

export async function getDealById(
  prisma: PrismaClient,
  tenantId: string,
  input: GetInput,
) {
  const deal = await prisma.deal.findFirst({
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
      company: {
        select: { id: true, name: true, domain: true, industry: true },
      },
      currentStage: {
        select: {
          id: true,
          name: true,
          outcomeType: true,
        },
      },
    },
  });

  if (!deal) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Deal not found" });
  }

  return deal;
}
