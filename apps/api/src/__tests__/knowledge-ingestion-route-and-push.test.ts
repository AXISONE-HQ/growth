/**
 * KAN-827 sub-cohort 6 — HTTP intake route + Pub/Sub push subscriber tests.
 *
 * Combined file because both modules are thin Hono apps that share auth/
 * envelope-handling concerns. Mocks: Firebase auth, Prisma, OIDC verify,
 * publisher, ingestSource. The 3 critical surfaces:
 *   1. Auth check fires (Fred's flag from sub-cohort 2 review) — missing or
 *      invalid Bearer → 401, NOT silent persist
 *   2. Malformed multipart parseBody returns clean 400 (Fred's flag)
 *   3. OIDC reject on push subscriber returns 401 (canonical helper invoked)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────
// Module mocks — vi.hoisted lets factories reference these names since
// vi.mock is itself hoisted to the top of the file before imports.
// ─────────────────────────────────────────────

const {
  verifyIdTokenMock,
  knowledgeSourceCreateMock,
  verifyPubsubOidcMock,
  publishKnowledgeSourceIngestedMock,
  ingestSourceMock,
} = vi.hoisted(() => ({
  verifyIdTokenMock: vi.fn(),
  knowledgeSourceCreateMock: vi.fn(async (args: { data: { id: string } }) => ({ id: args.data.id })),
  verifyPubsubOidcMock: vi.fn(),
  publishKnowledgeSourceIngestedMock: vi.fn(async () => ({ messageId: "test-msg-id" })),
  ingestSourceMock: vi.fn(),
}));

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifyIdToken: verifyIdTokenMock }),
}));
vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(),
  getApps: () => [{}],
  applicationDefault: vi.fn(),
}));
vi.mock("../prisma.js", () => ({
  prisma: { knowledgeSource: { create: knowledgeSourceCreateMock } },
}));
vi.mock("../lib/oidc-pubsub-verify.js", () => ({
  verifyPubsubOidc: (...args: unknown[]) => (verifyPubsubOidcMock as (...a: unknown[]) => unknown)(...args),
}));
vi.mock(
  "../../../../packages/api/src/services/knowledge-source-ingest-publisher.js",
  () => ({
    publishKnowledgeSourceIngested: (...args: unknown[]) => (publishKnowledgeSourceIngestedMock as (...a: unknown[]) => unknown)(...args),
  }),
);
vi.mock(
  "../../../../packages/api/src/services/knowledge-ingestion-service.js",
  () => ({
    ingestSource: (...args: unknown[]) => (ingestSourceMock as (...a: unknown[]) => unknown)(...args),
  }),
);

import { knowledgeSourcesApp } from "../routes/knowledge-sources.js";
import { knowledgeSourceIngestedPushApp } from "../subscribers/knowledge-source-ingested-push.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  verifyIdTokenMock.mockReset();
  knowledgeSourceCreateMock.mockClear();
  verifyPubsubOidcMock.mockReset();
  publishKnowledgeSourceIngestedMock.mockClear();
  ingestSourceMock.mockReset();
});

// ─────────────────────────────────────────────
// HTTP intake — POST /api/knowledge/sources
// ─────────────────────────────────────────────

describe("KAN-827 — POST /api/knowledge/sources auth + validation", () => {
  it("missing Authorization header → 401; no source written", async () => {
    const res = await knowledgeSourcesApp.request("/sources", {
      method: "POST",
      headers: { "x-tenant-id": TENANT_A, "content-type": "application/json" },
      body: JSON.stringify({ sourceType: "paste_text", category: "other", rawContent: "x" }),
    });

    expect(res.status).toBe(401);
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
    expect(knowledgeSourceCreateMock).not.toHaveBeenCalled();
  });

  it("invalid Firebase token → 401; no source written", async () => {
    verifyIdTokenMock.mockRejectedValue(new Error("token expired"));

    const res = await knowledgeSourcesApp.request("/sources", {
      method: "POST",
      headers: {
        "x-tenant-id": TENANT_A,
        "authorization": "Bearer bad-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourceType: "paste_text", category: "other", rawContent: "x" }),
    });

    expect(res.status).toBe(401);
    expect(knowledgeSourceCreateMock).not.toHaveBeenCalled();
  });

  it("missing x-tenant-id header → 400 (auth-before-tenant ordering preserved)", async () => {
    const res = await knowledgeSourcesApp.request("/sources", {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: JSON.stringify({ sourceType: "paste_text", category: "other", rawContent: "x" }),
    });

    expect(res.status).toBe(400);
    expect(knowledgeSourceCreateMock).not.toHaveBeenCalled();
  });

  it("paste_text happy path — writes knowledge_source row + publishes event + returns 202", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "test-uid" });

    const res = await knowledgeSourcesApp.request("/sources", {
      method: "POST",
      headers: {
        "x-tenant-id": TENANT_A,
        "authorization": "Bearer good-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sourceType: "paste_text",
        category: "other",
        rawContent: "Refunds: 30 days from purchase, with proof of payment.",
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; sourceId: string };
    expect(body).toMatchObject({ status: "queued" });
    expect(body.sourceId).toMatch(/[0-9a-f-]{36}/);
    expect(knowledgeSourceCreateMock).toHaveBeenCalledOnce();
    const createArgs = knowledgeSourceCreateMock.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(createArgs.data.tenantId).toBe(TENANT_A);
    expect(createArgs.data.sourceType).toBe("paste_text");
    expect(createArgs.data.status).toBe("queued");
    expect(publishKnowledgeSourceIngestedMock).toHaveBeenCalledOnce();
  });

  it("malformed JSON body → 400 (not 500) — defensive parse handling per Fred's sub-cohort 2 review flag", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "test-uid" });

    const res = await knowledgeSourcesApp.request("/sources", {
      method: "POST",
      headers: {
        "x-tenant-id": TENANT_A,
        "authorization": "Bearer good-token",
        "content-type": "application/json",
      },
      body: "{ malformed json",
    });

    expect(res.status).toBe(400);
    expect(knowledgeSourceCreateMock).not.toHaveBeenCalled();
  });

  it("invalid category enum → 400 with details", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "test-uid" });

    const res = await knowledgeSourcesApp.request("/sources", {
      method: "POST",
      headers: {
        "x-tenant-id": TENANT_A,
        "authorization": "Bearer good-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourceType: "paste_text", category: "not-a-real-category", rawContent: "x" }),
    });

    expect(res.status).toBe(400);
    expect(knowledgeSourceCreateMock).not.toHaveBeenCalled();
  });

  it("unsupported Content-Type → 415", async () => {
    verifyIdTokenMock.mockResolvedValue({ uid: "test-uid" });

    const res = await knowledgeSourcesApp.request("/sources", {
      method: "POST",
      headers: {
        "x-tenant-id": TENANT_A,
        "authorization": "Bearer good-token",
        "content-type": "text/plain",
      },
      body: "raw text body",
    });

    expect(res.status).toBe(415);
  });
});

// ─────────────────────────────────────────────
// Push subscriber — POST /pubsub/knowledge-source-ingested
// ─────────────────────────────────────────────

describe("KAN-827 — push subscriber: knowledge.source_ingested handler", () => {
  function buildPushEnvelope(event: Record<string, unknown>): { message: { data: string } } {
    return {
      message: { data: Buffer.from(JSON.stringify(event)).toString("base64") },
    };
  }

  it("OIDC verify rejects → 401; ingestSource NOT invoked", async () => {
    verifyPubsubOidcMock.mockResolvedValue(false);

    const res = await knowledgeSourceIngestedPushApp.request("/knowledge-source-ingested", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildPushEnvelope({ ignored: true })),
    });

    expect(res.status).toBe(401);
    expect(ingestSourceMock).not.toHaveBeenCalled();
  });

  it("happy path — completed dispatch → 200; ingestSource invoked with sourceId", async () => {
    verifyPubsubOidcMock.mockResolvedValue(true);
    ingestSourceMock.mockResolvedValue({ type: "completed", sourceId: "src-x", chunksWritten: 3 });

    const event = {
      eventId: "evt-1",
      eventType: "knowledge.source_ingested",
      version: "1.0",
      publishedAt: new Date().toISOString(),
      tenantId: TENANT_A,
      sourceId: "550e8400-e29b-41d4-a716-446655440000",
      sourceType: "paste_text",
      category: "other",
    };

    const res = await knowledgeSourceIngestedPushApp.request("/knowledge-source-ingested", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildPushEnvelope(event)),
    });

    expect(res.status).toBe(200);
    expect(ingestSourceMock).toHaveBeenCalledOnce();
    expect(ingestSourceMock.mock.calls[0]![1]).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("malformed envelope → 200 ack+drop (poison-message defense)", async () => {
    verifyPubsubOidcMock.mockResolvedValue(true);

    const res = await knowledgeSourceIngestedPushApp.request("/knowledge-source-ingested", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(200);
    expect(ingestSourceMock).not.toHaveBeenCalled();
  });

  it("invalid event payload (wrong eventType) → 200 ack+drop", async () => {
    verifyPubsubOidcMock.mockResolvedValue(true);

    const res = await knowledgeSourceIngestedPushApp.request("/knowledge-source-ingested", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildPushEnvelope({ eventType: "wrong.event" })),
    });

    expect(res.status).toBe(200);
    expect(ingestSourceMock).not.toHaveBeenCalled();
  });

  it("ingestSource throws unrecoverable → 500 (Pub/Sub retries → DLQ)", async () => {
    verifyPubsubOidcMock.mockResolvedValue(true);
    ingestSourceMock.mockRejectedValue(new Error("Prisma client init failed"));

    const event = {
      eventId: "evt-2",
      eventType: "knowledge.source_ingested",
      version: "1.0",
      publishedAt: new Date().toISOString(),
      tenantId: TENANT_A,
      sourceId: "550e8400-e29b-41d4-a716-446655440001",
      sourceType: "paste_text",
      category: "other",
    };

    const res = await knowledgeSourceIngestedPushApp.request("/knowledge-source-ingested", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildPushEnvelope(event)),
    });

    expect(res.status).toBe(500);
  });
});
