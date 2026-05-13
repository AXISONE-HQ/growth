/**
 * KAN-913 — Ingestion Cohort 2.7. Commit + audit + Pub/Sub fanout.
 *
 * Cohort closer (PR 8/8). After KAN-911 wrote `matchDecision` JSON to
 * every staging row, this service honors those decisions and writes
 * canonical Contact / Company / Deal / Order rows.
 *
 * Architecture (V1, sync):
 *   - User clicks "Commit" → tRPC mutation → runCommit blocks until
 *     done (~30-60s for 10K rows).
 *   - Per-row $transaction wraps canonical write + staging status
 *     update + audit log entry. All-or-nothing PER ROW — one row's
 *     error doesn't roll back siblings.
 *   - Pub/Sub fanout fires AFTER the per-row $transaction commits
 *     (env-flag gated via IMPORT_EVENTS_ENABLED, KAN-852 pattern).
 *   - ImportJob aggregate counters update at the end (single write).
 *
 * Bright lines (decisions locked in Phase 1):
 *   - actor format: `user:${ImportJob.createdByUserId}` (fall back to
 *     'system' + console.warn if null).
 *   - Missing-contact policy on Deal/Order: error into commitErrors,
 *     DO NOT auto-create stubs, DO NOT silent-skip.
 *   - 1 fan-out topic (`import.row_committed`) with entityType
 *     attribute for downstream routing. No per-entity topic split.
 *   - On-demand CSV download — no GCS write at commit time.
 *
 * Async commit (Cloud Run job + Pub/Sub trigger) deferred to a
 * follow-up. Pre-launch single-tenant doesn't need it yet.
 */
import { Prisma, type PrismaClient, type ImportJob } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import crypto from "node:crypto";
import Papa from "papaparse";
import {
  buildImportRowCommittedEvent,
  type ImportEntityType,
} from "@growth/shared";
import { publishImportRowCommitted } from "./lib/import-row-committed-publisher.js";

// ─────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────

/** Failure modes a single row commit can hit. Wide enough to cover the
 *  observed paths without becoming a free-form string. Surfaced in the
 *  commitErrors CSV download for operator triage. */
export type CommitErrorReason =
  | "contact_not_found"
  | "pipeline_not_found"
  | "stage_not_found"
  | "order_number_duplicate"
  | "company_name_required"
  | "needs_review_unresolved"
  | "update_target_missing"
  | "unknown";

export interface CommitErrorEntry {
  stagingRowId: string;
  entityType: ImportEntityType;
  sourceRowIndex: number;
  reason: CommitErrorReason;
  /** The unresolved key (email / pipelineName / orderNumber / etc.) when
   *  the reason is a lookup miss. Omitted for generic errors. */
  unresolvedKey?: string;
  errorMessage: string;
}

/** Subset of MatchDecision shape we read at commit-time. Mirrors
 *  KAN-911's MatchDecision but kept loose so this module doesn't
 *  import from import-dedup.ts. */
interface MatchDecisionLike {
  candidates?: Array<{ existingEntityId: string; score: number }>;
  suggestedAction?: "update" | "needs_review" | "insert" | "skip";
  confidence?: number;
  suggestedReason?: string;
  userChoice?: {
    action: "update" | "needs_review" | "insert" | "skip";
    chosenCandidateId?: string;
    overriddenAt: string;
  };
}

// ─────────────────────────────────────────────
// Decision resolver — picks the effective action from KAN-911's
// matchDecision. After confirmDuplicateResolution, every needs_review
// row should have a userChoice; if we see one without, that's an
// invariant violation → row errors.
// ─────────────────────────────────────────────

interface EffectiveDecision {
  action: "update" | "needs_review" | "insert" | "skip";
  chosenCandidateId?: string;
}

function resolveEffectiveDecision(
  md: MatchDecisionLike | null,
): EffectiveDecision {
  if (!md) return { action: "insert" };
  const action = md.userChoice?.action ?? md.suggestedAction ?? "insert";
  const chosenCandidateId =
    action === "update"
      ? md.userChoice?.chosenCandidateId ??
        md.candidates?.[0]?.existingEntityId
      : undefined;
  return { action, chosenCandidateId };
}

// ─────────────────────────────────────────────
// Resolver helpers — Deal/Order need to project staging text fields
// (contactEmail, pipelineName, stageName) into canonical FK ids.
// ─────────────────────────────────────────────

