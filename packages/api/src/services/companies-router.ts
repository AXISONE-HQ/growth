/**
 * Companies router service.
 *
 * Pure service logic for the Companies tRPC routes. Schema landed in KAN-879.
 *
 * History:
 *   - KAN-883 — read surface (listCompanies, getCompanyById)
 *   - KAN-937 — Sub-cohort 3.2 mutations (createCompany, updateCompany) for
 *     manual CRUD forms. 30 form-eligible fields across 5 cards. Path β
 *     extension mirroring KAN-934's contacts pattern.
 *
 * Architecture mirrors `contacts-router.ts`: pure functions here, thin tRPC
 * layer in apps/api/src/router.ts.
 *
 * Multi-tenant safety: every query filters by `tenantId` from the caller.
 * `getCompanyById` returns TRPCError NOT_FOUND on miss (cross-tenant access
 * lands here too — neutral, no leak). `updateCompany` rejects cross-tenant +
 * soft-deleted rows with the same NOT_FOUND shape.
 *
 * Soft delete: `list` filters `deletedAt IS NULL` by default. `get` returns
 * the row regardless of soft-delete state (callers may legitimately want to
 * see a tombstone). `update` rejects soft-deleted rows — edits must operate
 * on live rows only.
 */
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";
import {
  buildCursorWhere,
  decodeCursor,
  encodeCursor,
  type CursorPayload,
} from "./_pagination.js";
import { assertOwnerInTenant } from "./canonical-lookups.js";

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

/**
 * KAN-937 — Sub-cohort 3.2 form-eligible field surface.
 *
 * 30 user-editable fields across 5 cards (Core Info, Contact Info, Billing
 * Address, Mailing Address, Tax & Compliance). Excludes ownerId (deferred to
 * KAN-936), tags / customFields / externalIds / aiContext (each needs its own
 * UX in Sub-cohort 3.x), and system-managed fields (id, tenantId, timestamps,
 * deletedAt).
 *
 * `annualRevenue` is Decimal(15,2). Serialized as string over the wire to
 * preserve precision; Prisma coerces back to Decimal on write.
 */
export interface CreateInput {
  // Card 1 — Core Info (required: name)
  name: string;
  legalName?: string | null;
  domain?: string | null;
  website?: string | null;
  industry?: string | null;
  sizeRange?: string | null;
  annualRevenue?: string | null;
  description?: string | null;
  lifecycleStage?: string;
  // Card 2 — Contact Info
  phone?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  // Card 3 — Billing Address
  billingAddressLine1?: string | null;
  billingAddressLine2?: string | null;
  billingCity?: string | null;
  billingRegion?: string | null;
  billingPostalCode?: string | null;
  billingCountry?: string | null;
  // Card 4 — Mailing Address
  mailingAddressLine1?: string | null;
  mailingAddressLine2?: string | null;
  mailingCity?: string | null;
  mailingRegion?: string | null;
  mailingPostalCode?: string | null;
  mailingCountry?: string | null;
  // Card 5 — Tax & Compliance
  taxId?: string | null;
  taxIdType?: string | null;
  businessRegistrationNumber?: string | null;
  incorporationJurisdiction?: string | null;
  isTaxExempt?: boolean;
  taxExemptionCertificate?: string | null;
  // KAN-936 — optional FK to User
  ownerId?: string | null;
}

