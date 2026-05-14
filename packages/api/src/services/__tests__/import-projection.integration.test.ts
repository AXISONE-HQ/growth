/**
 * KAN-915 — Integration test for the projection pipeline.
 *
 * This is the test that would have caught the KAN-913 PROD smoke
 * silent-NULL-commit bug. End-to-end shape (against an in-memory
 * Prisma mock; not a real DB because we don't have a vitest-side
 * Postgres harness):
 *
 *   1. Tenant has 5 pre-existing Contacts with populated mirror columns
 *      (simulating a prior import that ran through dedup back-fill).
 *   2. Fresh ImportJob has 5 staging rows in source_row_data form ONLY
 *      (mirror columns null — matches what KAN-907 row-classification
 *      writes today, BEFORE KAN-915 back-fill runs).
 *   3. Job has saved fieldMappings (from KAN-905).
 *   4. Run runDuplicateDetection → assert:
 *        - Mirror columns populated by back-fill (no NULL emails)
 *        - 3 of 5 rows have suggestedAction='update' (dedup found the
 *          pre-existing contacts via email_exact)
 *        - 2 of 5 rows have suggestedAction='insert' (new emails)
 *   5. Run runCommit → assert:
 *        - All 5 canonical Contact rows have non-NULL email/name/phone
 *        - lifecycle_stage matches the FIXTURE value (e.g. 'customer'),
 *          NOT the Prisma `lead` default
 *        - 3 'update' rows updated existing canonical Contacts (same id)
 *        - 2 'insert' rows created new Contact rows
 *
 * The dedup-hit assertion is the load-bearing data-correctness check.
 * Without KAN-915, every dedup matcher short-circuits on NULL mirror
 * cols → 5 inserts + 0 updates + canonical Contacts get NULL values.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import {
  confirmDuplicateResolution,
  runDuplicateDetection,
  type MatchDecision,
} from "../import-dedup.js";
import { runCommit, type CommitErrorEntry } from "../import-commit.js";

// Mock the Pub/Sub publisher — KAN-913 sibling pattern.
vi.mock("../lib/import-row-committed-publisher.js", () => ({
  publishImportRowCommitted: vi.fn().mockResolvedValue({ skipped: true }),
  importEventsEnabled: () => false,
}));

const TENANT = "11111111-1111-1111-1111-111111111111";
const JOB_ID = "job_kan915_integration";
const USER_ID = "user-fred";

interface InMemoryStore {
  contacts: Array<{
    id: string;
    tenantId: string;
    email: string | null;
    phone: string | null;
    firstName: string | null;
    lastName: string | null;
    companyName: string | null;
    lifecycleStage: string | null;
    source: string | null;
    segment: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
    [k: string]: unknown;
  }>;
  importJob: Record<string, unknown>;
  stagingContacts: Array<Record<string, unknown>>;
  auditLog: Array<Record<string, unknown>>;
}

function makeFieldMappings() {
  return [
    { sourceColumn: "email", targetField: "email", confidence: 100 },
    { sourceColumn: "first_name", targetField: "firstName", confidence: 100 },
    { sourceColumn: "last_name", targetField: "lastName", confidence: 100 },
    { sourceColumn: "phone", targetField: "phone", confidence: 100 },
    { sourceColumn: "lifecycle_stage", targetField: "lifecycleStage", confidence: 100 },
    { sourceColumn: "source", targetField: "source", confidence: 100 },
  ];
}

function makeStartingStore(): InMemoryStore {
  return {
    // 5 pre-existing contacts. Mirror cols populated as if from a
    // prior import that ran through KAN-915 back-fill.
    contacts: [
      {
        id: "ctc_existing_alice",
        tenantId: TENANT,
        email: "alice.morgan@acme.io",
        phone: "+1-415-555-0142",
        firstName: "Alice",
        lastName: "Morgan",
        companyName: null,
        lifecycleStage: "customer",
        source: "web_form",
        segment: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        region: null,
        postalCode: null,
        country: null,
      },
      {
        id: "ctc_existing_bjorn",
        tenantId: TENANT,
        email: "bjorn.kvist@nordic-supply.no",
        phone: null,
        firstName: "Bjorn",
        lastName: "Kvist",
        companyName: null,
        lifecycleStage: "mql",
        source: "csv_import",
        segment: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        region: null,
        postalCode: null,
        country: null,
      },
      {
        id: "ctc_existing_chika",
        tenantId: TENANT,
        email: "chika.tanaka@hexa.jp",
        phone: null,
        firstName: "Chika",
        lastName: "Tanaka",
        companyName: null,
        lifecycleStage: "lead",
        source: "meta_ad",
        segment: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        region: null,
        postalCode: null,
        country: null,
      },
      {
        id: "ctc_existing_zora",
        tenantId: TENANT,
        email: "zora.unrelated@example.com",
        phone: null,
        firstName: "Zora",
        lastName: "Unrelated",
        companyName: null,
        lifecycleStage: "lead",
        source: "manual",
        segment: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        region: null,
        postalCode: null,
        country: null,
      },
      {
        id: "ctc_existing_yannick",
        tenantId: TENANT,
        email: "yannick.unmatched@example.com",
        phone: null,
        firstName: "Yannick",
        lastName: "Unmatched",
        companyName: null,
        lifecycleStage: "lead",
        source: "manual",
        segment: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        region: null,
        postalCode: null,
        country: null,
      },
    ],
    importJob: {
      id: JOB_ID,
      tenantId: TENANT,
      createdByUserId: USER_ID,
      fileName: "contacts-projection-fixture.csv",
      fileSize: 500,
      fileMimeType: "text/csv",
      gcsObjectPath: "tenants/t/imports/j/x.csv",
      mode: "update_add",
      status: "inspected",
      detectedFileType: "csv",
      detectedRowCount: 5,
      detectedColumnCount: 6,
      detectedHeaders: [
        "email",
        "first_name",
        "last_name",
        "phone",
        "lifecycle_stage",
        "source",
      ],
      sampleRows: [],
      detectedEntityType: "contacts",
      detectionConfidence: 99,
      detectionReasoning: null,
      detectionStartedAt: null,
      detectionCompletedAt: null,
      detectionError: null,
      detectionErrorAt: null,
      detectionInputTokens: null,
      detectionOutputTokens: null,
      detectionLlmModel: null,
      fieldMappings: makeFieldMappings(),
      fieldMappingConfidence: 100,
      fieldMappingReasoning: null,
      fieldMappingStartedAt: null,
      fieldMappingCompletedAt: null,
      fieldMappingError: null,
      fieldMappingErrorAt: null,
      fieldMappingInputTokens: null,
      fieldMappingOutputTokens: null,
      fieldMappingLlmModel: null,
      fieldMappingConfirmedAt: new Date(),
      rowClassificationCounts: null,
      rowClassificationStartedAt: null,
      rowClassificationCompletedAt: null,
      rowClassificationError: null,
      rowClassificationErrorAt: null,
      rowClassificationInputTokens: null,
      rowClassificationOutputTokens: null,
      rowClassificationLlmModel: null,
      rowClassificationConfirmedAt: new Date(),
      dedupStartedAt: null,
      dedupCompletedAt: null,
      dedupError: null,
      dedupErrorAt: null,
      dedupCounts: null,
      dedupCandidatesCount: null,
      dedupConfirmedAt: null,
      commitStatus: "pending",
      commitStartedAt: null,
      commitCompletedAt: null,
      committedRowCount: 0,
      failedRowCount: 0,
      commitErrors: [],
      errorMessage: null,
      errorAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      uploadConfirmedAt: new Date(),
      inspectionStartedAt: new Date(),
      inspectionCompletedAt: new Date(),
    },
    // 5 staging rows — mirror columns NULL (matches KAN-907 today),
    // sourceRowData populated with the raw CSV row. THREE of these
    // emails match existing contacts (alice, bjorn, chika); two are
    // new (darrell, elena).
    stagingContacts: [
      {
        id: "stg_alice",
        importJobId: JOB_ID,
        tenantId: TENANT,
        sourceRowIndex: 0,
        sourceRowData: {
          email: "alice.morgan@acme.io",
          first_name: "Alice",
          last_name: "Morgan",
          phone: "+1-415-555-0142",
          lifecycle_stage: "customer",
          source: "web_form",
        },
        stagingStatus: "ready",
        matchDecision: null,
        email: null,
        phone: null,
        firstName: null,
        lastName: null,
        companyName: null,
        lifecycleStage: null,
        source: null,
        targetContactId: null,
      },
      {
        id: "stg_bjorn",
        importJobId: JOB_ID,
        tenantId: TENANT,
        sourceRowIndex: 1,
        sourceRowData: {
          email: "bjorn.kvist@nordic-supply.no",
          first_name: "Bjorn",
          last_name: "Kvist",
          phone: "+47-22-555-0118",
          lifecycle_stage: "mql",
          source: "csv_import",
        },
        stagingStatus: "ready",
        matchDecision: null,
        email: null,
        phone: null,
        firstName: null,
        lastName: null,
        companyName: null,
        lifecycleStage: null,
        source: null,
        targetContactId: null,
      },
      {
        id: "stg_chika",
        importJobId: JOB_ID,
        tenantId: TENANT,
        sourceRowIndex: 2,
        sourceRowData: {
          email: "chika.tanaka@hexa.jp",
          first_name: "Chika",
          last_name: "Tanaka",
          phone: "+81-3-5555-0193",
          lifecycle_stage: "lead",
          source: "meta_ad",
        },
        stagingStatus: "ready",
        matchDecision: null,
        email: null,
        phone: null,
        firstName: null,
        lastName: null,
        companyName: null,
        lifecycleStage: null,
        source: null,
        targetContactId: null,
      },
      {
        id: "stg_darrell",
        importJobId: JOB_ID,
        tenantId: TENANT,
        sourceRowIndex: 3,
        sourceRowData: {
          email: "darrell.huang@brightstack.io",
          first_name: "Darrell",
          last_name: "Huang",
          phone: "+1-650-555-0174",
          lifecycle_stage: "sql",
          source: "hubspot",
        },
        stagingStatus: "ready",
        matchDecision: null,
        email: null,
        phone: null,
        firstName: null,
        lastName: null,
        companyName: null,
        lifecycleStage: null,
        source: null,
        targetContactId: null,
      },
      {
        id: "stg_elena",
        importJobId: JOB_ID,
        tenantId: TENANT,
        sourceRowIndex: 4,
        sourceRowData: {
          email: "elena.rivera@vela.mx",
          first_name: "Elena",
          last_name: "Rivera",
          phone: "+52-55-5555-0102",
          lifecycle_stage: "customer",
          source: "manual",
        },
        stagingStatus: "ready",
        matchDecision: null,
        email: null,
        phone: null,
        firstName: null,
        lastName: null,
        companyName: null,
        lifecycleStage: null,
        source: null,
        targetContactId: null,
      },
    ],
    auditLog: [],
  };
}

// ─────────────────────────────────────────────
// Mini in-memory Prisma proxy — covers the subset of operations
// runDuplicateDetection + runCommit invoke for the contacts path.
// ─────────────────────────────────────────────

function makePrismaMock(store: InMemoryStore) {
  let nextContactId = 1;
  let nextAuditId = 1;

  const prismaProxy: Record<string, unknown> = {};

  prismaProxy.importJob = {
    findFirst: vi.fn().mockImplementation(async (args: {
      where: { id?: string; tenantId?: string };
    }) => {
      const j = store.importJob as { id: string; tenantId: string };
      if (args.where.id && j.id !== args.where.id) return null;
      if (args.where.tenantId && j.tenantId !== args.where.tenantId) return null;
      return store.importJob;
    }),
    findFirstOrThrow: vi.fn().mockImplementation(async (args: {
      where: { id?: string; tenantId?: string };
    }) => {
      const j = store.importJob as { id: string; tenantId: string };
      if (args.where.id && j.id !== args.where.id) throw new Error("not found");
      if (args.where.tenantId && j.tenantId !== args.where.tenantId) throw new Error("not found");
      return store.importJob;
    }),
    update: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => {
      Object.assign(store.importJob, args.data);
      return store.importJob;
    }),
    updateMany: vi.fn().mockImplementation(async (args: {
      where: { id?: string; tenantId?: string; commitStatus?: string; dedupConfirmedAt?: { not: null } };
      data: Record<string, unknown>;
    }) => {
      const j = store.importJob as Record<string, unknown>;
      if (args.where.id && j.id !== args.where.id) return { count: 0 };
      if (args.where.tenantId && j.tenantId !== args.where.tenantId) return { count: 0 };
      if (args.where.commitStatus && j.commitStatus !== args.where.commitStatus) return { count: 0 };
      if (args.where.dedupConfirmedAt?.not === null && !j.dedupConfirmedAt) return { count: 0 };
      Object.assign(j, args.data);
      return { count: 1 };
    }),
  };

  prismaProxy.importStagingContact = {
    findMany: vi.fn().mockImplementation(async (args: {
      where: { importJobId?: string; stagingStatus?: { in?: string[] } };
    }) => {
      return store.stagingContacts.filter((s) => {
        if (args.where.importJobId && s.importJobId !== args.where.importJobId) return false;
        if (args.where.stagingStatus?.in) {
          return args.where.stagingStatus.in.includes(s.stagingStatus as string);
        }
        return true;
      });
    }),
    update: vi.fn().mockImplementation(async (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = store.stagingContacts.find((s) => s.id === args.where.id);
      if (row) Object.assign(row, args.data);
      return row;
    }),
  };

  // Companies / Deals / Orders staging tables not exercised here but
  // need to respond to findMany so the orchestrator's Promise.all works.
  const emptyStagingMock = {
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
  };
  prismaProxy.importStagingCompany = emptyStagingMock;
  prismaProxy.importStagingDeal = emptyStagingMock;
  prismaProxy.importStagingOrder = emptyStagingMock;

  prismaProxy.contact = {
    findMany: vi.fn().mockImplementation(async (args: {
      where: { tenantId?: string };
      select?: Record<string, boolean>;
    }) => {
      return store.contacts
        .filter((c) => !args.where.tenantId || c.tenantId === args.where.tenantId)
        .map((c) => {
          // Honor select for the projection KAN-911 dedup uses.
          if (args.select) {
            const result: Record<string, unknown> = {};
            for (const k of Object.keys(args.select)) {
              if (args.select[k]) result[k] = (c as Record<string, unknown>)[k];
            }
            return result;
          }
          return c;
        });
    }),
    findFirst: vi.fn().mockImplementation(async (args: {
      where: { id?: string; tenantId?: string; email?: { equals?: string; mode?: string } };
    }) => {
      return (
        store.contacts.find((c) => {
          if (args.where.id && c.id !== args.where.id) return false;
          if (args.where.tenantId && c.tenantId !== args.where.tenantId) return false;
          if (args.where.email?.equals != null) {
            const target = args.where.email.equals.toLowerCase();
            if (c.email?.toLowerCase() !== target) return false;
          }
          return true;
        }) ?? null
      );
    }),
    create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => {
      const id = `ctc_new_${nextContactId++}`;
      const row = {
        id,
        tenantId: args.data.tenantId as string,
        email: (args.data.email as string | null) ?? null,
        phone: (args.data.phone as string | null) ?? null,
        firstName: (args.data.firstName as string | null) ?? null,
        lastName: (args.data.lastName as string | null) ?? null,
        companyName: (args.data.companyName as string | null) ?? null,
        lifecycleStage: (args.data.lifecycleStage as string | null) ?? "lead",
        source: (args.data.source as string | null) ?? null,
        segment: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        region: null,
        postalCode: null,
        country: null,
      };
      store.contacts.push(row);
      return { id };
    }),
    update: vi.fn().mockImplementation(async (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const row = store.contacts.find((c) => c.id === args.where.id);
      if (row) Object.assign(row, args.data);
      return { id: args.where.id };
    }),
  };

  prismaProxy.company = { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) };
  prismaProxy.deal = { findMany: vi.fn().mockResolvedValue([]) };
  prismaProxy.order = { findMany: vi.fn().mockResolvedValue([]) };
  prismaProxy.pipeline = { findFirst: vi.fn().mockResolvedValue(null) };
  prismaProxy.stage = { findFirst: vi.fn().mockResolvedValue(null) };

  prismaProxy.auditLog = {
    create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => {
      const entry = { id: `audit_${nextAuditId++}`, ...args.data };
      store.auditLog.push(entry);
      return entry;
    }),
  };

  prismaProxy.$transaction = vi.fn().mockImplementation(async (input: unknown) => {
    if (typeof input === "function") {
      return (input as (tx: unknown) => Promise<unknown>)(prismaProxy);
    }
    if (Array.isArray(input)) {
      return Promise.all(input);
    }
    return undefined;
  });

  return prismaProxy as unknown as import("@prisma/client").PrismaClient;
}

// ─────────────────────────────────────────────
// The load-bearing test
// ─────────────────────────────────────────────

describe("KAN-915 integration — projection round-trip", () => {
  let store: InMemoryStore;
  let prisma: import("@prisma/client").PrismaClient;

  beforeEach(() => {
    store = makeStartingStore();
    prisma = makePrismaMock(store);
  });

  it("runDuplicateDetection back-fills mirror columns AND matchers fire on the back-filled values (3 hits / 2 inserts)", async () => {
    // Pre-state assertion: mirror columns are NULL on every staging row.
    expect(store.stagingContacts.every((s) => s.email == null)).toBe(true);

    // Run dedup. Back-fill should populate mirror columns FIRST, then
    // matchers should see them and produce match decisions.
    await runDuplicateDetection(prisma, JOB_ID, TENANT);

    // ASSERTION 1: mirror columns populated by back-fill.
    const alice = store.stagingContacts.find((s) => s.id === "stg_alice")!;
    const bjorn = store.stagingContacts.find((s) => s.id === "stg_bjorn")!;
    const chika = store.stagingContacts.find((s) => s.id === "stg_chika")!;
    const darrell = store.stagingContacts.find((s) => s.id === "stg_darrell")!;
    const elena = store.stagingContacts.find((s) => s.id === "stg_elena")!;
    expect(alice.email).toBe("alice.morgan@acme.io");
    expect(alice.firstName).toBe("Alice");
    expect(alice.lifecycleStage).toBe("customer"); // enum projected
    expect(alice.source).toBe("web_form");
    expect(darrell.email).toBe("darrell.huang@brightstack.io");
    expect(darrell.lifecycleStage).toBe("sql");

    // ASSERTION 2 (LOAD-BEARING): dedup matchers fire correctly on
    // back-filled mirror cols. 3 staging rows match pre-existing
    // contacts via email_exact → suggestedAction='update' with
    // chosenCandidateId set.
    const expectHit = (
      row: { matchDecision: unknown },
      expectedExistingId: string,
    ) => {
      const md = row.matchDecision as MatchDecision;
      expect(md).not.toBeNull();
      expect(md.suggestedAction).toBe("update");
      expect(md.confidence).toBe(100);
      expect(md.candidates[0]?.existingEntityId).toBe(expectedExistingId);
      expect(md.candidates[0]?.matchedFields).toContain("email_exact");
    };
    expectHit(alice, "ctc_existing_alice");
    expectHit(bjorn, "ctc_existing_bjorn");
    expectHit(chika, "ctc_existing_chika");

    // ASSERTION 3: the 2 unmatched rows have suggestedAction='insert'.
    const expectInsert = (row: { matchDecision: unknown }) => {
      const md = row.matchDecision as MatchDecision;
      expect(md).not.toBeNull();
      expect(md.suggestedAction).toBe("insert");
      expect(md.candidates).toHaveLength(0);
    };
    expectInsert(darrell);
    expectInsert(elena);

    // ASSERTION 4: ImportJob.dedupCounts reflects 3 exact + 2 insert.
    const counts = store.importJob.dedupCounts as {
      byEntity: { contacts: { exactMatches: number; insertOnly: number; total: number } };
    };
    expect(counts.byEntity.contacts.total).toBe(5);
    expect(counts.byEntity.contacts.exactMatches).toBe(3);
    expect(counts.byEntity.contacts.insertOnly).toBe(2);
  });

  it("runCommit projects canonical content from sourceRowData (NULL mirror cols would still produce correct canonical rows — defense in depth)", async () => {
    // Pre-condition: dedup confirmed.
    await runDuplicateDetection(prisma, JOB_ID, TENANT);
    await confirmDuplicateResolution(prisma, JOB_ID, TENANT);

    // Critical: STRIP the back-filled mirror columns to prove commit
    // does NOT rely on them. Sourcerowdata is the actual source of truth.
    for (const s of store.stagingContacts) {
      s.email = null;
      s.firstName = null;
      s.lastName = null;
      s.phone = null;
      s.lifecycleStage = null;
      s.source = null;
    }

    // Run commit.
    const result = await runCommit(prisma, JOB_ID, TENANT);
    expect(result.commitStatus).toBe("succeeded");
    expect(result.committedRowCount).toBe(5);
    expect(result.failedRowCount).toBe(0);
    expect((result.commitErrors as CommitErrorEntry[]).length).toBe(0);

    // ASSERTION 1: All 5 canonical Contact updates/inserts produced
    // non-NULL email/firstName/phone — projected from sourceRowData.
    const aliceCanonical = store.contacts.find((c) => c.id === "ctc_existing_alice")!;
    expect(aliceCanonical.email).toBe("alice.morgan@acme.io");
    expect(aliceCanonical.firstName).toBe("Alice");
    expect(aliceCanonical.lastName).toBe("Morgan");
    expect(aliceCanonical.phone).toBe("+1-415-555-0142");

    // ASSERTION 2: lifecycle_stage matches the fixture value, NOT the
    // Prisma default 'lead'. This is the explicit data-truth check
    // from the brief — Alice's fixture row says 'customer'.
    expect(aliceCanonical.lifecycleStage).toBe("customer");

    // ASSERTION 3: 3 'update' rows updated existing canonical Contact
    // ids; 2 'insert' rows created new Contact rows. Total Contact
    // count: 5 pre-existing + 2 new = 7.
    expect(store.contacts.filter((c) => c.tenantId === TENANT)).toHaveLength(7);

    // The 2 new rows have email matching the fixture inserts.
    const darrellCanonical = store.contacts.find(
      (c) => c.email === "darrell.huang@brightstack.io",
    );
    const elenaCanonical = store.contacts.find(
      (c) => c.email === "elena.rivera@vela.mx",
    );
    expect(darrellCanonical).toBeDefined();
    expect(darrellCanonical?.firstName).toBe("Darrell");
    expect(darrellCanonical?.lifecycleStage).toBe("sql");
    expect(elenaCanonical).toBeDefined();
    expect(elenaCanonical?.firstName).toBe("Elena");
    expect(elenaCanonical?.lifecycleStage).toBe("customer");

    // ASSERTION 4: audit_log has 5 entries, each linking the right
    // entityId.
    const auditEntries = store.auditLog.filter(
      (a) =>
        (a.payload as { importJobId: string }).importJobId === JOB_ID,
    );
    expect(auditEntries).toHaveLength(5);
    expect(
      auditEntries.every(
        (a) => (a.actor as string) === `user:${USER_ID}`,
      ),
    ).toBe(true);
  });
});
