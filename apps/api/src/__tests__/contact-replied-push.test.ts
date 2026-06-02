/**
 * KAN-1037-PR3/PR4 — contact.replied push subscriber unit tests.
 *
 * **PR4 SCOPE — engine re-evaluation with body-aware prompt.** The
 * subscriber calls `evaluateDealState(prisma, dealId, { redis, openai,
 * latestInbound })` on the happy path and captures the Brain decision
 * in a `decision_re_evaluated` audit row. The PR3 skeleton bookmark
 * (`decision_re_evaluated_skipped_pr3_skeleton`) is retired in PR4.
 *
 * Coverage:
 *   - OIDC verify (success → 200, failure → 401)
 *   - Envelope + event parse (malformed → 200 ack-and-drop)
 *   - Cooldown gate (active → suppress audit + 200, expired → proceed)
 *   - In-flight gate (held → suppress audit + 200, free → acquire + proceed)
 *   - PR4 happy path: evaluateDealState invoked with latestInbound shape,
 *     decision_re_evaluated audit row written with Brain decision payload,
 *     cooldown set, in-flight released
 *   - PR4 null-dealId path: skip-with-audit (decision_re_evaluated_skipped_no_deal)
 *     + cooldown set, evaluateDealState NOT called
 *   - PR4 brain failure: 500 returned, in-flight released via finally,
 *     no cooldown set (so Pub/Sub retry can re-acquire and re-attempt)
 *   - Lock release in `finally` block (success AND error paths)
 *   - Tenant isolation (same contactId in different tenants = independent keys)
 *
 * Mocks: Prisma auditLog.create, verifyPubsubOidc, ioredis client via
 * the redis-client.js test seam (`__setRedisClientForTest`), brain-service
 * via vitest's vi.mock on the variable-specifier dynamic import path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// `vi.mock` factories are hoisted above local `const` declarations — using
// `vi.hoisted` keeps the mock fns available inside the factory closures
// while still letting tests inspect/reset them by reference below.
//
// Explicit signature on `auditLogCreateMock`: under tsconfig
// `noUncheckedIndexedAccess` (apps/api), an untyped vi.fn would type
// `mock.calls` as `never[][]` — `calls[0][0]` then fails TS2493/TS2532.
// Annotating the input/output shape makes `calls[N]` a known tuple so
// the dereferences below type-check cleanly (matches the test surface:
// inputs are `{ data: { tenantId, actor, actionType, reasoning?, payload } }`
// per the Prisma auditLog.create call shape in contact-replied-push.ts).
interface AuditCreateArg {
  data: {
    tenantId: string;
    actor: string;
    actionType: string;
    reasoning?: string;
    payload: Record<string, unknown>;
  };
}
const { verifyPubsubOidcMock, auditLogCreateMock, evaluateDealStateMock, wirePhase2ConsumersMock, buildThreadContextMock } = vi.hoisted(() => ({
  verifyPubsubOidcMock: vi.fn<(arg: unknown) => Promise<boolean>>(),
  auditLogCreateMock: vi.fn<(arg: AuditCreateArg) => Promise<{ id: string }>>(
    async () => ({ id: "audit_x" }),
  ),
  // KAN-1037-PR4 — Brain Service mock. evaluateDealState's real return
  // shape is captured at the type level via Awaited<ReturnType<...>> on
  // the BrainServiceModule interface; here the mock returns a
  // realistic-shape fixture so assertions on brainActionType /
  // brainConfidence / brainReasoning have non-undefined values.
  evaluateDealStateMock: vi.fn(),
  // KAN-1058 (Phase B PR III) — buildThreadContext mock. Default resolved
  // value is `[]` so the subscriber's `priorTurns` argument is empty for
  // most tests, matching pre-PR-III behavior (the `### Prior conversation
  // context` sub-section omits at render time). Specific tests override
  // via `mockResolvedValueOnce([...])` to assert multi-turn surface.
  buildThreadContextMock: vi.fn<
    (
      prisma: unknown,
      input: { tenantId: string; dealId: string; excludeEngagementId: string },
    ) => Promise<
      Array<{
        direction: 'outbound' | 'inbound';
        occurredAt: string;
        subjectLine: string;
        bodyText: string;
      }>
    >
  >(),
  // KAN-1037-PR4.5 — wirePhase2Consumers mock. The subscriber now passes
  // the precomputed brainDecision as the 4th arg per the KAN-834
  // precomputed-decision pattern (avoids double-eval inside
  // wirePhase2Consumers). Tests assert on the call args + that
  // wirePhase2Consumers is NOT called on the null-dealId or
  // brain-failure paths.
  //
  // Explicit signature so `mock.calls[0]` is a known 4-tuple under
  // noUncheckedIndexedAccess (apps/api strict mode). Same pattern as
  // auditLogCreateMock above. Per the PR3 lesson + KAN-689 cohort
  // discipline: untyped vi.fn → mock.calls typed as never[][] → access
  // fails at strict tsc.
  wirePhase2ConsumersMock: vi.fn<
    (
      dealId: string,
      eventId: string,
      isChainedInvocation: boolean,
      precomputedDecision: unknown,
    ) => Promise<void>
  >(async () => undefined),
}));

vi.mock("../lib/oidc-pubsub-verify.js", () => ({
  verifyPubsubOidc: verifyPubsubOidcMock,
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    auditLog: { create: auditLogCreateMock },
  },
}));

// KAN-1037-PR4.5 — mock the sibling subscriber's exported orchestrator.
// Direct ESM mock: contact-replied-push imports from
// `./lead-received-push.js`; vitest intercepts here so the subscriber's
// `void wirePhase2Consumers(...)` lands on the spy instead of the real
// orchestrator (which would re-evaluate Brain + touch downstream tables).
vi.mock("../subscribers/lead-received-push.js", () => ({
  wirePhase2Consumers: wirePhase2ConsumersMock,
}));

// Brain Service variable-specifier dynamic import — vitest intercepts the
// resolved path. Same path mocked in lead-received-push.test.ts:102.
// KAN-1052 — buildLatestInboundContext is a pure passthrough builder
// (asserts input == output); test mock matches the real implementation.
vi.mock("../../../../packages/api/src/services/brain-service.js", () => ({
  evaluateDealState: evaluateDealStateMock,
  buildLatestInboundContext: (input: unknown) => input,
  // KAN-1058 (Phase B PR III) — buildThreadContext is now part of the
  // loader surface for the reply chain. Mock returns whatever
  // buildThreadContextMock yields per-test (default `[]` set in beforeEach).
  buildThreadContext: buildThreadContextMock,
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

/**
 * KAN-1037-PR4 — realistic Brain Service decision fixture. Shape matches
 * the canonical EvaluateDealStateResult per brain-service.ts:280. Tests
 * use this as the default mock return; specific tests override fields
 * (action type, confidence, reasoning) when asserting on payload contents.
 */
