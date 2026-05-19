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
import {
  projectRow,
  type FieldMappingEntryLike,
  type ProjectedContact,
  type ProjectedCompany,
  type ProjectedDeal,
  type ProjectedOrder,
} from "./lib/row-projection.js";

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
  /** KAN-915 — staging row has null sourceRowData. Should not happen
   *  (KAN-907 always writes it), but defended against here so we never
   *  silently INSERT NULL-everywhere canonical rows again. */
  | "source_row_data_missing"
  /** KAN-922 — Order import's dealLinkField='external_id' but the
   *  referenced Deal doesn't exist in the tenant. Distinct from
   *  contact_not_found so the operator knows which dependency is missing. */
  | "deal_not_found"
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

/**
 * KAN-922 — Generalized contact resolver. Supports email / phone /
 * external_id match keys. The previous resolveContactByEmail is kept as
 * a thin wrapper so the 7+ existing call sites continue working.
 *
 * For 'external_id': uses Prisma's JSON path filter
 * `{ externalIds: { path: [source], equals: value } }`. Requires Prisma
 * 4.10+ (we're on 5.22 — confirmed supported).
 *
 * **KAN-925** — JSON expression indexes deferred. Single-tenant scans
 * under 10K contacts remain acceptable; revisit when a tenant crosses
 * that threshold (currently 6740 contacts in axisone smoke tenant).
 */
export type ContactResolveKey =
  | { kind: "email"; value: string | null | undefined }
  | { kind: "phone"; value: string | null | undefined }
  | { kind: "external_id"; source: string; value: string | null | undefined };

export async function resolveContactByMatchKey(
  prisma: PrismaClient,
  tenantId: string,
  key: ContactResolveKey,
  // KAN-930 — Optional pre-built cache keyed by externalSourceTag value.
  // When populated, the external_id branch does O(1) Map.get instead of
  // O(N) seqscan. Cache is built by runCommit when config warrants; a
  // cache miss is a true miss (no DB fallback) because the cache was
  // built from the same query the DB path would run.
  // `undefined` (param not passed) → use DB path (backwards compat for
  // all non-runCommit callers).
  // `null` (param explicitly null) → use DB path (sentinel-bailed case
  // where the tenant has too many tagged rows to pre-cache).
  cache?: Map<string, string> | null,
): Promise<{ id: string } | null> {
  if (!key.value) return null;
  switch (key.kind) {
    case "email":
      return prisma.contact.findFirst({
        where: { tenantId, email: { equals: key.value, mode: "insensitive" } },
        select: { id: true },
      });
    case "phone":
      // Caller is responsible for normalizing the value via normalizePhone()
      // before passing — staging-side projection should handle this.
      return prisma.contact.findFirst({
        where: { tenantId, phone: key.value },
        select: { id: true },
      });
    case "external_id": {
      // KAN-921 — accept multi-value delimited external_ids. HubSpot
      // semicolon-delimits when a relation has >1 association (empirical
      // evidence: importJob cmpcol6920ae1dqcvubia7u72, 6630/8528 = 77.7%
      // of staged deals had vid1;vid2 shape). Split on common CSV-export
      // delimiters, OR-batch the lookups, first-match-wins per Prisma's
      // default ordering. Single-value inputs pass through unchanged
      // (split returns [value], OR with one element ≡ prior exact-match).
      const candidates = key.value
        .split(/[;,|]/)
        .map((v) => v.trim())
        .filter(Boolean);
      if (candidates.length === 0) return null;

      // KAN-930 — Map-first lookup path. First-match-wins semantics
      // preserved: iterate candidates in order, return first hit.
      if (cache) {
        for (const v of candidates) {
          const id = cache.get(v);
          if (id) return { id };
        }
        return null;
      }

      // Fallback: per-row DB query (cache=null sentinel-bailed OR
      // cache=undefined non-runCommit caller).
      return prisma.contact.findFirst({
        where: {
          tenantId,
          OR: candidates.map((v) => ({
            externalIds: { path: [key.source], equals: v },
          })),
        },
        select: { id: true },
      });
    }
  }
}

/** KAN-922 — Backwards-compatible wrapper. 7+ existing call sites
 *  continue working unchanged. Delegates to resolveContactByMatchKey. */
export async function resolveContactByEmail(
  prisma: PrismaClient,
  tenantId: string,
  email: string | null | undefined,
): Promise<{ id: string } | null> {
  return resolveContactByMatchKey(prisma, tenantId, { kind: "email", value: email });
}

