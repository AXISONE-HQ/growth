/**
 * KAN-911 — Ingestion Cohort 2.6 duplicate-detection — backend tests.
 *
 * Coverage:
 *   PURE — 4 matchers
 *     · matchContact: email_exact / phone_exact / name_fuzzy + company
 *     · matchCompany: domain_exact / name_fuzzy / legal_name_fuzzy
 *     · matchDeal:    name+email+30d window / name+email only / no match
 *     · matchOrder:   providerOrderId / orderNumber+email+24h / orderNumber
 *   STRING — bucket pre-filter
 *     · names in different first-letter buckets are NOT compared
 *   ORCHESTRATOR — happy path + tenant scope + already-confirmed gate
 *     · stamps dedupStartedAt / dedupCompletedAt / dedupCounts
 *     · writes MatchDecision JSON per staging row
 *   OVERRIDE — operator per-row override
 *     · userChoice persisted; merges with existing matchDecision
 *   CONFIRM — final gate
 *     · refuses when needs_review rows lack override
 *     · sets dedupConfirmedAt on success
 *
 * Pattern: pure functions tested with raw inputs (no mocking); the
 * orchestrator uses hand-rolled Prisma mocks (matches sibling
 * import-detection / import-row-classification tests).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ImportJob, PrismaClient } from "@prisma/client";
import {
  matchContact,
  matchCompany,
  matchDeal,
  matchOrder,
  runDuplicateDetection,
  overrideStagingDecision,
  confirmDuplicateResolution,
  type MatchDecision,
} from "../import-dedup.js";
import { bucketKey } from "../lib/string-matching.js";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const JOB_ID = "job_kan911_001";

// ─────────────────────────────────────────────
// Bucket helper — used to seed buckets in pure-function tests
// ─────────────────────────────────────────────

function bucketsFrom<T extends { id: string }>(
  items: T[],
  nameOf: (t: T) => string | null | undefined,
): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const key = bucketKey(nameOf(it));
    const arr = m.get(key) ?? [];
    arr.push(it);
    m.set(key, arr);
  }
  return m;
}

// ─────────────────────────────────────────────
// matchContact
// ─────────────────────────────────────────────

describe("matchContact", () => {
  it("email_exact → score 100, action update", () => {
    const existing = [
      {
        id: "c1",
        email: "Alice@Example.com",
        phone: null,
        firstName: "Alice",
        lastName: "Anderson",
        companyName: null,
      },
    ];
    const decision = matchContact(
      { email: "alice@example.com", firstName: null, lastName: null },
      existing,
      bucketsFrom(existing, (c) => `${c.firstName} ${c.lastName}`),
    );
    expect(decision.confidence).toBe(100);
    expect(decision.suggestedAction).toBe("update");
    expect(decision.candidates[0]?.matchedFields).toContain("email_exact");
  });

  it("phone_exact NANP fallback → 95, needs_review band → 'update' (>=95)", () => {
    const existing = [
      {
        id: "c1",
        email: null,
        phone: "+1 (415) 555-0142",
        firstName: null,
        lastName: null,
        companyName: null,
      },
    ];
    const decision = matchContact(
      { phone: "4155550142", firstName: null, lastName: null },
      existing,
      bucketsFrom(existing, (c) => `${c.firstName} ${c.lastName}`),
    );
    expect(decision.confidence).toBe(95);
    expect(decision.suggestedAction).toBe("update");
    expect(decision.candidates[0]?.matchedFields).toContain("phone_exact");
  });

  it("name_fuzzy alone → ≤94 (capped) → needs_review", () => {
    const existing = [
      {
        id: "c1",
        email: null,
        phone: null,
        firstName: "Alice",
        lastName: "Anderson",
        companyName: null,
      },
    ];
    const decision = matchContact(
      { firstName: "Alicia", lastName: "Anderson" },
      existing,
      bucketsFrom(existing, (c) => `${c.firstName} ${c.lastName}`),
    );
    expect(decision.candidates[0]?.score).toBeLessThanOrEqual(94);
    expect(decision.candidates[0]?.matchedFields).toContain("name_fuzzy");
  });

  it("name_fuzzy + same company → bump to ≥85", () => {
    const existing = [
      {
        id: "c1",
        email: null,
        phone: null,
        firstName: "Alice",
        lastName: "Anderson",
        companyName: "Acme Corp",
      },
    ];
    const decision = matchContact(
      { firstName: "Alyce", lastName: "Anderson", companyName: "ACME corp." },
      existing,
      bucketsFrom(existing, (c) => `${c.firstName} ${c.lastName}`),
    );
    expect(decision.candidates[0]?.score).toBeGreaterThanOrEqual(85);
  });

  it("no signals → empty candidates → suggested 'insert'", () => {
    const existing = [
      {
        id: "c1",
        email: "bob@bar.com",
        phone: "9999",
        firstName: "Bob",
        lastName: "B",
        companyName: null,
      },
    ];
    const decision = matchContact(
      { email: "alice@foo.com", firstName: "Alice", lastName: "Wonderland" },
      existing,
      bucketsFrom(existing, (c) => `${c.firstName} ${c.lastName}`),
    );
    expect(decision.candidates).toEqual([]);
    expect(decision.suggestedAction).toBe("insert");
  });

  it("returns top 3 candidates only, sorted by score desc", () => {
    const existing = [
      { id: "c1", email: "a@x.com", phone: null, firstName: "A", lastName: "X", companyName: null },
      { id: "c2", email: "a@x.com", phone: null, firstName: "A", lastName: "X", companyName: null },
      { id: "c3", email: "a@x.com", phone: null, firstName: "A", lastName: "X", companyName: null },
      { id: "c4", email: "a@x.com", phone: null, firstName: "A", lastName: "X", companyName: null },
    ];
    const decision = matchContact(
      { email: "a@x.com" },
      existing,
      bucketsFrom(existing, (c) => `${c.firstName} ${c.lastName}`),
    );
    expect(decision.candidates).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────
// matchCompany
// ─────────────────────────────────────────────

describe("matchCompany", () => {
  it("domain_exact → 100", () => {
    const existing = [
      { id: "co1", name: "Acme", legalName: null, domain: "Acme.COM" },
    ];
    const decision = matchCompany(
      { name: "Foo", domain: "acme.com" },
      existing,
      bucketsFrom(existing, (c) => c.name),
    );
    expect(decision.confidence).toBe(100);
    expect(decision.candidates[0]?.matchedFields).toContain("domain_exact");
  });

  it("name_fuzzy → ≤94, action needs_review", () => {
    // 1-char typo over 16 chars = 0.0625 ratio, below 0.15 threshold.
    const existing = [
      { id: "co1", name: "Acme Corporation", legalName: null, domain: null },
    ];
    const decision = matchCompany(
      { name: "Acme Corportion" },
      existing,
      bucketsFrom(existing, (c) => c.name),
    );
    expect(decision.candidates[0]?.matchedFields).toContain("name_fuzzy");
    expect(decision.candidates[0]?.score).toBeLessThanOrEqual(94);
  });

  it("legal_name_fuzzy → fires when staging name matches legalName (post-normalize)", () => {
    // After normalize: "Acme Holdings Inc." → "acme holdings inc" matches
    // existing.legalName="Acme Holdings Inc" → "acme holdings inc" exactly.
    // Bucket on existing.name = "Acme Brands" → 'a'; staging name starts
    // with 'a' too, so the bucket pre-filter doesn't exclude the pair.
    const existing = [
      {
        id: "co1",
        name: "Acme Brands",
        legalName: "Acme Holdings Inc",
        domain: null,
      },
    ];
    const decision = matchCompany(
      { name: "Acme Holdings Inc." },
      existing,
      bucketsFrom(existing, (c) => c.name),
    );
    const fields = decision.candidates[0]?.matchedFields ?? [];
    expect(fields).toContain("legal_name_fuzzy");
  });

  it("no overlap → empty", () => {
    const existing = [
      { id: "co1", name: "Acme", legalName: null, domain: "acme.com" },
    ];
    const decision = matchCompany(
      { name: "Zulu Co", domain: "zulu.io" },
      existing,
      bucketsFrom(existing, (c) => c.name),
    );
    expect(decision.candidates).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// matchDeal
// ─────────────────────────────────────────────

describe("matchDeal", () => {
  const baseExisting = {
    id: "d1",
    name: "Acme Renewal Q1",
    expectedCloseDate: new Date("2026-06-01"),
    contact: { email: "buyer@acme.com" },
  };

  it("name + email + 30-day window → score ≥ 90 (90 floor, 94 cap)", () => {
    // Exact name → fuzzyScore=100, capped to 94. In-window floor is 90 →
    // max(94, 90) = 94. So 90 is the floor; the actual score can be 90-94.
    const decision = matchDeal(
      {
        name: "Acme Renewal Q1",
        contactEmail: "buyer@acme.com",
        expectedCloseDate: new Date("2026-06-15"),
      },
      [baseExisting],
      bucketsFrom([baseExisting], (d) => d.name),
    );
    expect(decision.candidates[0]?.score).toBeGreaterThanOrEqual(90);
    expect(decision.candidates[0]?.score).toBeLessThanOrEqual(94);
    expect(decision.candidates[0]?.matchedFields).toContain("close_date_window");
  });

  it("name + email, out of window → score capped at 85", () => {
    const decision = matchDeal(
      {
        name: "Acme Renewal Q1",
        contactEmail: "buyer@acme.com",
        expectedCloseDate: new Date("2027-01-01"),
      },
      [baseExisting],
      bucketsFrom([baseExisting], (d) => d.name),
    );
    expect(decision.candidates[0]?.score).toBeLessThanOrEqual(85);
    expect(decision.candidates[0]?.matchedFields).not.toContain("close_date_window");
  });

  it("missing contact email → no match (conservative)", () => {
    const decision = matchDeal(
      { name: "Acme Renewal Q1", contactEmail: null },
      [baseExisting],
      bucketsFrom([baseExisting], (d) => d.name),
    );
    expect(decision.candidates).toEqual([]);
  });

  it("different contact email → no match", () => {
    const decision = matchDeal(
      { name: "Acme Renewal Q1", contactEmail: "other@example.com" },
      [baseExisting],
      bucketsFrom([baseExisting], (d) => d.name),
    );
    expect(decision.candidates).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// matchOrder
// ─────────────────────────────────────────────

describe("matchOrder", () => {
  const o: {
    id: string;
    orderNumber: string;
    providerOrderId: string | null;
    placedAt: Date | null;
    contact: { email: string | null } | null;
  } = {
    id: "o1",
    orderNumber: "ORD-1234",
    providerOrderId: "shopify_999",
    placedAt: new Date("2026-05-13T10:00:00Z"),
    contact: { email: "buyer@example.com" },
  };

  function maps(arr: typeof o[]) {
    const orderNumberMap = new Map<string, typeof o[]>();
    const providerIdMap = new Map<string, typeof o[]>();
    for (const x of arr) {
      const a = orderNumberMap.get(x.orderNumber) ?? [];
      a.push(x);
      orderNumberMap.set(x.orderNumber, a);
      if (x.providerOrderId) {
        const b = providerIdMap.get(x.providerOrderId) ?? [];
        b.push(x);
        providerIdMap.set(x.providerOrderId, b);
      }
    }
    return { orderNumberMap, providerIdMap };
  }

  it("providerOrderId exact → 100", () => {
    const { orderNumberMap, providerIdMap } = maps([o]);
    const decision = matchOrder(
      { providerOrderId: "shopify_999" },
      [o],
      orderNumberMap,
      providerIdMap,
    );
    expect(decision.confidence).toBe(100);
    expect(decision.candidates[0]?.matchedFields).toContain("provider_order_id_exact");
  });

  it("orderNumber + email + 24h window → 90", () => {
    const { orderNumberMap, providerIdMap } = maps([o]);
    const decision = matchOrder(
      {
        orderNumber: "ORD-1234",
        contactEmail: "buyer@example.com",
        placedAt: new Date("2026-05-13T18:00:00Z"),
      },
      [o],
      orderNumberMap,
      providerIdMap,
    );
    expect(decision.candidates[0]?.score).toBe(90);
    expect(decision.candidates[0]?.matchedFields).toContain("placed_at_window");
  });

  it("orderNumber alone → 95", () => {
    const { orderNumberMap, providerIdMap } = maps([o]);
    const decision = matchOrder(
      { orderNumber: "ORD-1234" },
      [o],
      orderNumberMap,
      providerIdMap,
    );
    expect(decision.candidates[0]?.score).toBe(95);
    expect(decision.candidates[0]?.matchedFields).toEqual(["order_number_exact"]);
  });

  it("unknown providerOrderId + unknown orderNumber → empty", () => {
    const { orderNumberMap, providerIdMap } = maps([o]);
    const decision = matchOrder(
      { orderNumber: "OTHER-1", providerOrderId: "stripe_x" },
      [o],
      orderNumberMap,
      providerIdMap,
    );
    expect(decision.candidates).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// Bucket pre-filter
// ─────────────────────────────────────────────

describe("bucket pre-filter", () => {
  it("names in different first-letter buckets are NOT scored together", () => {
    const existing = [
      {
        id: "c1",
        email: null,
        phone: null,
        firstName: "Zachary",
        lastName: "Smith",
        companyName: null,
      },
    ];
    const decision = matchContact(
      { firstName: "Alex", lastName: "Smith" },
      existing,
      bucketsFrom(existing, (c) => `${c.firstName} ${c.lastName}`),
    );
    // Different first letters ('a' vs 'z') → bucket pre-filter excludes
    // this pair → no candidates.
    expect(decision.candidates).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// Orchestrator + override + confirm
// ─────────────────────────────────────────────

function makeJob(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    id: JOB_ID,
    tenantId: overrides.tenantId ?? TENANT_A,
    createdByUserId: "user-1",
    fileName: "contacts.csv",
    fileSize: 1024,
    fileMimeType: "text/csv",
    gcsObjectPath: "tenants/t/imports/j/contacts.csv",
    mode: "update_add",
    status: "inspected",
    detectedFileType: "csv",
    detectedRowCount: 1,
    detectedColumnCount: 4,
    detectedHeaders: ["email"] as unknown,
    sampleRows: [] as unknown,
    detectedEntityType: "contacts",
    detectionConfidence: 95,
    detectionReasoning: null,
    detectionStartedAt: null,
    detectionCompletedAt: null,
    detectionError: null,
    detectionErrorAt: null,
    detectionInputTokens: null,
    detectionOutputTokens: null,
    detectionLlmModel: null,
    fieldMappings: null,
    fieldMappingConfidence: null,
    fieldMappingReasoning: null,
    fieldMappingStartedAt: null,
    fieldMappingCompletedAt: null,
    fieldMappingError: null,
    fieldMappingErrorAt: null,
    fieldMappingInputTokens: null,
    fieldMappingOutputTokens: null,
    fieldMappingLlmModel: null,
    fieldMappingConfirmedAt: null,
    rowClassificationCounts: null,
    rowClassificationStartedAt: null,
    rowClassificationCompletedAt: null,
    rowClassificationError: null,
    rowClassificationErrorAt: null,
    rowClassificationInputTokens: null,
    rowClassificationOutputTokens: null,
    rowClassificationLlmModel: null,
    rowClassificationConfirmedAt: new Date("2026-05-13T12:00:00Z"),
    dedupStartedAt: null,
    dedupCompletedAt: null,
    dedupError: null,
    dedupErrorAt: null,
    dedupCounts: null,
    dedupCandidatesCount: null,
    dedupConfirmedAt: null,
    errorMessage: null,
    errorAt: null,
    createdAt: new Date("2026-05-13T11:00:00Z"),
    updatedAt: new Date("2026-05-13T12:00:00Z"),
    uploadConfirmedAt: new Date("2026-05-13T11:30:00Z"),
    inspectionStartedAt: new Date("2026-05-13T11:31:00Z"),
    inspectionCompletedAt: new Date("2026-05-13T11:33:00Z"),
    ...overrides,
  } as ImportJob;
}

interface OrchestratorMockSeed {
  job: ImportJob;
  stagingContacts: Array<{
    id: string;
    importJobId: string;
    tenantId: string;
    email?: string | null;
    phone?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    companyName?: string | null;
    sourceRowIndex: number;
    sourceRowData?: unknown;
    matchDecision?: unknown;
  }>;
  existingContacts: Array<{
    id: string;
    email: string | null;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
  }>;
}

function makeOrchestratorPrismaMock(seed: OrchestratorMockSeed) {
  let currentJob: ImportJob = seed.job;
  const staging = seed.stagingContacts.map((s) => ({ ...s }));

  const findFirstJob = vi.fn().mockImplementation(async () => currentJob);
  const updateJob = vi.fn().mockImplementation(async (args: { data: Partial<ImportJob> }) => {
    currentJob = { ...currentJob, ...args.data };
    return currentJob;
  });

  const findManyStagingContact = vi.fn().mockResolvedValue(staging);
  const findManyStagingCompany = vi.fn().mockResolvedValue([]);
  const findManyStagingDeal = vi.fn().mockResolvedValue([]);
  const findManyStagingOrder = vi.fn().mockResolvedValue([]);

  const findManyContact = vi.fn().mockResolvedValue(seed.existingContacts);
  const findManyCompany = vi.fn().mockResolvedValue([]);
  const findManyDeal = vi.fn().mockResolvedValue([]);
  const findManyOrder = vi.fn().mockResolvedValue([]);

  const updateStagingContact = vi.fn().mockImplementation(
    async (args: { where: { id: string }; data: { matchDecision: unknown } }) => {
      const row = staging.find((s) => s.id === args.where.id);
      if (row) row.matchDecision = args.data.matchDecision;
      return row;
    },
  );

  // $transaction receives an array of "queued" update promises. In the
  // service we build them as `prisma.X.update(...)` calls which start
  // executing immediately. The transaction just awaits them.
  const transaction = vi.fn().mockImplementation(async (queries: Promise<unknown>[]) => {
    return Promise.all(queries);
  });

  const prisma = {
    importJob: { findFirst: findFirstJob, update: updateJob },
    importStagingContact: {
      findMany: findManyStagingContact,
      update: updateStagingContact,
    },
    importStagingCompany: {
      findMany: findManyStagingCompany,
      update: vi.fn(),
    },
    importStagingDeal: {
      findMany: findManyStagingDeal,
      update: vi.fn(),
    },
    importStagingOrder: {
      findMany: findManyStagingOrder,
      update: vi.fn(),
    },
    contact: { findMany: findManyContact },
    company: { findMany: findManyCompany },
    deal: { findMany: findManyDeal },
    order: { findMany: findManyOrder },
    $transaction: transaction,
  } as unknown as PrismaClient;

  return {
    prisma,
    getJob: () => currentJob,
    getStagingRow: (id: string) => staging.find((s) => s.id === id),
    updateStagingContact,
    transaction,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("runDuplicateDetection — orchestrator", () => {
  it("happy path: stamps timestamps + writes counts + writes per-row matchDecision", async () => {
    // KAN-915 — mirror columns are now a LAZY CACHE populated by the
    // back-fill step at runDuplicateDetection entry. To exercise the
    // matchers, the staging row must have sourceRowData populated AND
    // the job must have fieldMappings — that's the new source of truth.
    const seed: OrchestratorMockSeed = {
      job: makeJob({
        fieldMappings: [
          { sourceColumn: "email", targetField: "email", confidence: 100 },
          { sourceColumn: "first_name", targetField: "firstName", confidence: 100 },
          { sourceColumn: "last_name", targetField: "lastName", confidence: 100 },
        ] as unknown as never,
      }),
      stagingContacts: [
        {
          id: "s1",
          importJobId: JOB_ID,
          tenantId: TENANT_A,
          sourceRowIndex: 0,
          sourceRowData: {
            email: "alice@example.com",
            first_name: "Alice",
            last_name: "Anderson",
          },
          // Mirror columns initialized NULL; back-fill populates them.
          email: null,
          firstName: null,
          lastName: null,
        },
      ],
      existingContacts: [
        {
          id: "c1",
          email: "alice@example.com",
          phone: null,
          firstName: "Alice",
          lastName: "Anderson",
          companyName: null,
        },
      ],
    };
    const { prisma, getJob, getStagingRow } = makeOrchestratorPrismaMock(seed);

    const result = await runDuplicateDetection(prisma, JOB_ID, TENANT_A);

    expect(result.dedupStartedAt).not.toBeNull();
    expect(result.dedupCompletedAt).not.toBeNull();
    expect(result.dedupError).toBeNull();
    expect(result.dedupCandidatesCount).toBe(1);

    const counts = getJob().dedupCounts as unknown as {
      byEntity: { contacts: { total: number; exactMatches: number } };
    };
    expect(counts.byEntity.contacts.total).toBe(1);
    expect(counts.byEntity.contacts.exactMatches).toBe(1);

    const staged = getStagingRow("s1");
    const md = staged?.matchDecision as MatchDecision;
    expect(md.suggestedAction).toBe("update");
    expect(md.confidence).toBe(100);
  });

  it("BAD_REQUEST when rowClassificationConfirmedAt is null", async () => {
    const seed: OrchestratorMockSeed = {
      job: makeJob({ rowClassificationConfirmedAt: null }),
      stagingContacts: [],
      existingContacts: [],
    };
    const { prisma } = makeOrchestratorPrismaMock(seed);
    await expect(runDuplicateDetection(prisma, JOB_ID, TENANT_A)).rejects.toThrow(
      /Row classification must be confirmed/,
    );
  });

  it("NOT_FOUND on cross-tenant access", async () => {
    const seed: OrchestratorMockSeed = {
      job: makeJob({ tenantId: TENANT_A }),
      stagingContacts: [],
      existingContacts: [],
    };
    const { prisma } = makeOrchestratorPrismaMock({
      ...seed,
      job: { ...seed.job, tenantId: TENANT_A },
    });
    // Tell the mock to return null when called with the wrong tenant.
    (prisma as unknown as {
      importJob: { findFirst: ReturnType<typeof vi.fn> };
    }).importJob.findFirst = vi.fn().mockResolvedValue(null);
    await expect(runDuplicateDetection(prisma, JOB_ID, TENANT_B)).rejects.toThrow(
      /Import job not found/,
    );
  });
});

// ─────────────────────────────────────────────
// overrideStagingDecision
// ─────────────────────────────────────────────

describe("overrideStagingDecision", () => {
  it("merges userChoice onto existing matchDecision", async () => {
    const existing: MatchDecision = {
      candidates: [
        { existingEntityId: "c1", score: 80, matchedFields: ["name_fuzzy"] },
      ],
      suggestedAction: "needs_review",
      confidence: 80,
      suggestedReason: "Top match @ 80% via name_fuzzy.",
    };
    let stored: unknown = existing;
    const prisma = {
      importStagingContact: {
        findFirst: vi.fn().mockResolvedValue({ id: "s1", matchDecision: existing }),
        update: vi.fn().mockImplementation(async (args: {
          where: { id: string };
          data: { matchDecision: unknown };
        }) => {
          stored = args.data.matchDecision;
        }),
      },
    } as unknown as PrismaClient;

    const result = await overrideStagingDecision(prisma, TENANT_A, {
      stagingId: "s1",
      entityType: "contacts",
      newAction: "update",
      chosenCandidateId: "c1",
    });

    expect(result).toEqual({ ok: true });
    const merged = stored as MatchDecision;
    expect(merged.userChoice?.action).toBe("update");
    expect(merged.userChoice?.chosenCandidateId).toBe("c1");
    expect(merged.candidates).toEqual(existing.candidates);
  });

  it("requires chosenCandidateId for newAction='update'", async () => {
    const prisma = {
      importStagingContact: { findFirst: vi.fn() },
    } as unknown as PrismaClient;
    await expect(
      overrideStagingDecision(prisma, TENANT_A, {
        stagingId: "s1",
        entityType: "contacts",
        newAction: "update",
      }),
    ).rejects.toThrow(/chosenCandidateId is required/);
  });

  it("NOT_FOUND when staging row missing", async () => {
    const prisma = {
      importStagingContact: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaClient;
    await expect(
      overrideStagingDecision(prisma, TENANT_A, {
        stagingId: "missing",
        entityType: "contacts",
        newAction: "insert",
      }),
    ).rejects.toThrow(/Staging row not found/);
  });
});

// ─────────────────────────────────────────────
// confirmDuplicateResolution
// ─────────────────────────────────────────────

describe("confirmDuplicateResolution", () => {
  it("refuses when a needs_review row has no userChoice", async () => {
    const needsReview: MatchDecision = {
      candidates: [
        { existingEntityId: "c1", score: 80, matchedFields: ["name_fuzzy"] },
      ],
      suggestedAction: "needs_review",
      confidence: 80,
      suggestedReason: "x",
    };
    const prisma = {
      importJob: {
        findFirst: vi.fn().mockResolvedValue(
          makeJob({ dedupCompletedAt: new Date("2026-05-13T12:00:00Z") }),
        ),
        update: vi.fn(),
      },
      importStagingContact: {
        findMany: vi.fn().mockResolvedValue([
          { id: "s1", sourceRowIndex: 0, matchDecision: needsReview },
        ]),
      },
      importStagingCompany: { findMany: vi.fn().mockResolvedValue([]) },
      importStagingDeal: { findMany: vi.fn().mockResolvedValue([]) },
      importStagingOrder: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;

    await expect(
      confirmDuplicateResolution(prisma, JOB_ID, TENANT_A),
    ).rejects.toThrow(/still need review/);
  });

  it("sets dedupConfirmedAt when all rows are resolved", async () => {
    let resolvedJob: ImportJob = makeJob({
      dedupCompletedAt: new Date("2026-05-13T12:00:00Z"),
    });
    const updateJob = vi.fn().mockImplementation(async (args: {
      data: Partial<ImportJob>;
    }) => {
      resolvedJob = { ...resolvedJob, ...args.data };
      return resolvedJob;
    });
    const resolved: MatchDecision = {
      candidates: [],
      suggestedAction: "insert",
      confidence: 0,
      suggestedReason: "",
    };
    const prisma = {
      importJob: {
        findFirst: vi.fn().mockResolvedValue(resolvedJob),
        update: updateJob,
      },
      importStagingContact: {
        findMany: vi.fn().mockResolvedValue([
          { id: "s1", sourceRowIndex: 0, matchDecision: resolved },
        ]),
      },
      importStagingCompany: { findMany: vi.fn().mockResolvedValue([]) },
      importStagingDeal: { findMany: vi.fn().mockResolvedValue([]) },
      importStagingOrder: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaClient;

    const result = await confirmDuplicateResolution(prisma, JOB_ID, TENANT_A);
    expect(result.dedupConfirmedAt).not.toBeNull();
    expect(updateJob).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dedupConfirmedAt: expect.any(Date) }),
      }),
    );
  });

  it("BAD_REQUEST when dedupCompletedAt is null", async () => {
    const prisma = {
      importJob: {
        findFirst: vi.fn().mockResolvedValue(makeJob()),
      },
    } as unknown as PrismaClient;
    await expect(
      confirmDuplicateResolution(prisma, JOB_ID, TENANT_A),
    ).rejects.toThrow(/Run duplicate detection before confirming/);
  });
});
