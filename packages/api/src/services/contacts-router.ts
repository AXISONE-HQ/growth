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
// KAN-980 — contacts.list converged to cursor pagination per the canonical
// helper at _pagination.ts. Mirrors deals.list / companies.list / orders.list.
// Closes the KAN-882 convergence ticket.
import { buildCursorWhere, decodeCursor, encodeCursor } from './_pagination.js';

// KAN-938 — `assertCompanyInTenant` lifted to canonical-lookups.ts for reuse
// across Cohort 3.x manual-CRUD procedures (Deal, Order). Re-exported here
// for backwards compat with any existing internal imports + the identity-
// check tests that pin behavior post-lift.
export { assertCompanyInTenant };

export interface ListInput {
  search?: string;
  lifecycleStage?: string;
  source?: string;
  companyId?: string;
  // KAN-980 (KAN-882 convergence) — cursor pagination replaces offset/limit.
  // Cursor encoded via _pagination.encodeCursor; first page is `cursor:
  // undefined`. Mirrors deals.list / companies.list / orders.list.
  limit?: number;
  cursor?: string;
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
  const cursor = decodeCursor(input.cursor);

  // Build base WHERE — tenant scope is the load-bearing predicate (Prisma's
  // explicit tenantId filter is the same gate every contacts query uses).
  const baseWhere: Record<string, unknown> = { tenantId };
  if (input.lifecycleStage) baseWhere.lifecycleStage = input.lifecycleStage;
  if (input.source) baseWhere.source = input.source;
  if (input.companyId) baseWhere.companyId = input.companyId;
  const searchOr = input.search
    ? [
        { firstName: { contains: input.search, mode: 'insensitive' as const } },
        { lastName: { contains: input.search, mode: 'insensitive' as const } },
        { email: { contains: input.search, mode: 'insensitive' as const } },
      ]
    : null;

  // Compose cursor + search via AND so the OR-groups don't clobber each
  // other. Same defensive shape as listDeals (KAN-883 OR-clobber lesson).
  const where: Record<string, unknown> = { ...baseWhere };
  const andClauses: Array<Record<string, unknown>> = [];
  if (cursor) andClauses.push(buildCursorWhere(cursor));
  if (searchOr) andClauses.push({ OR: searchOr });
  if (andClauses.length > 0) where.AND = andClauses;

  const totalCountWhere: Record<string, unknown> = { ...baseWhere };
  if (searchOr) totalCountWhere.OR = searchOr;

