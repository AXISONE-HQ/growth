/**
 * Deals router service.
 *
 * History:
 *   - KAN-883 — read surface (listDeals, getDealById)
 *   - KAN-938 — Sub-cohort 3.3 mutations (createDeal, updateDeal) for manual
 *     CRUD forms. 13 form-eligible fields across 4 cards. Path β build from
 *     scratch (mirrors KAN-937 contacts/companies mutation pattern).
 *
 * Architecture mirrors companies-router.ts: pure functions here, thin tRPC
 * layer in apps/api/src/router.ts, cursor pagination from _pagination.ts.
 *
 * Multi-tenant safety: every query filters by `tenantId`. Cross-tenant access
 * surfaces as NOT_FOUND (no existence leak). FK validation helpers live in
 * canonical-lookups.ts (KAN-938 lift).
 *
 * Soft delete: Deal currently LACKS `deletedAt` column. Update uses double-
 * guard (id + tenantId) instead of the KAN-937 triple-guard. KAN-940 tracks
 * the schema migration to add soft-delete + filter updates.
 */
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";
import {
  buildCursorWhere,
  decodeCursor,
  encodeCursor,
} from "./_pagination.js";
import {
  assertCompanyInTenant,
  assertContactInTenant,
  assertOwnerInTenant,
  assertPipelineInTenant,
  assertStageInPipeline,
  toDate,
} from "./canonical-lookups.js";

// KAN-945 — `toDate` lifted to canonical-lookups.ts for reuse across
// orders-router.ts and any future canonical-entity CRUD with date inputs.
// Re-exported here for backwards compat with any existing internal callers
// + the identity-check test that pins behavior post-lift.
export { toDate };

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

/**
 * KAN-938 — Sub-cohort 3.3 form-eligible field surface.
 *
 * 13 user-editable fields across 4 cards:
 *  - Card 1 Core: name, value (Decimal as string), currency, probability
 *  - Card 2 Status & Outcomes: status, expectedCloseDate (yyyy-mm-dd),
 *    lostReason, lostReasonDetail, wonProductSummary
 *  - Card 3 Pipeline & Stage: pipelineId, currentStageId (cascading)
 *  - Card 4 Relationships: contactId (required), companyId (optional)
 *
 * Deferred: ownerId (KAN-936), assignedAgentId, microObjectiveProgress,
 * products, metadata, externalIds, customFields, aiContext (each needs
 * its own UX in Sub-cohort 3.x).
 *
 * `closedAt` is system-managed (set on status transition) — NOT exposed.
 */
export interface CreateInput {
  // Card 1 — Core
  name?: string;
  value?: string;
  currency?: string;
  probability?: number | null;
  // Card 2 — Status & Outcomes (conditional fields driven by status)
  status?: string;
  expectedCloseDate?: string | null;
  lostReason?: string | null;
  lostReasonDetail?: string | null;
  wonProductSummary?: string | null;
  // Card 3 — Pipeline & Stage (REQUIRED FKs)
  pipelineId: string;
  currentStageId: string;
  // Card 4 — Relationships
  contactId: string;          // REQUIRED
  companyId?: string | null;  // optional
  ownerId?: string | null;    // KAN-936 optional FK to User
}

export interface UpdateInput {
  id: string;
  // All fields optional on update — partial-update semantics.
  name?: string;
  value?: string;
  currency?: string;
  probability?: number | null;
  status?: string;
  expectedCloseDate?: string | null;
  lostReason?: string | null;
  lostReasonDetail?: string | null;
  wonProductSummary?: string | null;
  pipelineId?: string;
  currentStageId?: string;
  contactId?: string;
  companyId?: string | null;
  ownerId?: string | null;    // KAN-936 optional FK to User
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

  // KAN-940 — soft-delete filter. Exclude tombstones from list by default.
  // getDealById still returns tombstones for audit-trail use (matches
  // getCompanyById's pattern).
  const where: Record<string, unknown> = { tenantId, deletedAt: null };
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