/** KAN-922 — Deal resolver (NEW). commitOrder previously did NOT
 *  populate Order.dealId at all — this is net-new wiring for the
 *  Order → Deal link via external_id. */
export type DealResolveKey =
  | { kind: "external_id"; source: string; value: string | null | undefined };

export async function resolveDealByMatchKey(
  prisma: PrismaClient,
  tenantId: string,
  key: DealResolveKey,
  // KAN-930 — symmetric to resolveContactByMatchKey's cache param. See
  // that function for rationale + semantics.
  cache?: Map<string, string> | null,
): Promise<{ id: string } | null> {
  if (!key.value) return null;
  switch (key.kind) {
    case "external_id": {
      // KAN-921 — symmetric to resolveContactByMatchKey's external_id
      // case. See that branch for delimiter-set + first-match-wins
      // rationale + empirical motivation.
      const candidates = key.value
        .split(/[;,|]/)
        .map((v) => v.trim())
        .filter(Boolean);
      if (candidates.length === 0) return null;

      // KAN-930 — Map-first lookup path.
      if (cache) {
        for (const v of candidates) {
          const id = cache.get(v);
          if (id) return { id };
        }
        return null;
      }

      return prisma.deal.findFirst({
        where: {
          tenantId,
          OR: candidates.map((v) => ({
            externalIds: { path: [key.source], equals: v },
          })),
        },
        select: { id: true },
      });
    }
  }
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

/** Shared projection error — returned when a staging row has null
 *  sourceRowData and we can't project canonical data from it. */
function sourceRowDataMissingError(
  entityType: ImportEntityType,
  staging: { id: string; sourceRowIndex: number },
): CommitErrorEntry {
  return {
    stagingRowId: staging.id,
    entityType,
    sourceRowIndex: staging.sourceRowIndex,
    reason: "source_row_data_missing",
    errorMessage:
      "Staging row has null source_row_data. Cannot project canonical fields. Re-run row classification.",
  };
}

async function commitContact(
  tx: Prisma.TransactionClient,
  tenantId: string,
  staging: StagingContact,
  decision: EffectiveDecision,
  fieldMappings: FieldMappingEntryLike[],
  importJobId: string,
  // KAN-922 — passed so projectRow can tag externalIds + so we can
  // persist them onto the canonical Contact at insert/update time.
  externalSourceTag: string | null,
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
  if (staging.sourceRowData == null) {
    return sourceRowDataMissingError("contact", staging);
  }

  // KAN-915 — project at commit time. Mirror columns are a cache; the
  // canonical source of truth is sourceRowData + fieldMappings.
  const projected = projectRow(
    staging.sourceRowData as Record<string, unknown>,
    fieldMappings,
    "contacts",
    { tenantId, importJobId, sourceRowIndex: staging.sourceRowIndex },
    externalSourceTag,
  ) as ProjectedContact;

  const data = {
    tenantId,
    email: projected.email,
    phone: projected.phone,
    firstName: projected.firstName,
    lastName: projected.lastName,
    companyName: projected.companyName,
    // lifecycleStage defaults to 'lead' (NOT NULL with default in
    // schema) — Prisma applies the default if we omit the key.
    ...(projected.lifecycleStage ? { lifecycleStage: projected.lifecycleStage } : {}),
    ...(projected.source ? { source: projected.source } : {}),
    ...(projected.segment ? { segment: projected.segment } : {}),
    ...(projected.addressLine1 ? { addressLine1: projected.addressLine1 } : {}),
    ...(projected.addressLine2 ? { addressLine2: projected.addressLine2 } : {}),
    ...(projected.city ? { city: projected.city } : {}),
    ...(projected.region ? { region: projected.region } : {}),
    ...(projected.postalCode ? { postalCode: projected.postalCode } : {}),
    ...(projected.country ? { country: projected.country } : {}),
    // KAN-922 — persist source-tagged external id onto canonical Contact.
    ...(externalSourceTag && projected.externalIds?.[externalSourceTag]
      ? { externalIds: { [externalSourceTag]: projected.externalIds[externalSourceTag] } }
      : {}),
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
  fieldMappings: FieldMappingEntryLike[],
  importJobId: string,
  // KAN-922 — see commitContact.
  externalSourceTag: string | null,
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
  if (staging.sourceRowData == null) {
    return sourceRowDataMissingError("company", staging);
  }

  const projected = projectRow(
    staging.sourceRowData as Record<string, unknown>,
    fieldMappings,
    "companies",
    { tenantId, importJobId, sourceRowIndex: staging.sourceRowIndex },
    externalSourceTag,
  ) as ProjectedCompany;

  if (!projected.name) {
    return {
      stagingRowId: staging.id,
      entityType: "company",
      sourceRowIndex: staging.sourceRowIndex,
      reason: "company_name_required",
      errorMessage: "Company.name is NOT NULL with no default; projected name is empty.",
    };
  }

  const data = {
    tenantId,
    name: projected.name,
    // KAN-922 — persist source-tagged external id onto canonical Company.
    ...(externalSourceTag && projected.externalIds?.[externalSourceTag]
      ? { externalIds: { [externalSourceTag]: projected.externalIds[externalSourceTag] } }
      : {}),
    ...(projected.legalName ? { legalName: projected.legalName } : {}),
    ...(projected.domain ? { domain: projected.domain } : {}),
    ...(projected.website ? { website: projected.website } : {}),
    ...(projected.industry ? { industry: projected.industry } : {}),
    ...(projected.sizeRange ? { sizeRange: projected.sizeRange } : {}),
    ...(projected.annualRevenue ? { annualRevenue: projected.annualRevenue } : {}),
    ...(projected.phone ? { phone: projected.phone } : {}),
    ...(projected.email ? { email: projected.email } : {}),
    ...(projected.description ? { description: projected.description } : {}),
    ...(projected.lifecycleStage ? { lifecycleStage: projected.lifecycleStage } : {}),
    ...(projected.billingAddressLine1 ? { billingAddressLine1: projected.billingAddressLine1 } : {}),
    ...(projected.billingAddressLine2 ? { billingAddressLine2: projected.billingAddressLine2 } : {}),
    ...(projected.billingCity ? { billingCity: projected.billingCity } : {}),
    ...(projected.billingRegion ? { billingRegion: projected.billingRegion } : {}),
    ...(projected.billingPostalCode ? { billingPostalCode: projected.billingPostalCode } : {}),
    ...(projected.billingCountry ? { billingCountry: projected.billingCountry } : {}),
    ...(projected.mailingAddressLine1 ? { mailingAddressLine1: projected.mailingAddressLine1 } : {}),
    ...(projected.mailingAddressLine2 ? { mailingAddressLine2: projected.mailingAddressLine2 } : {}),
    ...(projected.mailingCity ? { mailingCity: projected.mailingCity } : {}),
    ...(projected.mailingRegion ? { mailingRegion: projected.mailingRegion } : {}),
    ...(projected.mailingPostalCode ? { mailingPostalCode: projected.mailingPostalCode } : {}),
    ...(projected.mailingCountry ? { mailingCountry: projected.mailingCountry } : {}),
    ...(projected.taxId ? { taxId: projected.taxId } : {}),
    ...(projected.taxIdType ? { taxIdType: projected.taxIdType } : {}),
    ...(projected.businessRegistrationNumber ? { businessRegistrationNumber: projected.businessRegistrationNumber } : {}),
    ...(projected.incorporationJurisdiction ? { incorporationJurisdiction: projected.incorporationJurisdiction } : {}),
    ...(projected.isTaxExempt != null ? { isTaxExempt: projected.isTaxExempt } : {}),
    ...(projected.ownerId ? { ownerId: projected.ownerId } : {}),
    ...(projected.linkedinUrl ? { linkedinUrl: projected.linkedinUrl } : {}),
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

/** KAN-922 — Helper: build a ContactResolveKey dispatching on the
 *  user-picked customerLinkField. NULL/unknown → fall back to email. */
function buildContactResolveKey(
  customerLinkField: string | null,
  externalSourceTag: string | null,
  email: string | null | undefined,
  externalIds: Record<string, string> | undefined,
  phone: string | null | undefined,
): ContactResolveKey {
  if (customerLinkField === "external_id" && externalSourceTag) {
    return {
      kind: "external_id",
      source: externalSourceTag,
      value: externalIds?.[externalSourceTag] ?? null,
    };
  }
  if (customerLinkField === "phone") {
    return { kind: "phone", value: phone ?? null };
  }
  return { kind: "email", value: email ?? null };
}

/** KAN-922 — Helper: error entry for contact resolution miss, with the
 *  verbatim error message per locked decision G8 when external_id was
 *  the link key. */
function contactNotFoundError(
  entityType: ImportEntityType,
  staging: { id: string; sourceRowIndex: number },
  key: ContactResolveKey,
): CommitErrorEntry {
  let unresolvedKey = "";
  let errorMessage = "";
  if (key.kind === "external_id") {
    unresolvedKey = String(key.value ?? "");
    // Verbatim from KAN-922 locked decision G8.
    errorMessage = `Customer matched by external_id=${unresolvedKey} (source=${key.source}) not found. The customer may have been imported earlier without external_id set for this source. Re-import customers with external_id mapping first.`;
  } else if (key.kind === "phone") {
    unresolvedKey = String(key.value ?? "");
    errorMessage = key.value
      ? `No Contact with phone '${unresolvedKey}' found in tenant. Upload contacts first.`
      : `${entityType} staging row has no phone — Contact.${entityType === "deal" ? "contactId" : "contactId"} is NOT NULL.`;
  } else {
    unresolvedKey = String(key.value ?? "");
    errorMessage = key.value
      ? `No Contact with email '${unresolvedKey}' found in tenant. Upload contacts first.`
      : `${entityType} staging row has no contactEmail — Contact.contactId is NOT NULL.`;
  }
  return {
    stagingRowId: staging.id,
    entityType,
    sourceRowIndex: staging.sourceRowIndex,
    reason: "contact_not_found",
    unresolvedKey,
    errorMessage,
  };
}

async function commitDeal(
  tx: Prisma.TransactionClient,
  tenantId: string,
  staging: StagingDeal,
  decision: EffectiveDecision,
  fieldMappings: FieldMappingEntryLike[],
  importJobId: string,
  // KAN-922 — per-import match configuration. NULL → fall back to email
  // resolver (backwards compat).
  customerLinkField: string | null,
  externalSourceTag: string | null,
  // KAN-930 — optional pre-built resolver cache. undefined/null → DB fallback.
  contactCacheByVid: Map<string, string> | null,
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
  if (staging.sourceRowData == null) {
    return sourceRowDataMissingError("deal", staging);
  }

  const projected = projectRow(
    staging.sourceRowData as Record<string, unknown>,
    fieldMappings,
    "deals",
    { tenantId, importJobId, sourceRowIndex: staging.sourceRowIndex },
    externalSourceTag,
  ) as ProjectedDeal;

  // 1. KAN-922 — Resolve contactId via user-picked match key. NULL
  //    customerLinkField → email (backwards compat).
  const contactKey = buildContactResolveKey(
    customerLinkField,
    externalSourceTag,
    projected.contactEmail,
    projected.contactExternalIds,
    null, // phone not currently projected for Deal staging (out of scope)
  );
  const contact = await resolveContactByMatchKey(
    tx as unknown as PrismaClient,
    tenantId,
    contactKey,
    contactCacheByVid,
  );
  if (!contact) {
    return contactNotFoundError("deal", staging, contactKey);
  }

  // 2. Resolve pipelineId — falls back to tenant default.
  const pipeline = await resolvePipelineByName(
    tx as unknown as PrismaClient,
    tenantId,
    projected.pipelineName,
  );
  if (!pipeline) {
    return {
      stagingRowId: staging.id,
      entityType: "deal",
      sourceRowIndex: staging.sourceRowIndex,
      reason: "pipeline_not_found",
      unresolvedKey: projected.pipelineName ?? "(no default)",
      errorMessage:
        "No matching Pipeline + tenant has no default Pipeline. Run the Onboarding Wizard or create a Pipeline first.",
    };
  }

  // 3. Resolve currentStageId — falls back to pipeline's isInitial.
  const stage = await resolveStageByName(
    tx as unknown as PrismaClient,
    pipeline.id,
    projected.stageName,
  );
  if (!stage) {
    return {
      stagingRowId: staging.id,
      entityType: "deal",
      sourceRowIndex: staging.sourceRowIndex,
      reason: "stage_not_found",
      unresolvedKey: projected.stageName ?? "(no initial stage)",
      errorMessage: `Pipeline ${pipeline.id} has no matching Stage + no initial Stage. Pipeline configuration is broken.`,
    };
  }

  // 4. Optional Company lookup.
  const company = await resolveCompanyByName(
    tx as unknown as PrismaClient,
    tenantId,
    projected.companyName,
  );

  const data: Prisma.DealUncheckedCreateInput = {
    tenantId,
    contactId: contact.id,
    pipelineId: pipeline.id,
    currentStageId: stage.id,
    name: projected.name ?? "Untitled deal",
    value: projected.value ?? new Prisma.Decimal(0),
    currency: projected.currency ?? "USD",
    ...(projected.status ? { status: projected.status } : {}),
    ...(projected.probability != null ? { probability: projected.probability } : {}),
    ...(projected.expectedCloseDate ? { expectedCloseDate: projected.expectedCloseDate } : {}),
    ...(projected.closedAt ? { closedAt: projected.closedAt } : {}),
    ...(projected.lostReason ? { lostReason: projected.lostReason } : {}),
    ...(projected.lostReasonDetail ? { lostReasonDetail: projected.lostReasonDetail } : {}),
    ...(projected.wonProductSummary ? { wonProductSummary: projected.wonProductSummary } : {}),
    ...(projected.ownerId ? { ownerId: projected.ownerId } : {}),
    ...(company ? { companyId: company.id } : {}),
    // KAN-922 — persist source-tagged external id onto canonical Deal.
    ...(externalSourceTag && projected.externalIds?.[externalSourceTag]
      ? { externalIds: { [externalSourceTag]: projected.externalIds[externalSourceTag] } }
      : {}),
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
        // KAN-922 — update externalIds on existing Deal too (idempotent
        // re-import overwrites the same tag with same value).
        ...(externalSourceTag && projected.externalIds?.[externalSourceTag]
          ? { externalIds: { [externalSourceTag]: projected.externalIds[externalSourceTag] } }
          : {}),
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
  fieldMappings: FieldMappingEntryLike[],
  importJobId: string,
  // KAN-922 — per-import match configuration.
  customerLinkField: string | null,
  dealLinkField: string | null,
  externalSourceTag: string | null,
  // KAN-930 — optional pre-built resolver caches. undefined/null → DB fallback.
  contactCacheByVid: Map<string, string> | null,
  dealCacheByVid: Map<string, string> | null,
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
  if (staging.sourceRowData == null) {
    return sourceRowDataMissingError("order", staging);
  }

  const projected = projectRow(
    staging.sourceRowData as Record<string, unknown>,
    fieldMappings,
    "orders",
    { tenantId, importJobId, sourceRowIndex: staging.sourceRowIndex },
    externalSourceTag,
  ) as ProjectedOrder;

  // 1. KAN-922 — Resolve contactId via user-picked match key.
  const contactKey = buildContactResolveKey(
    customerLinkField,
    externalSourceTag,
    projected.contactEmail,
    projected.contactExternalIds,
    null, // phone not currently projected for Order staging
  );
  const contact = await resolveContactByMatchKey(
    tx as unknown as PrismaClient,
    tenantId,
    contactKey,
    contactCacheByVid,
  );
  if (!contact) {
    return contactNotFoundError("order", staging, contactKey);
  }

  // 2. KAN-922 — NEW Deal-FK resolver. dealLinkField NULL → leave
  //    Order.dealId NULL (today's pre-KAN-922 behavior). Only soft-misses
  //    are an error; missing dealLinkField is a deliberate user choice.
  let dealId: string | null = null;
  if (dealLinkField === "external_id" && externalSourceTag) {
    const dealExtId = projected.dealExternalIds?.[externalSourceTag] ?? null;
    if (dealExtId) {
      const deal = await resolveDealByMatchKey(
        tx as unknown as PrismaClient,
        tenantId,
        { kind: "external_id", source: externalSourceTag, value: dealExtId },
        dealCacheByVid,
      );
      if (!deal) {
        return {
          stagingRowId: staging.id,
          entityType: "order",
          sourceRowIndex: staging.sourceRowIndex,
          reason: "deal_not_found",
          unresolvedKey: dealExtId,
          errorMessage: `Deal matched by external_id=${dealExtId} (source=${externalSourceTag}) not found in tenant. Re-import deals with external_id mapping first.`,
        };
      }
      dealId = deal.id;
    }
  }

  if (!projected.orderNumber) {
    return {
      stagingRowId: staging.id,
      entityType: "order",
      sourceRowIndex: staging.sourceRowIndex,
      reason: "unknown",
      errorMessage: "Order.orderNumber is NOT NULL; projected orderNumber is empty.",
    };
  }

  // 3. Optional Company lookup.
  const company = await resolveCompanyByName(
    tx as unknown as PrismaClient,
    tenantId,
    projected.companyName,
  );

  const data: Prisma.OrderUncheckedCreateInput = {
    tenantId,
    contactId: contact.id,
    orderNumber: projected.orderNumber,
    ...(dealId ? { dealId } : {}),
    ...(projected.providerOrderId ? { providerOrderId: projected.providerOrderId } : {}),
    ...(projected.status ? { status: projected.status } : {}),
    ...(projected.totalAmount ? { totalAmount: projected.totalAmount } : {}),
    ...(projected.taxAmount ? { taxAmount: projected.taxAmount } : {}),
    ...(projected.discountAmount ? { discountAmount: projected.discountAmount } : {}),
    grandTotal: projected.grandTotal ?? new Prisma.Decimal(0),
    currency: projected.currency ?? "USD",
    placedAt: projected.placedAt ?? new Date(),
    ...(projected.paidAt ? { paidAt: projected.paidAt } : {}),
    ...(projected.refundedAt ? { refundedAt: projected.refundedAt } : {}),
    ...(projected.paymentMethod ? { paymentMethod: projected.paymentMethod } : {}),
    ...(projected.paymentProvider ? { paymentProvider: projected.paymentProvider } : {}),
    ...(projected.customerNotes ? { customerNotes: projected.customerNotes } : {}),
    ...(company ? { companyId: company.id } : {}),
    // KAN-922 — persist source-tagged external id onto canonical Order.
    ...(externalSourceTag && projected.externalIds?.[externalSourceTag]
      ? { externalIds: { [externalSourceTag]: projected.externalIds[externalSourceTag] } }
      : {}),
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
        unresolvedKey: projected.orderNumber,
        errorMessage: `Order with orderNumber '${projected.orderNumber}' already exists in this tenant.`,
      };
    }
    throw err;
  }
}

// ─────────────────────────────────────────────
// KAN-930 — Resolver pre-cache builders
// ─────────────────────────────────────────────

/** Sentinel: tenants with >50K tagged rows fall back to per-row resolver
 *  to bound memory + bulk-query latency. Pre-launch single-tenant ceiling
 *  is well below this; well-engineered for the foreseeable scale. */
const KAN930_PRECACHE_ROW_SENTINEL = 50_000;

/** KAN-930 — Build a vid → contactId Map for resolver fast path.
 *  Returns null when tenant has >SENTINEL contacts with the tag (caller
 *  falls back to per-row DB resolver). */
async function buildContactCacheByExternalId(
  prisma: PrismaClient,
  tenantId: string,
  externalSourceTag: string,
): Promise<Map<string, string> | null> {
  const taggedCount = await prisma.contact.count({
    where: {
      tenantId,
      externalIds: { path: [externalSourceTag], not: Prisma.JsonNull },
    },
  });
  if (taggedCount > KAN930_PRECACHE_ROW_SENTINEL) {
    // eslint-disable-next-line no-console
    console.log(
      `[KAN-930] Pre-cache bailed: tenantId=${tenantId} tag=${externalSourceTag} ` +
        `taggedCount=${taggedCount} > sentinel=${KAN930_PRECACHE_ROW_SENTINEL}. Per-row fallback.`,
    );
    return null;
  }
  const tagged = await prisma.contact.findMany({
    where: {
      tenantId,
      externalIds: { path: [externalSourceTag], not: Prisma.JsonNull },
    },
    select: { id: true, externalIds: true },
  });
  const cache = new Map<string, string>();
  for (const c of tagged) {
    const vid = (c.externalIds as Record<string, string> | null)?.[externalSourceTag];
    if (vid) cache.set(vid, c.id);
  }
  // eslint-disable-next-line no-console
  console.log(
    `[KAN-930] Contact pre-cache built: tenantId=${tenantId} tag=${externalSourceTag} ` +
      `taggedContacts=${tagged.length} mapEntries=${cache.size}`,
  );
  return cache;
}

/** KAN-930 — Symmetric Deal cache builder for Order.dealId resolution. */
async function buildDealCacheByExternalId(
  prisma: PrismaClient,
  tenantId: string,
  externalSourceTag: string,
): Promise<Map<string, string> | null> {
  const taggedCount = await prisma.deal.count({
    where: {
      tenantId,
      externalIds: { path: [externalSourceTag], not: Prisma.JsonNull },
    },
  });
  if (taggedCount > KAN930_PRECACHE_ROW_SENTINEL) {
    // eslint-disable-next-line no-console
    console.log(
      `[KAN-930] Pre-cache bailed (deal): tenantId=${tenantId} tag=${externalSourceTag} ` +
        `taggedCount=${taggedCount} > sentinel=${KAN930_PRECACHE_ROW_SENTINEL}. Per-row fallback.`,
    );
    return null;
  }
  const tagged = await prisma.deal.findMany({
    where: {
      tenantId,
      externalIds: { path: [externalSourceTag], not: Prisma.JsonNull },
    },
    select: { id: true, externalIds: true },
  });
  const cache = new Map<string, string>();
  for (const d of tagged) {
    const vid = (d.externalIds as Record<string, string> | null)?.[externalSourceTag];
    if (vid) cache.set(vid, d.id);
  }
  // eslint-disable-next-line no-console
  console.log(
    `[KAN-930] Deal pre-cache built: tenantId=${tenantId} tag=${externalSourceTag} ` +
      `taggedDeals=${tagged.length} mapEntries=${cache.size}`,
  );
  return cache;
}

// ─────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────

export async function runCommit(
  prisma: PrismaClient,
  importJobId: string,
  tenantId: string,
): Promise<ImportJob> {
  // KAN-923 — Pre-claim match-config completeness gate. If any field
  // mapping targets the external_id family but externalSourceTag is null,
  // the commit would silently produce external_ids={} on every canonical
  // row (current write-path code is null-tolerant but the data shape
  // would be wrong). Fail loud before any state mutation. See KAN-923
  // reframe (2026-05-19) — empirical evidence from importJob
  // cmp65ai4m1hr3bea6v7umawas: 6592 rows committed with external_ids={}
  // because externalSourceTag was set 6 min POST-commit.
  const preflightJob = await prisma.importJob.findFirst({
    where: { id: importJobId, tenantId },
    select: { fieldMappings: true, externalSourceTag: true },
  });
  if (preflightJob) {
    const externalIdTargets = new Set([
      "external_id",
      "customer_external_id",
      "deal_external_id",
    ]);
    const preflightMappings = Array.isArray(preflightJob.fieldMappings)
      ? (preflightJob.fieldMappings as unknown as FieldMappingEntryLike[])
      : [];
    const hasExternalIdMapping = preflightMappings.some(
      (m) => m.targetField != null && externalIdTargets.has(m.targetField),
    );
    if (hasExternalIdMapping && !preflightJob.externalSourceTag) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Match configuration is incomplete. Field mappings include an " +
          "external_id target but externalSourceTag is not set. " +
          "Re-open Card 5 (Match settings) and configure externalSourceTag " +
          "before committing.",
      });
    }
  }

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

  // KAN-915 — extract fieldMappings for the projection at commit time.
  // Job.fieldMappings is Json | null; coerce loose here, validate at
  // the projection layer (unknown source columns → null values).
  const fieldMappings: FieldMappingEntryLike[] = Array.isArray(job.fieldMappings)
    ? (job.fieldMappings as unknown as FieldMappingEntryLike[])
    : [];

  // KAN-922 — load per-import match configuration. NULL columns fall
  // back to the heuristic / email defaults in each commit handler.
  const externalSourceTag = job.externalSourceTag ?? null;
  const customerLinkField = job.customerLinkField ?? null;
  const dealLinkField = job.dealLinkField ?? null;

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

    // KAN-930 — Build resolver pre-caches if config + workload warrants.
    // contactCacheByVid: built when customerLinkField='external_id' AND there
    //   are deals/orders to commit (savings come from per-row resolver calls).
    // dealCacheByVid: built when dealLinkField='external_id' AND there are
    //   orders to commit.
    // Sentinel at 50K tagged rows: bail to per-row resolver fallback.
    // See KAN-927 reframe (`feedback_kan927_hang_misdiagnosis_2026_05_19.md`)
    // for the motivation — turning N seqscans into 1 bulk fetch + O(1) Map
    // lookups; worst-case wall-clock improvement 49min → <30sec at 8528 rows.
    let contactCacheByVid: Map<string, string> | null = null;
    let dealCacheByVid: Map<string, string> | null = null;
    if (
      externalSourceTag &&
      customerLinkField === "external_id" &&
      (stagingDeals.length > 0 || stagingOrders.length > 0)
    ) {
      contactCacheByVid = await buildContactCacheByExternalId(
        prisma,
        tenantId,
        externalSourceTag,
      );
    }
    if (
      externalSourceTag &&
      dealLinkField === "external_id" &&
      stagingOrders.length > 0
    ) {
      dealCacheByVid = await buildDealCacheByExternalId(
        prisma,
        tenantId,
        externalSourceTag,
      );
    }

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
      // KAN-930 — Per-row progress logging. Closes the "invisible-progressing
      // vs stuck" observability gap surfaced by KAN-927's misdiagnosis: when
      // all rows fail with contact_not_found, the per-row $transaction commits
      // with no DB writes (stagingUpdater + writeAuditEntry are inside the
      // `if ("ok" in r)` branch), making mid-run state visually identical to
      // a hang. Structured log every N rows answers "stuck or just slow?".
      const PROGRESS_LOG_EVERY = 100;
      const batchStartedAt = Date.now();
      let batchRowsProcessed = 0;
      let batchRowsCommitted = 0;
      let batchRowsErrored = 0;
      let batchRowsSkipped = 0;

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
          batchRowsProcessed++;
          batchRowsSkipped++;
          if (batchRowsProcessed % PROGRESS_LOG_EVERY === 0) {
            const elapsedMs = Date.now() - batchStartedAt;
            const rowsPerSec = (batchRowsProcessed / (elapsedMs / 1000)).toFixed(1);
            // eslint-disable-next-line no-console
            console.log(
              `[KAN-930] runCommit progress: importJobId=${importJobId} ` +
                `entityType=${entityType} processed=${batchRowsProcessed}/${rows.length} ` +
                `committed=${batchRowsCommitted} errored=${batchRowsErrored} skipped=${batchRowsSkipped} ` +
                `elapsedMs=${elapsedMs} rowsPerSec=${rowsPerSec}`,
            );
          }
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
            batchRowsCommitted++;
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
            batchRowsErrored++;
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
          batchRowsErrored++;
        }

        batchRowsProcessed++;
        if (batchRowsProcessed % PROGRESS_LOG_EVERY === 0) {
          const elapsedMs = Date.now() - batchStartedAt;
          const rowsPerSec = (batchRowsProcessed / (elapsedMs / 1000)).toFixed(1);
          // eslint-disable-next-line no-console
          console.log(
            `[KAN-930] runCommit progress: importJobId=${importJobId} ` +
              `entityType=${entityType} processed=${batchRowsProcessed}/${rows.length} ` +
              `committed=${batchRowsCommitted} errored=${batchRowsErrored} skipped=${batchRowsSkipped} ` +
              `elapsedMs=${elapsedMs} rowsPerSec=${rowsPerSec}`,
          );
        }
      }

      // KAN-930 — Final batch summary (always logged, regardless of N-row alignment).
      // Helps differentiate "completed cleanly" from "killed mid-loop" in PROD
      // logs even when the import is shorter than PROGRESS_LOG_EVERY.
      if (rows.length > 0) {
        const elapsedMs = Date.now() - batchStartedAt;
        // eslint-disable-next-line no-console
        console.log(
          `[KAN-930] runCommit batch done: importJobId=${importJobId} ` +
            `entityType=${entityType} processed=${batchRowsProcessed}/${rows.length} ` +
            `committed=${batchRowsCommitted} errored=${batchRowsErrored} skipped=${batchRowsSkipped} ` +
            `elapsedMs=${elapsedMs}`,
        );
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
      (tx, staging, decision) =>
        commitContact(tx, tenantId, staging, decision, fieldMappings, importJobId, externalSourceTag),
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
      (tx, staging, decision) =>
        commitCompany(tx, tenantId, staging, decision, fieldMappings, importJobId, externalSourceTag),
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
      (tx, staging, decision) =>
        commitDeal(tx, tenantId, staging, decision, fieldMappings, importJobId, customerLinkField, externalSourceTag, contactCacheByVid),
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
      (tx, staging, decision) =>
        commitOrder(tx, tenantId, staging, decision, fieldMappings, importJobId, customerLinkField, dealLinkField, externalSourceTag, contactCacheByVid, dealCacheByVid),
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