function buildBrainDecisionFixture(
  overrides: {
    type?: "send_follow_up" | "wait_for_response" | "advance_stage" | "escalate_to_human" | "close_deal_lost" | "no_action";
    reasoning?: string;
    confidence?: number;
    suggestedChannel?: "email" | "sms" | "meta_messenger";
    suggestedTone?: "curious" | "professional" | "urgent" | "closing";
  } = {},
): Record<string, unknown> {
  return {
    dealId: DEAL_X,
    evaluatedAt: new Date("2026-05-31T13:38:50.000Z"),
    currentStateSnapshot: {
      dealStatus: "open",
      currentStageName: "Qualified",
      currentStageOutcomeType: "open",
      daysInCurrentStage: 2,
      engagementCount: 3,
      lastEngagementType: "email_received",
      lastEngagementClass: "positive",
      daysSinceLastEngagement: 0,
      moProgressPercent: 50,
      pipelineName: "Default Pipeline",
      pipelineObjectiveType: "qualify",
    },
    nextBestAction: {
      type: overrides.type ?? "send_follow_up",
      reasoning:
        overrides.reasoning ??
        "Contact responded affirmatively about Q3 timeline and proposed Tuesday afternoon for a 30-min call.",
      suggestedChannel: overrides.suggestedChannel ?? "email",
      suggestedTone: overrides.suggestedTone ?? "professional",
    },
    confidence: overrides.confidence ?? 0.78,
    modelTier: "reasoning",
    llmInputTokens: 1200,
    llmOutputTokens: 180,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyPubsubOidcMock.mockResolvedValue(true);
  auditLogCreateMock.mockImplementation(async () => ({ id: "audit_x" }));
  evaluateDealStateMock.mockResolvedValue(buildBrainDecisionFixture());
  // KAN-1037-PR4.5 — default wirePhase2Consumers to a successful no-op.
  // Specific tests override to assert call args or to simulate failure.
  wirePhase2ConsumersMock.mockResolvedValue(undefined);
  // KAN-1058 (Phase B PR III) — default buildThreadContext to empty array.
  // The reply chain fires it before evaluateDealState; empty array means
  // the `### Prior conversation context` sub-section omits at render time
  // (matches pre-PR-III rendering). Specific multi-turn tests override
  // via `mockResolvedValueOnce([...])`.
  buildThreadContextMock.mockResolvedValue([]);
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

  it("PR4 happy path: evaluateDealState invoked with latestInbound shape, decision_re_evaluated audit, cooldown set, in-flight released", async () => {
    const redis = makeFakeRedis();
    __setRedisClientForTest(redis as never);
    const { body } = makeEnvelope(makeValidEvent());
    const res = await makeApp().request("/pubsub/contact-replied", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(200);

    // Brain Service was called with (prisma, dealId, options) shape.
    expect(evaluateDealStateMock).toHaveBeenCalledTimes(1);
    const [, dealIdArg, optionsArg] = evaluateDealStateMock.mock.calls[0]!;
    expect(dealIdArg).toBe(DEAL_X);
    // Knowledge Layer (KAN-828) clients threaded.
    expect(optionsArg).toMatchObject({
      triggerContext: "inbound",
    });
    // The load-bearing assertion: latestInbound carries the engine the
    // contact's verbatim words + thread metadata. Shape matches the
    // BrainLatestInbound interface in brain-service.ts.
    //
    // KAN-1058 (Phase B PR III) — priorTurns defaults to `[]` here because
    // buildThreadContextMock.mockResolvedValue([]) is the beforeEach
    // default. Tests in the KAN-1058 describe block below override the
    // mock to assert multi-turn threading; this test pins the empty-turns
    // back-compat shape.
    expect(optionsArg.latestInbound).toEqual({
      receivedAt: "2026-05-31T11:55:00.000Z",
      senderEmail: "alice@customer.example",
      bodyText: "Sure, Thursday 2pm ET works. Let's chat.",
      subjectLine: "Re: Quick question",
      inReplyToDecisionId: DECISION_X,
      threadDepth: 1,
      priorTurns: [],
    });

    // Single decision_re_evaluated audit row written — PR3 skeleton bookmark
    // (decision_re_evaluated_skipped_pr3_skeleton) is RETIRED in PR4.
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1);
    expect(auditLogCreateMock.mock.calls[0]![0].data.actionType).toBe(
      "decision_re_evaluated",
    );
    expect(auditLogCreateMock.mock.calls[0]![0].data.tenantId).toBe(TENANT_A);
    const auditPayload = auditLogCreateMock.mock.calls[0]![0].data.payload;
    expect(auditPayload.eventId).toBe("feedbeef-cafe-babe-dead-feedface0000");
    expect(auditPayload.triggerDecisionId).toBe(DECISION_X);
    expect(auditPayload.brainActionType).toBe("send_follow_up");
    expect(auditPayload.brainConfidence).toBe(0.78);
    expect(auditPayload.brainReasoning).toContain("Q3 timeline");
    expect(auditPayload.llmInputTokens).toBe(1200);
    expect(auditPayload.llmOutputTokens).toBe(180);

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

    // ── KAN-1037-PR4.5 — dispatch chain wired with precomputed decision ──
    // The load-bearing assertion: wirePhase2Consumers MUST be called with
    // the precomputed brainDecision as the 4th arg so its internal
    // evaluateDealState call SKIPS (avoids cognitive-blind double-eval
    // that would discard PR4's latestInbound-aware reasoning).
    expect(wirePhase2ConsumersMock).toHaveBeenCalledTimes(1);
    const wireCall = wirePhase2ConsumersMock.mock.calls[0];
    expect(wireCall[0]).toBe(DEAL_X); // dealId
    expect(wireCall[1]).toBe("feedbeef-cafe-babe-dead-feedface0000"); // eventId
    expect(wireCall[2]).toBe(false); // isChainedInvocation
    // 4th arg is the precomputed brainDecision — same shape as evaluateDealState returned.
    expect(wireCall[3]).toMatchObject({
      nextBestAction: { type: "send_follow_up" },
      confidence: 0.78,
    });
    // Audit row carries dispatchConsumersFired marker.
    expect(auditPayload.dispatchConsumersFired).toBe(true);
  });

  it("PR4 null-dealId path: skip-with-audit (decision_re_evaluated_skipped_no_deal) + cooldown set, evaluateDealState NOT called", async () => {
    const redis = makeFakeRedis();
    __setRedisClientForTest(redis as never);
    // Originator had no open Deal at the time of the inbound — publisher
    // honestly emits dealId: null per the nullable schema.
    const { body } = makeEnvelope(makeValidEvent({ dealId: null }));
    const res = await makeApp().request("/pubsub/contact-replied", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(200);

    // Brain Service NOT called — Brain requires a Deal id and would throw
    // BrainServiceNotFoundError. The subscriber short-circuits BEFORE the
    // engine call so an audit row carries the operator-observable signal.
    expect(evaluateDealStateMock).not.toHaveBeenCalled();

    expect(auditLogCreateMock).toHaveBeenCalledTimes(1);
    expect(auditLogCreateMock.mock.calls[0]![0].data.actionType).toBe(
      "decision_re_evaluated_skipped_no_deal",
    );
    expect(auditLogCreateMock.mock.calls[0]![0].data.reasoning).toBe(
      "no_open_deal_on_originator",
    );

    // Cooldown still set — prevents a no-deal contact replying multiple
    // times rapidly from flooding the audit log.
    const cooldown = redis.store.get(
      `decision-run:cooldown:${TENANT_A}:${CONTACT_X}`,
    );
    expect(cooldown?.value).toBe(DECISION_X);
    expect(cooldown?.ttlSec).toBe(300);
    // In-flight released.
    expect(redis.store.has(`decision-run:in-flight:${TENANT_A}:${CONTACT_X}`)).toBe(false);
    // KAN-1037-PR4.5 — wirePhase2Consumers NOT called when there's no Deal.
    expect(wirePhase2ConsumersMock).not.toHaveBeenCalled();
  });

  it("PR4 brain failure: returns 500 + releases in-flight + does NOT set cooldown (so Pub/Sub retry can re-attempt)", async () => {
    const redis = makeFakeRedis();
    __setRedisClientForTest(redis as never);
    evaluateDealStateMock.mockRejectedValueOnce(
      new Error("openai-rate-limit: 429 too many requests"),
    );
    const { body } = makeEnvelope(makeValidEvent());
    const res = await makeApp().request("/pubsub/contact-replied", {
      method: "POST",
      body,
    });

    // 500 → Pub/Sub retries per subscription retry policy (10s/600s
    // exponential, 24h retention).
    expect(res.status).toBe(500);
    // Brain was attempted exactly once on this delivery.
    expect(evaluateDealStateMock).toHaveBeenCalledTimes(1);
    // No audit row written for the failed eval (the catch block doesn't
    // write a partial-state audit — the retry will write the canonical
    // decision_re_evaluated audit once Brain succeeds).
    expect(auditLogCreateMock).not.toHaveBeenCalled();
    // No cooldown set — if cooldown were set on failure, the retry would
    // be suppressed by its own cooldown guard, eating the message silently.
    expect(redis.store.has(`decision-run:cooldown:${TENANT_A}:${CONTACT_X}`)).toBe(false);
    // In-flight RELEASED in finally — retry can re-acquire the lock.
    expect(redis.store.has(`decision-run:in-flight:${TENANT_A}:${CONTACT_X}`)).toBe(false);
    expect(redis.del).toHaveBeenCalledWith(
      `decision-run:in-flight:${TENANT_A}:${CONTACT_X}`,
    );
    // KAN-1037-PR4.5 — wirePhase2Consumers NOT called when Brain failed.
    // No cognitive decision to route through the dispatch chain.
    expect(wirePhase2ConsumersMock).not.toHaveBeenCalled();
  });

  it("PR4.5 wirePhase2Consumers failure is SWALLOWED (fire-and-forget): cooldown still set, 200 returned, audit row intact", async () => {
    // Downstream consumer failure (stage-transition error, send-policy
    // defer-write failure, escalation create reject, etc.) MUST NOT block
    // the cooldown set or trigger a Pub/Sub retry. The cognitive audit
    // row is already committed; per-consumer observability comes from
    // each consumer's own audit writes.
    const redis = makeFakeRedis();
    __setRedisClientForTest(redis as never);
    wirePhase2ConsumersMock.mockRejectedValueOnce(
      new Error("kan-815b-stage-transition-down: prisma connection lost"),
    );
    const { body } = makeEnvelope(makeValidEvent());
    const res = await makeApp().request("/pubsub/contact-replied", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(200);
    // Cognitive eval succeeded; decision_re_evaluated audit row written.
    expect(evaluateDealStateMock).toHaveBeenCalledTimes(1);
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1);
    expect(auditLogCreateMock.mock.calls[0]![0].data.actionType).toBe(
      "decision_re_evaluated",
    );
    // wirePhase2Consumers WAS invoked (with the precomputed decision)
    // — the throw happened inside the orchestrator.
    expect(wirePhase2ConsumersMock).toHaveBeenCalledTimes(1);
    // Cooldown STILL set despite the dispatch failure — operator-visible
    // suppression of duplicate evaluations stays correct.
    expect(redis.store.get(`decision-run:cooldown:${TENANT_A}:${CONTACT_X}`)?.value).toBe(
      DECISION_X,
    );
    // In-flight released.
    expect(redis.store.has(`decision-run:in-flight:${TENANT_A}:${CONTACT_X}`)).toBe(false);
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
    expect(auditLogCreateMock.mock.calls[0]![0].data.actionType).toBe(
      "contact_replied_suppressed_cooldown",
    );
    expect(auditLogCreateMock.mock.calls[0]![0].data.payload.cooldownDecisionId).toBe(
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
    expect(auditLogCreateMock.mock.calls[0]![0].data.actionType).toBe(
      "contact_replied_suppressed_in_flight",
    );
    // Cooldown key NOT written (the gate short-circuited).
    expect(redis.store.has(`decision-run:cooldown:${TENANT_A}:${CONTACT_X}`)).toBe(false);
    // The pre-existing in-flight lock is NOT released by this delivery — that's
    // the OWNING delivery's finally block's job.
    expect(redis.store.has(`decision-run:in-flight:${TENANT_A}:${CONTACT_X}`)).toBe(true);
  });

  it("in-flight lock released on audit-write error (finally block — orphan lock guard)", async () => {
    const redis = makeFakeRedis();
    __setRedisClientForTest(redis as never);
    // Force the PR4 decision_re_evaluated audit write to throw — handler
    // enters catch + finally. evaluateDealState succeeds first (per the
    // default mock); the throw is in the post-eval audit write site.
    // Sibling test PR4-brain-failure covers the brain-throw path.
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
    // Tenant B got the PR4 happy path — NOT the cooldown-suppression audit.
    expect(auditLogCreateMock).toHaveBeenCalledTimes(1);
    expect(auditLogCreateMock.mock.calls[0]![0].data.actionType).toBe(
      "decision_re_evaluated",
    );
    expect(auditLogCreateMock.mock.calls[0]![0].data.tenantId).toBe(TENANT_B);
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

// ─────────────────────────────────────────────
// KAN-1058 (Phase B PR III) — buildThreadContext wiring tests
//
// Reply chain: contact.replied → buildThreadContext(prisma, {tenantId,
// dealId, excludeEngagementId}) → result threaded as priorTurns into
// evaluateDealState's latestInbound argument. event.dealId is guaranteed
// non-null at the fetch site (the L360-378 null-dealId short-circuit
// returns 200 + audit + cooldown without calling the brain).
//
// Wiring-level pins only — prompt-rendering semantics live in
// packages/api/src/services/__tests__/brain-service.test.ts.
// ─────────────────────────────────────────────

describe("KAN-1058 (Phase B PR III) — buildThreadContext wiring", () => {
  it("calls buildThreadContext with {tenantId, dealId, excludeEngagementId: event.inboundEngagementId}", async () => {
    const redis = makeFakeRedis();
    __setRedisClientForTest(redis as never);
    const { body } = makeEnvelope(makeValidEvent());
    const res = await makeApp().request("/pubsub/contact-replied", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(200);
    // Sentinel: buildThreadContext fired exactly once before evaluateDealState.
    expect(buildThreadContextMock).toHaveBeenCalledTimes(1);
    const callArg = buildThreadContextMock.mock.calls[0]![1];
    expect(callArg).toEqual({
      tenantId: TENANT_A,
      dealId: DEAL_X,
      // event.inboundEngagementId is the just-received row; the helper
      // excludes it from the walk via WHERE id NOT IN.
      excludeEngagementId: INBOUND_ENG,
    });
  });

  it("threads buildThreadContext result into evaluateDealState.latestInbound.priorTurns", async () => {
    const priorTurnsFixture = [
      {
        direction: "outbound" as const,
        occurredAt: "2026-06-01T10:00:00.000Z",
        subjectLine: "Earlier outbound",
        bodyText: "Checking on your timeline.",
      },
      {
        direction: "inbound" as const,
        occurredAt: "2026-06-01T14:00:00.000Z",
        subjectLine: "Re: Earlier outbound",
        bodyText: "Looking at Q3.",
      },
    ];
    buildThreadContextMock.mockResolvedValueOnce(priorTurnsFixture);
    const redis = makeFakeRedis();
    __setRedisClientForTest(redis as never);
    const { body } = makeEnvelope(makeValidEvent());
    const res = await makeApp().request("/pubsub/contact-replied", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(200);
    // The evaluateDealState call receives latestInbound with the
    // priorTurns fixture verbatim. buildLatestInboundContext is the
    // passthrough mock here (L110) so the assertion shows end-to-end
    // threading from buildThreadContext through the helper.
    expect(evaluateDealStateMock).toHaveBeenCalledTimes(1);
    const evaluateOptions = evaluateDealStateMock.mock.calls[0]![2] as {
      latestInbound: { priorTurns: typeof priorTurnsFixture };
    };
    expect(evaluateOptions.latestInbound.priorTurns).toEqual(priorTurnsFixture);
  });

  it("null-dealId short-circuit does NOT call buildThreadContext (preserves the guard)", async () => {
    // L360-378 short-circuit: event.dealId === null → audit + cooldown + 200,
    // NO brain call. buildThreadContext must not fire either; the no-deal
    // path has no Deal to walk.
    const redis = makeFakeRedis();
    __setRedisClientForTest(redis as never);
    const { body } = makeEnvelope(makeValidEvent({ dealId: null }));
    const res = await makeApp().request("/pubsub/contact-replied", {
      method: "POST",
      body,
    });
    expect(res.status).toBe(200);
    // The skip-with-audit was written; buildThreadContext + evaluateDealState
    // both stayed silent.
    expect(buildThreadContextMock).not.toHaveBeenCalled();
    expect(evaluateDealStateMock).not.toHaveBeenCalled();
    expect(auditLogCreateMock.mock.calls[0]![0].data.actionType).toBe(
      "decision_re_evaluated_skipped_no_deal",
    );
  });
});