export interface UpdateInput
  extends Partial<Omit<CreateInput, "name">> {
  id: string;
  name?: string;
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
      // KAN-936 — owner FK now formalized; hydrate for the edit form's
      // pre-population label and the detail page if it surfaces ownership.
      owner: {
        select: { id: true, name: true, email: true },
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

export async function createCompany(
  prisma: PrismaClient,
  tenantId: string,
  input: CreateInput,
) {
  // KAN-936 — owner FK validation (formalized in this PR).
  await assertOwnerInTenant(prisma, tenantId, input.ownerId);

  return prisma.company.create({
    data: {
      tenantId,
      // Card 1
      name: input.name,
      legalName: input.legalName ?? null,
      domain: input.domain ?? null,
      website: input.website ?? null,
      industry: input.industry ?? null,
      sizeRange: (input.sizeRange ?? null) as never,
      annualRevenue: input.annualRevenue ?? null,
      description: input.description ?? null,
      lifecycleStage: (input.lifecycleStage ?? "prospect") as never,
      // Card 2
      phone: input.phone ?? null,
      email: input.email ?? null,
      linkedinUrl: input.linkedinUrl ?? null,
      // Card 3
      billingAddressLine1: input.billingAddressLine1 ?? null,
      billingAddressLine2: input.billingAddressLine2 ?? null,
      billingCity: input.billingCity ?? null,
      billingRegion: input.billingRegion ?? null,
      billingPostalCode: input.billingPostalCode ?? null,
      billingCountry: input.billingCountry ?? null,
      // Card 4
      mailingAddressLine1: input.mailingAddressLine1 ?? null,
      mailingAddressLine2: input.mailingAddressLine2 ?? null,
      mailingCity: input.mailingCity ?? null,
      mailingRegion: input.mailingRegion ?? null,
      mailingPostalCode: input.mailingPostalCode ?? null,
      mailingCountry: input.mailingCountry ?? null,
      // Card 5
      taxId: input.taxId ?? null,
      taxIdType: (input.taxIdType ?? null) as never,
      businessRegistrationNumber: input.businessRegistrationNumber ?? null,
      incorporationJurisdiction: input.incorporationJurisdiction ?? null,
      isTaxExempt: input.isTaxExempt ?? false,
      taxExemptionCertificate: input.taxExemptionCertificate ?? null,
      // KAN-936 — optional FK to User
      ownerId: input.ownerId ?? null,
    },
  });
}

export async function updateCompany(
  prisma: PrismaClient,
  tenantId: string,
  input: UpdateInput,
) {
  // Verify the row exists, belongs to tenant, and is not soft-deleted.
  // Cross-tenant + soft-deleted both surface as NOT_FOUND — no existence leak.
  const existing = await prisma.company.findFirst({
    where: { id: input.id, tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!existing) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Company not found" });
  }

  // KAN-936 — owner FK validation (formalized in this PR). Only validates
  // when ownerId is explicitly being updated.
  await assertOwnerInTenant(prisma, tenantId, input.ownerId);

  // Build a strict update payload — only set fields explicitly provided.
  // Avoids clobbering optional values to null when a partial update is sent.
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.legalName !== undefined) data.legalName = input.legalName;
  if (input.domain !== undefined) data.domain = input.domain;
  if (input.website !== undefined) data.website = input.website;
  if (input.industry !== undefined) data.industry = input.industry;
  if (input.sizeRange !== undefined) data.sizeRange = input.sizeRange;
  if (input.annualRevenue !== undefined) data.annualRevenue = input.annualRevenue;
  if (input.description !== undefined) data.description = input.description;
  if (input.lifecycleStage !== undefined) data.lifecycleStage = input.lifecycleStage;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.email !== undefined) data.email = input.email;
  if (input.linkedinUrl !== undefined) data.linkedinUrl = input.linkedinUrl;
  if (input.billingAddressLine1 !== undefined) data.billingAddressLine1 = input.billingAddressLine1;
  if (input.billingAddressLine2 !== undefined) data.billingAddressLine2 = input.billingAddressLine2;
  if (input.billingCity !== undefined) data.billingCity = input.billingCity;
  if (input.billingRegion !== undefined) data.billingRegion = input.billingRegion;
  if (input.billingPostalCode !== undefined) data.billingPostalCode = input.billingPostalCode;
  if (input.billingCountry !== undefined) data.billingCountry = input.billingCountry;
  if (input.mailingAddressLine1 !== undefined) data.mailingAddressLine1 = input.mailingAddressLine1;
  if (input.mailingAddressLine2 !== undefined) data.mailingAddressLine2 = input.mailingAddressLine2;
  if (input.mailingCity !== undefined) data.mailingCity = input.mailingCity;
  if (input.mailingRegion !== undefined) data.mailingRegion = input.mailingRegion;
  if (input.mailingPostalCode !== undefined) data.mailingPostalCode = input.mailingPostalCode;
  if (input.mailingCountry !== undefined) data.mailingCountry = input.mailingCountry;
  if (input.taxId !== undefined) data.taxId = input.taxId;
  if (input.taxIdType !== undefined) data.taxIdType = input.taxIdType;
  if (input.businessRegistrationNumber !== undefined) data.businessRegistrationNumber = input.businessRegistrationNumber;
  if (input.incorporationJurisdiction !== undefined) data.incorporationJurisdiction = input.incorporationJurisdiction;
  if (input.isTaxExempt !== undefined) data.isTaxExempt = input.isTaxExempt;
  if (input.taxExemptionCertificate !== undefined) data.taxExemptionCertificate = input.taxExemptionCertificate;
  // KAN-936 — optional ownerId (User FK). Null clears the owner.
  if (input.ownerId !== undefined) data.ownerId = input.ownerId;

  return prisma.company.update({
    where: { id: input.id },
    data,
  });
}

// Re-export for the thin tRPC layer's variable-specifier dynamic import.
export type { CursorPayload };
