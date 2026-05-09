/**
 * KAN-855 — Account Page Cohort 2 router integration tests for the logo
 * mutations. Mirrors the kan-852 test pattern (vi.hoisted + vi.mock,
 * caller-factory) but focused on the 4 logo paths: uploadLogo,
 * finalizeLogo (PNG happy path, SVG short-circuit, Sharp timeout
 * recovery), removeLogo, regenerateVariants.
 *
 * Fred's pre-merge ask: cover three specific paths he flagged most
 * likely to break in subtle ways:
 *
 *   1. SVG-no-variants — finalizeLogo points all 3 sizes at the
 *      original SVG path (vector, no Sharp call)
 *   2. Sharp timeout — finalizeLogo returns success with non-fatal
 *      `variantWarning` set + logoVariants=null on the persisted row
 *   3. regenerateVariants — recovers from a null-variants state by
 *      re-running Sharp on the existing original
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  enrichLogoUrlsMock,
  isOwnedByTenantMock,
  parseExtFromObjectNameMock,
  parseTimestampFromObjectNameMock,
  getSignedUploadUrlMock,
  downloadObjectMock,
  deleteObjectMock,
  objectExistsMock,
  generateAndUploadVariantsMock,
  accountProfileFindUniqueMock,
  accountProfileUpdateMock,
  accountProfileUpsertMock,
  tenantFindUniqueMock,
  publishMock,
  accountEventsEnabledMock,
} = vi.hoisted(() => ({
  enrichLogoUrlsMock: vi.fn(async (logoUrl: string | null, variants: unknown) => ({
    logoUrl: logoUrl ? `signed://${logoUrl}` : null,
    logoVariants: variants
      ? {
          256: `signed://${(variants as { "256": string })["256"]}`,
          128: `signed://${(variants as { "128": string })["128"]}`,
          64: `signed://${(variants as { "64": string })["64"]}`,
        }
      : null,
  })),
  isOwnedByTenantMock: vi.fn(
    (objectName: string, tenantId: string) =>
      objectName.startsWith(`tenants/${tenantId}/account/logo-`),
  ),
  parseExtFromObjectNameMock: vi.fn((name: string) => {
    const m = name.match(/\.(png|jpg|svg|webp)$/i);
    return (m?.[1].toLowerCase() ?? null) as "png" | "jpg" | "svg" | "webp" | null;
  }),
  parseTimestampFromObjectNameMock: vi.fn((name: string) => {
    const m = name.match(/\/logo-(\d+)/);
    return m ? Number(m[1]) : null;
  }),
  getSignedUploadUrlMock: vi.fn(),
  downloadObjectMock: vi.fn(),
  deleteObjectMock: vi.fn(),
  objectExistsMock: vi.fn(),
  generateAndUploadVariantsMock: vi.fn(),
  accountProfileFindUniqueMock: vi.fn(),
  accountProfileUpdateMock: vi.fn(),
  accountProfileUpsertMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
  publishMock: vi.fn(async () => ({ skipped: true })),
  accountEventsEnabledMock: vi.fn(() => false),
}));

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifyIdToken: vi.fn() }),
}));
vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(),
  getApps: () => [{}],
  applicationDefault: vi.fn(),
}));

vi.mock(
  "../../../../packages/api/src/services/account-field-updated-publisher.js",
  () => ({
    publishAccountFieldUpdated: (...args: unknown[]) =>
      (publishMock as (...a: unknown[]) => unknown)(...args),
    accountEventsEnabled: (...args: unknown[]) =>
      (accountEventsEnabledMock as (...a: unknown[]) => unknown)(...args),
  }),
);

vi.mock(
  "../../../../packages/api/src/services/account-logo-storage.js",
  () => ({
    enrichLogoUrls: (...args: unknown[]) =>
      (enrichLogoUrlsMock as (...a: unknown[]) => unknown)(...args),
    isOwnedByTenant: (...args: unknown[]) =>
      (isOwnedByTenantMock as (...a: unknown[]) => unknown)(...args),
    parseExtFromObjectName: (...args: unknown[]) =>
      (parseExtFromObjectNameMock as (...a: unknown[]) => unknown)(...args),
    parseTimestampFromObjectName: (...args: unknown[]) =>
      (parseTimestampFromObjectNameMock as (...a: unknown[]) => unknown)(...args),
    getSignedUploadUrl: (...args: unknown[]) =>
      (getSignedUploadUrlMock as (...a: unknown[]) => unknown)(...args),
    downloadObject: (...args: unknown[]) =>
      (downloadObjectMock as (...a: unknown[]) => unknown)(...args),
    deleteObject: (...args: unknown[]) =>
      (deleteObjectMock as (...a: unknown[]) => unknown)(...args),
    objectExists: (...args: unknown[]) =>
      (objectExistsMock as (...a: unknown[]) => unknown)(...args),
    generateAndUploadVariants: (...args: unknown[]) =>
      (generateAndUploadVariantsMock as (...a: unknown[]) => unknown)(...args),
  }),
);

import { accountRouter } from "../router.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

const mockedPrisma = {
  accountProfile: {
    findUnique: (...args: unknown[]) =>
      (accountProfileFindUniqueMock as (...a: unknown[]) => unknown)(...args),
    update: (...args: unknown[]) =>
      (accountProfileUpdateMock as (...a: unknown[]) => unknown)(...args),
    upsert: (...args: unknown[]) =>
      (accountProfileUpsertMock as (...a: unknown[]) => unknown)(...args),
  },
  tenant: {
    findUnique: (...args: unknown[]) =>
      (tenantFindUniqueMock as (...a: unknown[]) => unknown)(...args),
  },
};

function buildCaller(opts: { tenantId?: string } = {}) {
  const ctx = {
    prisma: mockedPrisma as unknown,
    tenantId: opts.tenantId ?? TENANT_A,
    firebaseUser: { uid: "user-x", email: "u@example.com" },
  } as Parameters<typeof accountRouter.createCaller>[0];
  return accountRouter.createCaller(ctx);
}

const PROFILE_BASE = {
  id: "ap1",
  tenantId: TENANT_A,
  legalName: "Acme Inc.",
  logoUrl: null,
  logoVariants: null,
  socialProfiles: [],
  observedHolidays: [],
  industryDisclosures: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  enrichLogoUrlsMock.mockImplementation(async (logoUrl: string | null, variants: unknown) => ({
    logoUrl: logoUrl ? `signed://${logoUrl}` : null,
    logoVariants: variants
      ? {
          256: `signed://${(variants as { "256": string })["256"]}`,
          128: `signed://${(variants as { "128": string })["128"]}`,
          64: `signed://${(variants as { "64": string })["64"]}`,
        }
      : null,
  }));
  isOwnedByTenantMock.mockImplementation((objectName: string, tenantId: string) =>
    objectName.startsWith(`tenants/${tenantId}/account/logo-`),
  );
  parseExtFromObjectNameMock.mockImplementation((name: string) => {
    const m = name.match(/\.(png|jpg|svg|webp)$/i);
    return (m?.[1].toLowerCase() ?? null) as "png" | "jpg" | "svg" | "webp" | null;
  });
  parseTimestampFromObjectNameMock.mockImplementation((name: string) => {
    const m = name.match(/\/logo-(\d+)/);
    return m ? Number(m[1]) : null;
  });
});

// ─────────────────────────────────────────────
// uploadLogo
// ─────────────────────────────────────────────

describe("KAN-855 — accountRouter.uploadLogo", () => {
  it("returns signed PUT URL + opaque uploadId on the §2-allowed MIME set", async () => {
    getSignedUploadUrlMock.mockResolvedValue({
      uploadUrl: "https://signed.put",
      objectName: `tenants/${TENANT_A}/account/logo-1700000000000.png`,
      uploadId: `tenants/${TENANT_A}/account/logo-1700000000000.png`,
      contentType: "image/png",
    });
    const caller = buildCaller();
    const out = await caller.uploadLogo({
      contentType: "image/png",
      sizeBytes: 100_000,
    });
    expect(out).toMatchObject({
      uploadUrl: "https://signed.put",
      contentType: "image/png",
    });
    expect(typeof out.uploadId).toBe("string");
    expect(out.uploadId).toContain(`tenants/${TENANT_A}/account/logo-`);
  });

  it("rejects unsupported MIME types at the Zod boundary (no signed URL minted)", async () => {
    const caller = buildCaller();
    await expect(
      caller.uploadLogo({
        contentType: "image/gif" as unknown as "image/png",
        sizeBytes: 100,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getSignedUploadUrlMock).not.toHaveBeenCalled();
  });

  it("rejects oversized files (>5MB) at the Zod boundary", async () => {
    const caller = buildCaller();
    await expect(
      caller.uploadLogo({
        contentType: "image/png",
        sizeBytes: 5 * 1024 * 1024 + 1,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(getSignedUploadUrlMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// finalizeLogo — PNG happy path + Fred's 3 scenarios
// ─────────────────────────────────────────────

describe("KAN-855 — accountRouter.finalizeLogo", () => {
  const PNG_OBJECT = `tenants/${TENANT_A}/account/logo-1700000000000.png`;
  const SVG_OBJECT = `tenants/${TENANT_A}/account/logo-1700000000001.svg`;

  it("PNG happy path — Sharp generates 3 variants, persists all 4 GCS paths on AccountProfile", async () => {
    objectExistsMock.mockResolvedValue(true);
    downloadObjectMock.mockResolvedValue(Buffer.from("png-bytes"));
    generateAndUploadVariantsMock.mockResolvedValue({
      size256: `tenants/${TENANT_A}/account/logo-1700000000000-256.png`,
      size128: `tenants/${TENANT_A}/account/logo-1700000000000-128.png`,
      size64: `tenants/${TENANT_A}/account/logo-1700000000000-64.png`,
    });
    accountProfileUpdateMock.mockResolvedValue({
      ...PROFILE_BASE,
      logoUrl: PNG_OBJECT,
      logoVariants: {
        "256": `tenants/${TENANT_A}/account/logo-1700000000000-256.png`,
        "128": `tenants/${TENANT_A}/account/logo-1700000000000-128.png`,
        "64": `tenants/${TENANT_A}/account/logo-1700000000000-64.png`,
      },
    });
    const caller = buildCaller();
    const out = await caller.finalizeLogo({ uploadId: PNG_OBJECT });
    expect(generateAndUploadVariantsMock).toHaveBeenCalledOnce();
    expect(accountProfileUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_A },
        data: expect.objectContaining({
          logoUrl: PNG_OBJECT,
          logoVariants: expect.objectContaining({
            "256": expect.stringContaining("-256.png"),
          }),
        }),
      }),
    );
    expect(out.variantWarning).toBeNull();
    expect(out.logoUrl).toContain("signed://");
  });

  // ─────────────────────────────────────────────
  // Fred's scenario 1 — SVG-no-variants path
  // ─────────────────────────────────────────────
  it("SVG short-circuit (Fred #1) — Sharp NOT called; logoVariants points all 3 sizes at the original SVG path", async () => {
    objectExistsMock.mockResolvedValue(true);
    accountProfileUpdateMock.mockImplementation(async (args: unknown) => {
      const data = (args as { data: { logoUrl: string; logoVariants: unknown } }).data;
      return { ...PROFILE_BASE, logoUrl: data.logoUrl, logoVariants: data.logoVariants };
    });
    const caller = buildCaller();
    const out = await caller.finalizeLogo({ uploadId: SVG_OBJECT });

    // Sharp must not be invoked for SVG — vector, no raster resize.
    expect(generateAndUploadVariantsMock).not.toHaveBeenCalled();
    expect(downloadObjectMock).not.toHaveBeenCalled();

    // The persisted shape — all 3 keys point at the SAME original path.
    expect(accountProfileUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          logoUrl: SVG_OBJECT,
          logoVariants: {
            "256": SVG_OBJECT,
            "128": SVG_OBJECT,
            "64": SVG_OBJECT,
          },
        },
      }),
    );
    expect(out.variantWarning).toBeNull();
    // Enriched return shape has signed URLs all resolving to the same SVG.
    expect(out.logoVariants).toEqual({
      256: `signed://${SVG_OBJECT}`,
      128: `signed://${SVG_OBJECT}`,
      64: `signed://${SVG_OBJECT}`,
    });
  });

  // ─────────────────────────────────────────────
  // Fred's scenario 2 — Sharp timeout recovery
  // ─────────────────────────────────────────────
  it("Sharp timeout (Fred #2) — mutation returns success with variantWarning + logoVariants=null persisted", async () => {
    objectExistsMock.mockResolvedValue(true);
    downloadObjectMock.mockResolvedValue(Buffer.from("png-bytes"));
    generateAndUploadVariantsMock.mockRejectedValue(
      new Error("Sharp variant generation exceeded 10s timeout"),
    );
    accountProfileUpdateMock.mockImplementation(async (args: unknown) => {
      const data = (args as { data: { logoUrl: string; logoVariants: unknown } }).data;
      return { ...PROFILE_BASE, logoUrl: data.logoUrl, logoVariants: data.logoVariants };
    });
    const caller = buildCaller();
    const out = await caller.finalizeLogo({ uploadId: PNG_OBJECT });

    // Update STILL writes the original logo URL — the user's upload
    // wasn't lost. Variants persist as null (recovery state).
    expect(accountProfileUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          logoUrl: PNG_OBJECT,
          logoVariants: null,
        },
      }),
    );
    // variantWarning surfaces the Sharp error message for the client UI
    // — the LogoUploader renders the "Retry thumbnails" button when set.
    expect(out.variantWarning).toContain("10s timeout");
    expect(out.logoUrl).toBe(`signed://${PNG_OBJECT}`);
    expect(out.logoVariants).toBeNull();
  });

  it("rejects cross-tenant uploadId — FORBIDDEN before any GCS call", async () => {
    const crossTenantId = `tenants/${TENANT_B}/account/logo-1700000000000.png`;
    const caller = buildCaller(); // ctx.tenantId = TENANT_A
    await expect(
      caller.finalizeLogo({ uploadId: crossTenantId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(objectExistsMock).not.toHaveBeenCalled();
    expect(downloadObjectMock).not.toHaveBeenCalled();
    expect(accountProfileUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects when uploaded object doesn't exist (PUT failed?) — NOT_FOUND", async () => {
    objectExistsMock.mockResolvedValue(false);
    const caller = buildCaller();
    await expect(
      caller.finalizeLogo({ uploadId: PNG_OBJECT }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects malformed uploadId (no parseable timestamp/ext) — BAD_REQUEST", async () => {
    objectExistsMock.mockResolvedValue(true);
    parseExtFromObjectNameMock.mockReturnValueOnce(null);
    const caller = buildCaller();
    await expect(
      caller.finalizeLogo({ uploadId: `tenants/${TENANT_A}/account/logo-bogus` }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ─────────────────────────────────────────────
// Fred's scenario 3 — regenerateVariants recovery
// ─────────────────────────────────────────────

describe("KAN-855 — accountRouter.regenerateVariants", () => {
  const PNG_OBJECT = `tenants/${TENANT_A}/account/logo-1700000000000.png`;
  const SVG_OBJECT = `tenants/${TENANT_A}/account/logo-1700000000001.svg`;

  it("Fred #3 — recovers from null-variants state by re-running Sharp on existing original", async () => {
    // Pre-state: AccountProfile.logoUrl set (original survived
    // finalizeLogo) but logoVariants is null because Sharp timed out.
    accountProfileFindUniqueMock.mockResolvedValue({
      logoUrl: PNG_OBJECT,
    });
    downloadObjectMock.mockResolvedValue(Buffer.from("png-bytes"));
    generateAndUploadVariantsMock.mockResolvedValue({
      size256: `tenants/${TENANT_A}/account/logo-1700000000000-256.png`,
      size128: `tenants/${TENANT_A}/account/logo-1700000000000-128.png`,
      size64: `tenants/${TENANT_A}/account/logo-1700000000000-64.png`,
    });
    accountProfileUpdateMock.mockImplementation(async (args: unknown) => {
      const data = (args as { data: { logoVariants: unknown } }).data;
      return { ...PROFILE_BASE, logoUrl: PNG_OBJECT, logoVariants: data.logoVariants };
    });

    const caller = buildCaller();
    const out = await caller.regenerateVariants();

    expect(downloadObjectMock).toHaveBeenCalledWith(PNG_OBJECT);
    expect(generateAndUploadVariantsMock).toHaveBeenCalledOnce();
    // Crucially: `update` only writes logoVariants — logoUrl stays put.
    expect(accountProfileUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_A },
        data: {
          logoVariants: {
            "256": expect.stringContaining("-256.png"),
            "128": expect.stringContaining("-128.png"),
            "64": expect.stringContaining("-64.png"),
          },
        },
      }),
    );
    expect(out.logoUrl).toBe(`signed://${PNG_OBJECT}`);
  });

  it("SVG regenerate — Sharp NOT called; variants point at the original SVG", async () => {
    accountProfileFindUniqueMock.mockResolvedValue({ logoUrl: SVG_OBJECT });
    accountProfileUpdateMock.mockImplementation(async (args: unknown) => {
      const data = (args as { data: { logoVariants: unknown } }).data;
      return { ...PROFILE_BASE, logoUrl: SVG_OBJECT, logoVariants: data.logoVariants };
    });
    const caller = buildCaller();
    const out = await caller.regenerateVariants();
    expect(generateAndUploadVariantsMock).not.toHaveBeenCalled();
    expect(downloadObjectMock).not.toHaveBeenCalled();
    expect(accountProfileUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          logoVariants: {
            "256": SVG_OBJECT,
            "128": SVG_OBJECT,
            "64": SVG_OBJECT,
          },
        },
      }),
    );
    expect(out.logoVariants).toEqual({
      256: `signed://${SVG_OBJECT}`,
      128: `signed://${SVG_OBJECT}`,
      64: `signed://${SVG_OBJECT}`,
    });
  });

  it("rejects when no logo set — NOT_FOUND", async () => {
    accountProfileFindUniqueMock.mockResolvedValue({ logoUrl: null });
    const caller = buildCaller();
    await expect(caller.regenerateVariants()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(generateAndUploadVariantsMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// removeLogo — best-effort GCS cleanup
// ─────────────────────────────────────────────

describe("KAN-855 — accountRouter.removeLogo", () => {
  const PNG_OBJECT = `tenants/${TENANT_A}/account/logo-1700000000000.png`;

  it("deletes original + 3 variants from GCS, then nulls the columns", async () => {
    accountProfileFindUniqueMock.mockResolvedValue({
      logoUrl: PNG_OBJECT,
      logoVariants: {
        "256": `tenants/${TENANT_A}/account/logo-1700000000000-256.png`,
        "128": `tenants/${TENANT_A}/account/logo-1700000000000-128.png`,
        "64": `tenants/${TENANT_A}/account/logo-1700000000000-64.png`,
      },
    });
    deleteObjectMock.mockResolvedValue(undefined);
    accountProfileUpdateMock.mockResolvedValue({
      ...PROFILE_BASE,
      logoUrl: null,
      logoVariants: null,
    });
    const caller = buildCaller();
    const out = await caller.removeLogo();
    // 1 original + 3 variants = 4 deletes
    expect(deleteObjectMock).toHaveBeenCalledTimes(4);
    expect(accountProfileUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_A },
        data: { logoUrl: null, logoVariants: null },
      }),
    );
    expect(out.logoUrl).toBeNull();
    expect(out.logoVariants).toBeNull();
  });

  it("no-op safe when there's no logo to remove (still nulls the columns)", async () => {
    accountProfileFindUniqueMock.mockResolvedValue({
      logoUrl: null,
      logoVariants: null,
    });
    accountProfileUpdateMock.mockResolvedValue({ ...PROFILE_BASE });
    const caller = buildCaller();
    await caller.removeLogo();
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  it("SVG remove — same-path dedup means 1 delete (original = all variants)", async () => {
    const SVG_OBJECT = `tenants/${TENANT_A}/account/logo-1700000000001.svg`;
    accountProfileFindUniqueMock.mockResolvedValue({
      logoUrl: SVG_OBJECT,
      logoVariants: { "256": SVG_OBJECT, "128": SVG_OBJECT, "64": SVG_OBJECT },
    });
    deleteObjectMock.mockResolvedValue(undefined);
    accountProfileUpdateMock.mockResolvedValue({ ...PROFILE_BASE });
    const caller = buildCaller();
    await caller.removeLogo();
    // SVG has same path for original + all variants → Set dedup → 1 delete
    expect(deleteObjectMock).toHaveBeenCalledTimes(1);
  });
});
