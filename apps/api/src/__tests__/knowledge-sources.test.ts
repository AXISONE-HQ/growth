/**
 * KAN-829 sub-cohort 1 — admin endpoint tests for knowledge sources.
 *
 * Covers GET list (cross-tenant safety + category filter), GET detail
 * (chunk_count shape + 404 on cross-tenant probe), DELETE (soft-delete
 * behavior + audit emit), GET tier-limits (vocab mapping for all 4 enum
 * values per pre-flight Decision 3).
 *
 * Mocks Firebase auth + Prisma delegates via vi.hoisted so vi.mock factories
 * can reference them (TS hoisting rules).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  verifyIdTokenMock,
  knowledgeSourceFindManyMock,
  knowledgeSourceFindFirstMock,
  knowledgeSourceUpdateMock,
  knowledgeSourceCountMock,
  knowledgeChunkCountMock,
  tenantFindUniqueMock,
  auditLogCreateMock,
} = vi.hoisted(() => ({
  verifyIdTokenMock: vi.fn(),
  knowledgeSourceFindManyMock: vi.fn(),
  knowledgeSourceFindFirstMock: vi.fn(),
  knowledgeSourceUpdateMock: vi.fn(async (args: { where: { id: string } }) => ({ id: args.where.id })),
  knowledgeSourceCountMock: vi.fn(async () => 0),
  knowledgeChunkCountMock: vi.fn(async () => 0),
  tenantFindUniqueMock: vi.fn(),
  auditLogCreateMock: vi.fn(async () => ({ id: "audit-1" })),
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
  prisma: {
    knowledgeSource: {
      findMany: knowledgeSourceFindManyMock,
      findFirst: knowledgeSourceFindFirstMock,
      update: knowledgeSourceUpdateMock,
      count: knowledgeSourceCountMock,
      // create is used by KAN-827 POST tests, not these — provided for safety.
      create: vi.fn(async (args: { data: { id: string } }) => ({ id: args.data.id })),
    },
    knowledgeChunk: { count: knowledgeChunkCountMock },
    tenant: { findUnique: tenantFindUniqueMock },
    auditLog: { create: auditLogCreateMock },
  },
}));

import { knowledgeSourcesApp } from "../routes/knowledge-sources.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const VALID_BEARER = { authorization: "Bearer good-token", "x-tenant-id": TENANT_A };

beforeEach(() => {
  verifyIdTokenMock.mockReset();
  verifyIdTokenMock.mockResolvedValue({ uid: "test-uid" });
  knowledgeSourceFindManyMock.mockReset();
  knowledgeSourceFindFirstMock.mockReset();
  knowledgeSourceUpdateMock.mockClear();
  knowledgeSourceCountMock.mockReset();
  knowledgeSourceCountMock.mockResolvedValue(0);
  knowledgeChunkCountMock.mockReset();
  knowledgeChunkCountMock.mockResolvedValue(0);
  tenantFindUniqueMock.mockReset();
  auditLogCreateMock.mockClear();
});

// ─────────────────────────────────────────────
// Test 1 — GET list returns only requesting tenant's sources (cross-tenant safety pin)
// ─────────────────────────────────────────────

describe("KAN-829 — GET /api/knowledge/sources", () => {
  it("Test 1 — list filters by tenantId; cross-tenant probe yields zero leakage (Prisma where pin)", async () => {
    knowledgeSourceFindManyMock.mockResolvedValue([
      {
        id: "src-1",
        sourceType: "paste_text",
        category: "faq",
        title: "Tenant A doc",
        status: "ready",
        fileName: null,
        fileSizeBytes: 552,
        errorDetail: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await knowledgeSourcesApp.request("/sources", {
      method: "GET",
      headers: VALID_BEARER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: Array<{ id: string; chunkCount: number }> };
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]!.id).toBe("src-1");

    // Pin: Prisma where clause includes BOTH tenantId AND soft-delete filter
    expect(knowledgeSourceFindManyMock).toHaveBeenCalledOnce();
    const findArgs = knowledgeSourceFindManyMock.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(findArgs.where.tenantId).toBe(TENANT_A);
    expect(findArgs.where.NOT).toEqual({ status: 'deleted' });
  });

  it("Test 2 — category query param filters list", async () => {
    knowledgeSourceFindManyMock.mockResolvedValue([]);

    await knowledgeSourcesApp.request("/sources?category=warranty", {
      method: "GET",
      headers: VALID_BEARER,
    });

    const findArgs = knowledgeSourceFindManyMock.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(findArgs.where.category).toBe("warranty");
    expect(findArgs.where.tenantId).toBe(TENANT_A);
  });

  it("Test 2b — invalid category returns 400 (defensive enum allowlist)", async () => {
    const res = await knowledgeSourcesApp.request("/sources?category=not-a-real-category", {
      method: "GET",
      headers: VALID_BEARER,
    });
    expect(res.status).toBe(400);
    expect(knowledgeSourceFindManyMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// Test 3 — GET detail returns source with chunkCount; 404 on cross-tenant or deleted
// ─────────────────────────────────────────────

describe("KAN-829 — GET /api/knowledge/sources/:id", () => {
  it("Test 3 — returns source with chunkCount derived from knowledge_chunk count", async () => {
    knowledgeSourceFindFirstMock.mockResolvedValue({
      id: "src-detail-1",
      sourceType: "pdf",
      category: "warranty",
      title: "Warranty doc",
      status: "ready",
      fileName: "warranty.pdf",
      fileSizeBytes: 12345,
      fileChecksum: "sha256-abc",
      rawContent: null,
      metadata: {},
      errorDetail: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    knowledgeChunkCountMock.mockResolvedValue(7);

    const res = await knowledgeSourcesApp.request("/sources/src-detail-1", {
      method: "GET",
      headers: VALID_BEARER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: { id: string; chunkCount: number } };
    expect(body.source.id).toBe("src-detail-1");
    expect(body.source.chunkCount).toBe(7);

    // Pin: detail query is tenant-scoped + soft-delete aware
    const findArgs = knowledgeSourceFindFirstMock.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(findArgs.where.tenantId).toBe(TENANT_A);
    expect(findArgs.where.NOT).toEqual({ status: 'deleted' });
  });

  it("Test 3b — cross-tenant probe returns 404 (no row found because tenantId scoped)", async () => {
    knowledgeSourceFindFirstMock.mockResolvedValue(null); // simulating cross-tenant where condition not matching

    const res = await knowledgeSourcesApp.request("/sources/src-other-tenant", {
      method: "GET",
      headers: VALID_BEARER,
    });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────
// Test 4 — DELETE soft-deletes; audit emit fires; subsequent GET returns 404
// ─────────────────────────────────────────────

describe("KAN-829 — DELETE /api/knowledge/sources/:id", () => {
  it("Test 4 — soft-delete: status='deleted', deleted_at set; audit log emit; chunkCount captured", async () => {
    knowledgeSourceFindFirstMock.mockResolvedValue({
      id: "src-to-delete",
      sourceType: "paste_text",
      category: "pricing",
      title: "Pricing notes",
    });
    knowledgeChunkCountMock.mockResolvedValue(3);

    const res = await knowledgeSourcesApp.request("/sources/src-to-delete", {
      method: "DELETE",
      headers: VALID_BEARER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe("src-to-delete");
    expect(body.status).toBe("deleted");

    // Pin: update set status='deleted' + deletedAt
    expect(knowledgeSourceUpdateMock).toHaveBeenCalledOnce();
    const updArgs = knowledgeSourceUpdateMock.mock.calls[0]![0] as {
      where: { id: string };
      data: { status: string; deletedAt: Date };
    };
    expect(updArgs.where.id).toBe("src-to-delete");
    expect(updArgs.data.status).toBe("deleted");
    expect(updArgs.data.deletedAt).toBeInstanceOf(Date);

    // Audit emit fires on a tick — flush microtasks
    await new Promise((resolve) => setImmediate(resolve));
    expect(auditLogCreateMock).toHaveBeenCalledOnce();
    const auditArgs = (auditLogCreateMock.mock.calls as unknown as Array<Array<{
      data: { actionType: string; tenantId: string; payload: Record<string, unknown> };
    }>>)[0]![0]!;
    expect(auditArgs.data.actionType).toBe("knowledge.source_deleted");
    expect(auditArgs.data.tenantId).toBe(TENANT_A);
    expect(auditArgs.data.payload.chunkCountAtDelete).toBe(3);
  });

  it("Test 4b — DELETE on non-existent source returns 404; no update or audit emit", async () => {
    knowledgeSourceFindFirstMock.mockResolvedValue(null);

    const res = await knowledgeSourcesApp.request("/sources/src-missing", {
      method: "DELETE",
      headers: VALID_BEARER,
    });
    expect(res.status).toBe(404);
    expect(knowledgeSourceUpdateMock).not.toHaveBeenCalled();
    expect(auditLogCreateMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// Test 5 — GET tier-limits returns correct mapping for all 4 planTier values
// ─────────────────────────────────────────────

describe("KAN-829 — GET /api/knowledge/tier-limits", () => {
  async function callTierLimits(): Promise<{ planTier: string; limits: { maxSources: number; allowsPdf: boolean }; currentSourceCount: number; remaining: number }> {
    const res = await knowledgeSourcesApp.request("/tier-limits", {
      method: "GET",
      headers: VALID_BEARER,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as never;
  }

  it("Test 5 — planTier='free' → Starter limits (1 source, no PDF)", async () => {
    tenantFindUniqueMock.mockResolvedValue({ planTier: "free" });
    knowledgeSourceCountMock.mockResolvedValue(0);

    const body = await callTierLimits();
    expect(body.planTier).toBe("free");
    expect(body.limits.maxSources).toBe(1);
    expect(body.limits.allowsPdf).toBe(false);
    expect(body.currentSourceCount).toBe(0);
    expect(body.remaining).toBe(1);
  });

  it("Test 5b — planTier='starter' → same as free (synonym mapping per Decision 3)", async () => {
    tenantFindUniqueMock.mockResolvedValue({ planTier: "starter" });
    knowledgeSourceCountMock.mockResolvedValue(0);

    const body = await callTierLimits();
    expect(body.limits.maxSources).toBe(1);
    expect(body.limits.allowsPdf).toBe(false);
  });

  it("Test 5c — planTier='pro' → Growth limits (5 sources, 5MB PDF)", async () => {
    tenantFindUniqueMock.mockResolvedValue({ planTier: "pro" });
    knowledgeSourceCountMock.mockResolvedValue(2);

    const body = await callTierLimits();
    expect(body.limits.maxSources).toBe(5);
    expect(body.limits.allowsPdf).toBe(true);
    expect(body.currentSourceCount).toBe(2);
    expect(body.remaining).toBe(3);
  });

  it("Test 5d — planTier='enterprise' → Revenue limits (effectively unlimited, 10MB PDF)", async () => {
    tenantFindUniqueMock.mockResolvedValue({ planTier: "enterprise" });
    knowledgeSourceCountMock.mockResolvedValue(50);

    const body = await callTierLimits();
    expect(body.limits.maxSources).toBe(9999);
    expect(body.limits.allowsPdf).toBe(true);
    // remaining bounded by maxSources - currentSourceCount; 9999 - 50 = 9949
    expect(body.remaining).toBe(9949);
  });

  it("Test 5e — unknown planTier (e.g., 'growth' from KAN-848 partial migration) → safe Starter default", async () => {
    tenantFindUniqueMock.mockResolvedValue({ planTier: "growth" });
    knowledgeSourceCountMock.mockResolvedValue(0);

    const body = await callTierLimits();
    expect(body.limits.maxSources).toBe(1); // FREE_LIMITS fallback
  });
});

// ─────────────────────────────────────────────
// Test 6 — auth surface defended on all 4 new endpoints (sentinel for KAN-828
//          fix-forward audit lesson — every endpoint must hit the auth check)
// ─────────────────────────────────────────────

describe("KAN-829 — auth defense on all admin endpoints", () => {
  it.each([
    ["GET", "/sources"],
    ["GET", "/sources/some-id"],
    ["DELETE", "/sources/some-id"],
    ["GET", "/tier-limits"],
  ])("%s %s without Authorization → 401", async (method: string, path: string) => {
    const res = await knowledgeSourcesApp.request(path, {
      method,
      headers: { "x-tenant-id": TENANT_A },
    });
    expect(res.status).toBe(401);
  });
});
