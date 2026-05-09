/**
 * KAN-859 — Cohort 4 backend touch: extend `account.get` to include
 * `legalDefaults: { optOutLanguage, emailFooterDisclosure, source }`
 * resolved via blueprint-loader's resolveLegalDefaults helper.
 *
 * Single approved backend change for Cohort 4 (Pre-flight item 4 →
 * Decision 1, Path (a)). Lets the Legal tab UI render "Blueprint
 * default" vs "Custom" badges without leaking Blueprint internals to
 * the client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  enrichLogoUrlsMock,
  accountProfileUpsertMock,
  tenantFindUniqueMock,
  getBlueprintForTenantMock,
  resolveLegalDefaultsMock,
} = vi.hoisted(() => ({
  enrichLogoUrlsMock: vi.fn(async (logoUrl: string | null) => ({
    logoUrl,
    logoVariants: null,
  })),
  accountProfileUpsertMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
  getBlueprintForTenantMock: vi.fn(),
  resolveLegalDefaultsMock: vi.fn(),
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
    publishAccountFieldUpdated: vi.fn(async () => ({ skipped: true })),
    accountEventsEnabled: vi.fn(() => false),
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

vi.mock(
  "../../../../packages/api/src/services/blueprint-loader.js",
  () => ({
    getBlueprintForTenant: (...args: unknown[]) =>
      (getBlueprintForTenantMock as (...a: unknown[]) => unknown)(...args),
    resolveLegalDefaults: (...args: unknown[]) =>
      (resolveLegalDefaultsMock as (...a: unknown[]) => unknown)(...args),
    GENERIC_BLUEPRINT: {
      legalDefaults: {
        en: {
          optOutLanguage: "Reply STOP to unsubscribe.",
          emailFooterDisclosure: "Default footer (en).",
        },
        fr: {
          optOutLanguage: "Répondez STOP pour vous désabonner.",
          emailFooterDisclosure: "Pied de page par défaut (fr).",
        },
      },
    },
  }),
);

import { accountRouter } from "../router.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";

const mockedPrisma = {
  accountProfile: {
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

const TENANT_BLUEPRINT = {
  legalDefaults: {
    en: {
      optOutLanguage: "Reply STOP to unsubscribe.",
      emailFooterDisclosure: "Default footer (en).",
    },
    fr: {
      optOutLanguage: "Répondez STOP pour vous désabonner.",
      emailFooterDisclosure: "Pied de page par défaut (fr).",
    },
  },
};

const PROFILE_BASE = {
  id: "ap1",
  tenantId: TENANT_A,
  legalName: "Acme",
  logoUrl: null,
  logoVariants: null,
  // Cohort 4 Legal columns
  optOutLanguage: null,
  emailFooterDisclosure: null,
  defaultLanguage: "en",
  // Cohort 1 child relations included on `account.get`
  socialProfiles: [],
  observedHolidays: [],
  industryDisclosures: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  tenantFindUniqueMock.mockResolvedValue({ name: "Acme" });
  accountProfileUpsertMock.mockResolvedValue(PROFILE_BASE);
  getBlueprintForTenantMock.mockResolvedValue(TENANT_BLUEPRINT);
  resolveLegalDefaultsMock.mockReturnValue({
    optOutLanguage: "Reply STOP to unsubscribe.",
    emailFooterDisclosure: "Default footer (en).",
    source: {
      optOutLanguage: "language",
      emailFooterDisclosure: "language",
    },
  });
});

describe("KAN-859 — account.get returns resolved Blueprint defaults (Path a)", () => {
  it("calls resolveLegalDefaults with the row's override fields + the loaded Blueprint", async () => {
    const caller = buildCaller();
    await caller.get();
    expect(resolveLegalDefaultsMock).toHaveBeenCalledWith({
      accountProfile: {
        optOutLanguage: null,
        emailFooterDisclosure: null,
        defaultLanguage: "en",
      },
      blueprint: TENANT_BLUEPRINT,
    });
  });

  it("includes legalDefaults in the response payload with shape { optOutLanguage, emailFooterDisclosure, source }", async () => {
    const caller = buildCaller();
    const result = (await caller.get()) as Record<string, unknown> & {
      legalDefaults: {
        optOutLanguage: string;
        emailFooterDisclosure: string;
        source: { optOutLanguage: string; emailFooterDisclosure: string };
      };
    };
    expect(result.legalDefaults).toBeDefined();
    expect(result.legalDefaults.optOutLanguage).toBe("Reply STOP to unsubscribe.");
    expect(result.legalDefaults.emailFooterDisclosure).toBe(
      "Default footer (en).",
    );
    expect(result.legalDefaults.source).toEqual({
      optOutLanguage: "language",
      emailFooterDisclosure: "language",
    });
  });

  it("falls back to GENERIC_BLUEPRINT when no Blueprint is loaded for the tenant", async () => {
    getBlueprintForTenantMock.mockResolvedValue(null);
    const caller = buildCaller();
    await caller.get();
    // resolveLegalDefaults should still get called — with the bundled
    // GENERIC_BLUEPRINT as the fallback.
    expect(resolveLegalDefaultsMock).toHaveBeenCalled();
    const callArg = resolveLegalDefaultsMock.mock.calls[0]?.[0] as {
      blueprint: { legalDefaults: unknown };
    };
    expect(callArg.blueprint.legalDefaults).toBeDefined();
    expect(
      (callArg.blueprint.legalDefaults as { en?: unknown }).en,
    ).toBeDefined();
  });

  it("threads the override values through when set (source: 'override')", async () => {
    accountProfileUpsertMock.mockResolvedValue({
      ...PROFILE_BASE,
      optOutLanguage: "My custom opt-out text.",
      emailFooterDisclosure: null,
    });
    resolveLegalDefaultsMock.mockReturnValue({
      optOutLanguage: "My custom opt-out text.",
      emailFooterDisclosure: "Default footer (en).",
      source: {
        optOutLanguage: "override",
        emailFooterDisclosure: "language",
      },
    });
    const caller = buildCaller();
    const result = (await caller.get()) as { legalDefaults: { source: { optOutLanguage: string } } };
    expect(resolveLegalDefaultsMock).toHaveBeenCalledWith({
      accountProfile: {
        optOutLanguage: "My custom opt-out text.",
        emailFooterDisclosure: null,
        defaultLanguage: "en",
      },
      blueprint: TENANT_BLUEPRINT,
    });
    expect(result.legalDefaults.source.optOutLanguage).toBe("override");
  });

  it("preserves the existing AccountProfile fields + child relations alongside legalDefaults", async () => {
    const caller = buildCaller();
    const result = (await caller.get()) as Record<string, unknown>;
    expect(result.id).toBe("ap1");
    expect(result.tenantId).toBe(TENANT_A);
    expect(result.legalName).toBe("Acme");
    expect(result.socialProfiles).toEqual([]);
    expect(result.observedHolidays).toEqual([]);
    expect(result.industryDisclosures).toEqual([]);
    expect(result.legalDefaults).toBeDefined();
  });
});
