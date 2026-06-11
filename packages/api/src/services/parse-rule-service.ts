/**
 * KAN-1140 Phase 3 PR 9a — Tenant parser customization lifecycle service.
 *
 * Ships substrate only: create, update, delete, list, getDetail, restore.
 * Rules cannot fire until PR 9b's executor lands in lead-normalizer.ts;
 * no operator UI until PR 9c. tRPC procedures exist (this PR's
 * `parseRulesRouter`) but are unreachable from the operator-facing surface
 * in 9a.
 *
 * # Security posture
 *
 *   - All queries are `tenantId`-scoped (multi-tenant rule leakage defense)
 *   - Cross-tenant `fingerprintId` reference rejected with NOT_FOUND
 *   - Body validation runs at create AND update time via
 *     `ParseRuleBodySchema` from `@growth/shared` (defense-in-depth — tRPC
 *     layer also validates)
 *   - Per-tenant rule count cap (`MAX_RULES_PER_TENANT`) enforced before
 *     INSERT (Q10 lock)
 *   - Operator info-leak minimized: NOT_FOUND surface for any
 *     wrong-tenant access (same surface as wrong-id)
 *
 * # Versioning (Q7 hybrid lock)
 *
 *   - Each mutation writes a `parse_rule.*` audit row (full history)
 *   - Update + restore snapshot the displaced body to `ParseRuleVersion`
 *     (`@unique ruleId` — exactly one snapshot per rule)
 *   - Restore promotes the snapshot back; re-snapshots the displaced body
 *     so restoring is itself reversible
 *
 * # Q-ADD-2 lock — writeAuditBestEffort
 *
 * 4th inline copy of the helper. Uses the 5-arg canonical shape mirrored
 * from `recommendations.ts:writeAuditBestEffort` (actor parameterized;
 * NOT the gap-tracker.ts 4-arg variant with hardcoded actor). KAN-1150
 * follow-up consolidates all 4 sites; intentionally kept separate from
 * PR 9a per Senior PO Q-ADD-2 lock.
 *
 * # Prisma surface cast pattern
 *
 * Mirrors `parse-fingerprint-aggregator.ts` cross-workspace Prisma type
 * drift defense — `(prisma as unknown as { ... }).model.op(...)` keeps
 * the apps/api → packages/api type inference predictable across the
 * cross-rootDir boundary (KAN-689 territory).
 */
import { TRPCError } from "@trpc/server";
import { PrismaClient } from "@prisma/client";
import {
  ParseRuleBodySchema,
  MAX_RULES_PER_TENANT,
  type ParseRuleBody,
} from "@growth/shared";
// KAN-1168 — Consolidated audit-helper migration. Previously inline copy at
// :792 (5-arg positional with explicit `actor`). All 7 callsites pass the
// per-call operator identity (input.userId) at the callsite.
import { writeAuditBestEffort } from "../utils/audit-helpers.js";

// ─────────────────────────────────────────────
// Service input/output shapes
// ─────────────────────────────────────────────

export interface CreateParseRuleInput {
  tenantId: string;
  userId: string;
  label: string;
  body: ParseRuleBody;
  fingerprintId?: string;
  format?: string;
  vendor?: string;
}

export interface UpdateParseRuleInput {
  tenantId: string;
  userId: string;
  ruleId: string;
  label?: string;
  body?: ParseRuleBody;
  status?: "pending" | "active" | "disabled";
}

export interface DeleteParseRuleInput {
  tenantId: string;
  userId: string;
  ruleId: string;
}

export interface ListParseRulesInput {
  tenantId: string;
  fingerprintId?: string;
  format?: string;
  vendor?: string;
  statusFilter?: "pending" | "active" | "disabled";
  limit?: number;
  offset?: number;
}

export interface GetParseRuleDetailInput {
  tenantId: string;
  ruleId: string;
}

/**
 * KAN-1140 Phase 3 PR 9b — Cascade lookup input. Returns rules whose
 * scope cascade matches the provided fingerprint context. Used by
 * `lead-normalizer` to fetch applicable rules at runtime.
 *
 * Cascade semantics (Q-ADD-4 lock):
 *   - rule.fingerprintId match OR null = applies
 *   - rule.format match OR null = applies
 *   - rule.vendor match OR null = applies
 *
 * Rules filtered to `status='active'` (Q8 lock — operators must
 * explicitly activate rules; PR 9b's create defaults to 'pending').
 */
