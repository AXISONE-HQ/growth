/**
 * KAN-1140 Phase 3 PR 7 — Parse-fingerprint aggregation service.
 *
 * Mirrors the cognitive-metrics-aggregator.ts pattern (KAN-1086) but
 * narrower scope: just `list` + `getDetail` operator-facing queries.
 * Aggregation queries use Prisma typed queries (NOT raw SQL) since the
 * grouping is already done at write-path via the UPSERT in the webhook
 * hook — each row IS the aggregate.
 *
 * tenantProcedure-gated at the router (NOT adminProcedure / super-admin):
 * fingerprints are tenant-scoped operational data per Q9 lock; cross-
 * tenant aggregation is deferred to KAN-1148 follow-up.
 */
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

export type SortBy = "lastSeenAt" | "occurrenceCount" | "escalationCount";

/**
 * KAN-1140 Phase 3 PR 8 — capability announcement status vocabulary.
 * String column on the DB side (Q2 codebase-convention pin: NOT a Prisma
 * enum); typed at the service surface so consumers stay type-safe.
 */
export type SupportStatus = "pending" | "suggested" | "supported" | "unsupported";

export interface ListParseFingerprintsInput {
  tenantId: string;
  sortBy: SortBy;
  limit: number;
  offset: number;
  formatFilter?: string;
  languageFilter?: string;
  vendorFilter?: string;
  showOnlyWithEscalations?: boolean;
  /** KAN-1140 PR 8 — status filter for the "show only supported / suggested
   *  / pending / unsupported" Settings UI affordance. */
  statusFilter?: SupportStatus;
}

export interface ParseFingerprintRow {
  id: string;
  format: string;
  language: string | null;
  vendor: string | null;
  formatConfidence: string;
  languageConfidence: string | null;
  occurrenceCount: number;
  escalationCount: number;
  reclassifyCount: number;
  /** KAN-1140 PR 8 — capability announcement state. */
  supportStatus: SupportStatus;
  suggestedAt: string | null;
  supportedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ListParseFingerprintsResult {
  items: ParseFingerprintRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface ParseFingerprintSampleRow {
  id: string;
  resendEmailId: string | null;
  bodyPreview: string;
  senderDomain: string;
  customFields: Record<string, unknown>;
  capturedAt: string;
}

export interface ParseFingerprintDetail extends ParseFingerprintRow {
  /** Hashes surface for operator triage — lets ops spot "two fingerprints,
   *  same structureHash but different senderDomainHash" patterns. */
  structureHash: string | null;
  senderDomainHash: string;
  labelTokenHash: string | null;
  samples: ParseFingerprintSampleRow[];
}

const SORT_BY_TO_ORDER_BY: Record<SortBy, "lastSeenAt" | "occurrenceCount" | "escalationCount"> = {
  lastSeenAt: "lastSeenAt",
  occurrenceCount: "occurrenceCount",
  escalationCount: "escalationCount",
};

function clampLimit(limit: number | undefined, max = 100): number {
  if (typeof limit !== "number" || limit < 1) return 50;
  return Math.min(limit, max);
}

/**
 * Paginated list of parse-fingerprints for a tenant. Sort by operator-
 * facing axis; filter by format / language / vendor / escalation-only.
 * Empty list is a valid result (new tenant with no inbound activity).
 */
export async function listParseFingerprints(
  prisma: PrismaClient,
  input: ListParseFingerprintsInput,
): Promise<ListParseFingerprintsResult> {
  const limit = clampLimit(input.limit);
  const offset = Math.max(0, input.offset ?? 0);

  const where = {
    tenantId: input.tenantId,
    ...(input.formatFilter ? { format: input.formatFilter } : {}),
    ...(input.languageFilter ? { language: input.languageFilter } : {}),
    ...(input.vendorFilter ? { vendor: input.vendorFilter } : {}),
    ...(input.showOnlyWithEscalations ? { escalationCount: { gt: 0 } } : {}),
    ...(input.statusFilter ? { supportStatus: input.statusFilter } : {}),
  };

  const orderField = SORT_BY_TO_ORDER_BY[input.sortBy];
  const [rows, total] = await Promise.all([
    (prisma as unknown as {
      parseFingerprint: {
        findMany: (args: unknown) => Promise<Array<{
          id: string;
          format: string;
          language: string | null;
          vendor: string | null;
          formatConfidence: string;
          languageConfidence: string | null;
          occurrenceCount: number;
          escalationCount: number;
          reclassifyCount: number;
          supportStatus: string;
          suggestedAt: Date | null;
          supportedAt: Date | null;
          firstSeenAt: Date;
          lastSeenAt: Date;
        }>>;
      };
    }).parseFingerprint.findMany({
      where,
      orderBy: { [orderField]: "desc" },
      take: limit,
      skip: offset,
      select: {
        id: true,
        format: true,
        language: true,
        vendor: true,
        formatConfidence: true,
        languageConfidence: true,
        occurrenceCount: true,
        escalationCount: true,
        reclassifyCount: true,
        supportStatus: true,
        suggestedAt: true,
        supportedAt: true,
        firstSeenAt: true,
        lastSeenAt: true,
      },
    }),
    (prisma as unknown as {
      parseFingerprint: { count: (args: unknown) => Promise<number> };
    }).parseFingerprint.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      format: r.format,
      language: r.language,
      vendor: r.vendor,
      formatConfidence: r.formatConfidence,
      languageConfidence: r.languageConfidence,
      occurrenceCount: r.occurrenceCount,
      escalationCount: r.escalationCount,
      reclassifyCount: r.reclassifyCount,
      supportStatus: r.supportStatus as SupportStatus,
      suggestedAt: r.suggestedAt?.toISOString() ?? null,
      supportedAt: r.supportedAt?.toISOString() ?? null,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
    })),
    total,
    limit,
    offset,
  };
}

