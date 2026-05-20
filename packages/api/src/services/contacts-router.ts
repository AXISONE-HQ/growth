/**
 * KAN-718 Day 10 — Contacts router service.
 *
 * Replaces the broken pre-KAN-689 `contactsRouter` (snake_case + `name` /
 * `company` / `status` fields that don't exist in the canonical Contact
 * schema). Per `packages/db/prisma/schema.prisma`:
 *
 *   id, tenantId, email, phone, firstName, lastName, externalIds,
 *   dataQualityScore, segment, lifecycleStage, source, currentPipelineId,
 *   currentStageId, microObjectiveProgress, enteredStageAt, createdAt, updatedAt
 *
 * Notable shape changes vs pre-KAN-689 router:
 *   - `name` (single field) → `firstName` + `lastName` (split). Caller-side:
 *     UI renders `${firstName ?? ''} ${lastName ?? ''}`.trim() with null-safety.
 *   - `company` field doesn't exist. Removed from create/update entirely.
 *     If "company" tracking is needed for V1, file a separate ticket to
 *     add a column — not in KAN-718 scope.
 *   - `status` (single field) → `lifecycleStage` (canonical lead lifecycle).
 *   - Search-by-name becomes OR on firstName + lastName + email.
 */
import { TRPCError } from '@trpc/server';
import type { PrismaClient } from '@prisma/client';
import { assertCompanyInTenant } from './canonical-lookups.js';

// KAN-938 — `assertCompanyInTenant` lifted to canonical-lookups.ts for reuse
// across Cohort 3.x manual-CRUD procedures (Deal, Order). Re-exported here
// for backwards compat with any existing internal imports + the identity-
// check tests that pin behavior post-lift.
export { assertCompanyInTenant };

export interface ListInput {
  search?: string;
  lifecycleStage?: string;
  // KAN-883 — Read-layer extensions (filters added to the existing
  // offset/limit shape; convergence to cursor pagination tracked in KAN-882).
  source?: string;
  companyId?: string;
  limit?: number;
  offset?: number;
}

export interface CreateInput {
  email: string;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  segment?: string | null;
  lifecycleStage?: string;
  source?: string | null;
  // KAN-934 — Cohort 3.1 form-eligible fields.
  companyId?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface UpdateInput {
  id: string;
  email?: string;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  segment?: string | null;
  lifecycleStage?: string;
  source?: string | null;
  // KAN-934 — Cohort 3.1 form-eligible fields.
  companyId?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, limit));
}

export async function listContacts(
  prisma: PrismaClient,
  tenantId: string,
  input: ListInput,
) {
  const limit = clampLimit(input.limit);
  const offset = Math.max(0, input.offset ?? 0);

  const where: Record<string, unknown> = { tenantId };
  if (input.lifecycleStage) {
    where.lifecycleStage = input.lifecycleStage;
  }
  if (input.source) {
    where.source = input.source;
  }
  if (input.companyId) {
    where.companyId = input.companyId;
  }
  if (input.search) {
    // Search OR across firstName / lastName / email — `name` doesn't exist
    // in the schema, so we expand to all human-identifying fields.
    where.OR = [
      { firstName: { contains: input.search, mode: 'insensitive' as const } },
      { lastName: { contains: input.search, mode: 'insensitive' as const } },
      { email: { contains: input.search, mode: 'insensitive' as const } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        segment: true,
        lifecycleStage: true,
        source: true,
        dataQualityScore: true,
        // KAN-883 — Company FK + denormalized name + address columns surfaced
        // for the read layer. `company` include hydrates the FK target so the
        // UI doesn't need a second roundtrip for the company badge.
        companyId: true,
        companyName: true,
        addressLine1: true,
        // KAN-887: addressLine2 was missed by KAN-883's LIST_SELECT. Surfacing
        // now so detail pages can render the full mailing block without a
        // second roundtrip.
        addressLine2: true,
        city: true,
        region: true,
        postalCode: true,
        country: true,
        createdAt: true,
        updatedAt: true,
        company: {
          select: { id: true, name: true },
        },
      },
    }),
    prisma.contact.count({ where }),
  ]);

  return {
    items: rows,
    total,
    limit,
    offset,
  };
}