export interface GetApplicableRulesInput {
  tenantId: string;
  fingerprintId: string | null;
  format: string | null;
  vendor: string | null;
}

export interface RestoreParseRuleInput {
  tenantId: string;
  userId: string;
  ruleId: string;
}

export interface ParseRuleRow {
  id: string;
  tenantId: string;
  fingerprintId: string | null;
  format: string | null;
  vendor: string | null;
  body: unknown;
  label: string;
  status: string;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ParseRuleVersionRow {
  id: string;
  ruleId: string;
  tenantId: string;
  body: unknown;
  label: string;
  status: string;
  archivedAt: Date;
  archivedBy: string;
}

export interface ParseRuleDetail extends ParseRuleRow {
  previousVersion: ParseRuleVersionRow | null;
}

// Prisma surface shape (cast pattern per parse-fingerprint-aggregator.ts).
interface PrismaSurface {
  parseRule: {
    count: (args: { where: { tenantId: string } }) => Promise<number>;
    create: (args: { data: Record<string, unknown> }) => Promise<ParseRuleRow>;
    findFirst: (args: {
      where: { id: string; tenantId: string };
      include?: { version?: boolean };
    }) => Promise<(ParseRuleRow & { version?: ParseRuleVersionRow | null }) | null>;
    findMany: (args: {
      where: Record<string, unknown>;
      orderBy: Record<string, unknown>;
      take: number;
      skip: number;
    }) => Promise<ParseRuleRow[]>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<ParseRuleRow>;
    delete: (args: { where: { id: string } }) => Promise<ParseRuleRow>;
  };
  parseRuleVersion: {
    upsert: (args: {
      where: { ruleId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => Promise<ParseRuleVersionRow>;
    findUnique: (args: {
      where: { ruleId: string };
    }) => Promise<ParseRuleVersionRow | null>;
  };
  parseFingerprint: {
    findFirst: (args: {
      where: { id: string; tenantId: string };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
  auditLog: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
}

// ─────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────

export async function createParseRule(
  prisma: PrismaClient,
  input: CreateParseRuleInput,
): Promise<{ id: string }> {
  // Defense-in-depth body validation (tRPC layer also validates).
  ParseRuleBodySchema.parse(input.body);

  const ps = prisma as unknown as PrismaSurface;

  // Q10 lock — per-tenant rule count cap.
  const count = await ps.parseRule.count({ where: { tenantId: input.tenantId } });
  if (count >= MAX_RULES_PER_TENANT) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Tenant rule limit reached (${MAX_RULES_PER_TENANT}). Delete or update existing rules before creating new ones.`,
    });
  }

  // Cross-tenant fingerprint reference defense — verify the fingerprint
  // exists in the tenant's scope before linking. NOT_FOUND surface for
  // wrong-tenant access (info-leak minimization).
  if (input.fingerprintId) {
    const fp = await ps.parseFingerprint.findFirst({
      where: { id: input.fingerprintId, tenantId: input.tenantId },
      select: { id: true },
    });
    if (!fp) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Fingerprint not found in tenant scope.",
      });
    }
  }

  const rule = await ps.parseRule.create({
    data: {
      tenantId: input.tenantId,
      fingerprintId: input.fingerprintId ?? null,
      format: input.format ?? null,
      vendor: input.vendor ?? null,
      body: input.body as unknown as Record<string, unknown>,
      label: input.label,
      status: "pending",
      createdBy: input.userId,
      updatedBy: input.userId,
    },
  });

  await writeAuditBestEffort(prisma, {
    tenantId: input.tenantId,
    actor: input.userId,
    actionType: "parse_rule.created",
    payload: {
      ruleId: rule.id,
      label: input.label,
      scope: {
        fingerprintId: input.fingerprintId ?? null,
        format: input.format ?? null,
        vendor: input.vendor ?? null,
      },
    },
  });

  return { id: rule.id };
}

// ─────────────────────────────────────────────
// Update
// ─────────────────────────────────────────────

export async function updateParseRule(
  prisma: PrismaClient,
  input: UpdateParseRuleInput,
): Promise<{ id: string }> {
  if (input.body) ParseRuleBodySchema.parse(input.body);

  const ps = prisma as unknown as PrismaSurface;

  // Read current — confirms tenant scope + captures body for snapshot.
  const current = await ps.parseRule.findFirst({
    where: { id: input.ruleId, tenantId: input.tenantId },
  });
  if (!current) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Rule not found in tenant scope." });
  }

  // Snapshot current body to ParseRuleVersion BEFORE writing the new
  // body (upsert on @unique ruleId — exactly one snapshot per rule;
  // updating overwrites the prior snapshot).
  await ps.parseRuleVersion.upsert({
    where: { ruleId: input.ruleId },
    create: {
      ruleId: input.ruleId,
      tenantId: input.tenantId,
      body: current.body as unknown as Record<string, unknown>,
      label: current.label,
      status: current.status,
      archivedBy: input.userId,
    },
    update: {
      body: current.body as unknown as Record<string, unknown>,
      label: current.label,
      status: current.status,
      archivedAt: new Date(),
      archivedBy: input.userId,
    },
  });

  // Build update data only with fields the caller provided.
  const updateData: Record<string, unknown> = { updatedBy: input.userId };
  if (input.label !== undefined) updateData.label = input.label;
  if (input.body !== undefined) updateData.body = input.body as unknown as Record<string, unknown>;
  if (input.status !== undefined) updateData.status = input.status;

  await ps.parseRule.update({
    where: { id: input.ruleId },
    data: updateData,
  });

  await writeAuditBestEffort(prisma, {
    tenantId: input.tenantId,
    actor: input.userId,
    actionType: "parse_rule.updated",
    payload: {
      ruleId: input.ruleId,
      fieldsChanged: Object.keys(updateData).filter((k) => k !== "updatedBy"),
    },
  });

  return { id: input.ruleId };
}

// ─────────────────────────────────────────────
// Delete
// ─────────────────────────────────────────────

export async function deleteParseRule(
  prisma: PrismaClient,
  input: DeleteParseRuleInput,
): Promise<{ id: string }> {
  const ps = prisma as unknown as PrismaSurface;

  // Tenant scope check before delete.
  const current = await ps.parseRule.findFirst({
    where: { id: input.ruleId, tenantId: input.tenantId },
  });
  if (!current) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Rule not found in tenant scope." });
  }

  // FK onDelete: Cascade drops the ParseRuleVersion snapshot atomically.
  await ps.parseRule.delete({ where: { id: input.ruleId } });

  await writeAuditBestEffort(prisma, {
    tenantId: input.tenantId,
    actor: input.userId,
    actionType: "parse_rule.deleted",
    payload: {
      ruleId: input.ruleId,
      label: current.label,
    },
  });

  return { id: input.ruleId };
}

// ─────────────────────────────────────────────
// List
// ─────────────────────────────────────────────

/**
 * KAN-1140 Phase 3 PR 9b — Cascade lookup for runtime rule execution.
 *
 * Single SQL query implementing the Q-ADD-4 nullable composite scope
 * discriminator: returns rules whose scope cascade matches the inbound
 * context. Application-layer (parse-rule-executor.ts) then selects the
 * most-specific per-field winner via specificity score + createdAt
 * tie-breaker.
 *
 * # Cascade semantics
 *
 *   - `fingerprintId = $1 OR fingerprintId IS NULL`
 *   - `format = $2 OR format IS NULL`
 *   - `vendor = $3 OR vendor IS NULL`
 *
 * AND'd together. A rule whose fingerprintId/format/vendor are all null
 * is a global tenant rule and matches every inbound.
 *
 * # Defense
 *
 *   - `tenantId` filter on every query (multi-tenant rule leakage defense)
 *   - `status = 'active'` gate (Q8 lock — operators must explicitly
 *     activate rules; pending/disabled rules never fire)
 *   - `LIMIT 100` matches `MAX_RULES_PER_TENANT` from `@growth/shared`;
 *     defense against per-tenant performance DoS via thousands of rules
 *
 * # Performance
 *
 * No cache for PR 9b (Q3 lock). DB hit per inbound is ~5-10ms typical;
 * negligible vs Haiku 200-500ms. Defer to KAN-1155 if performance signal
 * emerges at scale (e.g., 100+ inbounds/sec/tenant).
 */
export async function getApplicableRules(
  prisma: PrismaClient,
  input: GetApplicableRulesInput,
): Promise<ParseRuleRow[]> {
  const ps = prisma as unknown as PrismaSurface;
  const rows = await ps.parseRule.findMany({
    where: {
      tenantId: input.tenantId,
      status: "active",
      AND: [
        { OR: [{ fingerprintId: input.fingerprintId }, { fingerprintId: null }] },
        { OR: [{ format: input.format }, { format: null }] },
        { OR: [{ vendor: input.vendor }, { vendor: null }] },
      ],
    } as unknown as Record<string, unknown>,
    orderBy: { createdAt: "asc" },
    take: 100,
    skip: 0,
  });
  return rows;
}

export async function listParseRules(
  prisma: PrismaClient,
  input: ListParseRulesInput,
): Promise<{ rows: ParseRuleRow[] }> {
  const ps = prisma as unknown as PrismaSurface;

  const where: Record<string, unknown> = { tenantId: input.tenantId };
  if (input.fingerprintId !== undefined) where.fingerprintId = input.fingerprintId;
  if (input.format !== undefined) where.format = input.format;
  if (input.vendor !== undefined) where.vendor = input.vendor;
  if (input.statusFilter !== undefined) where.status = input.statusFilter;

  const rows = await ps.parseRule.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: input.limit ?? 50,
    skip: input.offset ?? 0,
  });

  return { rows };
}

// ─────────────────────────────────────────────
// GetDetail
// ─────────────────────────────────────────────

export async function getParseRuleDetail(
  prisma: PrismaClient,
  input: GetParseRuleDetailInput,
): Promise<ParseRuleDetail> {
  const ps = prisma as unknown as PrismaSurface;

  const rule = await ps.parseRule.findFirst({
    where: { id: input.ruleId, tenantId: input.tenantId },
    include: { version: true },
  });
  if (!rule) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Rule not found in tenant scope." });
  }

  const { version, ...rest } = rule;
  return { ...rest, previousVersion: version ?? null };
}

// ─────────────────────────────────────────────
// RestorePreviousVersion
// ─────────────────────────────────────────────

export async function restoreParseRulePreviousVersion(
  prisma: PrismaClient,
  input: RestoreParseRuleInput,
): Promise<{ id: string }> {
  const ps = prisma as unknown as PrismaSurface;

  // Read current rule (tenant scope check) + the snapshot.
  const current = await ps.parseRule.findFirst({
    where: { id: input.ruleId, tenantId: input.tenantId },
  });
  if (!current) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Rule not found in tenant scope." });
  }

  const snapshot = await ps.parseRuleVersion.findUnique({ where: { ruleId: input.ruleId } });
  if (!snapshot) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "No previous version available to restore.",
    });
  }

  // Re-snapshot the displaced (current) body. After restore, the
  // displaced body becomes the new "previous" — restore is itself
  // reversible. Upsert because the @unique ruleId row already exists
  // (the snapshot we just read); update path overwrites with the
  // displaced body.
  await ps.parseRuleVersion.upsert({
    where: { ruleId: input.ruleId },
    create: {
      ruleId: input.ruleId,
      tenantId: input.tenantId,
      body: current.body as unknown as Record<string, unknown>,
      label: current.label,
      status: current.status,
      archivedBy: input.userId,
    },
    update: {
      body: current.body as unknown as Record<string, unknown>,
      label: current.label,
      status: current.status,
      archivedAt: new Date(),
      archivedBy: input.userId,
    },
  });

  // Promote snapshot body back into the rule.
  await ps.parseRule.update({
    where: { id: input.ruleId },
    data: {
      body: snapshot.body as unknown as Record<string, unknown>,
      label: snapshot.label,
      status: snapshot.status,
      updatedBy: input.userId,
    },
  });

  await writeAuditBestEffort(prisma, {
    tenantId: input.tenantId,
    actor: input.userId,
    actionType: "parse_rule.restored",
    payload: {
      ruleId: input.ruleId,
      snapshotArchivedAt: snapshot.archivedAt.toISOString(),
    },
  });

  return { id: input.ruleId };
}

// ─────────────────────────────────────────────
// KAN-1140 PR 9c — Status lifecycle transitions
// ─────────────────────────────────────────────

export interface StatusTransitionInput {
  tenantId: string;
  userId: string;
  ruleId: string;
}

/**
 * KAN-1140 PR 9c — Activate a rule.
 *
 * Allowed transitions:
 *   - `pending` → `active`
 *   - `disabled` → `active`
 *
 * Idempotent: re-activating an already-`active` rule returns the rule
 * row without throwing (no audit entry on no-op).
 *
 * KAN-1158 dependency: this procedure is the operator surface that
 * actually causes a rule to fire on subsequent inbounds. KAN-1158 (P1)
 * empirically verified the budget mechanism in CI before this affordance
 * shipped.
 */
export async function activateParseRule(
  prisma: PrismaClient,
  input: StatusTransitionInput,
): Promise<{ id: string; status: string }> {
  const ps = prisma as unknown as PrismaSurface;
  const current = await ps.parseRule.findFirst({
    where: { id: input.ruleId, tenantId: input.tenantId },
  });
  if (!current) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Rule not found in tenant scope." });
  }
  if (current.status === "active") {
    // Idempotent no-op; no state change, no audit entry.
    return { id: current.id, status: current.status };
  }
  await ps.parseRule.update({
    where: { id: input.ruleId },
    data: { status: "active", updatedBy: input.userId },
  });
  await writeAuditBestEffort(prisma, {
    tenantId: input.tenantId,
    actor: input.userId,
    actionType: "parse_rule.activated",
    payload: {
      ruleId: input.ruleId,
      fromStatus: current.status,
    },
  });
  return { id: input.ruleId, status: "active" };
}

/**
 * KAN-1140 PR 9c — Deactivate a rule.
 *
 * Allowed transition: `active` → `disabled`. Throws BAD_REQUEST on any
 * other current status — `pending` rules should be deleted instead;
 * `disabled` is the terminal "off" state and a no-op deactivation would
 * surface as a confusing operator outcome.
 */
export async function deactivateParseRule(
  prisma: PrismaClient,
  input: StatusTransitionInput,
): Promise<{ id: string; status: string }> {
  const ps = prisma as unknown as PrismaSurface;
  const current = await ps.parseRule.findFirst({
    where: { id: input.ruleId, tenantId: input.tenantId },
  });
  if (!current) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Rule not found in tenant scope." });
  }
  if (current.status !== "active") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot deactivate rule with status='${current.status}'. Only active rules can be deactivated; delete pending rules instead.`,
    });
  }
  await ps.parseRule.update({
    where: { id: input.ruleId },
    data: { status: "disabled", updatedBy: input.userId },
  });
  await writeAuditBestEffort(prisma, {
    tenantId: input.tenantId,
    actor: input.userId,
    actionType: "parse_rule.deactivated",
    payload: {
      ruleId: input.ruleId,
      fromStatus: current.status,
    },
  });
  return { id: input.ruleId, status: "disabled" };
}

// ─────────────────────────────────────────────
// KAN-1140 PR 9c — Sample testing (Memo 37: executor is single source of truth)
// ─────────────────────────────────────────────

export interface TestRuleAgainstSampleInput {
  tenantId: string;
  userId: string;
  /** FORM-STATE rule body (Q-ADD-TEST-AGAINST-DRAFT); not a DB rule ID.
   *  Validated via ParseRuleBodySchema (defense-in-depth — tRPC also validates). */
  ruleBody: unknown;
  sampleSource: "stored" | "paste" | "recent";
  sampleId?: string;
  rawBody?: string;
  rawStructured?: Record<string, unknown>;
  fromAddress?: string;
}

export interface TestRuleAgainstSampleResult {
  output: Record<string, string>;
  metrics: {
    rulesEvaluated: number;
    fieldsWritten: number;
    rulesThrown: number;
    rulesTimedOut: number;
    pipelineBudgetExceeded: boolean;
    totalDurationMs: number;
  };
}

/**
 * KAN-1140 PR 9c — Test a rule body against a sample without saving.
 *
 * # Memo 37 single source of truth
 *
 * Calls the existing `executeRules` from `parse-rule-executor.ts` — the
 * SAME execution path that fires on every inbound in PR 9b. Operators
 * authoring rules see exactly what the runtime would extract; no UI-side
 * re-implementation of extraction logic.
 *
 * # Sample sources
 *
 *   - `stored`: pick a `ParseFingerprintSample` (PR 7 substrate); use its
 *     `bodyPreview` + `customFields` + synthetic `noreply@${senderDomain}`
 *     for the executor payload
 *   - `paste`: operator-supplied raw body + optional structured payload +
 *     optional fromAddress
 *   - `recent`: pick a `LeadInboxEvent`; pull bodyPreview via on-demand
 *     server lookup (the input only carries the event ID)
 *
 * # Q-ADD-TEST-AGAINST-DRAFT lock
 *
 * `ruleBody` is the FORM STATE, not a saved DB body. Operators iterate
 * on extractor patterns without save→test→edit cycles. The procedure
 * synthesizes an ephemeral `ExecutableRule` object stamped with the
 * caller's `tenantId` so the executor's cross-tenant assertion passes.
 *
 * # Audit
 *
 * Emits `parse_rule.tested` audit row with sample source + result
 * metrics. Operator forensic trail.
 */
export async function testRuleAgainstSample(
  prisma: PrismaClient,
  input: TestRuleAgainstSampleInput,
): Promise<TestRuleAgainstSampleResult> {
  // Defense-in-depth: re-validate rule body (the tRPC procedure also
  // validates at the wire layer).
  ParseRuleBodySchema.parse(input.ruleBody);

  // Resolve sample → executor payload.
  let bodyText = "";
  let structured: Record<string, unknown> | undefined = undefined;
  let fromAddress = "noreply@test.invalid";

  const ps = prisma as unknown as PrismaSurface & {
    parseFingerprintSample: {
      findFirst: (args: {
        where: { id: string };
        include?: { fingerprint?: { select: { tenantId: true } } };
      }) => Promise<{
        id: string;
        bodyPreview: string;
        senderDomain: string;
        customFields: unknown;
        fingerprint?: { tenantId: string };
      } | null>;
    };
    leadInboxEvent: {
      findFirst: (args: {
        where: { id: string; tenantId: string };
        select: { bodyPreview: true; fromAddress: true };
      }) => Promise<{ bodyPreview: string | null; fromAddress: string } | null>;
    };
  };

  if (input.sampleSource === "stored") {
    if (!input.sampleId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "sampleId required for stored sample source.",
      });
    }
    const sample = await ps.parseFingerprintSample.findFirst({
      where: { id: input.sampleId },
      include: { fingerprint: { select: { tenantId: true } } },
    });
    if (!sample || sample.fingerprint?.tenantId !== input.tenantId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Sample not found in tenant scope." });
    }
    bodyText = sample.bodyPreview;
    structured =
      sample.customFields && typeof sample.customFields === "object"
        ? (sample.customFields as Record<string, unknown>)
        : undefined;
    fromAddress = `noreply@${sample.senderDomain}`;
  } else if (input.sampleSource === "paste") {
    if (!input.rawBody) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "rawBody required for paste sample source.",
      });
    }
    bodyText = input.rawBody;
    structured = input.rawStructured;
    fromAddress = input.fromAddress ?? fromAddress;
  } else {
    // recent
    if (!input.sampleId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "sampleId (LeadInboxEvent.id) required for recent sample source.",
      });
    }
    const event = await ps.leadInboxEvent.findFirst({
      where: { id: input.sampleId, tenantId: input.tenantId },
      select: { bodyPreview: true, fromAddress: true },
    });
    if (!event) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Recent inbound event not found in tenant scope.",
      });
    }
    bodyText = event.bodyPreview ?? "";
    fromAddress = event.fromAddress;
  }

  // Synthesize an ephemeral ExecutableRule. Stamps tenantId so the
  // executor's cross-tenant assertion (PR 9b defense-in-depth) passes.
  const syntheticRule = {
    id: "test-synthetic-rule",
    tenantId: input.tenantId,
    fingerprintId: null,
    format: null,
    vendor: null,
    body: input.ruleBody,
    status: "active",
    createdAt: new Date(),
  };

  // Memo 37 — call the existing executor; no re-implementation.
  const { executeRules } = await import("./parse-rule-executor.js");
  const result = await executeRules({
    tenantId: input.tenantId,
    rules: [syntheticRule],
    payload: { fromAddress, subject: null, bodyPreview: bodyText, structured },
  });

  await writeAuditBestEffort(prisma, {
    tenantId: input.tenantId,
    actor: input.userId,
    actionType: "parse_rule.tested",
    payload: {
      sampleSource: input.sampleSource,
      sampleId: input.sampleId ?? null,
      metrics: result.metrics,
    },
  });

  return {
    output: result.output as Record<string, string>,
    metrics: result.metrics,
  };
}

// KAN-1168 — inline writeAuditBestEffort deleted; consolidated into
// packages/api/src/utils/audit-helpers.ts. All 7 callers above use the
// shared object-arg helper with per-call `actor: input.userId`.
