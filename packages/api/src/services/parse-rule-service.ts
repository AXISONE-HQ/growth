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

  await writeAuditBestEffort(prisma, input.tenantId, input.userId, "parse_rule.created", {
    ruleId: rule.id,
    label: input.label,
    scope: {
      fingerprintId: input.fingerprintId ?? null,
      format: input.format ?? null,
      vendor: input.vendor ?? null,
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

  await writeAuditBestEffort(prisma, input.tenantId, input.userId, "parse_rule.updated", {
    ruleId: input.ruleId,
    fieldsChanged: Object.keys(updateData).filter((k) => k !== "updatedBy"),
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

  await writeAuditBestEffort(prisma, input.tenantId, input.userId, "parse_rule.deleted", {
    ruleId: input.ruleId,
    label: current.label,
  });

  return { id: input.ruleId };
}

// ─────────────────────────────────────────────
// List
// ─────────────────────────────────────────────

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

  await writeAuditBestEffort(prisma, input.tenantId, input.userId, "parse_rule.restored", {
    ruleId: input.ruleId,
    snapshotArchivedAt: snapshot.archivedAt.toISOString(),
  });

  return { id: input.ruleId };
}

// ─────────────────────────────────────────────
// writeAuditBestEffort (4th inline; KAN-1150 consolidation queued)
// ─────────────────────────────────────────────

async function writeAuditBestEffort(
  prisma: PrismaClient,
  tenantId: string,
  actor: string,
  actionType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await (prisma as unknown as PrismaSurface).auditLog.create({
      data: { tenantId, actor, actionType, payload },
    });
  } catch (err) {
    // Best-effort — never fail the mutation on audit-log write failure.
    console.error(`[parse-rule-service] auditLog write failed for ${actionType}:`, err);
  }
}
