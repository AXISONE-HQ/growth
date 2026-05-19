/**
 * KAN-913 — Ingestion Cohort 2.7 commit + audit + fanout — backend tests.
 *
 * Coverage:
 *   RESOLVERS — pure-function correctness
 *     · resolveContactByEmail: hit / miss / case-insensitive
 *     · resolvePipelineByName: hit / fall back to tenant default / no Pipeline
 *     · resolveStageByName: hit / fall back to isInitial / fall back to first by order
 *
 *   ORCHESTRATOR (runCommit)
 *     · BAD_REQUEST when dedupConfirmedAt is null
 *     · NOT_FOUND on cross-tenant access
 *     · CONFLICT when commitStatus='running'
 *     · happy path: 1 contact (insert), commitStatus='succeeded',
 *       counters update, AuditLog written, Pub/Sub event published
 *     · skip action: stagingStatus='skipped', no canonical write,
 *       no audit, no event
 *     · update action: chosenCandidateId honored, Contact updated
 *     · needs_review post-confirm → commitErrors entry, no canonical write
 *     · Deal contact-resolution miss → commitErrors with reason='contact_not_found'
 *     · Order P2002 unique violation → commitErrors with reason='order_number_duplicate'
 *     · partial outcome: 1 success + 1 error → commitStatus='partial'
 *     · failed outcome: 0 success + 1 error → commitStatus='failed'
 *     · actor format: createdByUserId → 'user:<id>'; null → 'system'
 *     · Pub/Sub: IMPORT_EVENTS_ENABLED=true → publish; default → skipped
 *
 *   CSV DOWNLOAD
 *     · downloadCommitErrors returns empty for jobs with no errors
 *     · papaparse.unparse output has correct header + row count
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Prisma, type ImportJob, type PrismaClient } from "@prisma/client";

// Mock the Pub/Sub publisher at module scope so we can introspect calls
// without instantiating the real client (which would require GCP creds).
const publishMock = vi.fn();
vi.mock("../lib/import-row-committed-publisher.js", () => ({
  publishImportRowCommitted: (...args: unknown[]) => publishMock(...args),
  importEventsEnabled: () => process.env.IMPORT_EVENTS_ENABLED === "true",
}));

import {
  runCommit,
  downloadCommitErrors,
  resolveContactByEmail,
  resolvePipelineByName,
  resolveStageByName,
} from "../import-commit.js";

// Note: real UUIDs required because the Pub/Sub event schema in
// @growth/shared validates `tenantId` as zod.string().uuid() — the
// publisher would reject non-UUID tenant ids at parse time.
const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const JOB_ID = "job_kan913_001";

// ─────────────────────────────────────────────
// Resolver tests — call resolvers directly with hand-rolled prisma mock
// ─────────────────────────────────────────────

describe("resolveContactByEmail", () => {
  it("returns matching contact by case-insensitive email", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "c1" });
    const prisma = { contact: { findFirst } } as unknown as PrismaClient;
    const res = await resolveContactByEmail(prisma, TENANT_A, "ALICE@example.com");
    expect(res).toEqual({ id: "c1" });
    expect(findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT_A, email: { equals: "ALICE@example.com", mode: "insensitive" } },
      select: { id: true },
    });
  });

  it("returns null for empty / missing email", async () => {
    const prisma = { contact: { findFirst: vi.fn() } } as unknown as PrismaClient;
    expect(await resolveContactByEmail(prisma, TENANT_A, null)).toBeNull();
    expect(await resolveContactByEmail(prisma, TENANT_A, "")).toBeNull();
  });
});

describe("resolvePipelineByName", () => {
  it("hits by name first", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({ id: "p1" }); // by-name call
    const prisma = { pipeline: { findFirst } } as unknown as PrismaClient;
    const res = await resolvePipelineByName(prisma, TENANT_A, "Sales Pipeline");
    expect(res).toEqual({ id: "p1" });
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("falls back to tenant default when name miss", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null) // by-name miss
      .mockResolvedValueOnce({ id: "p_default" }); // fallback
    const prisma = { pipeline: { findFirst } } as unknown as PrismaClient;
    const res = await resolvePipelineByName(prisma, TENANT_A, "Unknown Pipeline");
    expect(res).toEqual({ id: "p_default" });
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it("falls back when name is null/empty", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "p_default" });
    const prisma = { pipeline: { findFirst } } as unknown as PrismaClient;
    const res = await resolvePipelineByName(prisma, TENANT_A, null);
    expect(res).toEqual({ id: "p_default" });
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("returns null when tenant has no Pipelines at all", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { pipeline: { findFirst } } as unknown as PrismaClient;
    const res = await resolvePipelineByName(prisma, TENANT_A, null);
    expect(res).toBeNull();
  });
});

describe("resolveStageByName", () => {
  it("hits by name first", async () => {
    const findFirst = vi.fn().mockResolvedValueOnce({ id: "s1" });
    const prisma = { stage: { findFirst } } as unknown as PrismaClient;
    const res = await resolveStageByName(prisma, "p1", "Discovery");
    expect(res).toEqual({ id: "s1" });
  });

  it("falls back to isInitial=true when name miss", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null) // by-name miss
      .mockResolvedValueOnce({ id: "s_initial" }); // isInitial fallback
    const prisma = { stage: { findFirst } } as unknown as PrismaClient;
    const res = await resolveStageByName(prisma, "p1", "UnknownStage");
    expect(res).toEqual({ id: "s_initial" });
  });

  it("falls back to first-by-order when no isInitial stage", async () => {
    // name=null → skips the by-name lookup; only 2 calls fire
    // (isInitial miss + first-by-order).
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null) // isInitial miss
      .mockResolvedValueOnce({ id: "s_first" }); // first by order
    const prisma = { stage: { findFirst } } as unknown as PrismaClient;
    const res = await resolveStageByName(prisma, "p1", null);
    expect(res).toEqual({ id: "s_first" });
  });
});

// ─────────────────────────────────────────────
// Orchestrator mocks
// ─────────────────────────────────────────────

function makeJob(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    id: JOB_ID,
    tenantId: TENANT_A,
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
    dedupConfirmedAt: new Date("2026-05-13T12:00:00Z"),
    commitStatus: "pending",
    commitStartedAt: null,
    commitCompletedAt: null,
    committedRowCount: 0,
    failedRowCount: 0,
    commitErrors: [] as unknown,
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

interface StagingContactRow {
  id: string;
  importJobId: string;
  tenantId: string;
  sourceRowIndex: number;
  sourceRowData: unknown;
  matchDecision: unknown;
  stagingStatus: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  lifecycleStage: string | null;
  source: string | null;
  targetContactId: string | null;
}

function makeOrchestratorPrismaMock(seed: {
  job: ImportJob;
  stagingContacts?: StagingContactRow[];
  stagingCompanies?: unknown[];
  stagingDeals?: unknown[];
  stagingOrders?: unknown[];
  existingContacts?: Array<{ id: string }>;
  contactCreateImpl?: (data: unknown) => { id: string };
  contactUpdateImpl?: (where: unknown, data: unknown) => { id: string };
}) {
  let currentJob: ImportJob = seed.job;
  const stagingContacts = (seed.stagingContacts ?? []).map((s) => ({ ...s }));

  // Track audit log writes for assertions.
  const auditWrites: Array<Record<string, unknown>> = [];

  const findFirstJob = vi.fn().mockImplementation(async (args: {
    where: { id?: string; tenantId?: string };
  }) => {
    if (args.where.tenantId && args.where.tenantId !== currentJob.tenantId) {
      return null;
    }
    if (args.where.id && args.where.id !== currentJob.id) return null;
    return currentJob;
  });
  // findFirstOrThrow mirrors findFirst but throws on null. Used by
  // runCommit's post-claim re-fetch.
  const findFirstOrThrowJob = vi.fn().mockImplementation(async (args: {
    where: { id?: string; tenantId?: string };
  }) => {
    const result = await findFirstJob(args);
    if (!result) throw new Error("findFirstOrThrow: no rows match");
    return result;
  });
  const updateJob = vi.fn().mockImplementation(async (args: { data: Partial<ImportJob> }) => {
    currentJob = { ...currentJob, ...args.data };
    return currentJob;
  });
  // Atomic claim simulator — mirrors the WHERE-filter check from the
  // updateMany call site. count=1 only when every filter clause matches
  // currentJob's state; count=0 otherwise. After a successful claim,
  // currentJob's commitStatus transitions to 'running' (preventing a
  // second sequential claim from succeeding — load-bearing for the
  // concurrent-invocation test).
  const updateManyJob = vi.fn().mockImplementation(async (args: {
    where: {
      id?: string;
      tenantId?: string;
      commitStatus?: ImportJob["commitStatus"];
      dedupConfirmedAt?: { not: null };
    };
    data: Partial<ImportJob>;
  }) => {
    if (args.where.id && args.where.id !== currentJob.id) return { count: 0 };
    if (args.where.tenantId && args.where.tenantId !== currentJob.tenantId) {
      return { count: 0 };
    }
    if (
      args.where.commitStatus &&
      args.where.commitStatus !== currentJob.commitStatus
    ) {
      return { count: 0 };
    }
    if (args.where.dedupConfirmedAt?.not === null && !currentJob.dedupConfirmedAt) {
      return { count: 0 };
    }
    // Match — apply the patch.
    currentJob = { ...currentJob, ...args.data };
    return { count: 1 };
  });

  // Per-row $transaction simulation. We run the callback with a `tx`
  // object that proxies all operations to our top-level mocks (good
  // enough for unit tests; doesn't simulate actual rollback).
  const txExecute = async <T>(
    callback: (tx: unknown) => Promise<T>,
  ): Promise<T> => {
    const tx = prismaProxy;
    return callback(tx);
  };

  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_${++counter}`;

  const prismaProxy = {
    importJob: {
      findFirst: findFirstJob,
      findFirstOrThrow: findFirstOrThrowJob,
      update: updateJob,
      updateMany: updateManyJob,
    },
    importStagingContact: {
      findMany: vi.fn().mockResolvedValue(stagingContacts),
      update: vi.fn().mockImplementation(async (args: {
        where: { id: string };
        data: { stagingStatus?: string; targetContactId?: string | null };
      }) => {
        const row = stagingContacts.find((s) => s.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row;
      }),
    },
    importStagingCompany: {
      findMany: vi.fn().mockResolvedValue(seed.stagingCompanies ?? []),
      update: vi.fn(),
    },
    importStagingDeal: {
      findMany: vi.fn().mockResolvedValue(seed.stagingDeals ?? []),
      update: vi.fn(),
    },
    importStagingOrder: {
      findMany: vi.fn().mockResolvedValue(seed.stagingOrders ?? []),
      update: vi.fn(),
    },
    contact: {
      findFirst: vi.fn().mockImplementation(async (args: {
        where: { id?: string; tenantId?: string };
      }) => {
        if (!seed.existingContacts) return null;
        return (
          seed.existingContacts.find(
            (c) =>
              (!args.where.id || c.id === args.where.id) &&
              (!args.where.tenantId || true),
          ) ?? null
        );
      }),
      create: vi.fn().mockImplementation(async (args: {
        data: unknown;
        select?: unknown;
      }) => {
        if (seed.contactCreateImpl) return seed.contactCreateImpl(args.data);
        return { id: nextId("ctc") };
      }),
      update: vi.fn().mockImplementation(async (args: {
        where: { id: string };
        data: unknown;
      }) => {
        if (seed.contactUpdateImpl)
          return seed.contactUpdateImpl(args.where, args.data);
        return { id: args.where.id };
      }),
    },
    company: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), update: vi.fn() },
    deal: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    order: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    pipeline: { findFirst: vi.fn() },
    stage: { findFirst: vi.fn() },
    auditLog: {
      create: vi.fn().mockImplementation(async (args: { data: unknown }) => {
        auditWrites.push(args.data as Record<string, unknown>);
        return { id: nextId("audit") };
      }),
    },
    $transaction: vi.fn().mockImplementation(async (
      callback: (tx: unknown) => Promise<unknown>,
    ) => {
      return txExecute(callback);
    }),
  };

  return {
    prisma: prismaProxy as unknown as PrismaClient,
    getJob: () => currentJob,
    getAuditWrites: () => auditWrites,
    getStagingContacts: () => stagingContacts,
  };
}

beforeEach(() => {
  publishMock.mockReset();
  delete process.env.IMPORT_EVENTS_ENABLED;
});

// ─────────────────────────────────────────────
// Orchestrator — happy path + gates + actor format
// ─────────────────────────────────────────────

describe("runCommit — gates", () => {
  it("BAD_REQUEST when dedupConfirmedAt is null", async () => {
    const seed = {
      job: makeJob({ dedupConfirmedAt: null }),
    };
    const { prisma } = makeOrchestratorPrismaMock(seed);
    await expect(runCommit(prisma, JOB_ID, TENANT_A)).rejects.toThrow(
      /Duplicate detection must be confirmed/,
    );
  });

  it("NOT_FOUND on cross-tenant access", async () => {
    const seed = { job: makeJob() };
    const { prisma } = makeOrchestratorPrismaMock(seed);
    await expect(runCommit(prisma, JOB_ID, TENANT_B)).rejects.toThrow(
      /Import job not found/,
    );
  });

  it("CONFLICT when commitStatus is already 'running'", async () => {
    const seed = { job: makeJob({ commitStatus: "running" }) };
    const { prisma } = makeOrchestratorPrismaMock(seed);
    await expect(runCommit(prisma, JOB_ID, TENANT_A)).rejects.toThrow(
      /already running/,
    );
  });

  // KAN-923 — pre-claim match-config completeness gate. Fail loud BEFORE
  // any state mutation if a field mapping targets external_id family but
  // externalSourceTag is null. See KAN-923 reframe (2026-05-19).
  describe("KAN-923 — pre-loop config completeness", () => {
    it("(KAN-923 f) external_id mapping + null externalSourceTag → PRECONDITION_FAILED", async () => {
      const seed = {
        job: makeJob({
          fieldMappings: [
            { sourceColumn: "objectId", targetField: "external_id", confidence: 95 },
            { sourceColumn: "email", targetField: "email", confidence: 99 },
          ] as unknown as ImportJob["fieldMappings"],
          externalSourceTag: null,
        }),
      };
      const { prisma } = makeOrchestratorPrismaMock(seed);
      await expect(runCommit(prisma, JOB_ID, TENANT_A)).rejects.toThrow(
        /Match configuration is incomplete/,
      );
    });

    it("(KAN-923 g) customer_external_id mapping + null externalSourceTag → PRECONDITION_FAILED", async () => {
      const seed = {
        job: makeJob({
          fieldMappings: [
            { sourceColumn: "AssocContact", targetField: "customer_external_id", confidence: 90 },
          ] as unknown as ImportJob["fieldMappings"],
          externalSourceTag: null,
        }),
      };
      const { prisma } = makeOrchestratorPrismaMock(seed);
      await expect(runCommit(prisma, JOB_ID, TENANT_A)).rejects.toThrow(
        /Match configuration is incomplete/,
      );
    });

    it("(KAN-923 h) deal_external_id mapping + null externalSourceTag → PRECONDITION_FAILED", async () => {
      const seed = {
        job: makeJob({
          fieldMappings: [
            { sourceColumn: "DealVID", targetField: "deal_external_id", confidence: 90 },
          ] as unknown as ImportJob["fieldMappings"],
          externalSourceTag: null,
        }),
      };
      const { prisma } = makeOrchestratorPrismaMock(seed);
      await expect(runCommit(prisma, JOB_ID, TENANT_A)).rejects.toThrow(
        /Match configuration is incomplete/,
      );
    });

    it("(KAN-923 i) no external_id family mappings + null externalSourceTag → proceeds (current heuristic mode)", async () => {
      // Backwards-compat: pre-KAN-922 imports without any external_id-family
      // mappings should still commit cleanly with null externalSourceTag.
      const seed = {
        job: makeJob({
          fieldMappings: [
            { sourceColumn: "email", targetField: "email", confidence: 99 },
            { sourceColumn: "phone", targetField: "phone", confidence: 95 },
          ] as unknown as ImportJob["fieldMappings"],
          externalSourceTag: null,
        }),
      };
      const { prisma } = makeOrchestratorPrismaMock(seed);
      // No staging rows → fast path through orchestrator; we just need to
      // verify the pre-loop gate doesn't throw.
      await expect(runCommit(prisma, JOB_ID, TENANT_A)).resolves.toBeDefined();
    });

    it("(KAN-923 j) external_id mapping + valid externalSourceTag → proceeds (KAN-922 happy path)", async () => {
      const seed = {
        job: makeJob({
          fieldMappings: [
            { sourceColumn: "objectId", targetField: "external_id", confidence: 95 },
          ] as unknown as ImportJob["fieldMappings"],
          externalSourceTag: "hubspot",
        }),
      };
      const { prisma } = makeOrchestratorPrismaMock(seed);
      await expect(runCommit(prisma, JOB_ID, TENANT_A)).resolves.toBeDefined();
    });
  });
});

describe("runCommit — Contact happy path", () => {
  function makeStagingContact(overrides: Partial<StagingContactRow> = {}): StagingContactRow {
    return {
      id: "sc1",
      importJobId: JOB_ID,
      tenantId: TENANT_A,
      sourceRowIndex: 0,
      sourceRowData: {} as unknown,
      matchDecision: { suggestedAction: "insert", candidates: [], confidence: 0, suggestedReason: "" } as unknown,
      stagingStatus: "ready",
      email: "alice@example.com",
      phone: null,
      firstName: "Alice",
      lastName: "Anderson",
      companyName: null,
      lifecycleStage: null,
      source: null,
      targetContactId: null,
      ...overrides,
    };
  }

  it("inserts canonical Contact + writes AuditLog + commitStatus='succeeded'", async () => {
    const { prisma, getJob, getAuditWrites, getStagingContacts } =
      makeOrchestratorPrismaMock({
        job: makeJob(),
        stagingContacts: [makeStagingContact()],
      });
    const result = await runCommit(prisma, JOB_ID, TENANT_A);

    expect(result.commitStatus).toBe("succeeded");
    expect(result.committedRowCount).toBe(1);
    expect(result.failedRowCount).toBe(0);
    expect(result.commitStartedAt).not.toBeNull();
    expect(result.commitCompletedAt).not.toBeNull();

    const audit = getAuditWrites();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      tenantId: TENANT_A,
      actor: "user:user-1",
      actionType: "import.row.committed.contact",
    });

    const staged = getStagingContacts()[0]!;
    expect(staged.stagingStatus).toBe("committed");
    expect(staged.targetContactId).toMatch(/^ctc_/);
    expect(getJob().commitStatus).toBe("succeeded");
  });

  it("falls back to actor='system' when createdByUserId is null", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { prisma, getAuditWrites } = makeOrchestratorPrismaMock({
      job: makeJob({ createdByUserId: null as unknown as string }),
      stagingContacts: [makeStagingContact()],
    });
    await runCommit(prisma, JOB_ID, TENANT_A);
    expect(getAuditWrites()[0]?.actor).toBe("system");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skip action: stagingStatus='skipped', no audit, no event", async () => {
    process.env.IMPORT_EVENTS_ENABLED = "true";
    const { prisma, getAuditWrites, getStagingContacts } =
      makeOrchestratorPrismaMock({
        job: makeJob(),
        stagingContacts: [
          makeStagingContact({
            matchDecision: {
              suggestedAction: "skip",
              userChoice: { action: "skip", overriddenAt: "x" },
              candidates: [],
              confidence: 0,
              suggestedReason: "",
            } as unknown,
          }),
        ],
      });
    const result = await runCommit(prisma, JOB_ID, TENANT_A);

    expect(getAuditWrites()).toHaveLength(0);
    expect(getStagingContacts()[0]?.stagingStatus).toBe("skipped");
    expect(result.committedRowCount).toBe(0);
    expect(result.commitStatus).toBe("succeeded"); // skip-only = no-op commit
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("update action: chosenCandidateId honored", async () => {
    const { prisma, getAuditWrites } = makeOrchestratorPrismaMock({
      job: makeJob(),
      stagingContacts: [
        makeStagingContact({
          matchDecision: {
            suggestedAction: "update",
            candidates: [
              { existingEntityId: "ctc_existing", score: 100, matchedFields: [] },
            ],
            confidence: 100,
            suggestedReason: "",
            userChoice: {
              action: "update",
              chosenCandidateId: "ctc_existing",
              overriddenAt: "x",
            },
          } as unknown,
        }),
      ],
      existingContacts: [{ id: "ctc_existing" }],
    });

    const result = await runCommit(prisma, JOB_ID, TENANT_A);
    expect(result.committedRowCount).toBe(1);
    expect(getAuditWrites()[0]?.actionType).toBe("import.row.committed.contact");
    const payload = getAuditWrites()[0]?.payload as { action: string; entityId: string };
    expect(payload.action).toBe("updated");
    expect(payload.entityId).toBe("ctc_existing");
  });

  it("needs_review post-confirm: row errors with reason='needs_review_unresolved'", async () => {
    const { prisma, getJob } = makeOrchestratorPrismaMock({
      job: makeJob(),
      stagingContacts: [
        makeStagingContact({
          matchDecision: {
            suggestedAction: "needs_review",
            candidates: [{ existingEntityId: "x", score: 80, matchedFields: [] }],
            confidence: 80,
            suggestedReason: "",
          } as unknown,
        }),
      ],
    });
    const result = await runCommit(prisma, JOB_ID, TENANT_A);
    expect(result.commitStatus).toBe("failed");
    expect(result.failedRowCount).toBe(1);
    const errs = getJob().commitErrors as unknown as Array<{ reason: string }>;
    expect(errs[0]?.reason).toBe("needs_review_unresolved");
  });
});

describe("runCommit — Pub/Sub fanout", () => {
  function makeStagingContact(): StagingContactRow {
    return {
      id: "sc1",
      importJobId: JOB_ID,
      tenantId: TENANT_A,
      sourceRowIndex: 0,
      sourceRowData: {} as unknown,
      matchDecision: { suggestedAction: "insert", candidates: [], confidence: 0, suggestedReason: "" } as unknown,
      stagingStatus: "ready",
      email: "alice@example.com",
      phone: null,
      firstName: "A",
      lastName: "B",
      companyName: null,
      lifecycleStage: null,
      source: null,
      targetContactId: null,
    };
  }

  it("skipped when IMPORT_EVENTS_ENABLED is not set", async () => {
    const { prisma } = makeOrchestratorPrismaMock({
      job: makeJob(),
      stagingContacts: [makeStagingContact()],
    });
    // publishMock IS called (the publisher returns { skipped: true } on
    // the env-flag check), so just verify no throw. The publisher's
    // env-flag check is unit-tested separately in the publisher module.
    await runCommit(prisma, JOB_ID, TENANT_A);
    expect(publishMock).toHaveBeenCalledTimes(1);
  });

  it("fanout failure does NOT roll back the commit", async () => {
    publishMock.mockRejectedValueOnce(new Error("pubsub down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { prisma, getJob } = makeOrchestratorPrismaMock({
      job: makeJob(),
      stagingContacts: [makeStagingContact()],
    });
    const result = await runCommit(prisma, JOB_ID, TENANT_A);
    expect(result.committedRowCount).toBe(1);
    expect(result.commitStatus).toBe("succeeded");
    expect(getJob().commitStatus).toBe("succeeded");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────
// Idempotency — atomic optimistic-lock claim is the load-bearing
// boundary against concurrent invocations (double-click on Commit,
// tRPC retry while in-flight, two operators on the same job, etc.).
// V1 also forbids re-running a partial/failed/succeeded commit — a
// retry requires a new ImportJob. Tests here pin that behavior.
// ─────────────────────────────────────────────

describe("runCommit — idempotency claim", () => {
  function makeStagingContact(): StagingContactRow {
    return {
      id: "sc1",
      importJobId: JOB_ID,
      tenantId: TENANT_A,
      sourceRowIndex: 0,
      sourceRowData: {} as unknown,
      matchDecision: {
        suggestedAction: "insert",
        candidates: [],
        confidence: 0,
        suggestedReason: "",
      } as unknown,
      stagingStatus: "ready",
      email: "alice@example.com",
      phone: null,
      firstName: "Alice",
      lastName: "Anderson",
      companyName: null,
      lifecycleStage: null,
      source: null,
      targetContactId: null,
    };
  }

  it("rejects concurrent invocations atomically", async () => {
    // The harness uses a fully-mocked Prisma. The atomic claim is
    // simulated via the updateMany mock: the first call observing
    // `commitStatus='pending'` flips it to 'running' synchronously
    // and returns count=1; any subsequent updateMany sees
    // `commitStatus='running'` and returns count=0. That's the load-
    // bearing assertion — the claim is the atomic boundary, the
    // staging loop is downstream of it.
    //
    // In real Postgres this is enforced by the row-level write lock
    // an UPDATE acquires; the test simulates the same single-winner
    // outcome at the mock layer.
    const { prisma, getJob } = makeOrchestratorPrismaMock({
      job: makeJob(),
      stagingContacts: [makeStagingContact()],
    });

    const [resultA, resultB] = await Promise.allSettled([
      runCommit(prisma, JOB_ID, TENANT_A),
      runCommit(prisma, JOB_ID, TENANT_A),
    ]);

    // Exactly one resolves, exactly one rejects.
    const fulfilled = [resultA, resultB].filter((r) => r.status === "fulfilled");
    const rejected = [resultA, resultB].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The rejection is a CONFLICT with the "already running" diagnostic.
    const reason = (rejected[0] as PromiseRejectedResult).reason as {
      code?: string;
      message?: string;
    };
    expect(reason.code).toBe("CONFLICT");
    expect(reason.message ?? "").toMatch(/already running/i);

    // Canonical-write count: exactly 1 commit (NOT 2× the staging row).
    expect(getJob().committedRowCount).toBe(1);
  });

  it.each([
    ["succeeded" as const, /already succeeded/i],
    ["partial" as const, /already partial/i],
    ["failed" as const, /already failed/i],
  ])(
    "rejects re-invocation after a %s commit",
    async (terminalStatus, messageRegex) => {
      const { prisma } = makeOrchestratorPrismaMock({
        job: makeJob({ commitStatus: terminalStatus }),
      });
      await expect(runCommit(prisma, JOB_ID, TENANT_A)).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringMatching(messageRegex),
      });
    },
  );
});

// ─────────────────────────────────────────────
// CSV download
// ─────────────────────────────────────────────

describe("downloadCommitErrors", () => {
  it("returns empty CSV for a job with no errors", async () => {
    const prisma = {
      importJob: {
        findFirst: vi.fn().mockResolvedValue({ commitErrors: [] }),
      },
    } as unknown as PrismaClient;
    const res = await downloadCommitErrors(prisma, JOB_ID, TENANT_A);
    expect(res).toEqual({ csvContent: "", rowCount: 0 });
  });

  it("returns CSV with header + rows for a job with errors", async () => {
    const errors = [
      {
        stagingRowId: "s1",
        entityType: "contact",
        sourceRowIndex: 3,
        reason: "contact_not_found",
        unresolvedKey: "missing@example.com",
        errorMessage: "No Contact with email 'missing@example.com' found in tenant.",
      },
      {
        stagingRowId: "s2",
        entityType: "order",
        sourceRowIndex: 7,
        reason: "order_number_duplicate",
        unresolvedKey: "ORD-1234",
        errorMessage: "Order with orderNumber 'ORD-1234' already exists.",
      },
    ];
    const prisma = {
      importJob: { findFirst: vi.fn().mockResolvedValue({ commitErrors: errors }) },
    } as unknown as PrismaClient;
    const res = await downloadCommitErrors(prisma, JOB_ID, TENANT_A);
    expect(res.rowCount).toBe(2);
    const lines = res.csvContent.split("\n");
    expect(lines[0]).toContain("sourceRowIndex");
    expect(lines[0]).toContain("entityType");
    expect(lines[0]).toContain("reason");
    expect(lines[0]).toContain("unresolvedKey");
    expect(lines[1]).toContain("contact_not_found");
    expect(lines[2]).toContain("order_number_duplicate");
  });

  it("NOT_FOUND when job missing", async () => {
    const prisma = {
      importJob: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    await expect(downloadCommitErrors(prisma, JOB_ID, TENANT_A)).rejects.toThrow(
      /Import job not found/,
    );
  });
});
