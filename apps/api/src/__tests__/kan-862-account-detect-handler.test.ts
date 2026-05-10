/**
 * KAN-862 — Account Page Cohort 5: handler endpoint tests.
 *
 * Two specific behaviors covered (Fred's PR #127 fix-forward review):
 *   1. Idempotency — at-least-once Cloud Tasks delivery: second
 *      invocation with the same jobId is a 200 no-op (no extractor
 *      call, no DB writes, no Pub/Sub publishes beyond what the
 *      idempotency-claim acknowledgement allows)
 *   2. Dead-letter — handler invoked with X-CloudTasks-TaskRetryCount: 2
 *      + extractor failure → publishDetectDeadLetter called with the
 *      full Decision-B payload shape
 *
 * Hono's app.request() lets us drive the endpoint without a real HTTP
 * server. All side-effect dependencies (Redis, OIDC verify, DB, LLM,
 * page fetcher, publishers) are mocked at module level.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  redisSetMock,
  redisIncrMock,
  redisExpireMock,
  verifyPubsubOidcMock,
  accountProfileFindUniqueMock,
  accountProfileUpdateManyMock,
  accountFieldDetectionCreateMock,
  discoverAndFetchPagesMock,
  buildCombinedTextForLLMMock,
  extractAccountFieldsFromPagesMock,
  publishDetectProgressMock,
  publishDetectCompletedMock,
  publishDetectFailedMock,
  publishDetectDeadLetterMock,
} = vi.hoisted(() => ({
  redisSetMock: vi.fn(),
  redisIncrMock: vi.fn(async () => 1),
  redisExpireMock: vi.fn(async () => 1),
  verifyPubsubOidcMock: vi.fn(async () => true),
  accountProfileFindUniqueMock: vi.fn(),
  accountProfileUpdateManyMock: vi.fn(async () => ({ count: 1 })),
  accountFieldDetectionCreateMock: vi.fn(),
  discoverAndFetchPagesMock: vi.fn(),
  buildCombinedTextForLLMMock: vi.fn(),
  extractAccountFieldsFromPagesMock: vi.fn(),
  publishDetectProgressMock: vi.fn(async () => undefined),
  publishDetectCompletedMock: vi.fn(async () => undefined),
  publishDetectFailedMock: vi.fn(async () => undefined),
  publishDetectDeadLetterMock: vi.fn(async () => undefined),
}));

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifyIdToken: vi.fn() }),
}));
vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(),
  getApps: () => [{}],
  applicationDefault: vi.fn(),
}));

// Redis singleton mock — handler now depends on .set() for idempotency
// in addition to the rate-limit's .incr/.expire usage.
vi.mock("../services/redis-client.js", () => ({
  getRedisClient: () => ({
    set: redisSetMock,
    incr: redisIncrMock,
    expire: redisExpireMock,
  }),
  __setRedisClientForTest: vi.fn(),
}));

// OIDC verify — handler reuses verifyPubsubOidc (KAN-732 generic helper).
vi.mock("../lib/oidc-pubsub-verify.js", () => ({
  verifyPubsubOidc: (...args: unknown[]) =>
    (verifyPubsubOidcMock as (...a: unknown[]) => unknown)(...args),
  expectedAudience: vi.fn(() => "https://test.local/internal/account-detect-handler"),
}));

// Prisma — direct table mocks. Handler uses .accountProfile.{findUnique,
// updateMany} + .accountFieldDetection.create.
vi.mock("../prisma.js", () => ({
  prisma: {
    accountProfile: {
      findUnique: (...args: unknown[]) =>
        (accountProfileFindUniqueMock as (...a: unknown[]) => unknown)(...args),
      updateMany: (...args: unknown[]) =>
        (accountProfileUpdateManyMock as (...a: unknown[]) => unknown)(...args),
    },
    accountFieldDetection: {
      create: (...args: unknown[]) =>
        (accountFieldDetectionCreateMock as (...a: unknown[]) => unknown)(...args),
    },
  },
}));

// HTML fetcher — return a dummy 1-page result so the handler proceeds
// to the extractor stage.
vi.mock("../services/account-detect-html-fetcher.js", () => ({
  discoverAndFetchPages: (...args: unknown[]) =>
    (discoverAndFetchPagesMock as (...a: unknown[]) => unknown)(...args),
  buildCombinedTextForLLM: (...args: unknown[]) =>
    (buildCombinedTextForLLMMock as (...a: unknown[]) => unknown)(...args),
}));

// Extractor — handler just calls .extractAccountFieldsFromPages.
vi.mock("../services/account-detect-extractor.js", () => ({
  extractAccountFieldsFromPages: (...args: unknown[]) =>
    (extractAccountFieldsFromPagesMock as (...a: unknown[]) => unknown)(...args),
}));

// Publishers — count + capture all 4 lifecycle topics.
vi.mock("../services/account-detect-publishers.js", () => ({
  publishDetectProgress: (...args: unknown[]) =>
    (publishDetectProgressMock as (...a: unknown[]) => unknown)(...args),
  publishDetectCompleted: (...args: unknown[]) =>
    (publishDetectCompletedMock as (...a: unknown[]) => unknown)(...args),
  publishDetectFailed: (...args: unknown[]) =>
    (publishDetectFailedMock as (...a: unknown[]) => unknown)(...args),
  publishDetectDeadLetter: (...args: unknown[]) =>
    (publishDetectDeadLetterMock as (...a: unknown[]) => unknown)(...args),
  publishDetectStarted: vi.fn(async () => undefined),
  ACCOUNT_DETECT_TOPICS: {
    started: "account.detect_started",
    progress: "account.detect_progress",
    completed: "account.detect_completed",
    failed: "account.detect_failed",
    deadLetter: "account.detect_dead_letter",
  },
}));

import { accountDetectHandlerApp } from "../internal/account-detect-handler.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const JOB_ID_1 = "job-aaaa-bbbb-cccc-dddd-eeee";

function buildRequest(opts: {
  body: unknown;
  retryCount?: number;
}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: "Bearer fake-oidc-token",
  };
  if (opts.retryCount !== undefined) {
    headers["x-cloudtasks-taskretrycount"] = String(opts.retryCount);
  }
  return new Request("https://test.local/internal/account-detect-handler", {
    method: "POST",
    headers,
    body: JSON.stringify(opts.body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: idempotency claim succeeds (first delivery)
  redisSetMock.mockResolvedValue("OK");
  // Default: AccountProfile exists
  accountProfileFindUniqueMock.mockResolvedValue({ id: "ap1" });
  // Default: HTML fetch returns 1 page
  discoverAndFetchPagesMock.mockResolvedValue({
    pages: [{ url: "https://acme.example.com", textContent: "Acme content..." }],
    notes: [],
  });
  buildCombinedTextForLLMMock.mockReturnValue("PAGE: Acme content...");
  // Default: extractor returns 1 valid proposal
  extractAccountFieldsFromPagesMock.mockResolvedValue({
    validProposals: [
      {
        fieldName: "legalName",
        proposedValue: '"Acme Inc"',
        confidence: 0.95,
        sourceUrl: "https://acme.example.com",
        sourceSnippet: "Welcome to Acme Inc",
      },
    ],
    invalidProposals: [],
    inputTokens: 1000,
    outputTokens: 50,
    model: "claude-sonnet-4-6",
    latencyMs: 1234,
  });
});

// ─────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────

describe("KAN-862 handler — idempotency (Cloud Tasks at-least-once)", () => {
  it("first delivery: SETNX claims jobId, full pipeline runs, returns 200 with proposalCount", async () => {
    redisSetMock.mockResolvedValueOnce("OK"); // claim succeeds
    const req = buildRequest({
      body: { tenantId: TENANT_A, jobId: JOB_ID_1, websiteUrl: "https://acme.example.com" },
    });
    const res = await accountDetectHandlerApp.fetch(req);
    const body = (await res.json()) as { ok: boolean; proposalCount?: number; idempotent?: boolean };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.idempotent).toBeUndefined(); // not the no-op return path
    expect(body.proposalCount).toBe(1);

    // SETNX called with idempotency key + 24h TTL
    const setCall = redisSetMock.mock.calls[0] as [string, string, "EX", number, "NX"];
    expect(setCall[0]).toBe(`idemp:account-detect:${JOB_ID_1}`);
    expect(setCall[2]).toBe("EX");
    expect(setCall[3]).toBe(86400); // 24h
    expect(setCall[4]).toBe("NX");

    // Side effects fired (extractor, DB write, completion event)
    expect(extractAccountFieldsFromPagesMock).toHaveBeenCalledTimes(1);
    expect(accountFieldDetectionCreateMock).toHaveBeenCalledTimes(1);
    expect(publishDetectCompletedMock).toHaveBeenCalledTimes(1);
  });

  it("duplicate delivery: SETNX returns null, handler returns 200 no-op (no extractor, no DB writes, no detect_completed)", async () => {
    redisSetMock.mockResolvedValueOnce(null); // duplicate — already claimed
    const req = buildRequest({
      body: { tenantId: TENANT_A, jobId: JOB_ID_1, websiteUrl: "https://acme.example.com" },
    });
    const res = await accountDetectHandlerApp.fetch(req);
    const body = (await res.json()) as { ok: boolean; idempotent?: boolean; jobId?: string };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.idempotent).toBe(true);
    expect(body.jobId).toBe(JOB_ID_1);

    // NO side effects: no extractor call, no DB write, no completion event,
    // no progress event (the handler bails out before any of these).
    expect(extractAccountFieldsFromPagesMock).not.toHaveBeenCalled();
    expect(accountFieldDetectionCreateMock).not.toHaveBeenCalled();
    expect(publishDetectCompletedMock).not.toHaveBeenCalled();
    expect(publishDetectProgressMock).not.toHaveBeenCalled();
    expect(publishDetectFailedMock).not.toHaveBeenCalled();
    expect(publishDetectDeadLetterMock).not.toHaveBeenCalled();
  });

  it("Redis SETNX throws → fail-open posture (proceeds with scan)", async () => {
    redisSetMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const req = buildRequest({
      body: { tenantId: TENANT_A, jobId: JOB_ID_1, websiteUrl: "https://acme.example.com" },
    });
    const res = await accountDetectHandlerApp.fetch(req);
    const body = (await res.json()) as { ok: boolean; proposalCount?: number };

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.proposalCount).toBe(1);
    // Pipeline ran despite Redis failure — fail-open.
    expect(extractAccountFieldsFromPagesMock).toHaveBeenCalledTimes(1);
    consoleWarnSpy.mockRestore();
  });

  it("OIDC verification failure: 401, no idempotency check (claim wasted on unauth requests is bad)", async () => {
    verifyPubsubOidcMock.mockResolvedValueOnce(false);
    const req = buildRequest({
      body: { tenantId: TENANT_A, jobId: JOB_ID_1, websiteUrl: "https://acme.example.com" },
    });
    const res = await accountDetectHandlerApp.fetch(req);
    expect(res.status).toBe(401);
    expect(redisSetMock).not.toHaveBeenCalled();
    expect(extractAccountFieldsFromPagesMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// Dead-letter publish on attempt 3 (Decision B)
// ─────────────────────────────────────────────────────────────────

describe("KAN-862 handler — dead-letter publish on retryCount >= 2 (3rd attempt)", () => {
  it("X-CloudTasks-TaskRetryCount: 2 + extractor failure → publishDetectDeadLetter with full Decision B payload", async () => {
    // SETNX returns "OK" — first claim of THIS jobId. Cloud Tasks retries
    // re-deliver the same task body / same jobId; the idempotency key has
    // already been claimed from attempt 1, but this test exercises the
    // attempt-tracking path so we simulate a fresh claim (otherwise the
    // dead-letter path is unreachable in pure isolation testing).
    redisSetMock.mockResolvedValueOnce("OK");
    extractAccountFieldsFromPagesMock.mockRejectedValueOnce(
      new Error("anthropic 503 service unavailable"),
    );

    const req = buildRequest({
      body: { tenantId: TENANT_A, jobId: JOB_ID_1, websiteUrl: "https://acme.example.com" },
      retryCount: 2, // 0-indexed → this is attempt 3
    });
    const res = await accountDetectHandlerApp.fetch(req);
    expect(res.status).toBe(200); // permanent error path returns 200 to stop further retries

    // Failed event always fires (regardless of attempt count)
    expect(publishDetectFailedMock).toHaveBeenCalledTimes(1);
    const failedArg = (publishDetectFailedMock.mock.calls as unknown as unknown[][])[0]?.[0] as {
      tenantId: string;
      jobId: string;
      errorCode: string;
      errorMessage: string;
      attempt: number;
    };
    expect(failedArg.tenantId).toBe(TENANT_A);
    expect(failedArg.jobId).toBe(JOB_ID_1);
    expect(failedArg.errorCode).toBe("llm_error");
    expect(failedArg.attempt).toBe(3);

    // Dead-letter event ALSO fires on the 3rd attempt with the full
    // Decision B payload shape
    expect(publishDetectDeadLetterMock).toHaveBeenCalledTimes(1);
    const dlqArg = (publishDetectDeadLetterMock.mock.calls as unknown as unknown[][])[0]?.[0] as {
      tenantId: string;
      jobId: string;
      websiteUrl: string;
      errorCode: string;
      errorMessage: string;
      retryCount: number;
      originalTimestamp: string;
    };
    expect(dlqArg.tenantId).toBe(TENANT_A);
    expect(dlqArg.jobId).toBe(JOB_ID_1);
    expect(dlqArg.websiteUrl).toBe("https://acme.example.com");
    expect(dlqArg.errorCode).toBe("llm_error");
    expect(dlqArg.errorMessage).toMatch(/anthropic 503/);
    expect(dlqArg.retryCount).toBe(3);
    expect(dlqArg.originalTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
  });

  it("X-CloudTasks-TaskRetryCount: 0 (1st attempt) + extractor failure → detect_failed but NO dead-letter", async () => {
    redisSetMock.mockResolvedValueOnce("OK");
    extractAccountFieldsFromPagesMock.mockRejectedValueOnce(
      new Error("anthropic 503"),
    );

    const req = buildRequest({
      body: { tenantId: TENANT_A, jobId: JOB_ID_1, websiteUrl: "https://acme.example.com" },
      retryCount: 0, // attempt 1
    });
    await accountDetectHandlerApp.fetch(req);

    expect(publishDetectFailedMock).toHaveBeenCalledTimes(1);
    expect(publishDetectDeadLetterMock).not.toHaveBeenCalled();
  });

  it("X-CloudTasks-TaskRetryCount: 1 (2nd attempt) + extractor failure → detect_failed but NO dead-letter", async () => {
    redisSetMock.mockResolvedValueOnce("OK");
    extractAccountFieldsFromPagesMock.mockRejectedValueOnce(
      new Error("anthropic 503"),
    );

    const req = buildRequest({
      body: { tenantId: TENANT_A, jobId: JOB_ID_1, websiteUrl: "https://acme.example.com" },
      retryCount: 1, // attempt 2
    });
    await accountDetectHandlerApp.fetch(req);

    expect(publishDetectFailedMock).toHaveBeenCalledTimes(1);
    expect(publishDetectDeadLetterMock).not.toHaveBeenCalled();
  });

  it("missing X-CloudTasks-TaskRetryCount header → defaults to attempt 1 (no dead-letter)", async () => {
    redisSetMock.mockResolvedValueOnce("OK");
    extractAccountFieldsFromPagesMock.mockRejectedValueOnce(
      new Error("anthropic 503"),
    );

    const req = buildRequest({
      body: { tenantId: TENANT_A, jobId: JOB_ID_1, websiteUrl: "https://acme.example.com" },
      // no retryCount header
    });
    await accountDetectHandlerApp.fetch(req);

    const failedArg = (publishDetectFailedMock.mock.calls as unknown as unknown[][])[0]?.[0] as { attempt: number };
    expect(failedArg.attempt).toBe(1);
    expect(publishDetectDeadLetterMock).not.toHaveBeenCalled();
  });
});
