/**
 * KAN-XXX — FAQ entries endpoint tests.
 *
 * Mirrors the auth-defense + happy-path matrix from knowledge-sources.test.ts.
 * Mocks Firebase auth + the dynamically-imported faq-entries service so the
 * endpoint contract is exercised without spinning up Postgres.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  verifyIdTokenMock,
  listFaqEntriesMock,
  getFaqEntryMock,
  createFaqEntryMock,
  updateFaqEntryMock,
  deleteFaqEntryMock,
  auditLogCreateMock,
} = vi.hoisted(() => ({
  verifyIdTokenMock: vi.fn(),
  listFaqEntriesMock: vi.fn(),
  getFaqEntryMock: vi.fn(),
  createFaqEntryMock: vi.fn(),
  updateFaqEntryMock: vi.fn(),
  deleteFaqEntryMock: vi.fn(),
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
    auditLog: { create: auditLogCreateMock },
  },
}));

// Service is loaded via variable-specifier dynamic import in the route.
// Vitest can intercept the resolved module path (after path resolution).
class MockFaqValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaqValidationError";
  }
}
vi.mock("../../../../packages/api/src/services/faq-entries.js", () => ({
  listFaqEntries: listFaqEntriesMock,
  getFaqEntry: getFaqEntryMock,
  createFaqEntry: createFaqEntryMock,
  updateFaqEntry: updateFaqEntryMock,
  deleteFaqEntry: deleteFaqEntryMock,
  FaqValidationError: MockFaqValidationError,
}));

import { faqEntriesApp } from "../routes/faq-entries.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const VALID_BEARER = { authorization: "Bearer good-token", "x-tenant-id": TENANT_A };

beforeEach(() => {
  verifyIdTokenMock.mockReset();
  verifyIdTokenMock.mockResolvedValue({ uid: "test-uid" });
  listFaqEntriesMock.mockReset();
  getFaqEntryMock.mockReset();
  createFaqEntryMock.mockReset();
  updateFaqEntryMock.mockReset();
  deleteFaqEntryMock.mockReset();
  auditLogCreateMock.mockClear();
});

// ─────────────────────────────────────────────
// Auth defense matrix — applies to every route uniformly
// ─────────────────────────────────────────────

describe("KAN-XXX — auth defense", () => {
  it("Test 1 — missing Authorization → 401", async () => {
    const res = await faqEntriesApp.request("/faqs", {
      method: "GET",
      headers: { "x-tenant-id": TENANT_A },
    });
    expect(res.status).toBe(401);
  });

  it("Test 2 — missing x-tenant-id → 400", async () => {
    const res = await faqEntriesApp.request("/faqs", {
      method: "GET",
      headers: { authorization: "Bearer good-token" },
    });
    expect(res.status).toBe(400);
  });

  it("Test 3 — invalid Firebase token → 401", async () => {
    verifyIdTokenMock.mockRejectedValueOnce(new Error("invalid"));
    const res = await faqEntriesApp.request("/faqs", {
      method: "GET",
      headers: VALID_BEARER,
    });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// GET /faqs
// ─────────────────────────────────────────────

describe("KAN-XXX — GET /faqs", () => {
  it("Test 4 — happy path returns faqs[]", async () => {
    listFaqEntriesMock.mockResolvedValue([
      { id: "f1", question: "Q1", answer: "A1", status: "ready" },
    ]);
    const res = await faqEntriesApp.request("/faqs", {
      method: "GET",
      headers: VALID_BEARER,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { faqs: Array<{ id: string }> };
    expect(body.faqs).toHaveLength(1);
    expect(body.faqs[0]!.id).toBe("f1");
    expect(listFaqEntriesMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_A,
      expect.objectContaining({ offset: 0, limit: 50 }),
    );
  });
});

// ─────────────────────────────────────────────
// GET /faqs/:id
// ─────────────────────────────────────────────

describe("KAN-XXX — GET /faqs/:id", () => {
  it("Test 5 — found returns faq", async () => {
    getFaqEntryMock.mockResolvedValue({ id: "f1", question: "Q", answer: "A", status: "ready" });
    const res = await faqEntriesApp.request("/faqs/f1", { method: "GET", headers: VALID_BEARER });
    expect(res.status).toBe(200);
    const body = await res.json() as { faq: { id: string } };
    expect(body.faq.id).toBe("f1");
  });

  it("Test 6 — not found → 404", async () => {
    getFaqEntryMock.mockResolvedValue(null);
    const res = await faqEntriesApp.request("/faqs/missing", { method: "GET", headers: VALID_BEARER });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────
// POST /faqs
// ─────────────────────────────────────────────

describe("KAN-XXX — POST /faqs", () => {
  it("Test 7 — happy path creates + returns 201 + audit emitted", async () => {
    createFaqEntryMock.mockResolvedValue({
      id: "f1",
      question: "What's the warranty?",
      answer: "Five years.",
      status: "ready",
      errorDetail: null,
    });
    const res = await faqEntriesApp.request("/faqs", {
      method: "POST",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({ question: "What's the warranty?", answer: "Five years." }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { faq: { id: string; status: string } };
    expect(body.faq.status).toBe("ready");
    expect(createFaqEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_A,
      { question: "What's the warranty?", answer: "Five years." },
    );
    // Audit emit is best-effort; the call schedules a microtask. Check called.
    await new Promise((r) => setTimeout(r, 0));
    expect(auditLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT_A,
          actionType: "knowledge.faq_created",
        }),
      }),
    );
  });

  it("Test 8 — empty question rejected with 400 (zod schema enforces min(1))", async () => {
    const res = await faqEntriesApp.request("/faqs", {
      method: "POST",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({ question: "", answer: "A" }),
    });
    expect(res.status).toBe(400);
    expect(createFaqEntryMock).not.toHaveBeenCalled();
  });

  it("Test 9 — answer over 10k chars rejected with 400", async () => {
    const tooLong = "x".repeat(10_001);
    const res = await faqEntriesApp.request("/faqs", {
      method: "POST",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({ question: "Q", answer: tooLong }),
    });
    expect(res.status).toBe(400);
    expect(createFaqEntryMock).not.toHaveBeenCalled();
  });

  it("Test 10 — service-thrown FaqValidationError surfaces as 400", async () => {
    createFaqEntryMock.mockRejectedValue(new MockFaqValidationError("Question is required."));
    const res = await faqEntriesApp.request("/faqs", {
      method: "POST",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({ question: "valid", answer: "valid" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("required");
  });
});

// ─────────────────────────────────────────────
// PUT /faqs/:id
// ─────────────────────────────────────────────

describe("KAN-XXX — PUT /faqs/:id", () => {
  it("Test 11 — happy path updates + returns 200", async () => {
    updateFaqEntryMock.mockResolvedValue({
      id: "f1",
      question: "Q",
      answer: "new A",
      status: "ready",
    });
    const res = await faqEntriesApp.request("/faqs/f1", {
      method: "PUT",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({ answer: "new A" }),
    });
    expect(res.status).toBe(200);
    expect(updateFaqEntryMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_A,
      "f1",
      { answer: "new A" },
    );
  });

  it("Test 12 — not found → 404", async () => {
    updateFaqEntryMock.mockResolvedValue(null);
    const res = await faqEntriesApp.request("/faqs/missing", {
      method: "PUT",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({ question: "Q" }),
    });
    expect(res.status).toBe(404);
  });

  it("Test 13 — empty body (neither question nor answer) → 400", async () => {
    const res = await faqEntriesApp.request("/faqs/f1", {
      method: "PUT",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(updateFaqEntryMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// DELETE /faqs/:id
// ─────────────────────────────────────────────

describe("KAN-XXX — DELETE /faqs/:id", () => {
  it("Test 14 — happy path returns 200 + audit emitted", async () => {
    deleteFaqEntryMock.mockResolvedValue(true);
    const res = await faqEntriesApp.request("/faqs/f1", {
      method: "DELETE",
      headers: VALID_BEARER,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; status: string };
    expect(body.status).toBe("deleted");
    await new Promise((r) => setTimeout(r, 0));
    expect(auditLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actionType: "knowledge.faq_deleted" }),
      }),
    );
  });

  it("Test 15 — not found → 404", async () => {
    deleteFaqEntryMock.mockResolvedValue(false);
    const res = await faqEntriesApp.request("/faqs/missing", {
      method: "DELETE",
      headers: VALID_BEARER,
    });
    expect(res.status).toBe(404);
  });
});
