/**
 * KAN-862 — Account Page Cohort 5: detect-from-website pipeline tests.
 *
 * Coverage:
 *   - Hardcoded prompt + tool schema invariants (field-name pin per
 *     KAN-817 Group 4 pattern)
 *   - HTML cleaning (strip script/style/nav/footer, preserve content)
 *   - Page discovery: anchor extraction + URL-pattern fallback
 *   - Rate-limit helper (1/tenant/60s, fail-open on Redis error)
 *   - Extractor: tool_use parse + per-field Zod validation + invalid-row drop
 *   - Router mutations: detectFromWebsite enqueues + publishes
 *   - Router mutations: acceptDetection writes through + audit metadata
 *   - Router mutations: rejectDetection marks rejected (no profile write)
 *   - Tenant isolation on all mutation surfaces
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ────────── Hoisted mocks ──────────
const {
  publishMock,
  accountEventsEnabledMock,
  accountProfileFindUniqueMock,
  accountProfileUpdateMock,
  accountProfileUpdateManyMock,
  accountFieldDetectionFindFirstMock,
  accountFieldDetectionFindManyMock,
  accountFieldDetectionUpdateMock,
  accountFieldDetectionUpdateManyMock,
  accountFieldDetectionCreateMock,
  tenantFindUniqueMock,
  enrichLogoUrlsMock,
  redisIncrMock,
  redisExpireMock,
  enqueueTaskMock,
  publishStartedMock,
} = vi.hoisted(() => ({
  publishMock: vi.fn(async () => ({ messageId: "msg", skipped: false })),
  accountEventsEnabledMock: vi.fn(() => false),
  accountProfileFindUniqueMock: vi.fn(),
  accountProfileUpdateMock: vi.fn(),
  accountProfileUpdateManyMock: vi.fn(),
  accountFieldDetectionFindFirstMock: vi.fn(),
  accountFieldDetectionFindManyMock: vi.fn(),
  accountFieldDetectionUpdateMock: vi.fn(),
  accountFieldDetectionUpdateManyMock: vi.fn(),
  accountFieldDetectionCreateMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
  enrichLogoUrlsMock: vi.fn(async (logoUrl: string | null) => ({
    logoUrl,
    logoVariants: null,
  })),
  redisIncrMock: vi.fn(async () => 1),
  redisExpireMock: vi.fn(async () => 1),
  enqueueTaskMock: vi.fn(async () => ({ taskName: "projects/x/locations/us/queues/account-detect/tasks/y" })),
  publishStartedMock: vi.fn(async () => undefined),
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
vi.mock(
  "../../../../packages/api/src/services/blueprint-loader.js",
  () => ({
    getBlueprintForTenant: vi.fn(async () => ({
      legalDefaults: { en: { optOutLanguage: "x", emailFooterDisclosure: "y" } },
    })),
    resolveLegalDefaults: vi.fn(() => ({
      optOutLanguage: "x",
      emailFooterDisclosure: "y",
      source: { optOutLanguage: "language", emailFooterDisclosure: "language" },
    })),
    GENERIC_BLUEPRINT: { legalDefaults: { en: { optOutLanguage: "x", emailFooterDisclosure: "y" } } },
  }),
);
// Cloud Tasks client mock — return a deterministic taskName.
vi.mock("../services/account-detect-tasks-client.js", () => ({
  enqueueAccountDetectTask: (body: unknown) => enqueueTaskMock(body),
  __setTasksClientForTest: vi.fn(),
}));
// Pub/Sub publishers mock — count + capture publish calls.
vi.mock("../services/account-detect-publishers.js", () => ({
  publishDetectStarted: (event: unknown) => publishStartedMock(event),
  publishDetectProgress: vi.fn(async () => undefined),
  publishDetectCompleted: vi.fn(async () => undefined),
  publishDetectFailed: vi.fn(async () => undefined),
  publishDetectDeadLetter: vi.fn(async () => undefined),
  ACCOUNT_DETECT_TOPICS: {
    started: "account.detect_started",
    progress: "account.detect_progress",
    completed: "account.detect_completed",
    failed: "account.detect_failed",
    deadLetter: "account.detect_dead_letter",
  },
  __setAccountDetectPubsubForTest: vi.fn(),
}));
// ioredis singleton mock — patch the redis-client module.
vi.mock("../services/redis-client.js", () => ({
  getRedisClient: () => ({
    incr: redisIncrMock,
    expire: redisExpireMock,
  }),
  __setRedisClientForTest: vi.fn(),
}));

import { accountRouter } from "../router.js";
import {
  ACCOUNT_DETECT_FIELD_NAMES,
  ACCOUNT_DETECT_TOOL,
  ACCOUNT_DETECT_PROMPT_V1,
  getAccountDetectPrompt,
} from "../services/account-detect-prompt.js";
import {
  cleanHtml,
  _internalForTest,
} from "../services/account-detect-html-fetcher.js";
import { checkAccountDetectRateLimit } from "../services/account-detect-rate-limit.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

const mockedPrisma = {
  accountProfile: {
    findUnique: (...args: unknown[]) =>
      (accountProfileFindUniqueMock as (...a: unknown[]) => unknown)(...args),
    update: (...args: unknown[]) =>
      (accountProfileUpdateMock as (...a: unknown[]) => unknown)(...args),
    updateMany: (...args: unknown[]) =>
      (accountProfileUpdateManyMock as (...a: unknown[]) => unknown)(...args),
    upsert: vi.fn(),
  },
  accountFieldDetection: {
    findFirst: (...args: unknown[]) =>
      (accountFieldDetectionFindFirstMock as (...a: unknown[]) => unknown)(...args),
    findMany: (...args: unknown[]) =>
      (accountFieldDetectionFindManyMock as (...a: unknown[]) => unknown)(...args),
    update: (...args: unknown[]) =>
      (accountFieldDetectionUpdateMock as (...a: unknown[]) => unknown)(...args),
    updateMany: (...args: unknown[]) =>
      (accountFieldDetectionUpdateManyMock as (...a: unknown[]) => unknown)(...args),
    create: (...args: unknown[]) =>
      (accountFieldDetectionCreateMock as (...a: unknown[]) => unknown)(...args),
  },
  tenant: {
    findUnique: (...args: unknown[]) =>
      (tenantFindUniqueMock as (...a: unknown[]) => unknown)(...args),
  },
};

function buildCaller(tenantId: string = TENANT_A) {
  const ctx = {
    prisma: mockedPrisma as unknown,
    tenantId,
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
};

beforeEach(() => {
  vi.clearAllMocks();
  accountProfileFindUniqueMock.mockResolvedValue(PROFILE_BASE);
  accountProfileUpdateMock.mockImplementation(async (args: unknown) => {
    const data = (args as { data: Record<string, unknown> }).data;
    return { ...PROFILE_BASE, ...data };
  });
  accountProfileUpdateManyMock.mockResolvedValue({ count: 1 });
  enrichLogoUrlsMock.mockImplementation(async (logoUrl: string | null) => ({
    logoUrl,
    logoVariants: null,
  }));
  redisIncrMock.mockResolvedValue(1);
  enqueueTaskMock.mockResolvedValue({ taskName: "projects/x/locations/us/queues/account-detect/tasks/y" });
  publishStartedMock.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────
// Hardcoded prompt + tool-schema invariants (field-name pin)
// ─────────────────────────────────────────────────────────────────

describe("KAN-862 — prompt + tool schema invariants", () => {
  it("ACCOUNT_DETECT_FIELD_NAMES includes the spec §6 field set verbatim", () => {
    // Pin against silent typo regression — if someone edits the constant
    // by mistake, tests fail loud rather than the worker silently dropping
    // the renamed field on extraction.
    expect([...ACCOUNT_DETECT_FIELD_NAMES]).toEqual([
      "legalName",
      "displayName",
      "oneLineDescription",
      "primaryPhone",
      "primaryEmail",
      "physicalAddress",
      "weeklyHours",
      "acceptedPaymentMethods",
      "socialProfiles",
    ]);
  });

  it("ACCOUNT_DETECT_TOOL.input_schema declares the same field enum as the constant", () => {
    const props = ACCOUNT_DETECT_TOOL.input_schema as {
      properties: { fields: { items: { properties: { fieldName: { enum: string[] } } } } };
    };
    expect(props.properties.fields.items.properties.fieldName.enum).toEqual([
      ...ACCOUNT_DETECT_FIELD_NAMES,
    ]);
  });

  it("getAccountDetectPrompt() returns both the system prompt + tool together", () => {
    const got = getAccountDetectPrompt();
    expect(got.systemPrompt).toBe(ACCOUNT_DETECT_PROMPT_V1);
    expect(got.tool).toBe(ACCOUNT_DETECT_TOOL);
  });

  it("system prompt includes the safe-extraction posture rule", () => {
    expect(ACCOUNT_DETECT_PROMPT_V1).toMatch(/omit it entirely/i);
    expect(ACCOUNT_DETECT_PROMPT_V1).toMatch(/Don't fabricate/i);
  });
});

// ─────────────────────────────────────────────────────────────────
// HTML cleaning + link extraction
// ─────────────────────────────────────────────────────────────────

describe("KAN-862 — HTML cleaning", () => {
  it("strips script/style/nav/footer/aside content", () => {
    const html = `
      <html><head><style>.x{color:red}</style></head>
      <body>
        <nav>Home About Contact</nav>
        <main>Welcome to Acme. Best widgets in town.</main>
        <aside>Sidebar ad</aside>
        <footer>© 2026</footer>
        <script>alert('x')</script>
      </body></html>
    `;
    const cleaned = cleanHtml(html);
    expect(cleaned).toMatch(/Welcome to Acme/);
    expect(cleaned).not.toMatch(/alert/);
    expect(cleaned).not.toMatch(/Sidebar ad/);
    expect(cleaned).not.toMatch(/©/);
    expect(cleaned).not.toMatch(/\.x\{color/);
  });

  it("prefers <main> over <body> when present", () => {
    const html = `<body>BODY TEXT<main>MAIN TEXT</main></body>`;
    expect(cleanHtml(html)).toMatch(/MAIN TEXT/);
    expect(cleanHtml(html)).not.toMatch(/BODY TEXT/);
  });

  it("collapses excessive whitespace", () => {
    const html = `<body>line one\n\n\n  line two   \t\t  line three</body>`;
    const out = cleanHtml(html);
    expect(out).not.toMatch(/\n\n\n/);
    expect(out).not.toMatch(/   line two/);
  });
});

describe("KAN-862 — page discovery patterns", () => {
  it("RELEVANT_LINK_REGEX matches common about/contact/team paths case-insensitively", () => {
    const re = _internalForTest.RELEVANT_LINK_REGEX;
    expect(re.test("/about")).toBe(true);
    expect(re.test("/About-Us")).toBe(true);
    expect(re.test("/contact-us")).toBe(true);
    expect(re.test("/team")).toBe(true);
    expect(re.test("/about?utm=x")).toBe(true);
    expect(re.test("/services/new")).toBe(false);
    expect(re.test("/blog")).toBe(false);
  });

  it("FALLBACK_PATTERNS covers the canonical 5", () => {
    expect(_internalForTest.FALLBACK_PATTERNS).toEqual([
      "/about",
      "/about-us",
      "/contact",
      "/contact-us",
      "/team",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────
// Rate-limit helper
// ─────────────────────────────────────────────────────────────────

describe("KAN-862 — account-detect rate limit", () => {
  it("first call within window: allowed=true (count=1)", async () => {
    redisIncrMock.mockResolvedValueOnce(1);
    const result = await checkAccountDetectRateLimit(TENANT_A);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(1);
  });

  it("second call within window: allowed=false (count=2)", async () => {
    redisIncrMock.mockResolvedValueOnce(2);
    const result = await checkAccountDetectRateLimit(TENANT_A);
    expect(result.allowed).toBe(false);
  });

  it("Redis throw → fail-open (allowed=true)", async () => {
    redisIncrMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await checkAccountDetectRateLimit(TENANT_A);
    expect(result.allowed).toBe(true);
    consoleErrorSpy.mockRestore();
  });

  it("only sets EXPIRE on the first INCR (count=1)", async () => {
    redisIncrMock.mockResolvedValueOnce(1);
    await checkAccountDetectRateLimit(TENANT_A);
    expect(redisExpireMock).toHaveBeenCalled();
    redisIncrMock.mockResolvedValueOnce(2);
    redisExpireMock.mockClear();
    await checkAccountDetectRateLimit(TENANT_A);
    expect(redisExpireMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// Router mutations
// ─────────────────────────────────────────────────────────────────

describe("KAN-862 — detectFromWebsite mutation", () => {
  it("rate-limit miss: throws TOO_MANY_REQUESTS, no enqueue, no publish", async () => {
    redisIncrMock.mockResolvedValueOnce(2); // already used the slot
    const caller = buildCaller();
    await expect(
      caller.detectFromWebsite({ websiteUrl: "https://acme.example.com" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(enqueueTaskMock).not.toHaveBeenCalled();
    expect(publishStartedMock).not.toHaveBeenCalled();
  });

  it("happy path: enqueues Cloud Task with tenantId+jobId+websiteUrl, publishes account.detect_started, returns jobId", async () => {
    redisIncrMock.mockResolvedValueOnce(1);
    const caller = buildCaller();
    const result = await caller.detectFromWebsite({
      websiteUrl: "https://acme.example.com",
    });
    expect(typeof result.jobId).toBe("string");
    expect(result.jobId.length).toBeGreaterThan(10);
    expect(result.estimatedSeconds).toBe(12);
    expect(enqueueTaskMock).toHaveBeenCalledTimes(1);
    const taskArg = enqueueTaskMock.mock.calls[0]?.[0] as {
      tenantId: string;
      jobId: string;
      websiteUrl: string;
    };
    expect(taskArg.tenantId).toBe(TENANT_A);
    expect(taskArg.websiteUrl).toBe("https://acme.example.com");
    expect(taskArg.jobId).toBe(result.jobId);
    expect(publishStartedMock).toHaveBeenCalledTimes(1);
    const publishArg = publishStartedMock.mock.calls[0]?.[0] as {
      tenantId: string;
      jobId: string;
    };
    expect(publishArg.tenantId).toBe(TENANT_A);
    expect(publishArg.jobId).toBe(result.jobId);
  });

  it("rejects malformed URL via Zod (TRPC BAD_REQUEST), no rate-limit consumed", async () => {
    const caller = buildCaller();
    await expect(
      caller.detectFromWebsite({ websiteUrl: "not-a-url" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(redisIncrMock).not.toHaveBeenCalled();
  });
});

describe("KAN-862 — getDetectionProposals query", () => {
  it("returns empty when AccountProfile is missing", async () => {
    accountProfileFindUniqueMock.mockResolvedValueOnce(null);
    const result = await buildCaller().getDetectionProposals();
    expect(result.proposals).toEqual([]);
  });

  it("returns proposed-status rows for tenant only, ordered by createdAt asc", async () => {
    accountProfileFindUniqueMock.mockResolvedValueOnce({ id: "ap1" });
    accountFieldDetectionFindManyMock.mockResolvedValueOnce([
      { id: "d1", fieldPath: "primaryPhone", proposedValue: '"+15551234567"', confidence: 0.92, sourceUrl: "u", sourceSnippet: "s", createdAt: new Date(0) },
      { id: "d2", fieldPath: "legalName", proposedValue: '"Acme Inc"', confidence: 0.95, sourceUrl: "u", sourceSnippet: "s", createdAt: new Date(1) },
    ]);
    const result = await buildCaller().getDetectionProposals();
    expect(result.proposals.length).toBe(2);
    const findManyCall = accountFieldDetectionFindManyMock.mock.calls[0]?.[0] as {
      where: { accountProfileId: string; status: string };
      orderBy: { createdAt: string };
    };
    expect(findManyCall.where.accountProfileId).toBe("ap1");
    expect(findManyCall.where.status).toBe("proposed");
    expect(findManyCall.orderBy.createdAt).toBe("asc");
  });
});

describe("KAN-862 — acceptDetection mutation", () => {
  it("happy path: writes proposed value via _applyAccountUpdate + marks accepted with audit metadata", async () => {
    accountFieldDetectionFindFirstMock.mockResolvedValueOnce({
      id: "d1",
      fieldPath: "primaryPhone",
      proposedValue: '"+15551234567"',
      accountProfileId: "ap1",
    });
    await buildCaller().acceptDetection({ detectionId: "d1" });
    // _applyAccountUpdate uses prisma.accountProfile.update — verify the
    // detected field/value made it through.
    const updateCall = accountProfileUpdateMock.mock.calls[0]?.[0] as
      | { data: Record<string, unknown> }
      | undefined;
    expect(updateCall?.data.primaryPhone).toBe("+15551234567");
    // Detection row marked accepted with decidedAt + decidedBy
    const detectionUpdate = accountFieldDetectionUpdateMock.mock.calls[0]?.[0] as
      | { where: { id: string }; data: { status: string; decidedBy: string; decidedAt: Date } }
      | undefined;
    expect(detectionUpdate?.where.id).toBe("d1");
    expect(detectionUpdate?.data.status).toBe("accepted");
    expect(detectionUpdate?.data.decidedBy).toBe("user-x");
    expect(detectionUpdate?.data.decidedAt).toBeInstanceOf(Date);
  });

  it("not found (wrong tenant) → NOT_FOUND, no profile write", async () => {
    accountFieldDetectionFindFirstMock.mockResolvedValueOnce(null);
    await expect(
      buildCaller(TENANT_B).acceptDetection({ detectionId: "d-other-tenant" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(accountProfileUpdateMock).not.toHaveBeenCalled();
  });

  it("malformed proposedValue (not JSON) → INTERNAL_SERVER_ERROR, no profile write", async () => {
    accountFieldDetectionFindFirstMock.mockResolvedValueOnce({
      id: "d1",
      fieldPath: "primaryPhone",
      proposedValue: "this-is-not-json",
      accountProfileId: "ap1",
    });
    await expect(
      buildCaller().acceptDetection({ detectionId: "d1" }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(accountProfileUpdateMock).not.toHaveBeenCalled();
  });
});

describe("KAN-862 — rejectDetection mutation", () => {
  it("happy path: marks rejected with audit metadata, no AccountProfile write", async () => {
    accountFieldDetectionUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    await buildCaller().rejectDetection({ detectionId: "d1" });
    expect(accountProfileUpdateMock).not.toHaveBeenCalled();
    const updateCall = accountFieldDetectionUpdateManyMock.mock.calls[0]?.[0] as
      | { where: Record<string, unknown>; data: { status: string; decidedBy: string } }
      | undefined;
    expect(updateCall?.data.status).toBe("rejected");
    expect(updateCall?.data.decidedBy).toBe("user-x");
    // Tenant scope enforced via FK-transitive shape
    const where = updateCall?.where as { accountProfile?: { tenantId?: string }; status?: string };
    expect(where?.accountProfile?.tenantId).toBe(TENANT_A);
    expect(where?.status).toBe("proposed");
  });

  it("not found → NOT_FOUND", async () => {
    accountFieldDetectionUpdateManyMock.mockResolvedValueOnce({ count: 0 });
    await expect(
      buildCaller().rejectDetection({ detectionId: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("KAN-862 — acceptAllDetections mutation", () => {
  it("processes every status='proposed' row, writes each value, marks accepted", async () => {
    accountProfileFindUniqueMock.mockResolvedValueOnce({ id: "ap1" });
    accountFieldDetectionFindManyMock.mockResolvedValueOnce([
      { id: "d1", fieldPath: "primaryPhone", proposedValue: '"+15551234567"' },
      { id: "d2", fieldPath: "legalName", proposedValue: '"Acme Inc"' },
    ]);
    const result = await buildCaller().acceptAllDetections();
    expect(result.acceptedCount).toBe(2);
    // Two _applyAccountUpdate calls ⇒ two prisma.accountProfile.update calls
    expect(accountProfileUpdateMock).toHaveBeenCalledTimes(2);
    expect(accountFieldDetectionUpdateMock).toHaveBeenCalledTimes(2);
  });

  it("malformed proposedValue rows are skipped, batch continues", async () => {
    accountProfileFindUniqueMock.mockResolvedValueOnce({ id: "ap1" });
    accountFieldDetectionFindManyMock.mockResolvedValueOnce([
      { id: "d1", fieldPath: "primaryPhone", proposedValue: "broken-json" },
      { id: "d2", fieldPath: "legalName", proposedValue: '"Acme Inc"' },
    ]);
    const result = await buildCaller().acceptAllDetections();
    expect(result.acceptedCount).toBe(1);
    // Only one update fires (the legalName one)
    expect(accountProfileUpdateMock).toHaveBeenCalledTimes(1);
    const updateCall = accountProfileUpdateMock.mock.calls[0]?.[0] as
      | { data: Record<string, unknown> }
      | undefined;
    expect(updateCall?.data.legalName).toBe("Acme Inc");
  });

  it("returns 0 when AccountProfile is missing", async () => {
    accountProfileFindUniqueMock.mockResolvedValueOnce(null);
    const result = await buildCaller().acceptAllDetections();
    expect(result.acceptedCount).toBe(0);
    expect(accountProfileUpdateMock).not.toHaveBeenCalled();
  });
});