export async function getContactById(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
) {
  const row = await prisma.contact.findFirst({
    where: { id, tenantId },
    include: {
      // KAN-887 — Contact detail page. Hydrates all relations the new
      // /customers/[id] page needs in one roundtrip. Takes are bounded
      // (10-20) so payloads stay small even for high-activity contacts.
      company: {
        select: { id: true, name: true, domain: true },
      },
      customer: {
        select: { mrr: true, ltv: true, healthScore: true, status: true, since: true, plan: true },
      },
      deals: {
        take: 20,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          status: true,
          value: true,
          currency: true,
          expectedCloseDate: true,
        },
      },
      engagements: {
        take: 20,
        orderBy: { occurredAt: 'desc' },
        select: {
          id: true,
          engagementType: true,
          signalClass: true,
          channel: true,
          occurredAt: true,
          metadata: true,
        },
      },
      outcomes: {
        take: 20,
        orderBy: { recordedAt: 'desc' },
        select: {
          id: true,
          result: true,
          reasonCategory: true,
          recordedAt: true,
          objectiveId: true,
        },
      },
      decisions: {
        take: 10,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          actionType: true,
          strategySelected: true,
          confidence: true,
          createdAt: true,
        },
      },
      escalations: {
        take: 10,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          triggerType: true,
          triggerReason: true,
          status: true,
          severity: true,
          createdAt: true,
        },
      },
    },
  });
  if (!row) {
    // Cross-tenant access lands here too — neutral NOT_FOUND, no leak.
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' });
  }
  return row;
}

export async function createContact(
  prisma: PrismaClient,
  tenantId: string,
  input: CreateInput,
) {
  // KAN-934 — FK validation before write.
  await assertCompanyInTenant(prisma, tenantId, input.companyId);

  return prisma.contact.create({
    data: {
      tenantId,
      email: input.email,
      phone: input.phone ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      segment: input.segment ?? null,
      lifecycleStage: input.lifecycleStage ?? 'lead',
      source: input.source ?? null,
      // KAN-934 — Cohort 3.1 fields.
      companyId: input.companyId ?? null,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      region: input.region ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
    },
  });
}

export async function updateContact(
  prisma: PrismaClient,
  tenantId: string,
  input: UpdateInput,
) {
  const existing = await prisma.contact.findFirst({
    where: { id: input.id, tenantId },
    select: { id: true },
  });
  if (!existing) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' });
  }

  // KAN-934 — FK validation before write.
  await assertCompanyInTenant(prisma, tenantId, input.companyId);

  // Build a strict update payload — only set fields that were explicitly
  // provided. Avoids accidentally clearing optional values to null.
  const data: Record<string, unknown> = {};
  if (input.email !== undefined) data.email = input.email;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.firstName !== undefined) data.firstName = input.firstName;
  if (input.lastName !== undefined) data.lastName = input.lastName;
  if (input.segment !== undefined) data.segment = input.segment;
  if (input.lifecycleStage !== undefined) data.lifecycleStage = input.lifecycleStage;
  if (input.source !== undefined) data.source = input.source;
  // KAN-934 — Cohort 3.1 fields.
  if (input.companyId !== undefined) data.companyId = input.companyId;
  if (input.addressLine1 !== undefined) data.addressLine1 = input.addressLine1;
  if (input.addressLine2 !== undefined) data.addressLine2 = input.addressLine2;
  if (input.city !== undefined) data.city = input.city;
  if (input.region !== undefined) data.region = input.region;
  if (input.postalCode !== undefined) data.postalCode = input.postalCode;
  if (input.country !== undefined) data.country = input.country;

  return prisma.contact.update({
    where: { id: input.id },
    data,
  });
}
