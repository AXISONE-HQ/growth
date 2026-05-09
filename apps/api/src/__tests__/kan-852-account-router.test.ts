/**
 * KAN-852 — Account Page Cohort 1 router integration tests.
 *
 * Builds a caller against the exported `accountRouter` with a mocked
 * Prisma client + mocked publisher module. Exercises the spec §11
 * required surface:
 *
 *   - Each mutation: success path, validation error, tenant-isolation
 *     enforced (provision-on-first-touch creates row scoped to ctx.tenantId)
 *   - Pub/Sub: with ACCOUNT_EVENTS_ENABLED=false the publisher mock is NOT
 *     invoked; with true it IS invoked with the exact §5 payload shape
 *
 * Mirrors the `vi.mock` + `vi.hoisted` pattern from
 * knowledge-ingestion-route-and-push.test.ts so the publisher mock is in
 * place before the dynamic-import inside accountRouter resolves.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ─────────────────────────────────────────────
// Hoisted mocks — must appear above import of accountRouter so the
// dynamic spec resolution lands on the mock module.
// ─────────────────────────────────────────────

const {
  publishMock,
  accountEventsEnabledMock,
  accountProfileFindUniqueMock,
  accountProfileCreateMock,
  accountProfileUpdateMock,
  accountProfileUpsertMock,
  tenantFindUniqueMock,
  observedHolidayCreateMock,
  observedHolidayDeleteManyMock,
  socialProfileFindFirstMock,
  socialProfileCreateMock,
  socialProfileDeleteManyMock,
  industryDisclosureFindFirstMock,
  industryDisclosureCreateMock,
  industryDisclosureDeleteManyMock,
  // KAN-855 — logo storage stubs. Default no-op so Cohort 1 tests don't
  // accidentally hit GCS via the new account.get → enrichLogoUrls path.
  enrichLogoUrlsMock,
} = vi.hoisted(() => ({
  publishMock: vi.fn(async () => ({ messageId: "test-msg-id", skipped: false })),
  accountEventsEnabledMock: vi.fn(() => false),
  accountProfileFindUniqueMock: vi.fn(),
  accountProfileCreateMock: vi.fn(),
  accountProfileUpdateMock: vi.fn(),
  accountProfileUpsertMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
  observedHolidayCreateMock: vi.fn(),
  observedHolidayDeleteManyMock: vi.fn(),
  socialProfileFindFirstMock: vi.fn(),
  socialProfileCreateMock: vi.fn(),
  socialProfileDeleteManyMock: vi.fn(),
  industryDisclosureFindFirstMock: vi.fn(),
  industryDisclosureCreateMock: vi.fn(),
  industryDisclosureDeleteManyMock: vi.fn(),
  enrichLogoUrlsMock: vi.fn(async (logoUrl: string | null, _v: unknown) => ({
    logoUrl,
    logoVariants: null,
  })),
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

// KAN-855 — stub the logo storage module so Cohort 1 router tests don't
// touch GCS via the new account.get → enrichLogoUrls hook.
vi.mock(
  "../../../../packages/api/src/services/account-logo-storage.js",
  () => ({
    enrichLogoUrls: (logoUrl: string | null, v: unknown) =>
      (enrichLogoUrlsMock as (...a: unknown[]) => unknown)(logoUrl, v),
    isOwnedByTenant: (objectName: string, tenantId: string) =>
      objectName.startsWith(`tenants/${tenantId}/account/logo-`),
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

// KAN-859 — stub the blueprint-loader module so Cohort 1 router tests
// don't hit prisma.brainSnapshot via the new account.get → resolveLegalDefaults
// path. The legalDefaults shape is exercised in
// kan-859-account-get-legal-defaults.test.ts; this stub just keeps the
// Cohort 1 surface contract intact.
vi.mock(
  "../../../../packages/api/src/services/blueprint-loader.js",
  () => ({
    getBlueprintForTenant: vi.fn(async () => ({
      legalDefaults: {
        en: {
          optOutLanguage: "Reply STOP to unsubscribe.",
          emailFooterDisclosure: "Default footer (en).",
        },
      },
    })),
    resolveLegalDefaults: vi.fn(() => ({
      optOutLanguage: "Reply STOP to unsubscribe.",
      emailFooterDisclosure: "Default footer (en).",
      source: {
        optOutLanguage: "language",
        emailFooterDisclosure: "language",
      },
    })),
    GENERIC_BLUEPRINT: {
      legalDefaults: {
        en: {
          optOutLanguage: "Reply STOP to unsubscribe.",
          emailFooterDisclosure: "Default footer (en).",
        },
      },
    },
  }),
);

import { accountRouter } from "../router.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

// The router reads `ctx.prisma` directly (cast-loose pattern), so we
// inject the mocked client through context — no vi.mock on '../prisma.js'
// needed. Keeps the test surface matched to actual call shape.
const mockedPrisma = {
  accountProfile: {
    findUnique: (...args: unknown[]) =>
      (accountProfileFindUniqueMock as (...a: unknown[]) => unknown)(...args),
    create: (...args: unknown[]) =>
      (accountProfileCreateMock as (...a: unknown[]) => unknown)(...args),
    update: (...args: unknown[]) =>
      (accountProfileUpdateMock as (...a: unknown[]) => unknown)(...args),
    upsert: (...args: unknown[]) =>
      (accountProfileUpsertMock as (...a: unknown[]) => unknown)(...args),
  },
  tenant: {
    findUnique: (...args: unknown[]) =>
      (tenantFindUniqueMock as (...a: unknown[]) => unknown)(...args),
  },
  observedHoliday: {
    create: (...args: unknown[]) =>
      (observedHolidayCreateMock as (...a: unknown[]) => unknown)(...args),
    deleteMany: (...args: unknown[]) =>
      (observedHolidayDeleteManyMock as (...a: unknown[]) => unknown)(...args),
  },
  socialProfile: {
    findFirst: (...args: unknown[]) =>
      (socialProfileFindFirstMock as (...a: unknown[]) => unknown)(...args),
    create: (...args: unknown[]) =>
      (socialProfileCreateMock as (...a: unknown[]) => unknown)(...args),
    deleteMany: (...args: unknown[]) =>
      (socialProfileDeleteManyMock as (...a: unknown[]) => unknown)(...args),
  },
  industryDisclosure: {
    findFirst: (...args: unknown[]) =>
      (industryDisclosureFindFirstMock as (...a: unknown[]) => unknown)(...args),
    create: (...args: unknown[]) =>
      (industryDisclosureCreateMock as (...a: unknown[]) => unknown)(...args),
    deleteMany: (...args: unknown[]) =>
      (industryDisclosureDeleteManyMock as (...a: unknown[]) => unknown)(...args),
  },
};

function buildCaller(opts: { tenantId?: string; uid?: string } = {}) {
  const ctx = {
    prisma: mockedPrisma as unknown,
    tenantId: opts.tenantId ?? TENANT_A,
    firebaseUser: opts.uid ? { uid: opts.uid, email: "test@example.com" } : null,
  } as Parameters<typeof accountRouter.createCaller>[0];
  return accountRouter.createCaller(ctx);
}

const BASE_PROFILE = {
  id: "ap_seed_1",
  tenantId: TENANT_A,
  legalName: "Acme Inc.",
  displayName: null,
  websiteUrl: null,
  oneLineDescription: null,
  industry: null,
  primaryPhone: null,
  primaryEmail: null,
  weeklyHours: {},
  defaultCurrency: "USD",
  additionalCurrencies: [],
  defaultLanguage: "en",
  supportedLanguages: ["en"],
  socialProfiles: [],
  observedHolidays: [],
  industryDisclosures: [],
};

beforeEach(() => {
  publishMock.mockClear();
  accountEventsEnabledMock.mockReset();
  accountEventsEnabledMock.mockReturnValue(false); // default off per spec
  accountProfileFindUniqueMock.mockReset();
  accountProfileCreateMock.mockReset();
  accountProfileUpdateMock.mockReset();
  accountProfileUpsertMock.mockReset();
  tenantFindUniqueMock.mockReset();
  observedHolidayCreateMock.mockReset();
  observedHolidayDeleteManyMock.mockReset();
  socialProfileFindFirstMock.mockReset();
  socialProfileCreateMock.mockReset();
  socialProfileDeleteManyMock.mockReset();
  industryDisclosureFindFirstMock.mockReset();
  industryDisclosureCreateMock.mockReset();
  industryDisclosureDeleteManyMock.mockReset();
  enrichLogoUrlsMock.mockClear();
});

// ─────────────────────────────────────────────
// get — provision-on-first-touch
// ─────────────────────────────────────────────

describe("accountRouter.get", () => {
  // KAN-855 (Cohort 2 / Fred E.4): get switched from findUnique +
  // conditional create to upsert (race-safety on concurrent first-touch).
  it("returns existing AccountProfile via upsert (where match) — idempotent on second call", async () => {
    tenantFindUniqueMock.mockResolvedValue({ name: "Acme Inc." });
    accountProfileUpsertMock.mockResolvedValue(BASE_PROFILE);
    const caller = buildCaller();
    const out = await caller.get();
    expect(out).toMatchObject({ id: BASE_PROFILE.id });
    expect(accountProfileUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT_A } }),
    );
    // Calling twice returns the same row — race-safe; no duplicate
    // create attempt.
    await caller.get();
    expect(accountProfileUpsertMock).toHaveBeenCalledTimes(2);
    expect(accountProfileCreateMock).not.toHaveBeenCalled();
  });

  it("provisions on first touch using Tenant.name as legalName (via upsert.create branch)", async () => {
    tenantFindUniqueMock.mockResolvedValue({ name: "Acme Inc." });
    accountProfileUpsertMock.mockResolvedValue({ ...BASE_PROFILE, legalName: "Acme Inc." });
    const caller = buildCaller();
    await caller.get();
    expect(accountProfileUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_A },
        create: { tenantId: TENANT_A, legalName: "Acme Inc." },
        update: {},
      }),
    );
  });

  it("throws NOT_FOUND when tenant row is missing", async () => {
    tenantFindUniqueMock.mockResolvedValue(null);
    const caller = buildCaller();
    await expect(caller.get()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(accountProfileUpsertMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// updateIdentity — happy path + validation + Pub/Sub gating
// ─────────────────────────────────────────────

describe("accountRouter.updateIdentity", () => {
  it("rejects http:// websiteUrl at the schema boundary", async () => {
    const caller = buildCaller();
    await expect(
      caller.updateIdentity({ websiteUrl: "http://acme.com" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(accountProfileUpdateMock).not.toHaveBeenCalled();
  });

  it("with ACCOUNT_EVENTS_ENABLED=false — publisher is NOT called", async () => {
    accountEventsEnabledMock.mockReturnValue(false);
    accountProfileFindUniqueMock.mockResolvedValue({ ...BASE_PROFILE });
    accountProfileUpdateMock.mockResolvedValue({ ...BASE_PROFILE, legalName: "New Name" });
    const caller = buildCaller({ uid: "user-abc" });
    await caller.updateIdentity({ legalName: "New Name" });
    expect(accountProfileUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_A },
        data: { legalName: "New Name" },
      }),
    );
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("with ACCOUNT_EVENTS_ENABLED=true — publisher IS called with §5 payload shape", async () => {
    accountEventsEnabledMock.mockReturnValue(true);
    accountProfileFindUniqueMock.mockResolvedValue({ ...BASE_PROFILE, legalName: "Old Name" });
    accountProfileUpdateMock.mockResolvedValue({ ...BASE_PROFILE, legalName: "New Name" });
    const caller = buildCaller({ uid: "user-abc" });
    await caller.updateIdentity({ legalName: "New Name" });
    expect(publishMock).toHaveBeenCalledTimes(1);
    const event = publishMock.mock.calls[0][0] as Record<string, unknown>;
    expect(event).toMatchObject({
      eventType: "account.field_updated",
      version: "1.0",
      tenantId: TENANT_A,
      fieldPath: "legalName",
      oldValue: "Old Name",
      newValue: "New Name",
      source: "human",
      userId: "user-abc",
    });
    expect(typeof event.eventId).toBe("string");
    expect(typeof event.publishedAt).toBe("string");
  });

  it("emits one event per changed field on a multi-field update", async () => {
    accountEventsEnabledMock.mockReturnValue(true);
    accountProfileFindUniqueMock.mockResolvedValue({
      ...BASE_PROFILE,
      legalName: "Old",
      displayName: null,
      websiteUrl: null,
    });
    accountProfileUpdateMock.mockResolvedValue({ ...BASE_PROFILE });
    const caller = buildCaller({ uid: "user-abc" });
    await caller.updateIdentity({
      legalName: "New",
      displayName: "Acme",
      websiteUrl: "https://acme.com",
    });
    const paths = publishMock.mock.calls.map((c) => (c[0] as { fieldPath: string }).fieldPath);
    expect(paths.sort()).toEqual(["displayName", "legalName", "websiteUrl"]);
  });

  it("does NOT publish when no field actually changed", async () => {
    accountEventsEnabledMock.mockReturnValue(true);
    accountProfileFindUniqueMock.mockResolvedValue({ ...BASE_PROFILE, legalName: "Same" });
    accountProfileUpdateMock.mockResolvedValue({ ...BASE_PROFILE, legalName: "Same" });
    const caller = buildCaller({ uid: "user-abc" });
    await caller.updateIdentity({ legalName: "Same" });
    expect(publishMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// updatePayments — cross-field validation
// ─────────────────────────────────────────────

describe("accountRouter.updatePayments — cross-field invariants", () => {
  it("rejects additionalCurrencies that include defaultCurrency", async () => {
    const caller = buildCaller();
    await expect(
      caller.updatePayments({
        defaultCurrency: "USD",
        additionalCurrencies: ["USD", "EUR"],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(accountProfileUpdateMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// updateHours — IANA + per-day open<close
// ─────────────────────────────────────────────

describe("accountRouter.updateHours", () => {
  it("rejects invalid IANA time zone", async () => {
    const caller = buildCaller();
    await expect(
      caller.updateHours({ timeZone: "Mars/Olympus_Mons" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects open >= close on any day", async () => {
    const caller = buildCaller();
    await expect(
      caller.updateHours({
        weeklyHours: {
          monday: { closed: false, open: "17:00", close: "09:00" },
          tuesday: { closed: true },
          wednesday: { closed: true },
          thursday: { closed: true },
          friday: { closed: true },
          saturday: { closed: true },
          sunday: { closed: true },
        },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ─────────────────────────────────────────────
// updateLegal — supportedLanguages contains defaultLanguage
// ─────────────────────────────────────────────

describe("accountRouter.updateLegal — language invariant", () => {
  it("rejects when supportedLanguages omits defaultLanguage", async () => {
    const caller = buildCaller();
    await expect(
      caller.updateLegal({ defaultLanguage: "en", supportedLanguages: ["fr"] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ─────────────────────────────────────────────
// Holiday CRUD — FK-transitive tenant scope
// ─────────────────────────────────────────────

describe("accountRouter.addHoliday / removeHoliday", () => {
  it("addHoliday — provisions parent profile lookup, then writes", async () => {
    accountProfileFindUniqueMock.mockResolvedValue({ id: "ap1" });
    observedHolidayCreateMock.mockResolvedValue({
      id: "h1",
      accountProfileId: "ap1",
      name: "Christmas",
      date: new Date("2026-12-25"),
      recurring: true,
    });
    const caller = buildCaller();
    const out = await caller.addHoliday({
      name: "Christmas",
      date: "2026-12-25",
      recurring: true,
    });
    expect(observedHolidayCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountProfileId: "ap1",
        name: "Christmas",
        recurring: true,
      }),
    });
    expect(out).toMatchObject({ id: "h1" });
  });

  it("addHoliday rejects malformed date", async () => {
    const caller = buildCaller();
    await expect(
      caller.addHoliday({ name: "Christmas", date: "12/25/2026", recurring: false }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("removeHoliday — deletes only when accountProfile.tenantId matches", async () => {
    observedHolidayDeleteManyMock.mockResolvedValue({ count: 1 });
    const caller = buildCaller();
    await caller.removeHoliday({ id: "h1" });
    expect(observedHolidayDeleteManyMock).toHaveBeenCalledWith({
      where: { id: "h1", accountProfile: { tenantId: TENANT_A } },
    });
  });

  it("removeHoliday throws NOT_FOUND when tenant FK chain mismatches (cross-tenant safety)", async () => {
    observedHolidayDeleteManyMock.mockResolvedValue({ count: 0 });
    const caller = buildCaller({ tenantId: TENANT_B });
    await expect(caller.removeHoliday({ id: "h-belongs-to-A" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

// ─────────────────────────────────────────────
// Social profile + disclosure — same FK-transitive shape
// ─────────────────────────────────────────────

describe("accountRouter.addSocialProfile / removeSocialProfile", () => {
  it("addSocialProfile auto-positions at end + 1", async () => {
    accountProfileFindUniqueMock.mockResolvedValue({ id: "ap1" });
    socialProfileFindFirstMock.mockResolvedValue({ position: 3 });
    socialProfileCreateMock.mockResolvedValue({ id: "sp1" });
    const caller = buildCaller();
    await caller.addSocialProfile({
      platform: "linkedin",
      url: "https://linkedin.com/in/acme",
    });
    expect(socialProfileCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountProfileId: "ap1",
        platform: "linkedin",
        position: 4,
      }),
    });
  });

  it("removeSocialProfile NOT_FOUND when cross-tenant", async () => {
    socialProfileDeleteManyMock.mockResolvedValue({ count: 0 });
    const caller = buildCaller({ tenantId: TENANT_B });
    await expect(caller.removeSocialProfile({ id: "sp1" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("accountRouter.addDisclosure / removeDisclosure", () => {
  it("addDisclosure rejects unknown channel", async () => {
    const caller = buildCaller();
    await expect(
      caller.addDisclosure({
        label: "FINRA",
        body: "Required text",
        appliesToChannels: ["fax"] as unknown as Array<"email" | "sms" | "whatsapp">,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("removeDisclosure NOT_FOUND when cross-tenant", async () => {
    industryDisclosureDeleteManyMock.mockResolvedValue({ count: 0 });
    const caller = buildCaller({ tenantId: TENANT_B });
    await expect(caller.removeDisclosure({ id: "d1" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

// ─────────────────────────────────────────────
// Tenant-isolation structural guarantee
// ─────────────────────────────────────────────

describe("KAN-852 — tenant-isolation invariants", () => {
  it("get's upsert targets the row by { tenantId: ctx.tenantId } (not by id)", async () => {
    tenantFindUniqueMock.mockResolvedValue({ name: "Acme Inc." });
    accountProfileUpsertMock.mockResolvedValue(BASE_PROFILE);
    const caller = buildCaller();
    await caller.get();
    expect(accountProfileUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT_A } }),
    );
  });

  it("update mutations target the row by tenantId, never by id", async () => {
    accountProfileFindUniqueMock.mockResolvedValue({ ...BASE_PROFILE });
    accountProfileUpdateMock.mockResolvedValue({ ...BASE_PROFILE });
    const caller = buildCaller();
    await caller.updateContact({ primaryPhone: "+15551234567" });
    expect(accountProfileUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT_A } }),
    );
  });
});
