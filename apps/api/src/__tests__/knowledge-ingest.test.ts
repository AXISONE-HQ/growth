/**
 * Tests for KAN-707 PR A — knowledge ingestion service contract + per-tenant
 * queue depth + tenant-scoped polling + push subscriber OIDC verification.
 *
 * Pure unit-level coverage. The PubSub publisher uses InMemoryPubSubClient
 * via NODE_ENV=test (set by the connectors vitest config), so publish() is a
 * no-op append. PR B's integration tests will exercise the real Cloud
 * Pub/Sub round-trip.
 */
import { describe, it, expect, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  IngestionPathEnum,
  IngestRequestSchema,
  PER_TENANT_INGEST_QUEUE_DEPTH_LIMIT,
} from "@growth/shared";

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifyIdToken: vi.fn() }),
}));
vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(),
  getApps: () => [],
  applicationDefault: () => ({}),
}));

describe("knowledge-ingest contract types", () => {
  it("IngestionPath enum is the 3-value subset of KnowledgeSourceType", () => {
    expect([...IngestionPathEnum.options].sort()).toEqual(["document", "qa_pair", "url"]);
  });

  it("IngestRequest URL path requires HTTPS", () => {
    const r = IngestRequestSchema.safeParse({
      path: "url",
      sourceUrl: "http://example.com",
      crawlScope: "page",
    });
    expect(r.success).toBe(false);
  });

  it("IngestRequest URL path accepts HTTPS with default crawlScope", () => {
    const r = IngestRequestSchema.safeParse({
      path: "url",
      sourceUrl: "https://example.com",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.path === "url" && r.data.crawlScope).toBe("page");
  });

  it("IngestRequest document path requires uploadedFileRef + originalFileName", () => {
    const r1 = IngestRequestSchema.safeParse({ path: "document", uploadedFileRef: "" });
    expect(r1.success).toBe(false);
    const r2 = IngestRequestSchema.safeParse({
      path: "document",
      uploadedFileRef: "growth-knowledge-uploads/t1/file.pdf",
      originalFileName: "file.pdf",
    });
    expect(r2.success).toBe(true);
  });

  it("IngestRequest qa_pair requires both question and answer", () => {
    const r1 = IngestRequestSchema.safeParse({ path: "qa_pair", question: "Q?" });
    expect(r1.success).toBe(false);
    const r2 = IngestRequestSchema.safeParse({
      path: "qa_pair",
      question: "What is X?",
      answer: "X is Y",
    });
    expect(r2.success).toBe(true);
  });

  it("IngestRequest qa_pair rejects empty answer", () => {
    const r = IngestRequestSchema.safeParse({
      path: "qa_pair",
      question: "What is X?",
      answer: "",
    });
    expect(r.success).toBe(false);
  });

  it("PER_TENANT_INGEST_QUEUE_DEPTH_LIMIT is 100", () => {
    expect(PER_TENANT_INGEST_QUEUE_DEPTH_LIMIT).toBe(100);
  });
});

describe("knowledge-ingest tRPC procedures", () => {
  // Build a tiny tRPC caller with a mocked prisma context.
  async function buildCaller(opts: {
    tenantId: string;
    inFlightCount: number;
    existingIngestion?: { id: string; sourceTenantId: string } | null;
  }) {
    const { router, protectedProcedure } = await import("../trpc.js");
    const { appRouter } = await import("../router.js");

    const ctx = {
      prisma: {
        knowledgeIngestion: {
          count: vi.fn().mockResolvedValue(opts.inFlightCount),
          create: vi.fn().mockResolvedValue({ id: "33333333-3333-3333-3333-333333333333", status: "pending" }),
          findFirst: vi.fn().mockImplementation(({ where }: any) => {
            if (
              opts.existingIngestion &&
              where.id === opts.existingIngestion.id &&
              where.source.tenantId === opts.existingIngestion.sourceTenantId
            ) {
              return Promise.resolve({
                id: opts.existingIngestion.id,
                knowledgeSourceId: "44444444-4444-4444-4444-444444444444",
                status: "indexed",
                startedAt: new Date("2026-04-28T01:00:00Z"),
                completedAt: new Date("2026-04-28T01:01:00Z"),
                urlsDiscovered: 0,
                urlsIndexed: 0,
                source: { id: "44444444-4444-4444-4444-444444444444", errorMessage: null },
              });
            }
            return Promise.resolve(null);
          }),
        },
        knowledgeSource: {
          upsert: vi.fn().mockResolvedValue({ id: "44444444-4444-4444-4444-444444444444", tenantId: opts.tenantId }),
        },
        $transaction: vi.fn(),
      },
      tenantId: opts.tenantId,
      firebaseUser: { uid: "uid-test", email: "fred@axisone.ca" },
    } as any;

    return appRouter.createCaller(ctx);
  }

  const TENANT_A = "11111111-1111-1111-1111-111111111111";
  const TENANT_B = "22222222-2222-2222-2222-222222222222";

  it("queue depth >= limit → TOO_MANY_REQUESTS", async () => {
    const caller = await buildCaller({ tenantId: TENANT_A, inFlightCount: 100 });
    await expect(
      caller.knowledgeIngest.request({
        path: "qa_pair",
        question: "Q?",
        answer: "A",
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("queue depth < limit → request succeeds", async () => {
    const caller = await buildCaller({ tenantId: TENANT_A, inFlightCount: 99 });
    const out = await caller.knowledgeIngest.request({
      path: "qa_pair",
      question: "What is X?",
      answer: "X is Y",
    });
    expect(out.status).toBe("pending");
    expect(out.ingestionId).toBeTruthy();
    expect(out.sourceId).toBeTruthy();
  });

  it("status query — same-tenant lookup returns the row", async () => {
    const caller = await buildCaller({
      tenantId: TENANT_A,
      inFlightCount: 0,
      existingIngestion: { id: "33333333-3333-3333-3333-333333333333", sourceTenantId: TENANT_A },
    });
    const out = await caller.knowledgeIngest.status({ ingestionId: "33333333-3333-3333-3333-333333333333" });
    expect(out.status).toBe("indexed");
    expect(out.ingestionId).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("status query — cross-tenant lookup returns NOT_FOUND, never the other tenant's status", async () => {
    // Tenant A's ingestion exists; tenant B asks for it. Mock's findFirst
    // applies the where-filter (id + source.tenantId), so B's where won't match.
    const caller = await buildCaller({
      tenantId: TENANT_B,
      inFlightCount: 0,
      existingIngestion: { id: "33333333-3333-3333-3333-333333333333", sourceTenantId: TENANT_A },
    });
    await expect(
      caller.knowledgeIngest.status({ ingestionId: "33333333-3333-3333-3333-333333333333" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
