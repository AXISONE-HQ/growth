/**
 * KAN-1140 Phase 3 PR 7 — parse-fingerprint aggregator unit tests.
 *
 * Pure mocked-Prisma tests covering the listParseFingerprints +
 * getParseFingerprintDetail shaping logic. Real-Postgres exercise of the
 * raw SQL UPSERT path lives at
 * `apps/api/src/__tests__/integration/parse-fingerprint-write-path.test.ts`
 * per Q-ADD-3 lock (query_raw_sql_syntax_validation_must_execute_not_mock memo).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listParseFingerprints,
  getParseFingerprintDetail,
  markFingerprintSupported,
  markFingerprintUnsupported,
  unmarkFingerprint,
  type SortBy,
  type SupportStatus,
} from "../parse-fingerprint-aggregator.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const FP_AAA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const FP_BBB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

interface FakeFingerprint {
  id: string;
  tenantId: string;
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
  // KAN-1140 PR 8 — capability announcement state.
  supportStatus: SupportStatus;
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
}

function makeFingerprint(overrides: Partial<FakeFingerprint> = {}): FakeFingerprint {
  return {
    id: FP_AAA,
    tenantId: TENANT_A,
    structureHash: "abc123",
    senderDomainHash: "def456",
    labelTokenHash: null,
    format: "plain-text",
    language: "en",
    vendor: "formspree",
    formatConfidence: "high",
    languageConfidence: "high",
    occurrenceCount: 5,
    escalationCount: 0,
    reclassifyCount: 0,
    supportStatus: "pending",
    suggestedAt: null,
    supportedAt: null,
    firstSeenAt: new Date("2026-06-01T10:00:00Z"),
    lastSeenAt: new Date("2026-06-09T13:00:00Z"),
    samples: [],
    ...overrides,
  };
}

function makePrisma(rows: FakeFingerprint[]) {
  return {
    parseFingerprint: {
      findMany: vi.fn(async ({ where, orderBy, take, skip }: {
        where: { tenantId: string; format?: string; language?: string; vendor?: string; escalationCount?: { gt: number }; supportStatus?: string };
        orderBy: Record<string, "asc" | "desc">;
        take: number;
        skip: number;
      }) => {
        const filtered = rows.filter(
          (r) =>
            r.tenantId === where.tenantId &&
            (!where.format || r.format === where.format) &&
            (!where.language || r.language === where.language) &&
            (!where.vendor || r.vendor === where.vendor) &&
            // Use typeof check — `gt: 0` is falsy under `!where.escalationCount?.gt`
            (typeof where.escalationCount?.gt !== "number" ||
              r.escalationCount > where.escalationCount.gt) &&
            // KAN-1140 PR 8 — status filter
            (!where.supportStatus || r.supportStatus === where.supportStatus),
        );
        const [field, dir] = Object.entries(orderBy)[0]!;
        const sorted = filtered.sort((a, b) => {
          const va = (a as unknown as Record<string, number | Date>)[field];
          const vb = (b as unknown as Record<string, number | Date>)[field];
          const cmp = va < vb ? -1 : va > vb ? 1 : 0;
          return dir === "desc" ? -cmp : cmp;
        });
        return sorted.slice(skip, skip + take);
      }),
      count: vi.fn(async ({ where }: { where: { tenantId: string; format?: string; escalationCount?: { gt: number }; supportStatus?: string } }) =>
        rows.filter(
          (r) =>
            r.tenantId === where.tenantId &&
            (!where.format || r.format === where.format) &&
            (typeof where.escalationCount?.gt !== "number" ||
              r.escalationCount > where.escalationCount.gt) &&
            (!where.supportStatus || r.supportStatus === where.supportStatus),
        ).length,
      ),
      findFirst: vi.fn(async ({ where }: { where: { id: string; tenantId: string } }) => {
        const r = rows.find((row) => row.id === where.id && row.tenantId === where.tenantId);
        return r ?? null;
      }),
    },
    // KAN-1140 PR 8 — capture executeRaw calls so mutation tests can assert.
    // Returns 1 on success (row updated); 0 on guard miss.
    $executeRaw: vi.fn(async (..._args: unknown[]) => 1),
    auditLog: {
      create: vi.fn(async () => ({ id: "audit_a" })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listParseFingerprints — sort + filter + pagination", () => {
  it("sorts by lastSeenAt DESC by default selection", async () => {
    const rows = [
      makeFingerprint({ id: "fp_old", lastSeenAt: new Date("2026-06-01T00:00:00Z") }),
      makeFingerprint({ id: "fp_new", lastSeenAt: new Date("2026-06-09T00:00:00Z") }),
    ];
    const prisma = makePrisma(rows);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "lastSeenAt",
      limit: 10,
      offset: 0,
    });
    expect(result.items[0]!.id).toBe("fp_new");
    expect(result.items[1]!.id).toBe("fp_old");
  });

  it("sorts by occurrenceCount DESC", async () => {
    const rows = [
      makeFingerprint({ id: "fp_low", occurrenceCount: 3 }),
      makeFingerprint({ id: "fp_high", occurrenceCount: 50 }),
    ];
    const prisma = makePrisma(rows);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "occurrenceCount",
      limit: 10,
      offset: 0,
    });
    expect(result.items[0]!.id).toBe("fp_high");
  });

  it("sorts by escalationCount DESC", async () => {
    const rows = [
      makeFingerprint({ id: "fp_clean", escalationCount: 0 }),
      makeFingerprint({ id: "fp_problematic", escalationCount: 7 }),
    ];
    const prisma = makePrisma(rows);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "escalationCount",
      limit: 10,
      offset: 0,
    });
    expect(result.items[0]!.id).toBe("fp_problematic");
  });

  it("filters by format", async () => {
    const rows = [
      makeFingerprint({ id: "fp_plain", format: "plain-text" }),
      makeFingerprint({ id: "fp_html", format: "html" }),
    ];
    const prisma = makePrisma(rows);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "lastSeenAt",
      limit: 10,
      offset: 0,
      formatFilter: "plain-text",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe("fp_plain");
  });

  it("filters by language", async () => {
    const rows = [
      makeFingerprint({ id: "fp_en", language: "en" }),
      makeFingerprint({ id: "fp_fr", language: "fr" }),
    ];
    const prisma = makePrisma(rows);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "lastSeenAt",
      limit: 10,
      offset: 0,
      languageFilter: "fr",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe("fp_fr");
  });

  it("filters by vendor", async () => {
    const rows = [
      makeFingerprint({ id: "fp_fs", vendor: "formspree" }),
      makeFingerprint({ id: "fp_tally", vendor: "tally" }),
      makeFingerprint({ id: "fp_none", vendor: null }),
    ];
    const prisma = makePrisma(rows);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "lastSeenAt",
      limit: 10,
      offset: 0,
      vendorFilter: "tally",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe("fp_tally");
  });

  it("showOnlyWithEscalations filters out escalation_count=0 rows", async () => {
    const rows = [
      makeFingerprint({ id: "fp_clean", escalationCount: 0 }),
      makeFingerprint({ id: "fp_problematic", escalationCount: 3 }),
    ];
    const prisma = makePrisma(rows);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "lastSeenAt",
      limit: 10,
      offset: 0,
      showOnlyWithEscalations: true,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe("fp_problematic");
  });

  it("paginates via limit + offset", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeFingerprint({
        id: `fp_${i}`,
        lastSeenAt: new Date(`2026-06-${(i + 1).toString().padStart(2, "0")}T00:00:00Z`),
      }),
    );
    const prisma = makePrisma(rows);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "lastSeenAt",
      limit: 3,
      offset: 3,
    });
    expect(result.items).toHaveLength(3);
    expect(result.total).toBe(10);
  });

  it("clamps limit > 100 to 100", async () => {
    const prisma = makePrisma([]);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "lastSeenAt",
      limit: 500,
      offset: 0,
    });
    expect(result.limit).toBe(100);
  });

  it("returns empty list for tenant with no fingerprints", async () => {
    const prisma = makePrisma([]);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "lastSeenAt",
      limit: 10,
      offset: 0,
    });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("enforces tenant isolation — does NOT return other tenants rows", async () => {
    const OTHER = "22222222-2222-2222-2222-222222222222";
    const rows = [
      makeFingerprint({ id: "fp_mine", tenantId: TENANT_A }),
      makeFingerprint({ id: "fp_theirs", tenantId: OTHER }),
    ];
    const prisma = makePrisma(rows);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "lastSeenAt",
      limit: 10,
      offset: 0,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe("fp_mine");
  });

  it("each item carries Date → ISO string conversion", async () => {
    const rows = [makeFingerprint({ lastSeenAt: new Date("2026-06-09T13:00:00Z") })];
    const prisma = makePrisma(rows);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "lastSeenAt",
      limit: 10,
      offset: 0,
    });
    expect(typeof result.items[0]!.lastSeenAt).toBe("string");
    expect(result.items[0]!.lastSeenAt).toMatch(/^2026-06-09T13:00:00/);
  });
});

describe("getParseFingerprintDetail — detail + samples + tenant isolation", () => {
  it("returns null on cross-tenant access", async () => {
    const OTHER = "22222222-2222-2222-2222-222222222222";
    const rows = [makeFingerprint({ id: FP_AAA, tenantId: OTHER })];
    const prisma = makePrisma(rows);
    const result = await getParseFingerprintDetail(prisma as never, {
      tenantId: TENANT_A,
      fingerprintId: FP_AAA,
    });
    expect(result).toBeNull();
  });

  it("returns null on unknown fingerprintId", async () => {
    const prisma = makePrisma([]);
    const result = await getParseFingerprintDetail(prisma as never, {
      tenantId: TENANT_A,
      fingerprintId: FP_BBB,
    });
    expect(result).toBeNull();
  });

  it("surfaces hashes + samples on happy path", async () => {
    const rows = [
      makeFingerprint({
        id: FP_AAA,
        structureHash: "struct_hash_42",
        senderDomainHash: "domain_hash_42",
        labelTokenHash: "label_hash_42",
        samples: [
          {
            id: "sample_1",
            resendEmailId: "re_001",
            bodyPreview: "Name: Alice",
            senderDomain: "alice@a.com",
            customFields: { foo: "bar" },
            capturedAt: new Date("2026-06-09T13:00:00Z"),
          },
        ],
      }),
    ];
    const prisma = makePrisma(rows);
    const result = await getParseFingerprintDetail(prisma as never, {
      tenantId: TENANT_A,
      fingerprintId: FP_AAA,
    });
    expect(result).not.toBeNull();
    expect(result!.structureHash).toBe("struct_hash_42");
    expect(result!.senderDomainHash).toBe("domain_hash_42");
    expect(result!.labelTokenHash).toBe("label_hash_42");
    expect(result!.samples).toHaveLength(1);
    expect(result!.samples[0]!.bodyPreview).toBe("Name: Alice");
    expect(result!.samples[0]!.customFields).toEqual({ foo: "bar" });
  });

  it("converts sample capturedAt to ISO string", async () => {
    const rows = [
      makeFingerprint({
        samples: [
          {
            id: "s1",
            resendEmailId: null,
            bodyPreview: "x",
            senderDomain: "a@b.c",
            customFields: {},
            capturedAt: new Date("2026-06-09T12:00:00Z"),
          },
        ],
      }),
    ];
    const prisma = makePrisma(rows);
    const result = await getParseFingerprintDetail(prisma as never, {
      tenantId: TENANT_A,
      fingerprintId: FP_AAA,
    });
    expect(typeof result!.samples[0]!.capturedAt).toBe("string");
  });
});

describe("listParseFingerprints — sortBy enum is exhaustive", () => {
  it.each<SortBy>(["lastSeenAt", "occurrenceCount", "escalationCount"])(
    "sortBy='%s' routes to a Prisma orderBy without throwing",
    async (sortBy) => {
      const prisma = makePrisma([makeFingerprint()]);
      const result = await listParseFingerprints(prisma as never, {
        tenantId: TENANT_A,
        sortBy,
        limit: 10,
        offset: 0,
      });
      expect(result.items).toBeDefined();
    },
  );
});

// ─────────────────────────────────────────────────────────────
// KAN-1140 Phase 3 PR 8 — capability announcement tests
// ─────────────────────────────────────────────────────────────

describe("listParseFingerprints — statusFilter", () => {
  it("statusFilter='supported' returns only supported rows", async () => {
    const rows = [
      makeFingerprint({ id: "fp_p", supportStatus: "pending" }),
      makeFingerprint({ id: "fp_su", supportStatus: "supported" }),
      makeFingerprint({ id: "fp_sg", supportStatus: "suggested" }),
    ];
    const prisma = makePrisma(rows);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "lastSeenAt",
      limit: 10,
      offset: 0,
      statusFilter: "supported",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe("fp_su");
  });

  it("statusFilter undefined returns all rows (no filter)", async () => {
    const rows = [
      makeFingerprint({ id: "fp_p", supportStatus: "pending" }),
      makeFingerprint({ id: "fp_su", supportStatus: "supported" }),
    ];
    const prisma = makePrisma(rows);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "lastSeenAt",
      limit: 10,
      offset: 0,
    });
    expect(result.items).toHaveLength(2);
  });

  it("statusFilter respects tenant isolation", async () => {
    const OTHER = "22222222-2222-2222-2222-222222222222";
    const rows = [
      makeFingerprint({ id: "fp_mine", tenantId: TENANT_A, supportStatus: "supported" }),
      makeFingerprint({ id: "fp_theirs", tenantId: OTHER, supportStatus: "supported" }),
    ];
    const prisma = makePrisma(rows);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "lastSeenAt",
      limit: 10,
      offset: 0,
      statusFilter: "supported",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe("fp_mine");
  });

  it("each item surfaces supportStatus + timestamps", async () => {
    const rows = [
      makeFingerprint({
        supportStatus: "supported",
        suggestedAt: new Date("2026-06-08T10:00:00Z"),
        supportedAt: new Date("2026-06-09T13:00:00Z"),
      }),
    ];
    const prisma = makePrisma(rows);
    const result = await listParseFingerprints(prisma as never, {
      tenantId: TENANT_A,
      sortBy: "lastSeenAt",
      limit: 10,
      offset: 0,
    });
    expect(result.items[0]!.supportStatus).toBe("supported");
    expect(result.items[0]!.suggestedAt).toMatch(/^2026-06-08T10:00:00/);
    expect(result.items[0]!.supportedAt).toMatch(/^2026-06-09T13:00:00/);
  });
});

const ACTOR = "uid-fred";

describe("markFingerprintSupported", () => {
  it("pending → supported (audit row written)", async () => {
    const rows = [makeFingerprint({ id: FP_AAA, supportStatus: "pending" })];
    const prisma = makePrisma(rows);
    const result = await markFingerprintSupported(prisma as never, {
      tenantId: TENANT_A,
      userId: ACTOR,
      fingerprintId: FP_AAA,
    });
    expect(result.supportStatus).toBe("supported");
    expect(result.previousStatus).toBe("pending");
    const audit = (prisma as unknown as { auditLog: { create: { mock: { calls: Array<[{ data: Record<string, unknown> }]> } } } })
      .auditLog.create.mock.calls;
    expect(audit).toHaveLength(1);
    expect(audit[0]![0].data.actionType).toBe("parse_fingerprint.marked_supported");
  });

  it("suggested → supported (audit captures previousStatus)", async () => {
    const rows = [makeFingerprint({ id: FP_AAA, supportStatus: "suggested" })];
    const prisma = makePrisma(rows);
    const result = await markFingerprintSupported(prisma as never, {
      tenantId: TENANT_A,
      userId: ACTOR,
      fingerprintId: FP_AAA,
    });
    expect(result.previousStatus).toBe("suggested");
    const audit = (prisma as unknown as { auditLog: { create: { mock: { calls: Array<[{ data: { payload: Record<string, unknown> } }]> } } } })
      .auditLog.create.mock.calls;
    expect((audit[0]![0].data.payload as { previousStatus: string }).previousStatus).toBe("suggested");
  });

  it("unsupported → supported (operator changes mind)", async () => {
    const rows = [makeFingerprint({ id: FP_AAA, supportStatus: "unsupported" })];
    const prisma = makePrisma(rows);
    const result = await markFingerprintSupported(prisma as never, {
      tenantId: TENANT_A,
      userId: ACTOR,
      fingerprintId: FP_AAA,
    });
    expect(result.previousStatus).toBe("unsupported");
  });

  it("wrong tenantId → throws NOT_FOUND", async () => {
    const rows = [makeFingerprint({ id: FP_AAA, supportStatus: "pending" })];
    const prisma = makePrisma(rows);
    const OTHER = "22222222-2222-2222-2222-222222222222";
    await expect(
      markFingerprintSupported(prisma as never, {
        tenantId: OTHER,
        userId: ACTOR,
        fingerprintId: FP_AAA,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("already supported → throws BAD_REQUEST when guarded UPDATE returns 0", async () => {
    const rows = [makeFingerprint({ id: FP_AAA, supportStatus: "supported" })];
    const prisma = makePrisma(rows);
    // Force the guarded UPDATE to return 0 (no row matched the IN-clause)
    (prisma as unknown as { $executeRaw: { mockResolvedValueOnce: (v: number) => void } })
      .$executeRaw.mockResolvedValueOnce(0);
    await expect(
      markFingerprintSupported(prisma as never, {
        tenantId: TENANT_A,
        userId: ACTOR,
        fingerprintId: FP_AAA,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("markFingerprintUnsupported", () => {
  it("pending → unsupported (audit row written)", async () => {
    const rows = [makeFingerprint({ id: FP_AAA, supportStatus: "pending" })];
    const prisma = makePrisma(rows);
    const result = await markFingerprintUnsupported(prisma as never, {
      tenantId: TENANT_A,
      userId: ACTOR,
      fingerprintId: FP_AAA,
    });
    expect(result.supportStatus).toBe("unsupported");
    expect(result.previousStatus).toBe("pending");
    const audit = (prisma as unknown as { auditLog: { create: { mock: { calls: Array<[{ data: Record<string, unknown> }]> } } } })
      .auditLog.create.mock.calls;
    expect(audit[0]![0].data.actionType).toBe("parse_fingerprint.marked_unsupported");
  });

  it("suggested → unsupported (operator-explicit rejection)", async () => {
    const rows = [makeFingerprint({ id: FP_AAA, supportStatus: "suggested" })];
    const prisma = makePrisma(rows);
    const result = await markFingerprintUnsupported(prisma as never, {
      tenantId: TENANT_A,
      userId: ACTOR,
      fingerprintId: FP_AAA,
    });
    expect(result.previousStatus).toBe("suggested");
  });

  it("wrong tenantId → throws NOT_FOUND", async () => {
    const rows = [makeFingerprint({ id: FP_AAA, supportStatus: "suggested" })];
    const prisma = makePrisma(rows);
    const OTHER = "22222222-2222-2222-2222-222222222222";
    await expect(
      markFingerprintUnsupported(prisma as never, {
        tenantId: OTHER,
        userId: ACTOR,
        fingerprintId: FP_AAA,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("unmarkFingerprint", () => {
  it("supported → pending (clears suggestedAt/supportedAt/supportedBy)", async () => {
    const rows = [makeFingerprint({ id: FP_AAA, supportStatus: "supported" })];
    const prisma = makePrisma(rows);
    const result = await unmarkFingerprint(prisma as never, {
      tenantId: TENANT_A,
      userId: ACTOR,
      fingerprintId: FP_AAA,
    });
    expect(result.supportStatus).toBe("pending");
    expect(result.previousStatus).toBe("supported");
    const audit = (prisma as unknown as { auditLog: { create: { mock: { calls: Array<[{ data: Record<string, unknown> }]> } } } })
      .auditLog.create.mock.calls;
    expect(audit[0]![0].data.actionType).toBe("parse_fingerprint.unmarked");
  });

  it("unsupported → pending (re-arms auto-suggest)", async () => {
    const rows = [makeFingerprint({ id: FP_AAA, supportStatus: "unsupported" })];
    const prisma = makePrisma(rows);
    const result = await unmarkFingerprint(prisma as never, {
      tenantId: TENANT_A,
      userId: ACTOR,
      fingerprintId: FP_AAA,
    });
    expect(result.supportStatus).toBe("pending");
    expect(result.previousStatus).toBe("unsupported");
  });

  it("pending → ALREADY pending (guarded UPDATE returns 0; throws BAD_REQUEST)", async () => {
    const rows = [makeFingerprint({ id: FP_AAA, supportStatus: "pending" })];
    const prisma = makePrisma(rows);
    (prisma as unknown as { $executeRaw: { mockResolvedValueOnce: (v: number) => void } })
      .$executeRaw.mockResolvedValueOnce(0);
    await expect(
      unmarkFingerprint(prisma as never, {
        tenantId: TENANT_A,
        userId: ACTOR,
        fingerprintId: FP_AAA,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