export async function resolveContactByEmail(
  prisma: PrismaClient,
  tenantId: string,
  email: string | null | undefined,
): Promise<{ id: string } | null> {
  if (!email) return null;
  return prisma.contact.findFirst({
    where: { tenantId, email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
}

/** Look up a Pipeline by name within a tenant. When `name` is empty
 *  OR no Pipeline matches, falls back to the tenant's default Pipeline
 *  (first active Pipeline by createdAt asc — matches the
 *  default-pipeline-bootstrap.ts convention). Returns null if the
 *  tenant has no Pipelines at all (caller emits 'pipeline_not_found'). */
export async function resolvePipelineByName(
  prisma: PrismaClient,
  tenantId: string,
  name: string | null | undefined,
): Promise<{ id: string } | null> {
  if (name && name.trim()) {
    const byName = await prisma.pipeline.findFirst({
      where: { tenantId, name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    if (byName) return byName;
  }
  // Fallback: tenant's default (first active by createdAt asc).
  return prisma.pipeline.findFirst({
    where: { tenantId, isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
}

/** Look up a Stage by name within a Pipeline. When `name` is empty OR
 *  no Stage matches, falls back to the Pipeline's `isInitial=true`
 *  Stage. Returns null if the Pipeline has no stages at all (caller
 *  emits 'stage_not_found'). */
export async function resolveStageByName(
  prisma: PrismaClient,
  pipelineId: string,
  name: string | null | undefined,
): Promise<{ id: string } | null> {
  if (name && name.trim()) {
    const byName = await prisma.stage.findFirst({
      where: { pipelineId, name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    if (byName) return byName;
  }
  // Fallback: the Pipeline's isInitial Stage (one is guaranteed by
  // KAN-791 invariant). If somehow absent, return the first by order.
  return (
    (await prisma.stage.findFirst({
      where: { pipelineId, isInitial: true },
      select: { id: true },
    })) ??
    (await prisma.stage.findFirst({
      where: { pipelineId },
      orderBy: { order: "asc" },
      select: { id: true },
    }))
  );
}

/** Optional Company lookup by name within tenant. Returns null on miss
 *  — Company linkage on Contact/Deal/Order is optional, so a miss just
 *  leaves the relation unset (no error). */
async function resolveCompanyByName(
  prisma: PrismaClient,
  tenantId: string,
  name: string | null | undefined,
): Promise<{ id: string } | null> {
  if (!name || !name.trim()) return null;
  return prisma.company.findFirst({
    where: { tenantId, name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
}

// ─────────────────────────────────────────────
// Audit log writer + Pub/Sub emitter
// ─────────────────────────────────────────────

/** Per-row AuditLog write. Called INSIDE the per-row $transaction so
 *  a canonical-write success without an audit entry is impossible. */
async function writeAuditEntry(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    actor: string;
    entityType: ImportEntityType;
    action: "inserted" | "updated";
    entityId: string;
    importJobId: string;
    stagingRowId: string;
    sourceRowIndex: number;
    importFileName: string;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      tenantId: input.tenantId,
      actor: input.actor,
      actionType: `import.row.committed.${input.entityType}`,
      payload: {
        importJobId: input.importJobId,
        stagingRowId: input.stagingRowId,
        sourceRowIndex: input.sourceRowIndex,
        entityId: input.entityId,
        action: input.action,
        importFileName: input.importFileName,
      },
      reasoning: null,
    },
  });
}

/** Best-effort fanout emitter. Called OUTSIDE the per-row $transaction
 *  so a publish error never rolls back a successful commit. Env-flag
 *  gated; skipped silently when IMPORT_EVENTS_ENABLED!='true'. */
async function emitFanoutEvent(input: {
  tenantId: string;
  importJobId: string;
  entityType: ImportEntityType;
  entityId: string;
  action: "inserted" | "updated";
  stagingRowId: string;
  sourceRowIndex: number;
  actor: string;
  committedAt: Date;
}): Promise<void> {
  try {
    const event = buildImportRowCommittedEvent({
      eventId: `evt_${crypto.randomUUID()}`,
      tenantId: input.tenantId,
      importJobId: input.importJobId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      stagingRowId: input.stagingRowId,
      sourceRowIndex: input.sourceRowIndex,
      actor: input.actor,
      committedAt: input.committedAt.toISOString(),
    });
    await publishImportRowCommitted(event);
  } catch (err) {
    // At-least-once / best-effort: a publish failure must NOT roll
    // back the commit (transaction already closed). Log + move on.
    // eslint-disable-next-line no-console
    console.warn(
      `[import-commit] publishImportRowCommitted failed for ${input.entityType}/${input.entityId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ─────────────────────────────────────────────
// Staging-row shapes (projected from Prisma findMany)
// ─────────────────────────────────────────────

interface StagingContact {
  id: string;
  sourceRowIndex: number;
  sourceRowData: unknown;
  matchDecision: unknown;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  lifecycleStage: "lead" | "marketing_qualified" | "sales_qualified" | "customer" | "evangelist" | "other" | null;
  source: string | null;
  stagingStatus: string;
}

interface StagingCompany {
  id: string;
  sourceRowIndex: number;
  sourceRowData: unknown;
  matchDecision: unknown;
  name: string | null;
  domain: string | null;
  industry: string | null;
  billingCity: string | null;
  billingCountry: string | null;
  stagingStatus: string;
}

interface StagingDeal {
  id: string;
  sourceRowIndex: number;
  sourceRowData: unknown;
  matchDecision: unknown;
  name: string | null;
  value: Prisma.Decimal | null;
  currency: string | null;
  status: string | null;
  expectedCloseDate: Date | null;
  contactEmail: string | null;
  companyName: string | null;
  pipelineName: string | null;
  stageName: string | null;
  stagingStatus: string;
}

interface StagingOrder {
  id: string;
  sourceRowIndex: number;
  sourceRowData: unknown;
  matchDecision: unknown;
  orderNumber: string | null;
  providerOrderId: string | null;
  status: string | null;
  grandTotal: Prisma.Decimal | null;
  currency: string | null;
  placedAt: Date | null;
  contactEmail: string | null;
  companyName: string | null;
  stagingStatus: string;
}

// ─────────────────────────────────────────────
// Per-entity commit helpers
//
// Each returns { ok: true, action, entityId } | CommitErrorEntry.
// The orchestrator wraps the Prisma writes in $transaction; these
// helpers do the actual canonical insert/update.
// ─────────────────────────────────────────────

interface CommitOk {
  ok: true;
  action: "inserted" | "updated";
  entityId: string;
}
type CommitResult = CommitOk | CommitErrorEntry;

async function commitContact(
  tx: Prisma.TransactionClient,
  tenantId: string,
  staging: StagingContact,
  decision: EffectiveDecision,
): Promise<CommitResult> {
  if (decision.action === "needs_review") {
    return {
      stagingRowId: staging.id,
      entityType: "contact",
      sourceRowIndex: staging.sourceRowIndex,
      reason: "needs_review_unresolved",
      errorMessage:
        "Contact staging row reached commit with suggestedAction='needs_review' and no userChoice (KAN-911 confirm gate should have prevented this).",
    };
  }

  const data = {
    tenantId,
    email: staging.email,
    phone: staging.phone,
    firstName: staging.firstName,
    lastName: staging.lastName,
    companyName: staging.companyName,
    // lifecycleStage defaults to 'lead' (NOT NULL with default in
    // schema) — Prisma applies the default if we omit the key.
    ...(staging.lifecycleStage ? { lifecycleStage: staging.lifecycleStage } : {}),
  };

  if (decision.action === "update") {
    if (!decision.chosenCandidateId) {
      return {
        stagingRowId: staging.id,
        entityType: "contact",
        sourceRowIndex: staging.sourceRowIndex,
        reason: "update_target_missing",
        errorMessage:
          "matchDecision.userChoice.action='update' but chosenCandidateId is absent.",
      };
    }
    const existing = await tx.contact.findFirst({
      where: { id: decision.chosenCandidateId, tenantId },
      select: { id: true },
    });
    if (!existing) {
      return {
        stagingRowId: staging.id,
        entityType: "contact",
        sourceRowIndex: staging.sourceRowIndex,
        reason: "update_target_missing",
        unresolvedKey: decision.chosenCandidateId,
        errorMessage: `Update target Contact ${decision.chosenCandidateId} not found in tenant ${tenantId}.`,
      };
    }
    const updated = await tx.contact.update({
      where: { id: existing.id },
      data,
      select: { id: true },
    });
    return { ok: true, action: "updated", entityId: updated.id };
  }

  // insert path
  const created = await tx.contact.create({ data, select: { id: true } });
  return { ok: true, action: "inserted", entityId: created.id };
}

async function commitCompany(
  tx: Prisma.TransactionClient,
  tenantId: string,
  staging: StagingCompany,
  decision: EffectiveDecision,
): Promise<CommitResult> {
  if (decision.action === "needs_review") {
    return {
      stagingRowId: staging.id,
      entityType: "company",
      sourceRowIndex: staging.sourceRowIndex,
      reason: "needs_review_unresolved",
      errorMessage:
        "Company staging row reached commit with suggestedAction='needs_review' and no userChoice.",
    };
  }
  if (!staging.name || !staging.name.trim()) {
    return {
      stagingRowId: staging.id,
      entityType: "company",
      sourceRowIndex: staging.sourceRowIndex,
      reason: "company_name_required",
      errorMessage: "Company.name is NOT NULL with no default; staging row has no name.",
    };
  }

  const data = {
    tenantId,
    name: staging.name,
    domain: staging.domain,
    industry: staging.industry,
    billingCity: staging.billingCity,
    billingCountry: staging.billingCountry,
  };

  if (decision.action === "update") {
    if (!decision.chosenCandidateId) {
      return {
        stagingRowId: staging.id,
        entityType: "company",
        sourceRowIndex: staging.sourceRowIndex,
        reason: "update_target_missing",
        errorMessage: "userChoice.action='update' but chosenCandidateId is absent.",
      };
    }
    const existing = await tx.company.findFirst({
      where: { id: decision.chosenCandidateId, tenantId },
      select: { id: true },
    });
    if (!existing) {
      return {
        stagingRowId: staging.id,
        entityType: "company",
        sourceRowIndex: staging.sourceRowIndex,
        reason: "update_target_missing",
        unresolvedKey: decision.chosenCandidateId,
        errorMessage: `Update target Company ${decision.chosenCandidateId} not found in tenant ${tenantId}.`,
      };
    }
    const updated = await tx.company.update({
      where: { id: existing.id },
      data,
      select: { id: true },
    });
    return { ok: true, action: "updated", entityId: updated.id };
  }

  const created = await tx.company.create({ data, select: { id: true } });
  return { ok: true, action: "inserted", entityId: created.id };
}

async function commitDeal(
  tx: Prisma.TransactionClient,
  tenantId: string,
  staging: StagingDeal,
  decision: EffectiveDecision,
): Promise<CommitResult> {
  if (decision.action === "needs_review") {
    return {
      stagingRowId: staging.id,
      entityType: "deal",
      sourceRowIndex: staging.sourceRowIndex,
      reason: "needs_review_unresolved",
      errorMessage:
        "Deal staging row reached commit with suggestedAction='needs_review' and no userChoice.",
    };
  }

  // 1. Resolve contactId — required NOT NULL.
  const contact = await resolveContactByEmail(
    tx as unknown as PrismaClient,
    tenantId,
    staging.contactEmail,
  );
  if (!contact) {
    return {
      stagingRowId: staging.id,
      entityType: "deal",
      sourceRowIndex: staging.sourceRowIndex,
      reason: "contact_not_found",
      unresolvedKey: staging.contactEmail ?? "",
      errorMessage: staging.contactEmail
        ? `No Contact with email '${staging.contactEmail}' found in tenant. Upload contacts first.`
        : "Deal staging row has no contactEmail — Deal.contactId is NOT NULL.",
    };
  }

  // 2. Resolve pipelineId — falls back to tenant default.
  const pipeline = await resolvePipelineByName(
    tx as unknown as PrismaClient,
    tenantId,
    staging.pipelineName,
  );
  if (!pipeline) {
    return {
      stagingRowId: staging.id,
      entityType: "deal",
      sourceRowIndex: staging.sourceRowIndex,
      reason: "pipeline_not_found",
      unresolvedKey: staging.pipelineName ?? "(no default)",
      errorMessage:
        "No matching Pipeline + tenant has no default Pipeline. Run the Onboarding Wizard or create a Pipeline first.",
    };
  }

  // 3. Resolve currentStageId — falls back to pipeline's isInitial.
  const stage = await resolveStageByName(
    tx as unknown as PrismaClient,
    pipeline.id,
    staging.stageName,
  );
  if (!stage) {
    return {
      stagingRowId: staging.id,
      entityType: "deal",
      sourceRowIndex: staging.sourceRowIndex,
      reason: "stage_not_found",
      unresolvedKey: staging.stageName ?? "(no initial stage)",
      errorMessage: `Pipeline ${pipeline.id} has no matching Stage + no initial Stage. Pipeline configuration is broken.`,
    };
  }

  // 4. Optional Company lookup.
  const company = await resolveCompanyByName(
    tx as unknown as PrismaClient,
    tenantId,
    staging.companyName,
  );

  const data: Prisma.DealUncheckedCreateInput = {
    tenantId,
    contactId: contact.id,
    pipelineId: pipeline.id,
    currentStageId: stage.id,
    name: staging.name ?? "Untitled deal",
    value: staging.value ?? new Prisma.Decimal(0),
    currency: staging.currency ?? "USD",
    expectedCloseDate: staging.expectedCloseDate,
    ...(company ? { companyId: company.id } : {}),
  };

  if (decision.action === "update") {
    if (!decision.chosenCandidateId) {
      return {
        stagingRowId: staging.id,
        entityType: "deal",
        sourceRowIndex: staging.sourceRowIndex,
        reason: "update_target_missing",
        errorMessage: "userChoice.action='update' but chosenCandidateId is absent.",
      };
    }
    const existing = await tx.deal.findFirst({
      where: { id: decision.chosenCandidateId, tenantId },
      select: { id: true },
    });
    if (!existing) {
      return {
        stagingRowId: staging.id,
        entityType: "deal",
        sourceRowIndex: staging.sourceRowIndex,
        reason: "update_target_missing",
        unresolvedKey: decision.chosenCandidateId,
        errorMessage: `Update target Deal ${decision.chosenCandidateId} not found in tenant ${tenantId}.`,
      };
    }
    // Update path skips re-keying FKs (contactId / pipelineId immutable
    // here) — only mutable fields.
    const updated = await tx.deal.update({
      where: { id: existing.id },
      data: {
        name: data.name,
        value: data.value,
        currency: data.currency,
        expectedCloseDate: data.expectedCloseDate,
        ...(company ? { companyId: company.id } : {}),
      },
      select: { id: true },
    });
    return { ok: true, action: "updated", entityId: updated.id };
  }

  const created = await tx.deal.create({ data, select: { id: true } });
  return { ok: true, action: "inserted", entityId: created.id };
}

async function commitOrder(
  tx: Prisma.TransactionClient,
  tenantId: string,
  staging: StagingOrder,
  decision: EffectiveDecision,
): Promise<CommitResult> {
  if (decision.action === "needs_review") {
    return {
      stagingRowId: staging.id,
      entityType: "order",
      sourceRowIndex: staging.sourceRowIndex,
      reason: "needs_review_unresolved",
      errorMessage:
        "Order staging row reached commit with suggestedAction='needs_review' and no userChoice.",
    };
  }

  // 1. Resolve contactId — required NOT NULL.
  const contact = await resolveContactByEmail(
    tx as unknown as PrismaClient,
    tenantId,
    staging.contactEmail,
  );
  if (!contact) {
    return {
      stagingRowId: staging.id,
      entityType: "order",
      sourceRowIndex: staging.sourceRowIndex,
      reason: "contact_not_found",
      unresolvedKey: staging.contactEmail ?? "",
      errorMessage: staging.contactEmail
        ? `No Contact with email '${staging.contactEmail}' found in tenant. Upload contacts first.`
        : "Order staging row has no contactEmail — Order.contactId is NOT NULL.",
    };
  }

  if (!staging.orderNumber || !staging.orderNumber.trim()) {
    return {
      stagingRowId: staging.id,
      entityType: "order",
      sourceRowIndex: staging.sourceRowIndex,
      reason: "unknown",
      errorMessage: "Order.orderNumber is NOT NULL; staging row has no orderNumber.",
    };
  }

  // 2. Optional Company lookup.
  const company = await resolveCompanyByName(
    tx as unknown as PrismaClient,
    tenantId,
    staging.companyName,
  );

  const data: Prisma.OrderUncheckedCreateInput = {
    tenantId,
    contactId: contact.id,
    orderNumber: staging.orderNumber,
    providerOrderId: staging.providerOrderId,
    grandTotal: staging.grandTotal ?? new Prisma.Decimal(0),
    currency: staging.currency ?? "USD",
    placedAt: staging.placedAt ?? new Date(),
    ...(company ? { companyId: company.id } : {}),
  };

  try {
    if (decision.action === "update") {
      if (!decision.chosenCandidateId) {
        return {
          stagingRowId: staging.id,
          entityType: "order",
          sourceRowIndex: staging.sourceRowIndex,
          reason: "update_target_missing",
          errorMessage: "userChoice.action='update' but chosenCandidateId is absent.",
        };
      }
      const existing = await tx.order.findFirst({
        where: { id: decision.chosenCandidateId, tenantId },
        select: { id: true },
      });
      if (!existing) {
        return {
          stagingRowId: staging.id,
          entityType: "order",
          sourceRowIndex: staging.sourceRowIndex,
          reason: "update_target_missing",
          unresolvedKey: decision.chosenCandidateId,
          errorMessage: `Update target Order ${decision.chosenCandidateId} not found in tenant ${tenantId}.`,
        };
      }
      const updated = await tx.order.update({
        where: { id: existing.id },
        data: {
          providerOrderId: data.providerOrderId,
          grandTotal: data.grandTotal,
          currency: data.currency,
          placedAt: data.placedAt,
          ...(company ? { companyId: company.id } : {}),
        },
        select: { id: true },
      });
      return { ok: true, action: "updated", entityId: updated.id };
    }

    const created = await tx.order.create({ data, select: { id: true } });
    return { ok: true, action: "inserted", entityId: created.id };
  } catch (err) {
    // P2002 → unique constraint on [tenantId, orderNumber]. Surface as
    // a structured error rather than aborting the whole commit.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return {
        stagingRowId: staging.id,
        entityType: "order",
        sourceRowIndex: staging.sourceRowIndex,
        reason: "order_number_duplicate",
        unresolvedKey: staging.orderNumber,
        errorMessage: `Order with orderNumber '${staging.orderNumber}' already exists in this tenant.`,
      };
    }
    throw err;
  }
}

// ─────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────

export async function runCommit(
  prisma: PrismaClient,
  importJobId: string,
  tenantId: string,
): Promise<ImportJob> {
  // Atomic claim: race-free transition from pending → running.
  // Only one caller's updateMany returns count=1; concurrent callers see
  // count=0 and get an informative CONFLICT / BAD_REQUEST / NOT_FOUND from
  // the re-fetch branch below. The `commitStatus: 'pending'` filter is
  // load-bearing — partial / failed / succeeded commits cannot be re-run
  // in V1. Retry-after-failure semantics deferred (filed as a follow-up).
  const claim = await prisma.importJob.updateMany({
    where: {
      id: importJobId,
      tenantId,
      commitStatus: "pending",
      dedupConfirmedAt: { not: null },
    },
    data: {
      commitStatus: "running",
      commitStartedAt: new Date(),
      commitCompletedAt: null,
      committedRowCount: 0,
      failedRowCount: 0,
      commitErrors: [],
    },
  });

  if (claim.count === 0) {
    // Diagnose why the claim failed and return an informative error.
    const current = await prisma.importJob.findFirst({
      where: { id: importJobId, tenantId },
    });
    if (!current) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Import job not found: ${importJobId}`,
      });
    }
    if (!current.dedupConfirmedAt) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Duplicate detection must be confirmed before running commit",
      });
    }
    if (current.commitStatus === "running") {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Commit is already running for this import job",
      });
    }
    if (
      current.commitStatus === "succeeded" ||
      current.commitStatus === "partial" ||
      current.commitStatus === "failed"
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `Commit already ${current.commitStatus}; cannot re-run. File a new import job to retry.`,
      });
    }
    // Fallback — shouldn't be reachable given the cases above.
    throw new TRPCError({
      code: "CONFLICT",
      message: "Import job cannot be committed in its current state",
    });
  }

  // Re-fetch the now-claimed job for createdByUserId + fileName + other reads.
  const job = await prisma.importJob.findFirstOrThrow({
    where: { id: importJobId, tenantId },
  });

  // Resolve actor — `user:${createdByUserId}` with fallback to 'system'.
  let actor: string;
  if (job.createdByUserId) {
    actor = `user:${job.createdByUserId}`;
  } else {
    actor = "system";
    // eslint-disable-next-line no-console
    console.warn(
      `[import-commit] ImportJob ${importJobId} has null createdByUserId; falling back to actor='system'`,
    );
  }

  const errors: CommitErrorEntry[] = [];
  let committedCount = 0;
  const fanoutEvents: Array<{
    entityType: ImportEntityType;
    entityId: string;
    action: "inserted" | "updated";
    stagingRowId: string;
    sourceRowIndex: number;
    committedAt: Date;
  }> = [];

  try {
    // Pull every staging row. Excludes rows already in terminal staging
    // states (committed / skipped) — a re-run only touches rows that
    // haven't been resolved yet. mapping_error / dedup_error rows are
    // also excluded (they need a re-run of the upstream phase first).
    const [stagingContacts, stagingCompanies, stagingDeals, stagingOrders] =
      await Promise.all([
        prisma.importStagingContact.findMany({
          where: {
            importJobId,
            stagingStatus: { in: ["pending", "ready"] },
          },
          orderBy: { sourceRowIndex: "asc" },
        }),
        prisma.importStagingCompany.findMany({
          where: {
            importJobId,
            stagingStatus: { in: ["pending", "ready"] },
          },
          orderBy: { sourceRowIndex: "asc" },
        }),
        prisma.importStagingDeal.findMany({
          where: {
            importJobId,
            stagingStatus: { in: ["pending", "ready"] },
          },
          orderBy: { sourceRowIndex: "asc" },
        }),
        prisma.importStagingOrder.findMany({
          where: {
            importJobId,
            stagingStatus: { in: ["pending", "ready"] },
          },
          orderBy: { sourceRowIndex: "asc" },
        }),
      ]);

    // Helper — process a list of staging rows with a per-entity commit
    // handler. Each row gets its own $transaction; the handler returns
    // either CommitOk (canonical write + staging update + audit log
    // inside the tx) or a CommitErrorEntry (still updates staging
    // status to 'committed' won't fire — leaves at 'ready' for re-try).
    const processBatch = async <T extends { id: string; sourceRowIndex: number; matchDecision: unknown }>(
      rows: T[],
      entityType: ImportEntityType,
      handler: (
        tx: Prisma.TransactionClient,
        staging: T,
        decision: EffectiveDecision,
      ) => Promise<CommitResult>,
      stagingUpdater: (
        tx: Prisma.TransactionClient,
        id: string,
        targetIdField: { key: string; value: string },
        status: "committed" | "skipped",
      ) => Promise<void>,
      targetIdKey: string,
    ): Promise<void> => {
      for (const row of rows) {
        const decision = resolveEffectiveDecision(
          row.matchDecision as MatchDecisionLike | null,
        );

        if (decision.action === "skip") {
          // No canonical write, no audit, no event — just mark staging
          // status and move on. Single-statement update; no tx needed.
          await prisma.$transaction(async (tx) => {
            await stagingUpdater(tx, row.id, { key: targetIdKey, value: "" }, "skipped");
          });
          continue;
        }

        try {
          const result = await prisma.$transaction(async (tx) => {
            const r = await handler(tx, row, decision);
            if ("ok" in r) {
              await stagingUpdater(tx, row.id, { key: targetIdKey, value: r.entityId }, "committed");
              await writeAuditEntry(tx, {
                tenantId,
                actor,
                entityType,
                action: r.action,
                entityId: r.entityId,
                importJobId,
                stagingRowId: row.id,
                sourceRowIndex: row.sourceRowIndex,
                importFileName: job.fileName,
              });
            }
            return r;
          });

          if ("ok" in result) {
            committedCount++;
            fanoutEvents.push({
              entityType,
              entityId: result.entityId,
              action: result.action,
              stagingRowId: row.id,
              sourceRowIndex: row.sourceRowIndex,
              committedAt: new Date(),
            });
          } else {
            errors.push(result);
          }
        } catch (err) {
          // Anything that bubbles past the per-row tx (DB connection
          // failure, unexpected Prisma error, etc.) — record + continue.
          // Aborts ONLY if the orchestrator's outer try-catch catches a
          // catastrophic failure (caught below).
          errors.push({
            stagingRowId: row.id,
            entityType,
            sourceRowIndex: row.sourceRowIndex,
            reason: "unknown",
            errorMessage:
              err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    // Run per-entity batches sequentially (no concurrency in V1; deals
    // depend on contacts existing, and the user is staring at a
    // spinner — predictable ordering matters more than throughput).
    // Closure wrappers bind tenantId into each handler — `processBatch`'s
    // handler signature is (tx, staging, decision); the commit* helpers
    // take (tx, tenantId, staging, decision). Without these closures the
    // tenantId would shift into the `staging` slot and decision would
    // fall off as undefined (caught in dev as a TypeError on
    // `decision.action`).
    await processBatch(
      stagingContacts,
      "contact",
      (tx, staging, decision) => commitContact(tx, tenantId, staging, decision),
      (tx, id, target, status) =>
        tx.importStagingContact
          .update({
            where: { id },
            data: {
              stagingStatus: status,
              targetContactId: target.value || null,
            },
          })
          .then(() => undefined),
      "targetContactId",
    );
    await processBatch(
      stagingCompanies,
      "company",
      (tx, staging, decision) => commitCompany(tx, tenantId, staging, decision),
      (tx, id, target, status) =>
        tx.importStagingCompany
          .update({
            where: { id },
            data: {
              stagingStatus: status,
              targetCompanyId: target.value || null,
            },
          })
          .then(() => undefined),
      "targetCompanyId",
    );
    await processBatch(
      stagingDeals,
      "deal",
      (tx, staging, decision) => commitDeal(tx, tenantId, staging, decision),
      (tx, id, target, status) =>
        tx.importStagingDeal
          .update({
            where: { id },
            data: {
              stagingStatus: status,
              targetDealId: target.value || null,
            },
          })
          .then(() => undefined),
      "targetDealId",
    );
    await processBatch(
      stagingOrders,
      "order",
      (tx, staging, decision) => commitOrder(tx, tenantId, staging, decision),
      (tx, id, target, status) =>
        tx.importStagingOrder
          .update({
            where: { id },
            data: {
              stagingStatus: status,
              targetOrderId: target.value || null,
            },
          })
          .then(() => undefined),
      "targetOrderId",
    );

    // Determine final commitStatus.
    //   succeeded — at least 1 commit, zero errors
    //   partial   — at least 1 commit AND at least 1 error
    //   failed    — zero commits (all rows errored)
    let finalStatus: "succeeded" | "partial" | "failed";
    if (errors.length === 0 && committedCount > 0) finalStatus = "succeeded";
    else if (errors.length === 0 && committedCount === 0) finalStatus = "succeeded"; // no-op commit (everything was 'skip')
    else if (committedCount === 0) finalStatus = "failed";
    else finalStatus = "partial";

    const updated = await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        commitStatus: finalStatus,
        commitCompletedAt: new Date(),
        committedRowCount: committedCount,
        failedRowCount: errors.length,
        commitErrors: errors as unknown as Prisma.InputJsonValue,
      },
    });

    // Fire Pub/Sub events AFTER the ImportJob aggregate write. Each
    // emit is best-effort (catches its own errors, never throws).
    for (const evt of fanoutEvents) {
      await emitFanoutEvent({
        tenantId,
        importJobId,
        ...evt,
        actor,
      });
    }

    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Catastrophic failure path: mark commit as failed; preserve any
    // errors already captured.
    await prisma.importJob.update({
      where: { id: importJobId },
      data: {
        commitStatus: "failed",
        commitCompletedAt: new Date(),
        committedRowCount: committedCount,
        failedRowCount: errors.length,
        commitErrors: errors as unknown as Prisma.InputJsonValue,
      },
    });
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Commit aborted: ${message}`,
    });
  }
}

// ─────────────────────────────────────────────
// CSV download — on-demand from commitErrors JSON
// ─────────────────────────────────────────────

export async function downloadCommitErrors(
  prisma: PrismaClient,
  importJobId: string,
  tenantId: string,
): Promise<{ csvContent: string; rowCount: number }> {
  const job = await prisma.importJob.findFirst({
    where: { id: importJobId, tenantId },
    select: { commitErrors: true },
  });
  if (!job) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Import job not found: ${importJobId}`,
    });
  }
  const errors = (job.commitErrors ?? []) as CommitErrorEntry[];
  if (!Array.isArray(errors) || errors.length === 0) {
    return { csvContent: "", rowCount: 0 };
  }

  const csvContent = Papa.unparse(
    errors.map((e) => ({
      sourceRowIndex: e.sourceRowIndex,
      entityType: e.entityType,
      reason: e.reason,
      unresolvedKey: e.unresolvedKey ?? "",
      errorMessage: e.errorMessage,
      stagingRowId: e.stagingRowId,
    })),
    {
      header: true,
      columns: [
        "sourceRowIndex",
        "entityType",
        "reason",
        "unresolvedKey",
        "errorMessage",
        "stagingRowId",
      ],
    },
  );

  return { csvContent, rowCount: errors.length };
}