  // Fetch limit+1 to detect hasNext; canonical pattern from deals.list.
  const [rowsPlusOne, totalCount] = await Promise.all([
    prisma.contact.findMany({
      where,
      // ORDER BY createdAt DESC, id DESC — id tiebreaker is critical for
      // stable ordering when multiple rows share a millisecond createdAt
      // (high-write loads). Matches the _pagination.ts invariant.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
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
    prisma.contact.count({ where: totalCountWhere }),
  ]);

  const hasNext = rowsPlusOne.length > limit;
  const items = hasNext ? rowsPlusOne.slice(0, limit) : rowsPlusOne;
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
      // KAN-cohort-3.5 — reverse "Linked orders" relation for Contact detail.
      // Capped + ordered by placedAt DESC (most recent first), parity with
      // getCompanyById.orders. Paired _count.orders below carries the
      // truthful total even when the capped list omits older rows.
      orders: {
        take: 20,
        orderBy: { placedAt: 'desc' },
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
        select: { orders: true },
      },
    },
  });
  if (!row) {
    // Cross-tenant access lands here too — neutral NOT_FOUND, no leak.
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' });
  }

  // ── KAN-1037-PR5 — Last reply derivation ───────────────────────
  //
  // M3-2.5c reply-loop-closure final PR. Surfaces the most recent inbound
  // reply on the Contact detail page with engine-response context
  // (escalated / no_action / filtered_autoresponder, plus an implicit
  // "evaluating" fallback for the cooldown / in-flight window).
  //
  // Status enum is intentionally NARROW per the PR5 spec confirmation:
  // 4 derivable statuses today, with `auto_replied` + `paused_contact`
  // deferred to KAN-1049 until corresponding audit signals exist.
  //
  // Derivation steps (all single-roundtrip, indexed):
  //   1. Pick the most recent `email_received` engagement from the already-
  //      loaded `row.engagements` (no extra DB query — list is bounded to
  //      20 + ordered DESC, so the first inbound match wins).
  //   2. Parallel audit-log lookups for the most recent
  //      `decision_re_evaluated` + `escalation_created_from_engine_proposal`
  //      audit rows on this (tenant, contact). Both keyed on the
  //      `@@index([tenantId, actionType])` index added in PR3.
  //   3. Map to `engineResponseStatus` per the narrow enum.
  //
  // Adds 2 indexed queries to the getById roundtrip; bounded by
  // single-contact view (no N+1 risk).
  // KAN-1037-PR5 — defensive `?? []` guard: PROD rows always carry the
  // engagements include (above), but unit-test fixtures (contacts-router.test.ts
  // makePrisma) return bare rows without relation hydration. Treat absent
  // as empty so the derivation cleanly returns `latestReply: null` in tests
  // that don't exercise the panel.
  const latestInboundEngagement = (row.engagements ?? []).find(
    (e) => e.engagementType === 'email_received',
  );

  let latestReply: LatestReply | null = null;
  if (latestInboundEngagement) {
    const [reEvalAudit, escalationAudit, filteredAuditFromLeadInbox] = await Promise.all([
      prisma.auditLog.findFirst({
        where: {
          tenantId,
          actionType: 'decision_re_evaluated',
          payload: { path: ['contactId'], equals: id },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, payload: true, createdAt: true },
      }),
      prisma.auditLog.findFirst({
        where: {
          tenantId,
          actionType: 'escalation_created_from_engine_proposal',
          payload: { path: ['contactId'], equals: id },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, payload: true, createdAt: true },
      }),
      // KAN-1037-PR2 filtered autoresponders write LeadInboxEvent rows
      // (NOT AuditLog rows) — the connector-layer filter doesn't currently
      // emit an AuditLog. Skip lookup for now; treat absence of a
      // re-evaluated audit + presence of an inbound that didn't correlate
      // as `filtered_autoresponder` is unreliable. PR5 ships the
      // filtered_autoresponder status as a placeholder branch that today
      // never fires. KAN-1049 widens this.
      Promise.resolve(null),
    ]);

    const metadata = (latestInboundEngagement.metadata ?? {}) as Record<string, unknown>;
    const reEvalPayload = (reEvalAudit?.payload ?? {}) as Record<string, unknown>;
    const escalationPayload = (escalationAudit?.payload ?? {}) as Record<string, unknown>;

    // Status derivation — narrow enum per PR5 spec confirmation.
    let engineResponseStatus: LatestReplyEngineStatus;
    if (escalationAudit && (!reEvalAudit || escalationAudit.createdAt >= reEvalAudit.createdAt)) {
      engineResponseStatus = 'escalated';
    } else if (reEvalAudit) {
      // Brain evaluated but didn't escalate — assume no_action terminal
      // state. PR4.5 only writes `decision_re_evaluated` then routes
      // through wirePhase2Consumers; the absence of a downstream escalation
      // OR send_follow_up dispatch (the latter not yet observable as
      // audit; KAN-1049) defaults to no_action here.
      engineResponseStatus = 'no_action';
    } else if (filteredAuditFromLeadInbox) {
      engineResponseStatus = 'filtered_autoresponder';
    } else {
      // Reply landed but engine hasn't evaluated yet (cooldown window or
      // in-flight processing). Implicit fallback per PR5 spec.
      engineResponseStatus = 'evaluating';
    }

    latestReply = {
      id: latestInboundEngagement.id,
      bodyPreview: typeof metadata.bodyPreview === 'string' ? metadata.bodyPreview : '',
      fromAddress: typeof metadata.senderEmail === 'string' ? metadata.senderEmail : '',
      subject: typeof metadata.subject === 'string' ? metadata.subject : '',
      occurredAt: latestInboundEngagement.occurredAt.toISOString(),
      signalClass: latestInboundEngagement.signalClass,
      correlatedDecisionId:
        typeof reEvalPayload.triggerDecisionId === 'string'
          ? reEvalPayload.triggerDecisionId
          : null,
      engineResponseStatus,
      engineResponseAt: reEvalAudit?.createdAt.toISOString() ?? null,
      engineResponseEscalationId:
        typeof escalationPayload.escalationId === 'string'
          ? escalationPayload.escalationId
          : null,
      engineReasoning:
        typeof escalationPayload.brainReasoning === 'string'
          ? escalationPayload.brainReasoning
          : null,
    };
  }

  return { ...row, latestReply };
}

/**
 * KAN-1037-PR5 — Last reply engine-response status. Narrow enum per the
 * spec confirmation:
 *   - `escalated`: engine emitted `escalate_to_human` → new Escalation
 *     row created (PR4.5 path).
 *   - `no_action`: engine evaluated but didn't escalate. Includes
 *     `send_follow_up` / `advance_stage` / `wait_for_response` / etc.
 *     pending KAN-1049 widening.
 *   - `filtered_autoresponder`: KAN-1037-PR2 filter caught the inbound
 *     at the webhook (placeholder; LeadInboxEvent → AuditLog wiring
 *     deferred to KAN-1049).
 *   - `evaluating`: reply landed but engine hasn't yet evaluated
 *     (cooldown window / in-flight processing) — implicit fallback.
 *
 * `auto_replied` + `paused_contact` deferred to KAN-1049 until the
 * corresponding audit-event surfaces are wired.
 */
export type LatestReplyEngineStatus =
  | 'escalated'
  | 'no_action'
  | 'filtered_autoresponder'
  | 'evaluating';

/**
 * KAN-1037-PR5 — Last reply shape returned on `contacts.getById`. Null
 * when the contact has no inbound `email_received` engagement; absent
 * audit-trail joins surface as null inner fields, not as a null wrapper.
 */
export interface LatestReply {
  id: string;
  bodyPreview: string;
  fromAddress: string;
  subject: string;
  occurredAt: string;
  signalClass: string;
  correlatedDecisionId: string | null;
  engineResponseStatus: LatestReplyEngineStatus;
  engineResponseAt: string | null;
  engineResponseEscalationId: string | null;
  engineReasoning: string | null;
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
