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

export interface ListInput {
  search?: string;
  lifecycleStage?: string;
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
        createdAt: true,
        updatedAt: true,
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
  return prisma.contact.create({
    data: {
      tenantId,
      email: input.email,
      phone: input.phone ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      segment: input.segment ?? null,
      lifecycleStage: input.lifecycleStage ?? 'new',
      source: input.source ?? null,
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

  return prisma.contact.update({
    where: { id: input.id },
    data,
  });
}