  const totalCountWhere: Record<string, unknown> = { tenantId, deletedAt: null };
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

// ─────────────────────────────────────────────
// KAN-967 — Pipelines kanban board grouped read.
//
// Returns deals grouped by stage for one Pipeline, with the AI's most-recent
// Decision joined per deal, capped at 50 cards per stage. Read-only; the board
// renders this. Mutations live on existing endpoints (create/update/etc.).
//
// Tenant scoping in the raw SQL is EXPLICIT + MANDATORY — raw queries skip the
// Prisma tenant middleware. The `tenant_id = ${tenantId}` predicate is the
// load-bearing safety check. A cross-tenant-isolation test pins it.
// ─────────────────────────────────────────────

export interface ListByPipelineInput {
  pipelineId: string;
}

export interface DealCard {
  id: string;
  name: string;
  /** Decimal(12,2) serialized as string — matches listDeals' contract. */
  value: string;
  currency: string;
  currentStageId: string;
  enteredStageAt: Date;
  contact: { firstName: string | null; lastName: string | null };
  company: { name: string } | null;
  status: string;
  probability: number | null;
  latestDecision: {
    actionType: string;
    confidence: number;
  } | null;
}

export interface StageGroup {
  stageId: string;
  deals: DealCard[];
  /** Number of deals over the 50-cap, for the "+N more" UI affordance. */
  truncatedCount: number;
}

export interface ListByPipelineResult {
  stages: StageGroup[];
}

export const LIST_BY_PIPELINE_PER_STAGE_CAP = 50;

interface DealRow {
  id: string;
  name: string;
  // Prisma returns numeric columns from $queryRaw as Decimal-shaped objects
  // (string-coercible via toString()). Type as unknown + coerce defensively.
  value: { toString(): string };
  currency: string;
  current_stage_id: string;
  entered_stage_at: Date;
  contact_id: string;
  company_id: string | null;
  status: string;
  probability: number | null;
  stage_total: bigint;
}

interface DecisionRow {
  deal_id: string;
  action_type: string;
  confidence: number;
}

export async function listDealsByPipeline(
  prisma: PrismaClient,
  tenantId: string,
  input: ListByPipelineInput,
): Promise<ListByPipelineResult> {
  // 1. Verify pipeline ∈ tenant + load ordered stages. Cross-tenant access
  //    surfaces as NOT_FOUND (no existence leak — mirrors getDealById).
  const pipeline = await prisma.pipeline.findFirst({
    where: { id: input.pipelineId, tenantId },
    select: {
      id: true,
      stages: {
        orderBy: { order: "asc" },
        select: { id: true },
      },
    },
  });
  if (!pipeline) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Pipeline not found in tenant catalog",
    });
  }

  // 2. Fetch deals with per-stage cap via ROW_NUMBER PARTITION raw query.
  //    Tenant scoping is EXPLICIT in WHERE; soft-delete via deleted_at IS NULL
  //    matches listDeals' contract; stage_total in the same window provides
  //    the truncatedCount without a second count round-trip.
  const dealRows = await prisma.$queryRaw<DealRow[]>`
    WITH ranked AS (
      SELECT
        d.id,
        d.name,
        d.value,
        d.currency,
        d.current_stage_id,
        d.entered_stage_at,
        d.contact_id,
        d.company_id,
        d.status::text AS status,
        d.probability,
        ROW_NUMBER() OVER (
          PARTITION BY d.current_stage_id
          ORDER BY d.entered_stage_at DESC, d.id
        ) AS rn,
        COUNT(*) OVER (PARTITION BY d.current_stage_id) AS stage_total
      FROM deals d
      WHERE d.tenant_id = ${tenantId}
        AND d.pipeline_id = ${input.pipelineId}
        AND d.deleted_at IS NULL
    )
    SELECT
      id, name, value, currency, current_stage_id, entered_stage_at,
      contact_id, company_id, status, probability, stage_total
    FROM ranked
    WHERE rn <= ${LIST_BY_PIPELINE_PER_STAGE_CAP}
    ORDER BY current_stage_id, entered_stage_at DESC, id
  `;

  // Empty-pipeline early return — emit a StageGroup per Stage so the board
  // can render empty columns in correct order.
  if (dealRows.length === 0) {
    return {
      stages: pipeline.stages.map((s) => ({
        stageId: s.id,
        deals: [],
        truncatedCount: 0,
      })),
    };
  }

  // 3. Hydrate contact + company. Tenant-scoped via Prisma client (the
  //    upstream raw query already guaranteed deal rows belong to this tenant,
  //    so contacts + companies pulled by these ids are tenant-correct; the
  //    explicit tenantId filter is defense-in-depth).
  const dealIds = dealRows.map((r) => r.id);
  const contactIds = [...new Set(dealRows.map((r) => r.contact_id))];
  const companyIds = [
    ...new Set(
      dealRows
        .map((r) => r.company_id)
        .filter((id): id is string => id !== null),
    ),
  ];

  const [contacts, companies] = await Promise.all([
    prisma.contact.findMany({
      where: { id: { in: contactIds }, tenantId },
      select: { id: true, firstName: true, lastName: true },
    }),
    companyIds.length > 0
      ? prisma.company.findMany({
          where: { id: { in: companyIds }, tenantId },
          select: { id: true, name: true },
        })
      : Promise.resolve([] as Array<{ id: string; name: string }>),
  ]);

  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const companyById = new Map(companies.map((c) => [c.id, c]));

  // 4. Latest Decision per deal via DISTINCT ON. Tenant scoping is EXPLICIT
  //    again (defense-in-depth) — even though dealIds came from a tenant-
  //    scoped query, the inner JOIN on decisions.tenant_id = ${tenantId}
  //    means a malicious data shape (e.g., a stage_history row pointing at
  //    another tenant's Decision via a corrupted decision_id) cannot leak.
  //    Decision.created_at is the timestamp (no separate decided_at column).
  const decisionRows =
    dealIds.length > 0
      ? await prisma.$queryRaw<DecisionRow[]>`
          SELECT DISTINCT ON (dsh.deal_id)
            dsh.deal_id,
            dec.action_type,
            dec.confidence
          FROM deal_stage_history dsh
          INNER JOIN decisions dec ON dec.id = dsh.decision_id
          WHERE dsh.deal_id = ANY(${dealIds}::text[])
            AND dec.tenant_id = ${tenantId}
          ORDER BY dsh.deal_id, dsh.transitioned_at DESC
        `
      : [];
  const decisionByDealId = new Map(decisionRows.map((d) => [d.deal_id, d]));

  // 5. Group + hydrate. Stage order preserved from pipeline.stages query.
  const stageGroups: StageGroup[] = pipeline.stages.map((stage) => {
    const rowsForStage = dealRows.filter(
      (r) => r.current_stage_id === stage.id,
    );
    const cards: DealCard[] = rowsForStage.map((r) => {
      const contact = contactById.get(r.contact_id);
      const company = r.company_id
        ? (companyById.get(r.company_id) ?? null)
        : null;
      const decision = decisionByDealId.get(r.id);
      return {
        id: r.id,
        name: r.name,
        value: r.value.toString(),
        currency: r.currency,
        currentStageId: r.current_stage_id,
        enteredStageAt: r.entered_stage_at,
        contact: {
          firstName: contact?.firstName ?? null,
          lastName: contact?.lastName ?? null,
        },
        company: company ? { name: company.name } : null,
        status: r.status,
        probability: r.probability,
        latestDecision: decision
          ? {
              actionType: decision.action_type,
              confidence: decision.confidence,
            }
          : null,
      };
    });
    // stage_total carries the same value on every row of the stage (window
    // function output). Read off the first row; cap-aware truncatedCount =
    // total - cards.length (clamped to 0 for safety).
    const stageTotal = Number(rowsForStage[0]?.stage_total ?? 0n);
    const truncatedCount = Math.max(0, stageTotal - cards.length);
    return { stageId: stage.id, deals: cards, truncatedCount };
  });

  return { stages: stageGroups };
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
          lifecycleStage: true,
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
      // KAN-888 — pipeline + stage history for the Deal detail page.
      pipeline: {
        select: { id: true, name: true },
      },
      stageHistory: {
        take: 20,
        orderBy: { transitionedAt: "desc" },
        include: {
          fromStage: { select: { name: true } },
          toStage: { select: { name: true } },
          decision: {
            select: { id: true, actionType: true, strategySelected: true },
          },
        },
      },
      // KAN-cohort-3.5 — reverse "Linked orders" relation for Deal detail.
      // Capped + ordered by placedAt DESC, parity with getCompanyById.orders
      // + getContactById.orders. Paired _count.orders below for truthful
      // total when cap is exceeded.
      orders: {
        take: 20,
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
        select: { orders: true },
      },
    },
  });

  if (!deal) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Deal not found" });
  }

  // KAN-936 — manual owner hydration is now redundant because the relation
  // is declared on the schema. But the include above doesn't pull `owner`
  // (it was added in this PR; not yet wired into the existing include
  // block to avoid a wider audit). Manual hydration kept as a safety net
  // for the same shape; will collapse to `include: { owner }` in a future
  // PR. Either path returns the same { id, name, email } subset.
  let owner: { id: string; name: string | null; email: string } | null = null;
  if (deal.ownerId) {
    owner = await prisma.user.findFirst({
      where: { id: deal.ownerId, tenantId },
      select: { id: true, name: true, email: true },
    });
  }

  return { ...deal, owner };
}