/**
 * Full fingerprint detail with up to 5 LRU samples. Tenant isolation
 * enforced on the row lookup; cross-tenant access returns null.
 */
export async function getParseFingerprintDetail(
  prisma: PrismaClient,
  input: { tenantId: string; fingerprintId: string },
): Promise<ParseFingerprintDetail | null> {
  const row = await (prisma as unknown as {
    parseFingerprint: {
      findFirst: (args: unknown) => Promise<{
        id: string;
        structureHash: string | null;
        senderDomainHash: string;
        labelTokenHash: string | null;
        format: string;
        language: string | null;
        vendor: string | null;
        formatConfidence: string;
        languageConfidence: string | null;
        occurrenceCount: number;
        escalationCount: number;
        reclassifyCount: number;
        supportStatus: string;
        suggestedAt: Date | null;
        supportedAt: Date | null;
        firstSeenAt: Date;
        lastSeenAt: Date;
        samples: Array<{
          id: string;
          resendEmailId: string | null;
          bodyPreview: string;
          senderDomain: string;
          customFields: unknown;
          capturedAt: Date;
        }>;
      } | null>;
    };
  }).parseFingerprint.findFirst({
    where: { id: input.fingerprintId, tenantId: input.tenantId },
    include: {
      samples: {
        orderBy: { capturedAt: "desc" },
        take: 5,
        select: {
          id: true,
          resendEmailId: true,
          bodyPreview: true,
          senderDomain: true,
          customFields: true,
          capturedAt: true,
        },
      },
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    structureHash: row.structureHash,
    senderDomainHash: row.senderDomainHash,
    labelTokenHash: row.labelTokenHash,
    format: row.format,
    language: row.language,
    vendor: row.vendor,
    formatConfidence: row.formatConfidence,
    languageConfidence: row.languageConfidence,
    occurrenceCount: row.occurrenceCount,
    escalationCount: row.escalationCount,
    reclassifyCount: row.reclassifyCount,
    supportStatus: row.supportStatus as SupportStatus,
    suggestedAt: row.suggestedAt?.toISOString() ?? null,
    supportedAt: row.supportedAt?.toISOString() ?? null,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    samples: row.samples.map((s) => ({
      id: s.id,
      resendEmailId: s.resendEmailId,
      bodyPreview: s.bodyPreview,
      senderDomain: s.senderDomain,
      customFields: (s.customFields as Record<string, unknown>) ?? {},
      capturedAt: s.capturedAt.toISOString(),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────
// KAN-1140 Phase 3 PR 8 — capability announcement mutations
// ─────────────────────────────────────────────────────────────────
//
// Three operator-facing transitions:
//
//   markFingerprintSupported   — pending|suggested|unsupported → supported
//   markFingerprintUnsupported — pending|suggested → unsupported (defends
//                                against auto-re-suggest; predicate gates
//                                on === 'pending' per Q-ADD-2 lock)
//   unmarkFingerprint          — supported|unsupported → pending (re-arms
//                                auto-suggest; clears supportedAt/By)
//
// All three use raw SQL gated UPDATEs (`WHERE tenant_id = ? AND id = ?
// AND support_status IN (...)`) for atomic transition + tenant isolation
// + protection against accepting an unintended state. Cross-tenant access
// or already-in-target-state lookups → TRPCError NOT_FOUND (does not
// distinguish "wrong tenant" from "wrong state" — minimal info-leak).
//
// Audit log is best-effort (mirrors recommendations.ts:writeAuditBestEffort);
// the mutation succeeds even if the audit row write fails. The audit row
// captures `{ previousStatus, newStatus, fingerprintId, actor }`.

async function writeAuditBestEffort(
  prisma: PrismaClient,
  tenantId: string,
  actor: string,
  actionType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await (prisma as unknown as { auditLog: { create: (args: unknown) => Promise<unknown> } })
      .auditLog.create({
        data: { tenantId, actor, actionType, payload },
      });
  } catch (err) {
    // Best-effort — never fail the mutation on audit-log write failure.
    console.error(`[parse-fingerprint-aggregator] auditLog write failed for ${actionType}:`, err);
  }
}

export async function markFingerprintSupported(
  prisma: PrismaClient,
  input: { tenantId: string; userId: string; fingerprintId: string },
): Promise<{ id: string; supportStatus: SupportStatus; previousStatus: SupportStatus }> {
  // Two-phase: read previous status, then gated UPDATE. The read is
  // outside a transaction; concurrent ops could change the row between
  // SELECT and UPDATE, but the gated UPDATE's `IN (...)` clause is the
  // authoritative tenant-isolated atomic guard. Worst case: previousStatus
  // is one transition stale in the audit log; not a correctness issue.
  const before = await (prisma as unknown as {
    parseFingerprint: {
      findFirst: (args: unknown) => Promise<{ supportStatus: string } | null>;
    };
  }).parseFingerprint.findFirst({
    where: { id: input.fingerprintId, tenantId: input.tenantId },
    select: { supportStatus: true },
  });
  if (!before) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Parse fingerprint not found",
    });
  }
  const previousStatus = before.supportStatus as SupportStatus;
  const updated = await (prisma as unknown as {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
  }).$executeRaw`
    UPDATE parse_fingerprints
    SET support_status = 'supported',
        supported_at = NOW(),
        supported_by = ${input.userId},
        updated_at = NOW()
    WHERE id = ${input.fingerprintId}
      AND tenant_id = ${input.tenantId}
      AND support_status IN ('pending', 'suggested', 'unsupported')
  `;
  if (updated === 0) {
    // Either already supported or another transition raced us (extremely
    // unlikely — operator clicks happen once). Either way: no-op from the
    // operator's perspective; surface as BAD_REQUEST so the UI clarifies.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot mark as supported from status='${previousStatus}'`,
    });
  }
  await writeAuditBestEffort(
    prisma,
    input.tenantId,
    input.userId,
    "parse_fingerprint.marked_supported",
    {
      fingerprintId: input.fingerprintId,
      previousStatus,
      newStatus: "supported",
    },
  );
  return { id: input.fingerprintId, supportStatus: "supported", previousStatus };
}

export async function markFingerprintUnsupported(
  prisma: PrismaClient,
  input: { tenantId: string; userId: string; fingerprintId: string },
): Promise<{ id: string; supportStatus: SupportStatus; previousStatus: SupportStatus }> {
  const before = await (prisma as unknown as {
    parseFingerprint: {
      findFirst: (args: unknown) => Promise<{ supportStatus: string } | null>;
    };
  }).parseFingerprint.findFirst({
    where: { id: input.fingerprintId, tenantId: input.tenantId },
    select: { supportStatus: true },
  });
  if (!before) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Parse fingerprint not found",
    });
  }
  const previousStatus = before.supportStatus as SupportStatus;
  // Note: clears supportedAt + supportedBy on the transition from
  // 'supported' (operator decided this pattern is actually NOT something
  // they handle). suggestedAt is preserved as forensic anchor.
  const updated = await (prisma as unknown as {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
  }).$executeRaw`
    UPDATE parse_fingerprints
    SET support_status = 'unsupported',
        supported_at = NULL,
        supported_by = NULL,
        updated_at = NOW()
    WHERE id = ${input.fingerprintId}
      AND tenant_id = ${input.tenantId}
      AND support_status IN ('pending', 'suggested', 'supported')
  `;
  if (updated === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot mark as unsupported from status='${previousStatus}'`,
    });
  }
  await writeAuditBestEffort(
    prisma,
    input.tenantId,
    input.userId,
    "parse_fingerprint.marked_unsupported",
    {
      fingerprintId: input.fingerprintId,
      previousStatus,
      newStatus: "unsupported",
    },
  );
  return { id: input.fingerprintId, supportStatus: "unsupported", previousStatus };
}

export async function unmarkFingerprint(
  prisma: PrismaClient,
  input: { tenantId: string; userId: string; fingerprintId: string },
): Promise<{ id: string; supportStatus: SupportStatus; previousStatus: SupportStatus }> {
  const before = await (prisma as unknown as {
    parseFingerprint: {
      findFirst: (args: unknown) => Promise<{ supportStatus: string } | null>;
    };
  }).parseFingerprint.findFirst({
    where: { id: input.fingerprintId, tenantId: input.tenantId },
    select: { supportStatus: true },
  });
  if (!before) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Parse fingerprint not found",
    });
  }
  const previousStatus = before.supportStatus as SupportStatus;
  // Unmark from `supported` OR `unsupported` → `pending`. Re-arms the
  // auto-suggest predicate on next inbound. Clears suggestedAt /
  // supportedAt / supportedBy completely (operator reset).
  const updated = await (prisma as unknown as {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
  }).$executeRaw`
    UPDATE parse_fingerprints
    SET support_status = 'pending',
        suggested_at = NULL,
        supported_at = NULL,
        supported_by = NULL,
        updated_at = NOW()
    WHERE id = ${input.fingerprintId}
      AND tenant_id = ${input.tenantId}
      AND support_status IN ('suggested', 'supported', 'unsupported')
  `;
  if (updated === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot unmark from status='${previousStatus}'`,
    });
  }
  await writeAuditBestEffort(
    prisma,
    input.tenantId,
    input.userId,
    "parse_fingerprint.unmarked",
    {
      fingerprintId: input.fingerprintId,
      previousStatus,
      newStatus: "pending",
    },
  );
  return { id: input.fingerprintId, supportStatus: "pending", previousStatus };
}
