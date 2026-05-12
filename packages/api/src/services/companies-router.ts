/**
 * KAN-883 — Companies router service (read-only).
 *
 * Pure service logic for the Companies tRPC list/get routes introduced by
 * cohort 1 of the read-only CRM UI sequence. Schema landed in KAN-879.
 *
 * Architecture mirrors `contacts-router.ts` (KAN-689 cohort): pure functions
 * here, thin tRPC layer in apps/api/src/router.ts. Companies has no
 * mutations in this PR — that's cohort 4.
 *
 * Multi-tenant safety: every query filters by `tenantId` from the caller.
 * `getCompanyById` returns TRPCError NOT_FOUND on miss (cross-tenant access
 * lands here too — neutral, no leak).
 *
 * Soft delete: `list` filters `deletedAt IS NULL` by default. `get` returns
 * the row regardless of soft-delete state (callers may legitimately want to
 * see a tombstone).
 */
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";
import {
  buildCursorWhere,
  decodeCursor,
  encodeCursor,
  type CursorPayload,
} from "./_pagination.js";

export interface ListInput {
  search?: string;
  lifecycleStage?: string;
  ownerId?: string;
  limit: number;
  cursor?: string;
}

export interface GetInput {
  id: string;
}

const CONTACT_PREVIEW_LIMIT = 20;
const DEAL_PREVIEW_LIMIT = 20;
const ORDER_PREVIEW_LIMIT = 20;

const LIST_SELECT = {
  id: true,
  name: true,
  legalName: true,
  domain: true,
  website: true,
  industry: true,
  sizeRange: true,
  lifecycleStage: true,
  billingCity: true,
  billingRegion: true,
  billingCountry: true,
  taxId: true,
  taxIdType: true,
  isTaxExempt: true,
  ownerId: true,
  tags: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      contacts: true,
      deals: true,
      orders: true,
    },
  },
} as const;

export async function listCompanies(
  prisma: PrismaClient,
  tenantId: string,
  input: ListInput,
) {
  const cursor = decodeCursor(input.cursor);

  // Compose multiple OR-groups via top-level AND so cursor + search don't
  // clobber each other's OR clauses. Pure-string equality filters go on the
  // root `where`; nested OR groups (cursor tuple, multi-field ILIKE search)
  // each become their own AND clause.
  const where: Record<string, unknown> = { tenantId, deletedAt: null };
  if (input.lifecycleStage) where.lifecycleStage = input.lifecycleStage;
  if (input.ownerId) where.ownerId = input.ownerId;

  const searchOr = input.search
    ? [
        { name: { contains: input.search, mode: "insensitive" as const } },
        { legalName: { contains: input.search, mode: "insensitive" as const } },
        { domain: { contains: input.search, mode: "insensitive" as const } },
      ]
    : null;

  const andClauses: Array<Record<string, unknown>> = [];
  if (cursor) andClauses.push(buildCursorWhere(cursor));
  if (searchOr) andClauses.push({ OR: searchOr });
  if (andClauses.length > 0) where.AND = andClauses;

  // totalCount uses the SAME filtered surface MINUS the cursor — callers
  // want "how many in total match my filters," not "remaining after this
  // page." Search OR stays.
  const totalCountWhere: Record<string, unknown> = { tenantId, deletedAt: null };
  if (input.lifecycleStage) totalCountWhere.lifecycleStage = input.lifecycleStage;
  if (input.ownerId) totalCountWhere.ownerId = input.ownerId;
  if (searchOr) totalCountWhere.OR = searchOr;

  // Fetch limit+1 rows to determine whether a next page exists without a
  // separate count query for the next-page boundary check.
  const [rowsPlusOne, totalCount] = await Promise.all([
    prisma.company.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      select: LIST_SELECT,
    }),
    prisma.company.count({ where: totalCountWhere }),
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

export async function getCompanyById(
  prisma: PrismaClient,
  tenantId: string,
  input: GetInput,
) {
  const company = await prisma.company.findFirst({
    where: { id: input.id, tenantId },
    include: {
      contacts: {
        take: CONTACT_PREVIEW_LIMIT,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          lifecycleStage: true,
        },
      },
      deals: {
        take: DEAL_PREVIEW_LIMIT,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          status: true,
          value: true,
          currency: true,
        },
      },
      orders: {
        take: ORDER_PREVIEW_LIMIT,
        orderBy: { placedAt: "desc" },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          grandTotal: true,
          currency: true,
          placedAt: true,
        },
      },
      _count: {
        select: {
          contacts: true,
          deals: true,
          orders: true,
        },
      },
    },
  });

  if (!company) {
    // Cross-tenant access lands here too — neutral NOT_FOUND, no existence
    // leak across tenants.
    throw new TRPCError({ code: "NOT_FOUND", message: "Company not found" });
  }

  return company;
}

// Re-export for the thin tRPC layer's variable-specifier dynamic import.
export type { CursorPayload };
