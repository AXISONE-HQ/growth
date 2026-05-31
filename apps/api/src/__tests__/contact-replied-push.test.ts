/**
 * KAN-1037-PR3 — contact.replied push subscriber unit tests.
 *
 * **PR3 SKELETON SCOPE.** The subscriber writes audit rows + sets Redis
 * cooldown gate but does NOT invoke `runDecisionForContact` yet. Tests
 * cover the plumbing path end-to-end:
 *   - OIDC verify (success → 200, failure → 401)
 *   - Envelope + event parse (malformed → 200 ack-and-drop)
 *   - Cooldown gate (active → suppress audit + 200, expired → proceed)
 *   - In-flight gate (held → suppress audit + 200, free → acquire + proceed)
 *   - Happy path (skeleton audit row + cooldown set + in-flight released)
 *   - Lock release in `finally` block (success AND error paths)
 *   - Tenant isolation (same contactId in different tenants = independent keys)
 *
 * Mocks: Prisma auditLog.create, verifyPubsubOidc, ioredis client via
 * the redis-client.js test seam (`__setRedisClientForTest`).
 *
 * PR4 will extend this suite with the engine-invocation assertions
 * (runDecisionForContact called with the right RunForContactInput shape,
 * audit reason flips from `decision_re_evaluated_skipped_pr3_skeleton`
 * to canonical `decision_re_evaluated`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// `vi.mock` factories are hoisted above local `const` declarations — using
// `vi.hoisted` keeps the mock fns available inside the factory closures
// while still letting tests inspect/reset them by reference below.
const { verifyPubsubOidcMock, auditLogCreateMock } = vi.hoisted(() => ({
  verifyPubsubOidcMock: vi.fn(),
  auditLogCreateMock: vi.fn(async () => ({ id: "audit_x" })),
}));

vi.mock("../lib/oidc-pubsub-verify.js", () => ({
  verifyPubsubOidc: verifyPubsubOidcMock,
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    auditLog: { create: auditLogCreateMock },
  },
}));

import { contactRepliedPushApp } from "../subscribers/contact-replied-push.js";
import { __setRedisClientForTest } from "../services/redis-client.js";

// ─────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const CONTACT_X = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DEAL_X = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DECISION_X = "cl_decision_x_123";
const INBOUND_ENG = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const OUTBOUND_ENG = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

interface FakeRedis {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  // Backing store for stateful tests.
  store: Map<string, { value: string; ttlSec: number | null }>;
}

function makeFakeRedis(): FakeRedis {
  const store = new Map<string, { value: string; ttlSec: number | null }>();
  const redis = {
    store,
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      return entry?.value ?? null;
    }),
    set: vi.fn(
      async (
        key: string,
        value: string,
        ...args: Array<string | number>
      ): Promise<"OK" | null> => {
        // ioredis positional: set(key, val, 'NX', 'EX', seconds) OR set(key, val, 'EX', seconds)
        const hasNX = args.includes("NX");
        const exIdx = args.indexOf("EX");
        const ttlSec = exIdx >= 0 ? (args[exIdx + 1] as number) : null;
        if (hasNX && store.has(key)) return null;
        store.set(key, { value, ttlSec });
        return "OK";
      },
    ),
    del: vi.fn(async (key: string) => {
      const had = store.delete(key);
      return had ? 1 : 0;
    }),
  };
  return redis;
}

function makeApp() {
  const app = new Hono();
  app.route("/pubsub", contactRepliedPushApp);
  return app;
}

function makeValidEvent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    eventId: "feedbeef-cafe-babe-dead-feedface0000",
    eventType: "contact.replied",
    version: "1.0",
    publishedAt: "2026-05-31T12:00:00.000Z",
    tenantId: TENANT_A,
    contactId: CONTACT_X,
    dealId: DEAL_X,
    decisionId: DECISION_X,
    inboundEngagementId: INBOUND_ENG,
    outboundEngagementId: OUTBOUND_ENG,
    replyText: "Sure, Thursday 2pm ET works. Let's chat.",
    replyReceivedAt: "2026-05-31T11:55:00.000Z",
    metadata: {
      senderEmail: "alice@customer.example",
      subjectLine: "Re: Quick question",
      threadDepth: 1,
    },
    ...overrides,
  };
}

function makeEnvelope(event: Record<string, unknown>): { body: string } {
  const data = Buffer.from(JSON.stringify(event)).toString("base64");
  return {
    body: JSON.stringify({
      message: {
        data,
        messageId: "pubsub-msg-id-1",
        attributes: { eventType: "contact.replied" },
      },
      subscription: "projects/p/subscriptions/contact-replied-decision-run-trigger",
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyPubsubOidcMock.mockResolvedValue(true);
  auditLogCreateMock.mockImplementation(async () => ({ id: "audit_x" }));
  __setRedisClientForTest(null);
});

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe("KAN-1037-PR3 — contact.replied push subscriber (skeleton)", () => {
  it("rejects with 401 when OIDC verification fails", async () => {
    verifyPubsubOidcMock.mockResolvedValueOnce(false);
    const redis = makeFakeRedis();
    __setRedisClientForTest(redis as never);
    const { body } = makeEnvelope(makeValidEvent());
    const res = await makeApp().request("/pubsub/contact-replied", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(401);
    expect(auditLogCreateMock).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("returns 200 ack-and-drop on malformed envelope (poison-message defense)", async () => {
    const redis = makeFakeRedis();
    __setRedisClientForTest(redis as never);
    const res = await makeApp().request("/pubsub/contact-replied", {
      method: "POST",
      body: "not-json-at-all",
    });
    expect(res.status).toBe(200);
    expect(auditLogCreateMock).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("returns 200 ack-and-drop on event missing required field (schema reject)", async () => {
    const redis = makeFakeRedis();
    __setRedisClientForTest(redis as never);
    const broken = makeValidEvent({ tenantId: undefined });
    const { body } = makeEnvelope(broken);
    const res = await makeApp().request("/pubsub/contact-replied", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(200);
    expect(auditLogCreateMock).not.toHaveBeenCalled();
  });

  it("happy path: writes skeleton audit + sets 300s cooldown + releases in-flight lock", async () => {
    const redis = makeFakeRedis();
    __setRedisClientForTest(redis as never);
    const { body } = makeEnvelope(makeValidEvent());
    const res = await makeApp().request("/pubsub/contact-replied", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(200);
    // Single skeleton audit row written (no cooldown/in-flight suppression).
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1);
    expect(auditLogCreateMock.mock.calls[0][0].data.actionType).toBe(
      "decision_re_evaluated_skipped_pr3_skeleton",
    );
    expect(auditLogCreateMock.mock.calls[0][0].data.tenantId).toBe(TENANT_A);
    expect(auditLogCreateMock.mock.calls[0][0].data.payload.eventId).toBe(
      "feedbeef-cafe-babe-dead-feedface0000",
    );
    // Cooldown key set with the delivery's decisionId + 300s TTL.
    const cooldown = redis.store.get(
      `decision-run:cooldown:${TENANT_A}:${CONTACT_X}`,
    );
    expect(cooldown?.value).toBe(DECISION_X);
    expect(cooldown?.ttlSec).toBe(300);
    // In-flight lock acquired then released — store has cooldown only.
    expect(redis.store.has(`decision-run:in-flight:${TENANT_A}:${CONTACT_X}`)).toBe(false);
    expect(redis.del).toHaveBeenCalledWith(
      `decision-run:in-flight:${TENANT_A}:${CONTACT_X}`,
    );
  });

  it("cooldown gate: suppresses processing + writes contact_replied_suppressed_cooldown audit", async () => {
    const redis = makeFakeRedis();
    // Prime the cooldown key as if a prior delivery succeeded.
    redis.store.set(`decision-run:cooldown:${TENANT_A}:${CONTACT_X}`, {
      value: "cl_prior_decision_xyz",
      ttlSec: 200,
    });
    __setRedisClientForTest(redis as never);
    const { body } = makeEnvelope(makeValidEvent());
    const res = await makeApp().request("/pubsub/contact-replied", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(200);
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1);
    expect(auditLogCreateMock.mock.calls[0][0].data.actionType).toBe(
      "contact_replied_suppressed_cooldown",
    );
    expect(auditLogCreateMock.mock.calls[0][0].data.payload.cooldownDecisionId).toBe(
      "cl_prior_decision_xyz",
    );
    // In-flight key never acquired — gate fired before lock attempt.
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("in-flight gate: suppresses processing + writes contact_replied_suppressed_in_flight audit", async () => {
    const redis = makeFakeRedis();
    // Prime the in-flight key as if a concurrent delivery holds the lock.
    redis.store.set(`decision-run:in-flight:${TENANT_A}:${CONTACT_X}`, {
      value: "concurrent-delivery-eventId",
      ttlSec: 20,
    });
    __setRedisClientForTest(redis as never);
    const { body } = makeEnvelope(makeValidEvent());
    const res = await makeApp().request("/pubsub/contact-replied", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(200);
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1);
    expect(auditLogCreateMock.mock.calls[0][0].data.actionType).toBe(
      "contact_replied_suppressed_in_flight",
    );
    // Cooldown key NOT written (the gate short-circuited).
    expect(redis.store.has(`decision-run:cooldown:${TENANT_A}:${CONTACT_X}`)).toBe(false);
    // The pre-existing in-flight lock is NOT released by this delivery — that's
    // the OWNING delivery's finally block's job.
    expect(redis.store.has(`decision-run:in-flight:${TENANT_A}:${CONTACT_X}`)).toBe(true);
  });

  it("in-flight lock released on handler error (finally block — orphan lock guard)", async () => {
    const redis = makeFakeRedis();
    __setRedisClientForTest(redis as never);
    // Force the skeleton audit write to throw — handler enters catch + finally.
    auditLogCreateMock.mockRejectedValueOnce(new Error("audit-write-down"));
    const { body } = makeEnvelope(makeValidEvent());
    const res = await makeApp().request("/pubsub/contact-replied", {
      method: "POST",
      body,
    });
    // Handler returns 500 so Pub/Sub retries — but the in-flight lock must
    // have been released so the retry can re-acquire it.
    expect(res.status).toBe(500);
    expect(redis.del).toHaveBeenCalledWith(
      `decision-run:in-flight:${TENANT_A}:${CONTACT_X}`,
    );
    expect(redis.store.has(`decision-run:in-flight:${TENANT_A}:${CONTACT_X}`)).toBe(false);
    // Cooldown NOT set on error path (only set on successful processing).
    expect(redis.store.has(`decision-run:cooldown:${TENANT_A}:${CONTACT_X}`)).toBe(false);
  });

  it("tenant isolation: same contactId in different tenants = independent Redis keys", async () => {
    const redis = makeFakeRedis();
    __setRedisClientForTest(redis as never);
    // Prime tenant A's cooldown.
    redis.store.set(`decision-run:cooldown:${TENANT_A}:${CONTACT_X}`, {
      value: "cl_tenant_a_decision",
      ttlSec: 200,
    });
    // Tenant B with same contactId should NOT see tenant A's cooldown.
    const { body } = makeEnvelope(
      makeValidEvent({ tenantId: TENANT_B }),
    );
    const res = await makeApp().request("/pubsub/contact-replied", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(200);
    // Tenant B got the skeleton happy path — NOT the cooldown-suppression audit.
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1);
    expect(auditLogCreateMock.mock.calls[0][0].data.actionType).toBe(
      "decision_re_evaluated_skipped_pr3_skeleton",
    );
    expect(auditLogCreateMock.mock.calls[0][0].data.tenantId).toBe(TENANT_B);
    // Tenant A's cooldown still intact (independent key).
    expect(redis.store.get(`decision-run:cooldown:${TENANT_A}:${CONTACT_X}`)?.value).toBe(
      "cl_tenant_a_decision",
    );
    // Tenant B's cooldown freshly set.
    expect(redis.store.get(`decision-run:cooldown:${TENANT_B}:${CONTACT_X}`)?.value).toBe(
      DECISION_X,
    );
  });
});