/**
 * KAN-938 — Create a Deal with full FK validation.
 *
 * Required FKs: contactId, pipelineId, currentStageId — all must exist in
 * the caller's tenant + stage must belong to the pipeline.
 * Optional FK: companyId — validated if non-null.
 *
 * Conditional-field defensive null-clear lives in the FORM layer
 * (`formToCreateInput` in opportunity-form.tsx) — caller is expected to
 * have already cleared lostReason/lostReasonDetail when status≠'lost' and
 * wonProductSummary when status≠'won'. Backend trusts the payload.
 */
export async function createDeal(
  prisma: PrismaClient,
  tenantId: string,
  input: CreateInput,
) {
  // FK validations — order matters: tenant-scope first, then stage-in-pipeline.
  await assertContactInTenant(prisma, tenantId, input.contactId);
  await assertPipelineInTenant(prisma, tenantId, input.pipelineId);
  await assertStageInPipeline(prisma, tenantId, input.pipelineId, input.currentStageId);
  await assertCompanyInTenant(prisma, tenantId, input.companyId);
  // KAN-936 — owner FK validation (formalized in this PR).
  await assertOwnerInTenant(prisma, tenantId, input.ownerId);

  return prisma.deal.create({
    data: {
      tenantId,
      // Required FKs
      contactId: input.contactId,
      pipelineId: input.pipelineId,
      currentStageId: input.currentStageId,
      // Card 1 — defaults handled by Prisma schema when undefined
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
      probability: input.probability ?? null,
      // Card 2
      ...(input.status !== undefined ? { status: input.status as never } : {}),
      // KAN-942 — coerce yyyy-mm-dd → Date for Prisma's @db.Date column.
      expectedCloseDate: toDate(input.expectedCloseDate),
      lostReason: (input.lostReason ?? null) as never,
      lostReasonDetail: input.lostReasonDetail ?? null,
      wonProductSummary: input.wonProductSummary ?? null,
      // Card 4 — optional companyId + ownerId (required contactId set above)
      companyId: input.companyId ?? null,
      ownerId: input.ownerId ?? null,
    },
  });
}

