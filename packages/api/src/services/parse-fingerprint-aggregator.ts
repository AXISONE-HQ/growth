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
import type { PrismaClient } from "@prisma/client";

export type SortBy = "lastSeenAt" | "occurrenceCount" | "escalationCount";

export interface ListParseFingerprintsInput {
  tenantId: string;
  sortBy: SortBy;
  limit: number;
  offset: number;
  formatFilter?: string;
  languageFilter?: string;
  vendorFilter?: string;
  showOnlyWithEscalations?: boolean;
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
