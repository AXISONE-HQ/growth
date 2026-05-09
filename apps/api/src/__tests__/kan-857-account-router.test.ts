/**
 * KAN-857 — Cohort 3 backend touch: updateContact wrapper that
 * explicitly nulls mailingAddress when mailingSameAsPhysical=true.
 *
 * Single approved backend change for Cohort 3 (Decision 8). Prevents
 * stale mailing data from surviving a toggle-on save. The boolean
 * column on AccountProfile becomes the source of truth; downstream
 * consumers (email composer, etc.) check the boolean and substitute
 * physicalAddress when reading.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  enrichLogoUrlsMock,
  accountProfileFindUniqueMock,
  accountProfileUpdateMock,
  accountProfileUpsertMock,
  tenantFindUniqueMock,
  publishMock,
  accountEventsEnabledMock,
} = vi.hoisted(() => ({
  enrichLogoUrlsMock: vi.fn(async (logoUrl: string | null) => ({
    logoUrl,
    logoVariants: null,
  })),
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
    isOwnedByTenant: () => true,
    parseExtFromObjectName: () => "png",
    parseTimestampFromObjectName: () => 1700000000000,
    getSignedUploadUrl: vi.fn(),
    getSignedReadUrl: vi.fn(),
    downloadObject: vi.fn(),
    deleteObject: vi.fn(),
    objectExists: vi.fn(),
    generateAndUploadVariants: vi.fn(),
  }),
);

import { accountRouter } from "../router.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";

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

function buildCaller() {
  const ctx = {
    prisma: mockedPrisma as unknown,
    tenantId: TENANT_A,
    firebaseUser: { uid: "user-x", email: "u@example.com" },
  } as Parameters<typeof accountRouter.createCaller>[0];
  return accountRouter.createCaller(ctx);
}

const PROFILE_BASE = {
  id: "ap1",
  tenantId: TENANT_A,
  legalName: "Acme",
  logoUrl: null,
  logoVariants: null,
  physicalAddress: "123 Main St, Toronto, ON",
  mailingAddress: "PO Box 99, Toronto, ON",
  mailingSameAsPhysical: false,
  socialProfiles: [],
  observedHolidays: [],
  industryDisclosures: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  // _applyAccountUpdate's findUnique-then-update flow needs both stubs.
  accountProfileFindUniqueMock.mockResolvedValue(PROFILE_BASE);
  accountProfileUpdateMock.mockImplementation(async (args: unknown) => {
    const data = (args as { data: Record<string, unknown> }).data;
    return { ...PROFILE_BASE, ...data };
  });
  enrichLogoUrlsMock.mockImplementation(async (logoUrl: string | null) => ({
    logoUrl,
    logoVariants: null,
  }));
});

describe("KAN-857 Decision 8 — updateContact mailing-null wrapper", () => {
  it("when mailingSameAsPhysical=true, server nulls mailingAddress regardless of payload", async () => {
    const caller = buildCaller();
    await caller.updateContact({
      mailingSameAsPhysical: true,
      mailingAddress: "stale value the client tried to send",
    });
    // Pull the data passed to update
    const updateCallArgs = accountProfileUpdateMock.mock.calls[0]?.[0] as
      | { data: Record<string, unknown> }
      | undefined;
    expect(updateCallArgs).toBeDefined();
    expect(updateCallArgs!.data.mailingSameAsPhysical).toBe(true);
    expect(updateCallArgs!.data.mailingAddress).toBeNull();
  });

  it("when mailingSameAsPhysical=true and no mailingAddress in payload, server still writes null", async () => {
    const caller = buildCaller();
    await caller.updateContact({ mailingSameAsPhysical: true });
    const updateCallArgs = accountProfileUpdateMock.mock.calls[0]?.[0] as
      | { data: Record<string, unknown> }
      | undefined;
    expect(updateCallArgs!.data.mailingSameAsPhysical).toBe(true);
    expect(updateCallArgs!.data.mailingAddress).toBeNull();
  });

  it("when mailingSameAsPhysical=false, server passes mailingAddress through unchanged", async () => {
    const caller = buildCaller();
    await caller.updateContact({
      mailingSameAsPhysical: false,
      mailingAddress: "PO Box 5, Vancouver, BC",
    });
    const updateCallArgs = accountProfileUpdateMock.mock.calls[0]?.[0] as
      | { data: Record<string, unknown> }
      | undefined;
    expect(updateCallArgs!.data.mailingSameAsPhysical).toBe(false);
    expect(updateCallArgs!.data.mailingAddress).toBe("PO Box 5, Vancouver, BC");
  });

  it("when mailingSameAsPhysical is absent from payload, no mailing-null injection (other fields untouched)", async () => {
    const caller = buildCaller();
    await caller.updateContact({ primaryPhone: "+15551234567" });
    const updateCallArgs = accountProfileUpdateMock.mock.calls[0]?.[0] as
      | { data: Record<string, unknown> }
      | undefined;
    expect(updateCallArgs!.data.primaryPhone).toBe("+15551234567");
    expect(updateCallArgs!.data).not.toHaveProperty("mailingAddress");
    expect(updateCallArgs!.data).not.toHaveProperty("mailingSameAsPhysical");
  });

  it("Zod still validates other fields (E.164 phone) — wrapper doesn't bypass schema", async () => {
    const caller = buildCaller();
    await expect(
      caller.updateContact({
        mailingSameAsPhysical: true,
        primaryPhone: "5551234567", // missing + prefix → E.164 reject
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(accountProfileUpdateMock).not.toHaveBeenCalled();
  });
});