/**
 * KAN-938 — Update a Deal with partial-update semantics.
 *
 * Double-guard on existence: `id + tenantId` (Deal lacks `deletedAt`; see
 * KAN-940 for the soft-delete migration). NOT_FOUND surfaces uniformly for
 * cross-tenant access (no existence leak).
 *
 * Pipeline + Stage are tightly coupled: if either is provided, BOTH must
 * be provided and consistent (matches the frontend cascading-picker UX
 * that resets stageId on pipeline change).
 */
export async function updateDeal(
  prisma: PrismaClient,
  tenantId: string,
  input: UpdateInput,
) {
  // KAN-940 — Triple-guard: id + tenantId + deletedAt: null. Soft-deleted
  // rows surface as NOT_FOUND alongside cross-tenant access (uniform error
  // shape, no existence leak). Mirrors Company's updateCompany pattern.
  const existing = await prisma.deal.findFirst({
    where: { id: input.id, tenantId, deletedAt: null },
    select: { id: true },
  });
  if (!existing) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Deal not found" });
  }

  // FK validations — only for fields being updated.
  await assertContactInTenant(prisma, tenantId, input.contactId);
  await assertCompanyInTenant(prisma, tenantId, input.companyId);
  // KAN-936 — owner FK validation (formalized in this PR).
  await assertOwnerInTenant(prisma, tenantId, input.ownerId);

  // Pipeline + Stage tightly coupled: BOTH or NEITHER.
  if (input.pipelineId !== undefined || input.currentStageId !== undefined) {
    if (input.pipelineId === undefined || input.currentStageId === undefined) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "pipelineId and currentStageId must be updated together",
      });
    }
    await assertPipelineInTenant(prisma, tenantId, input.pipelineId);
    await assertStageInPipeline(prisma, tenantId, input.pipelineId, input.currentStageId);
  }

  // Build a strict partial-update payload — only set fields explicitly
  // provided. Avoids clobbering optional values to null when a partial
  // update is sent.
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.value !== undefined) data.value = input.value;
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.probability !== undefined) data.probability = input.probability;
  if (input.status !== undefined) data.status = input.status;
  // KAN-942 — coerce yyyy-mm-dd → Date for Prisma's @db.Date column.
  if (input.expectedCloseDate !== undefined) data.expectedCloseDate = toDate(input.expectedCloseDate);
  if (input.lostReason !== undefined) data.lostReason = input.lostReason;
  if (input.lostReasonDetail !== undefined) data.lostReasonDetail = input.lostReasonDetail;
  if (input.wonProductSummary !== undefined) data.wonProductSummary = input.wonProductSummary;
  if (input.pipelineId !== undefined) data.pipelineId = input.pipelineId;
  if (input.currentStageId !== undefined) data.currentStageId = input.currentStageId;
  if (input.contactId !== undefined) data.contactId = input.contactId;
  if (input.companyId !== undefined) data.companyId = input.companyId;
  // KAN-936 — optional ownerId (User FK). Null clears the owner.
  if (input.ownerId !== undefined) data.ownerId = input.ownerId;

  return prisma.deal.update({
    where: { id: input.id },
    data,
  });
}
