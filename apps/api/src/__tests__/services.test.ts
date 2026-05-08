/**
 * KAN-XXX — Services endpoint tests.
 *
 * Mirrors the auth-defense + happy-path matrix from faq-entries.test.ts.
 * Mocks Firebase auth + the dynamically-imported services service so the
 * endpoint contract is exercised without spinning up Postgres.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  verifyIdTokenMock,
  listServicesMock,
  getServiceMock,
  createServiceMock,
  updateServiceMock,
  deleteServiceMock,
  auditLogCreateMock,
} = vi.hoisted(() => ({
  verifyIdTokenMock: vi.fn(),
  listServicesMock: vi.fn(),
  getServiceMock: vi.fn(),
  createServiceMock: vi.fn(),
  updateServiceMock: vi.fn(),
  deleteServiceMock: vi.fn(),
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

class MockServiceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceValidationError";
  }
}
vi.mock("../../../../packages/api/src/services/services.js", () => ({
  listServices: listServicesMock,
  getService: getServiceMock,
  createService: createServiceMock,
  updateService: updateServiceMock,
  deleteService: deleteServiceMock,
  ServiceValidationError: MockServiceValidationError,
}));

import { servicesApp } from "../routes/services.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const VALID_BEARER = { authorization: "Bearer good-token", "x-tenant-id": TENANT_A };

beforeEach(() => {
  verifyIdTokenMock.mockReset();
  verifyIdTokenMock.mockResolvedValue({ uid: "test-uid" });
  listServicesMock.mockReset();
  getServiceMock.mockReset();
  createServiceMock.mockReset();
  updateServiceMock.mockReset();
  deleteServiceMock.mockReset();
  auditLogCreateMock.mockClear();
});

// ─────────────────────────────────────────────
// Auth defense matrix
// ─────────────────────────────────────────────

describe("KAN-XXX — services auth defense", () => {
  it("Test 1 — missing Authorization → 401", async () => {
    const res = await servicesApp.request("/services", {
      method: "GET",
      headers: { "x-tenant-id": TENANT_A },
    });
    expect(res.status).toBe(401);
  });

  it("Test 2 — missing x-tenant-id → 400", async () => {
    const res = await servicesApp.request("/services", {
      method: "GET",
      headers: { authorization: "Bearer good-token" },
    });
    expect(res.status).toBe(400);
  });

  it("Test 3 — invalid Firebase token → 401", async () => {
    verifyIdTokenMock.mockRejectedValueOnce(new Error("invalid"));
    const res = await servicesApp.request("/services", {
      method: "GET",
      headers: VALID_BEARER,
    });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────
// GET /services
// ─────────────────────────────────────────────

describe("KAN-XXX — GET /services", () => {
  it("Test 4 — happy path returns services[]", async () => {
    listServicesMock.mockResolvedValue([
      { id: "s1", title: "Mentorship", priceUnit: "PER_HOUR", price: 250, status: "ready" },
    ]);
    const res = await servicesApp.request("/services", {
      method: "GET",
      headers: VALID_BEARER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { services: Array<{ id: string }> };
    expect(body.services).toHaveLength(1);
    expect(body.services[0]!.id).toBe("s1");
    expect(listServicesMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_A,
      expect.objectContaining({ offset: 0, limit: 50 }),
    );
  });
});

// ─────────────────────────────────────────────
// GET /services/:id
// ─────────────────────────────────────────────

describe("KAN-XXX — GET /services/:id", () => {
  it("Test 5 — found returns service", async () => {
    getServiceMock.mockResolvedValue({ id: "s1", title: "Mentorship", status: "ready" });
    const res = await servicesApp.request("/services/s1", { method: "GET", headers: VALID_BEARER });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: { id: string } };
    expect(body.service.id).toBe("s1");
  });

  it("Test 6 — not found → 404", async () => {
    getServiceMock.mockResolvedValue(null);
    const res = await servicesApp.request("/services/missing", {
      method: "GET",
      headers: VALID_BEARER,
    });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────
// POST /services
// ─────────────────────────────────────────────

describe("KAN-XXX — POST /services", () => {
  it("Test 7 — happy path creates + returns 201 + audit emitted", async () => {
    createServiceMock.mockResolvedValue({
      id: "s1",
      title: "Mentorship",
      priceUnit: "PER_HOUR",
      price: 250,
      status: "ready",
      errorDetail: null,
    });
    const res = await servicesApp.request("/services", {
      method: "POST",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({
        title: "Mentorship",
        description: "Weekly 1:1.",
        price: 250,
        priceUnit: "PER_HOUR",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { service: { id: string; status: string } };
    expect(body.service.status).toBe("ready");
    await new Promise((r) => setTimeout(r, 0));
    expect(auditLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actionType: "knowledge.service_created" }),
      }),
    );
  });

  it("Test 8 — POST coerces ISO date strings to Date objects passed to service", async () => {
    createServiceMock.mockResolvedValue({
      id: "s1",
      status: "ready",
      errorDetail: null,
      title: "X",
      priceUnit: "PER_HOUR",
    });
    const res = await servicesApp.request("/services", {
      method: "POST",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({
        title: "X",
        description: "Y",
        price: 50,
        priceUnit: "PER_HOUR",
        startDate: "2026-06-01",
        endDate: "2026-12-31",
      }),
    });
    expect(res.status).toBe(201);
    const callArgs = createServiceMock.mock.calls[0]![2] as { startDate: Date; endDate: Date };
    expect(callArgs.startDate).toBeInstanceOf(Date);
    expect(callArgs.endDate).toBeInstanceOf(Date);
    expect(callArgs.startDate.toISOString().slice(0, 10)).toBe("2026-06-01");
  });

  it("Test 9 — empty title rejected with 400", async () => {
    const res = await servicesApp.request("/services", {
      method: "POST",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({ title: "", description: "Y", priceUnit: "PER_HOUR", price: 10 }),
    });
    expect(res.status).toBe(400);
    expect(createServiceMock).not.toHaveBeenCalled();
  });

  it("Test 10 — invalid priceUnit rejected with 400 (zod enum guard)", async () => {
    const res = await servicesApp.request("/services", {
      method: "POST",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({
        title: "X",
        description: "Y",
        price: 10,
        priceUnit: "PER_DECADE",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("Test 11 — malformed date string rejected with 400", async () => {
    const res = await servicesApp.request("/services", {
      method: "POST",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({
        title: "X",
        description: "Y",
        price: 10,
        priceUnit: "PER_HOUR",
        startDate: "06/01/2026",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("Test 12 — service-thrown ServiceValidationError surfaces as 400", async () => {
    createServiceMock.mockRejectedValue(
      new MockServiceValidationError("priceCustomLabel is required when priceUnit is CUSTOM."),
    );
    const res = await servicesApp.request("/services", {
      method: "POST",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({
        title: "X",
        description: "Y",
        priceUnit: "CUSTOM",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("CUSTOM");
  });
});

// ─────────────────────────────────────────────
// PUT /services/:id
// ─────────────────────────────────────────────

describe("KAN-XXX — PUT /services/:id", () => {
  it("Test 13 — happy path updates + returns 200", async () => {
    updateServiceMock.mockResolvedValue({
      id: "s1",
      title: "Updated",
      status: "ready",
      errorDetail: null,
    });
    const res = await servicesApp.request("/services/s1", {
      method: "PUT",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({ title: "Updated" }),
    });
    expect(res.status).toBe(200);
    expect(updateServiceMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_A,
      "s1",
      expect.objectContaining({ title: "Updated" }),
    );
  });

  it("Test 14 — not found → 404", async () => {
    updateServiceMock.mockResolvedValue(null);
    const res = await servicesApp.request("/services/missing", {
      method: "PUT",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({ title: "X" }),
    });
    expect(res.status).toBe(404);
  });

  it("Test 15 — empty body → 400", async () => {
    const res = await servicesApp.request("/services/s1", {
      method: "PUT",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(updateServiceMock).not.toHaveBeenCalled();
  });

  it("Test 16 — null startDate explicitly clears the date", async () => {
    updateServiceMock.mockResolvedValue({
      id: "s1",
      status: "ready",
      errorDetail: null,
      title: "X",
    });
    const res = await servicesApp.request("/services/s1", {
      method: "PUT",
      headers: { ...VALID_BEARER, "content-type": "application/json" },
      body: JSON.stringify({ startDate: null }),
    });
    expect(res.status).toBe(200);
    const callArgs = updateServiceMock.mock.calls[0]![3] as { startDate: Date | null };
    expect(callArgs.startDate).toBeNull();
  });
});

// ─────────────────────────────────────────────
// DELETE /services/:id
// ─────────────────────────────────────────────

describe("KAN-XXX — DELETE /services/:id", () => {
  it("Test 17 — happy path returns 200 + audit emitted", async () => {
    deleteServiceMock.mockResolvedValue(true);
    const res = await servicesApp.request("/services/s1", {
      method: "DELETE",
      headers: VALID_BEARER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("deleted");
    await new Promise((r) => setTimeout(r, 0));
    expect(auditLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actionType: "knowledge.service_deleted" }),
      }),
    );
  });

  it("Test 18 — not found → 404", async () => {
    deleteServiceMock.mockResolvedValue(false);
    const res = await servicesApp.request("/services/missing", {
      method: "DELETE",
      headers: VALID_BEARER,
    });
    expect(res.status).toBe(404);
  });
});
