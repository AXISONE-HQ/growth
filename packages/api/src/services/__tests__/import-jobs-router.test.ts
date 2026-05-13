/**
 * KAN-896 — import-jobs-router service tests.
 *
 * Coverage:
 *   - createUploadUrl: creates row, builds canonical path, returns
 *     placeholder signed URL (storage mocked)
 *   - confirmUpload (via confirmUploadWithDownload seam): happy path
 *     CSV → inspected; missing GCS object → failed; malformed CSV →
 *     failed; wrong-status → BAD_REQUEST; cross-tenant → NOT_FOUND
 *   - list: pagination + tenant scoping
 *   - getImportJobById: NOT_FOUND on cross-tenant + nonexistent
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createUploadUrl,
  confirmUploadWithDownload,
  listImportJobs,
  getImportJobById,
} from "../import-jobs-router.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const USER_ID = "user_1";

// Mock the import-storage module — createUploadUrl calls
// getSignedUploadUrl from it. We stub to return a deterministic shape so
// the test doesn't hit @google-cloud/storage.
vi.mock("../import-storage.js", () => ({
  buildImportObjectPath: (
    tenantId: string,
    importJobId: string,
    filename: string,
  ) => `tenants/${tenantId}/imports/${importJobId}/${filename}`,
  getSignedUploadUrl: vi.fn().mockResolvedValue({
    uploadUrl: "https://storage.googleapis.com/STUB/upload",
    contentType: "text/csv",
    expiresAt: "2026-05-13T13:00:00Z",
  }),
  objectExists: vi.fn(),
  downloadObject: vi.fn(),
}));

interface FakeJob {
  id: string;
  tenantId: string;
  createdByUserId: string;
  fileName: string;
  fileSize: number;
  fileMimeType: string;
  gcsObjectPath: string;
  mode: "replace_all" | "update_add";
  status:
    | "awaiting_upload"
    | "uploaded"
    | "inspecting"
    | "inspected"
    | "failed";
  detectedFileType: "csv" | "xlsx" | "unknown" | null;
  detectedRowCount: number | null;
  detectedColumnCount: number | null;
  detectedHeaders: unknown;
  sampleRows: unknown;
  errorMessage: string | null;
  errorAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  uploadConfirmedAt: Date | null;
  inspectionStartedAt: Date | null;
  inspectionCompletedAt: Date | null;
}

function makeJob(overrides: Partial<FakeJob> = {}): FakeJob {
  return {
    id: `j_${Math.random().toString(36).slice(2, 10)}`,
    tenantId: TENANT_A,
    createdByUserId: USER_ID,
    fileName: "leads.csv",
    fileSize: 1024,
    fileMimeType: "text/csv",
    gcsObjectPath: "PENDING",
    mode: "update_add",
    status: "awaiting_upload",
    detectedFileType: null,
    detectedRowCount: null,
    detectedColumnCount: null,
    detectedHeaders: null,
    sampleRows: null,
    errorMessage: null,
    errorAt: null,
    createdAt: new Date("2026-05-13T10:00:00Z"),
    updatedAt: new Date("2026-05-13T10:00:00Z"),
    uploadConfirmedAt: null,
    inspectionStartedAt: null,
    inspectionCompletedAt: null,
    ...overrides,
  };
}

function makePrisma(rows: FakeJob[]) {
  let nextId = rows.length;
  return {
    importJob: {
      create: async ({
        data,
      }: {
        data: Partial<FakeJob> & { tenantId: string; createdByUserId: string };
      }) => {
        const row = makeJob({
          id: `j_${++nextId}`,
          ...data,
        });
        rows.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeJob>;
      }) => {
        const r = rows.find((row) => row.id === where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      },
      findFirst: async ({
        where,
      }: {
        where: { id: string; tenantId: string };
      }) =>
        rows.find(
          (r) => r.id === where.id && r.tenantId === where.tenantId,
        ) ?? null,
      findMany: async ({
        where,
        take,
      }: {
        where: Record<string, unknown>;
        take: number;
      }) => {
        const matched = rows.filter((r) => {
          if (where.tenantId && r.tenantId !== where.tenantId) return false;
          if (where.status && r.status !== where.status) return false;
          return true;
        });
        matched.sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        );
        return matched.slice(0, take);
      },
      count: async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => {
          if (where.tenantId && r.tenantId !== where.tenantId) return false;
          if (where.status && r.status !== where.status) return false;
          return true;
        }).length,
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("KAN-896 — createUploadUrl", () => {
  it("creates ImportJob row + returns signed URL with canonical path", async () => {
    const rows: FakeJob[] = [];
    const prisma = makePrisma(rows);
    const result = await createUploadUrl(prisma, TENANT_A, USER_ID, {
      filename: "leads.csv",
      fileSize: 1024,
      fileMimeType: "text/csv",
      mode: "update_add",
    });
    expect(rows).toHaveLength(1);
    expect(result.importJobId).toBe(rows[0].id);
    expect(result.gcsObjectPath).toBe(
      `tenants/${TENANT_A}/imports/${rows[0].id}/leads.csv`,
    );
    expect(result.signedUploadUrl).toBe(
      "https://storage.googleapis.com/STUB/upload",
    );
  });

  it("captures mode + mime + size on the created row", async () => {
    const rows: FakeJob[] = [];
    const prisma = makePrisma(rows);
    await createUploadUrl(prisma, TENANT_A, USER_ID, {
      filename: "leads.xlsx",
      fileSize: 5_000_000,
      fileMimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      mode: "replace_all",
    });
    expect(rows[0].mode).toBe("replace_all");
    expect(rows[0].fileSize).toBe(5_000_000);
    expect(rows[0].fileMimeType).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(rows[0].status).toBe("awaiting_upload");
  });
});

describe("KAN-896 — confirmUpload happy path (CSV)", () => {
  it("transitions awaiting_upload → uploaded → inspecting → inspected and populates inspection metadata", async () => {
    const job = makeJob({
      id: "j_csv",
      gcsObjectPath: `tenants/${TENANT_A}/imports/j_csv/leads.csv`,
      fileMimeType: "text/csv",
      fileName: "leads.csv",
    });
    const prisma = makePrisma([job]);

    const csv = "email,firstName\nalice@x.com,Alice\nbob@x.com,Bob\n";
    const result = (await confirmUploadWithDownload(
      prisma,
      TENANT_A,
      { importJobId: "j_csv" },
      async () => Buffer.from(csv),
      async () => true,
    )) as FakeJob;

    expect(result.status).toBe("inspected");
    expect(result.detectedFileType).toBe("csv");
    expect(result.detectedRowCount).toBe(2);
    expect(result.detectedColumnCount).toBe(2);
    expect(result.detectedHeaders).toEqual(["email", "firstName"]);
    expect(result.uploadConfirmedAt).toBeInstanceOf(Date);
    expect(result.inspectionStartedAt).toBeInstanceOf(Date);
    expect(result.inspectionCompletedAt).toBeInstanceOf(Date);
  });
});

describe("KAN-896 — confirmUpload failure paths", () => {
  it("GCS object missing → status=failed, errorMessage set", async () => {
    const job = makeJob({ id: "j_missing" });
    const prisma = makePrisma([job]);

    const result = (await confirmUploadWithDownload(
      prisma,
      TENANT_A,
      { importJobId: "j_missing" },
      async () => {
        throw new Error("download should not be called");
      },
      async () => false,
    )) as FakeJob;

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/GCS object not found/i);
    expect(result.errorAt).toBeInstanceOf(Date);
  });

  it("malformed file → status=failed (unknown file type via wrong mime + wrong ext)", async () => {
    const job = makeJob({
      id: "j_bad",
      fileName: "leads.pdf",
      fileMimeType: "application/pdf",
    });
    const prisma = makePrisma([job]);

    const result = (await confirmUploadWithDownload(
      prisma,
      TENANT_A,
      { importJobId: "j_bad" },
      async () => Buffer.from("garbage"),
      async () => true,
    )) as FakeJob;

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/Unsupported file type|CSV/i);
  });

  it("rejects wrong-status (already inspected) → BAD_REQUEST", async () => {
    const job = makeJob({ id: "j_done", status: "inspected" });
    const prisma = makePrisma([job]);
    await expect(
      confirmUploadWithDownload(
        prisma,
        TENANT_A,
        { importJobId: "j_done" },
        async () => Buffer.from("ignored"),
        async () => true,
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("cross-tenant → NOT_FOUND (no leak)", async () => {
    const job = makeJob({ id: "j_other", tenantId: TENANT_B });
    const prisma = makePrisma([job]);
    await expect(
      confirmUploadWithDownload(
        prisma,
        TENANT_A,
        { importJobId: "j_other" },
        async () => Buffer.from("ignored"),
        async () => true,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("KAN-896 — listImportJobs", () => {
  it("scopes to tenant + paginates by limit", async () => {
    const rows: FakeJob[] = [
      makeJob({ id: "a", tenantId: TENANT_A }),
      makeJob({ id: "b", tenantId: TENANT_A }),
      makeJob({ id: "c", tenantId: TENANT_B }), // cross-tenant
    ];
    const prisma = makePrisma(rows);
    const result = await listImportJobs(prisma, TENANT_A, { limit: 50 });
    expect(result.items.map((i) => i.id).sort()).toEqual(["a", "b"]);
    expect(result.totalCount).toBe(2);
  });

  it("filters by status", async () => {
    const rows: FakeJob[] = [
      makeJob({ id: "a", status: "inspected" }),
      makeJob({ id: "b", status: "awaiting_upload" }),
      makeJob({ id: "c", status: "inspected" }),
    ];
    const prisma = makePrisma(rows);
    const result = await listImportJobs(prisma, TENANT_A, {
      limit: 50,
      status: "inspected",
    });
    expect(result.items.map((i) => i.id).sort()).toEqual(["a", "c"]);
  });
});

describe("KAN-896 — getImportJobById", () => {
  it("returns own-tenant row", async () => {
    const rows = [makeJob({ id: "j_a", tenantId: TENANT_A })];
    const prisma = makePrisma(rows);
    const result = (await getImportJobById(prisma, TENANT_A, {
      id: "j_a",
    })) as { id: string };
    expect(result.id).toBe("j_a");
  });

  it("cross-tenant → NOT_FOUND (no leak)", async () => {
    const rows = [makeJob({ id: "j_a", tenantId: TENANT_B })];
    const prisma = makePrisma(rows);
    await expect(
      getImportJobById(prisma, TENANT_A, { id: "j_a" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("nonexistent → NOT_FOUND", async () => {
    const prisma = makePrisma([]);
    await expect(
      getImportJobById(prisma, TENANT_A, { id: "j_missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
