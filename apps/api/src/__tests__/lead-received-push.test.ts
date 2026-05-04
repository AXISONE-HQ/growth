/**
 * KAN-774 + KAN-793 — lead-received push subscriber unit tests.
 *
 * Mocks: prisma (contact + stage + $transaction), verifyPubsubOidc,
 * and all 4 dynamic-import modules (assignment, bootstrap, normalizer,
 * engagement) loaded via the variable-specifier pattern in the subscriber.
 *
 * KAN-774 coverage (preserved):
 *   - OIDC verify success → assignment runs (rule mode)
 *   - OIDC verify failure → 401 + assignment NOT called
 *   - Malformed envelope → 200 ack-and-drop (poison-message defense)
 *   - Malformed inner payload (zod parse fail) → 200 ack-and-drop
 *
 * KAN-793 coverage (new):
 *   - Happy path (rule mode): bootstrap → assign → normalize → tx
 *     creates Deal + DealStageHistory + Engagement
 *   - Contact not found → 200 ack+drop (producer invariant violation)
 *   - Bootstrap fires before assignment (sequencing invariant)
 *   - assignment.mode = unassigned → no Deal write, 200 ok
 *   - assignment.mode = escalated → no Deal write, 200 ok
 *   - assignment.mode = ai_fallback → Deal written
 *   - assignment.mode = default_pipeline → Deal written
 *   - No initial Stage on assigned Pipeline → log + skip Deal write, 200 ok
 *   - Deal correlationId UNIQUE collision (P2002 redelivery) → 200 ok
 *   - Generic Prisma error inside tx → 500 (Pub/Sub retries)
 *   - Deal.correlationId built from event.eventId (idempotency anchor)
 *   - Engagement uses event.receivedAt (root-level, not nested)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyPubsubOidcMock = vi.fn();
const assignLeadToPipelineMock = vi.fn();
const ensureTenantHasDefaultPipelineMock = vi.fn();
const normalizeInboundMock = vi.fn();
const logEngagementMock = vi.fn();
const contactFindUniqueMock = vi.fn();
const stageFindFirstMock = vi.fn();
const dealCreateMock = vi.fn();
const dealStageHistoryCreateMock = vi.fn();
const transactionMock = vi.fn();
// KAN-819 — deal-continuity findMany lookup (existing open Deals for Contact)
const dealFindManyMock = vi.fn();

// KAN-815 — Phase 2 substrate mocks
const evaluateDealStateMock = vi.fn();
const evaluateStageTransitionMock = vi.fn();
const shapeMessageMock = vi.fn();
const evaluateSendPolicyMock = vi.fn();
const publishActionSendMock = vi.fn();
const resolveEmailConnectionIdMock = vi.fn();
const resolveReplyToForTenantMock = vi.fn();
const getPubSubClientMock = vi.fn();
const dealFindUniqueMock = vi.fn();
const decisionCreateMock = vi.fn();

vi.mock("../lib/oidc-pubsub-verify.js", () => ({
  verifyPubsubOidc: verifyPubsubOidcMock,
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    contact: { findUnique: contactFindUniqueMock },
    stage: { findFirst: stageFindFirstMock },
    deal: { findUnique: dealFindUniqueMock, findMany: dealFindManyMock },
    decision: { create: decisionCreateMock },
    engagement: { findUnique: vi.fn(), create: vi.fn() }, // KAN-819 — only invoked indirectly via mocked logEngagement
    $transaction: transactionMock,
  },
}));

vi.mock("../../../../packages/api/src/services/lead-assignment.js", () => ({
  assignLeadToPipeline: assignLeadToPipelineMock,
}));

vi.mock("../../../../packages/api/src/services/default-pipeline-bootstrap.js", () => ({
  ensureTenantHasDefaultPipeline: ensureTenantHasDefaultPipelineMock,
}));

vi.mock("../../../../packages/api/src/services/lead-normalizer.js", () => ({
  normalizeInbound: normalizeInboundMock,
}));

vi.mock("../../../../packages/api/src/services/engagement-service.js", () => ({
  logEngagement: logEngagementMock,
}));

// KAN-815 Phase 2 module mocks
vi.mock("../../../../packages/api/src/services/brain-service.js", () => ({
  evaluateDealState: evaluateDealStateMock,
}));

vi.mock("../../../../packages/api/src/services/stage-transition-engine.js", () => ({
  evaluateStageTransition: evaluateStageTransitionMock,
}));

vi.mock("../../../../packages/api/src/services/message-shaper.js", () => ({
  shapeMessage: shapeMessageMock,
}));

vi.mock("../../../../packages/api/src/services/send-policy.js", () => ({
  evaluateSendPolicy: evaluateSendPolicyMock,
}));

vi.mock("../../../../packages/api/src/services/message-composer.js", () => ({
  publishActionSend: publishActionSendMock,
  resolveEmailConnectionId: resolveEmailConnectionIdMock,
  // KAN-816: Reply-To lookup helper. Default returns the canonical
  // Toronto-tenant Reply-To address; per-test overrides via the
  // resolveReplyToForTenantMock declared below.
  resolveReplyToForTenant: resolveReplyToForTenantMock,
}));

vi.mock("../../../../packages/api/src/lib/pubsub-client.js", () => ({
  getPubSubClient: getPubSubClientMock,
}));

const { leadReceivedPushApp } = await import("../subscribers/lead-received-push.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const CONTACT_A = "22222222-2222-2222-2222-222222222222";
const PIPELINE_A = "pipeline_a";
const STAGE_INITIAL = "stage_initial_a";
const DEAL_A = "deal_created_a";

function buildLeadReceivedEvent(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date().toISOString();
  return {
    eventId: "550e8400-e29b-41d4-a716-446655440000",
    eventType: "lead.received" as const,
    version: "1.0" as const,
    publishedAt: now,
    tenantId: TENANT_A,
    contactId: CONTACT_A,
    source: "inbox_email" as const,
    metadata: {
      fromAddress: "test@example.com",
      subject: "Pricing inquiry",
      bodyPreview: "Hi, can you send pricing?",
      attachmentCount: 0,
    },
    receivedAt: now,
    ...overrides,
  };
}

function buildPushEnvelope(eventOverrides: Parameters<typeof buildLeadReceivedEvent>[0] = {}) {
  const event = buildLeadReceivedEvent(eventOverrides);
  return {
    message: {
      data: Buffer.from(JSON.stringify(event)).toString("base64"),
      messageId: "msg_test_001",
    },
    subscription: "projects/growth-493400/subscriptions/lead.received.assignment-worker",
  };
}

async function postEnvelope(envelope: unknown) {
  return leadReceivedPushApp.request("/lead-received", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
}

function setupHappyPathMocks(opts: {
  assignmentMode?: string;
  pipelineId?: string;
  stageId?: string | null;
} = {}) {
  verifyPubsubOidcMock.mockResolvedValue(true);
  contactFindUniqueMock.mockResolvedValue({ id: CONTACT_A, tenantId: TENANT_A });
  ensureTenantHasDefaultPipelineMock.mockResolvedValue({ id: PIPELINE_A });
  assignLeadToPipelineMock.mockResolvedValue({
    mode: opts.assignmentMode ?? "rule",
    ruleId: "rule_001",
    pipelineId: opts.pipelineId ?? PIPELINE_A,
    stageId: opts.stageId ?? STAGE_INITIAL,
  });
  stageFindFirstMock.mockResolvedValue({ id: STAGE_INITIAL });
  normalizeInboundMock.mockResolvedValue({
    source: "email",
    preParsed: {
      senderEmail: "test@example.com",
      senderNameGuess: null,
      subject: "Pricing inquiry",
      bodyText: "Hi, can you send pricing?",
    },
    extracted: {
      firstName: null,
      lastName: null,
      company: null,
      phone: null,
      intentSummary: "Asking about pricing",
      qualificationSignals: ["pricing"],
    },
    extractionConfidence: "medium",
    extractionError: null,
  });
  logEngagementMock.mockResolvedValue({ id: "eng_a" });

  // $transaction: invoke the callback with a tx that has deal + dealStageHistory delegates
  transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      deal: { create: dealCreateMock },
      dealStageHistory: { create: dealStageHistoryCreateMock },
    };
    return cb(tx);
  });
  dealCreateMock.mockResolvedValue({ id: DEAL_A });
  dealStageHistoryCreateMock.mockResolvedValue({ id: "dsh_a" });

  // KAN-815 Phase 2 wiring defaults — Brain returns wait_for_response so no
  // consumers fire by default. Existing tests that don't override this
  // continue to pass; new KAN-815 tests override per-case.
  evaluateDealStateMock.mockResolvedValue(buildBrainDecisionFixture({ type: "wait_for_response" }));
}

beforeEach(() => {
  verifyPubsubOidcMock.mockReset();
  assignLeadToPipelineMock.mockReset();
  ensureTenantHasDefaultPipelineMock.mockReset();
  normalizeInboundMock.mockReset();
  logEngagementMock.mockReset();
  contactFindUniqueMock.mockReset();
  stageFindFirstMock.mockReset();
  dealCreateMock.mockReset();
  dealStageHistoryCreateMock.mockReset();
  transactionMock.mockReset();
  // KAN-815 Phase 2 mocks
  evaluateDealStateMock.mockReset();
  evaluateStageTransitionMock.mockReset();
  shapeMessageMock.mockReset();
  evaluateSendPolicyMock.mockReset();
  publishActionSendMock.mockReset();
  resolveEmailConnectionIdMock.mockReset();
  resolveReplyToForTenantMock.mockReset();
  // KAN-816: default Reply-To resolution returns the canonical tenant
  // Reply-To. Tests that need to exercise the null/missing-slug case
  // override per-case.
  resolveReplyToForTenantMock.mockResolvedValue("c03065f6@leads.axisone.ca");
  getPubSubClientMock.mockReset();
  dealFindUniqueMock.mockReset();
  decisionCreateMock.mockReset();
  // KAN-819 — default to first-turn (no existing open Deals) so the entire
  // pre-Sprint-10 test corpus continues to exercise the bootstrap+assign+
  // create path. Tests that need multi-turn override this per-case.
  dealFindManyMock.mockReset();
  dealFindManyMock.mockResolvedValue([]);
});

// KAN-815 fixture builders
function buildBrainDecisionFixture(overrides: {
  type:
    | "send_follow_up"
    | "wait_for_response"
    | "advance_stage"
    | "escalate_to_human"
    | "close_deal_lost"
    | "no_action";
  confidence?: number;
  suggestedChannel?: "email" | "sms" | "meta_messenger";
  suggestedTone?: "curious" | "professional" | "urgent" | "closing";
  reasoning?: string;
}) {
  return {
    dealId: DEAL_A,
    evaluatedAt: new Date(),
    currentStateSnapshot: {
      dealStatus: "open",
      currentStageName: "New",
      currentStageOutcomeType: "open",
      daysInCurrentStage: 0,
      engagementCount: 1,
      lastEngagementType: "email_received",
      lastEngagementClass: "positive",
      daysSinceLastEngagement: 0,
      moProgressPercent: null,
      pipelineName: "KAN-702 Verify Pipeline",
      pipelineObjectiveType: "book_appointment",
    },
    nextBestAction: {
      type: overrides.type,
      reasoning: overrides.reasoning ?? "Test decision.",
      ...(overrides.suggestedChannel && { suggestedChannel: overrides.suggestedChannel }),
      ...(overrides.suggestedTone && { suggestedTone: overrides.suggestedTone }),
    },
    confidence: overrides.confidence ?? 0.85,
    modelTier: "reasoning" as const,
    llmInputTokens: 500,
    llmOutputTokens: 120,
  };
}

function buildShapedMessageFixture(overrides: {
  channel?: "email" | "sms" | "meta_messenger";
  subject?: string;
  body?: string;
}) {
  const channel = overrides.channel ?? "email";
  return {
    type: "shaped" as const,
    message: {
      dealId: DEAL_A,
      shapedAt: new Date(),
      channel,
      ...(channel === "email" && { subject: overrides.subject ?? "Quick question" }),
      body: overrides.body ?? "Hi Alice — saw your reply yesterday. Curious what caught your eye?",
      tone: "curious" as const,
      rationale: "Open-ended discovery.",
      antiRepetitionContextCount: 0,
      modelTier: "reasoning" as const,
      llmInputTokens: 510,
      llmOutputTokens: 95,
    },
    brainDecision: buildBrainDecisionFixture({ type: "send_follow_up" }),
  };
}

// ─────────────────────────────────────────────
// KAN-774 — preserved boundary cases
// ─────────────────────────────────────────────

describe("KAN-774 — boundary handling (preserved)", () => {
  it("OIDC verify failure → 401 + no downstream side effects", async () => {
    verifyPubsubOidcMock.mockResolvedValue(false);
    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(401);
    expect(contactFindUniqueMock).not.toHaveBeenCalled();
    expect(assignLeadToPipelineMock).not.toHaveBeenCalled();
  });

  it("malformed envelope (no message.data) → 200 ack-and-drop", async () => {
    verifyPubsubOidcMock.mockResolvedValue(true);
    const res = await postEnvelope({ message: {} });
    expect(res.status).toBe(200);
    expect(contactFindUniqueMock).not.toHaveBeenCalled();
    expect(assignLeadToPipelineMock).not.toHaveBeenCalled();
  });

  it("malformed inner payload (zod parse fails) → 200 ack-and-drop", async () => {
    verifyPubsubOidcMock.mockResolvedValue(true);
    const badPayload = { eventType: "lead.received", contactId: "not-a-uuid" };
    const res = await postEnvelope({
      message: {
        data: Buffer.from(JSON.stringify(badPayload)).toString("base64"),
        messageId: "msg_bad",
      },
    });
    expect(res.status).toBe(200);
    expect(contactFindUniqueMock).not.toHaveBeenCalled();
    expect(assignLeadToPipelineMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// KAN-793 — Track A → Deal integration
// ─────────────────────────────────────────────

describe("KAN-793 — happy path (rule mode)", () => {
  it("bootstrap → assign → normalize → tx writes Deal + DealStageHistory + Engagement", async () => {
    setupHappyPathMocks();
    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    expect(contactFindUniqueMock).toHaveBeenCalledOnce();
    expect(ensureTenantHasDefaultPipelineMock).toHaveBeenCalledOnce();
    expect(assignLeadToPipelineMock).toHaveBeenCalledOnce();
    expect(normalizeInboundMock).toHaveBeenCalledOnce();
    expect(stageFindFirstMock).toHaveBeenCalledOnce();
    expect(transactionMock).toHaveBeenCalledOnce();
    expect(dealCreateMock).toHaveBeenCalledOnce();
    expect(dealStageHistoryCreateMock).toHaveBeenCalledOnce();
    expect(logEngagementMock).toHaveBeenCalledOnce();
  });

  it("sequencing invariant — bootstrap fires BEFORE assignLeadToPipeline", async () => {
    setupHappyPathMocks();
    const callOrder: string[] = [];
    ensureTenantHasDefaultPipelineMock.mockImplementation(async () => {
      callOrder.push("bootstrap");
      return { id: PIPELINE_A };
    });
    assignLeadToPipelineMock.mockImplementation(async () => {
      callOrder.push("assign");
      return { mode: "rule", pipelineId: PIPELINE_A, stageId: STAGE_INITIAL };
    });

    await postEnvelope(buildPushEnvelope());
    expect(callOrder).toEqual(["bootstrap", "assign"]);
  });

  it("Deal.correlationId derives from event.eventId (Pub/Sub redelivery idempotency anchor)", async () => {
    setupHappyPathMocks();
    const eventId = "550e8400-e29b-41d4-a716-446655440099";
    await postEnvelope(buildPushEnvelope({ eventId }));

    const dealArgs = (dealCreateMock.mock.calls[0]![0] as { data: { correlationId: string } }).data;
    expect(dealArgs.correlationId).toBe(`deal:lead-received:${eventId}`);
  });

  it("Engagement uses event.receivedAt (root-level, not nested in metadata)", async () => {
    setupHappyPathMocks();
    const receivedAt = "2026-05-03T12:34:56.000Z";
    await postEnvelope(buildPushEnvelope({ receivedAt }));

    const engArgs = logEngagementMock.mock.calls[0]![1] as { occurredAt: Date; correlationId: string };
    expect(engArgs.occurredAt.toISOString()).toBe(receivedAt);
    expect(engArgs.correlationId).toContain("engagement:lead-received:");
  });

  it("Deal write uses pipelineId + stageId from assignment.result (not bootstrap return)", async () => {
    setupHappyPathMocks();
    // Bootstrap returns one Pipeline, assignLeadToPipeline picks a different
    // one (e.g. tenant has multiple Pipelines and rules route elsewhere).
    ensureTenantHasDefaultPipelineMock.mockResolvedValue({ id: "bootstrap-pipeline" });
    assignLeadToPipelineMock.mockResolvedValue({
      mode: "rule",
      pipelineId: "rule-routed-pipeline",
      stageId: STAGE_INITIAL,
    });
    stageFindFirstMock.mockResolvedValue({ id: STAGE_INITIAL });

    await postEnvelope(buildPushEnvelope());

    expect(stageFindFirstMock.mock.calls[0]![0]).toMatchObject({
      where: { pipelineId: "rule-routed-pipeline", isInitial: true },
    });
    const dealArgs = (dealCreateMock.mock.calls[0]![0] as { data: { pipelineId: string } }).data;
    expect(dealArgs.pipelineId).toBe("rule-routed-pipeline");
  });
});

describe("KAN-793 — assignment-mode dispatch", () => {
  it("ai_fallback mode → Deal written", async () => {
    setupHappyPathMocks({ assignmentMode: "ai_fallback" });
    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(200);
    expect(dealCreateMock).toHaveBeenCalledOnce();
  });

  it("default_pipeline mode → Deal written", async () => {
    setupHappyPathMocks({ assignmentMode: "default_pipeline" });
    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(200);
    expect(dealCreateMock).toHaveBeenCalledOnce();
  });

  it("unassigned mode → no Deal write, 200 ok (Phase 1 ambiguous-routing posture)", async () => {
    setupHappyPathMocks();
    assignLeadToPipelineMock.mockResolvedValue({ mode: "unassigned" });

    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(200);
    expect(dealCreateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(normalizeInboundMock).not.toHaveBeenCalled();
  });

  it("escalated mode → no Deal write, 200 ok", async () => {
    setupHappyPathMocks();
    assignLeadToPipelineMock.mockResolvedValue({ mode: "escalated", escalationId: "esc_a" });

    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(200);
    expect(dealCreateMock).not.toHaveBeenCalled();
  });
});

describe("KAN-793 — error + edge cases", () => {
  it("Contact not found → 200 ack+drop (producer invariant violation)", async () => {
    verifyPubsubOidcMock.mockResolvedValue(true);
    contactFindUniqueMock.mockResolvedValue(null);

    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(200);
    expect(ensureTenantHasDefaultPipelineMock).not.toHaveBeenCalled();
    expect(assignLeadToPipelineMock).not.toHaveBeenCalled();
  });

  it("no initial Stage on assigned Pipeline → log + skip Deal write, 200 ok", async () => {
    setupHappyPathMocks();
    stageFindFirstMock.mockResolvedValue(null);

    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(200);
    expect(dealCreateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("Deal correlationId UNIQUE collision (P2002) → 200 ok (idempotent redelivery)", async () => {
    setupHappyPathMocks();
    const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    transactionMock.mockRejectedValue(p2002);

    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(200);
  });

  it("generic Prisma error inside tx → 500 (Pub/Sub retries)", async () => {
    setupHappyPathMocks();
    transactionMock.mockRejectedValue(new Error("connection refused"));

    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(500);
  });

  it("assignLeadToPipeline throws → 500 (Pub/Sub retries)", async () => {
    verifyPubsubOidcMock.mockResolvedValue(true);
    contactFindUniqueMock.mockResolvedValue({ id: CONTACT_A, tenantId: TENANT_A });
    ensureTenantHasDefaultPipelineMock.mockResolvedValue({ id: PIPELINE_A });
    assignLeadToPipelineMock.mockRejectedValue(new Error("DB connection failed"));

    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(500);
  });

  it("Deal metadata captures normalizer extractionConfidence + assignment.mode for downstream observability", async () => {
    setupHappyPathMocks();
    await postEnvelope(buildPushEnvelope());

    const dealArgs = (dealCreateMock.mock.calls[0]![0] as { data: { metadata: Record<string, unknown> } }).data;
    expect(dealArgs.metadata).toMatchObject({
      source: "track_a_email_inbound",
      assignmentMode: "rule",
      normalizedLeadConfidence: "medium",
    });
  });
});

// ─────────────────────────────────────────────
// KAN-815 — Phase 2 wiring integration tests
// ─────────────────────────────────────────────

function setupPhase2DispatchMocks() {
  // Default: Brain returns send_follow_up + email; shape returns shaped;
  // policy allows; Contact has email; ChannelConnection found; Decision row
  // created; publish succeeds. Tests override individual mocks per case.
  evaluateDealStateMock.mockResolvedValueOnce(
    buildBrainDecisionFixture({
      type: "send_follow_up",
      suggestedChannel: "email",
      suggestedTone: "curious",
    }),
  );
  shapeMessageMock.mockResolvedValueOnce(buildShapedMessageFixture({ channel: "email" }));
  evaluateSendPolicyMock.mockResolvedValueOnce({ type: "allow", reason: "All policy checks passed" });
  dealFindUniqueMock.mockResolvedValueOnce({
    id: DEAL_A,
    tenantId: TENANT_A,
    contactId: CONTACT_A,
    contact: { id: CONTACT_A, email: "alice@acme.com" },
  });
  resolveEmailConnectionIdMock.mockResolvedValueOnce("conn_email_active");
  decisionCreateMock.mockResolvedValueOnce({ id: "decision_brain_v1" });
  getPubSubClientMock.mockReturnValueOnce({ publish: vi.fn() });
  publishActionSendMock.mockResolvedValueOnce("pubsub_msg_id_123");
}

describe("KAN-815 — Phase 2 wiring (Brain trigger framework + consumer dispatch)", () => {
  // ── Test 1 — Brain wait_for_response → no transition, no shape, no dispatch (existing-behavior regression)
  it("Brain returns wait_for_response → no consumers fire (production unchanged)", async () => {
    setupHappyPathMocks(); // Brain default = wait_for_response

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    expect(evaluateDealStateMock).toHaveBeenCalledOnce();
    expect(evaluateStageTransitionMock).not.toHaveBeenCalled();
    expect(shapeMessageMock).not.toHaveBeenCalled();
    expect(evaluateSendPolicyMock).not.toHaveBeenCalled();
    expect(publishActionSendMock).not.toHaveBeenCalled();
    expect(decisionCreateMock).not.toHaveBeenCalled();
  });

  // ── Test 2 — Brain advance_stage → stage-transition called
  it("Brain returns advance_stage → evaluateStageTransition fires; no shape/dispatch", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "advance_stage", confidence: 0.9 }),
    );
    evaluateStageTransitionMock.mockResolvedValueOnce({
      type: "transitioned",
      dealId: DEAL_A,
      fromStageId: STAGE_INITIAL,
      toStageId: "stage_qualified",
      transitionRowId: "dsh_new",
    });

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    expect(evaluateStageTransitionMock).toHaveBeenCalledOnce();
    expect(evaluateStageTransitionMock.mock.calls[0]![1]).toBe(DEAL_A);
    expect(shapeMessageMock).not.toHaveBeenCalled();
    expect(publishActionSendMock).not.toHaveBeenCalled();
  });

  // ── Test 3 — Brain close_deal_lost → stage-transition called
  it("Brain returns close_deal_lost → evaluateStageTransition fires", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "close_deal_lost", confidence: 0.7 }),
    );
    evaluateStageTransitionMock.mockResolvedValueOnce({
      type: "skipped",
      dealId: DEAL_A,
      reason: "no_terminal_lost_stage_in_pipeline",
    });

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    expect(evaluateStageTransitionMock).toHaveBeenCalledOnce();
  });

  // ── Test 4 — send_follow_up + shape allow + policy allow → publishActionSend called with correct payload
  it("Brain send_follow_up + shape allow + policy allow → publishActionSend called", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    setupPhase2DispatchMocks();

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    expect(publishActionSendMock).toHaveBeenCalledOnce();
    const callArgs = publishActionSendMock.mock.calls[0]!;
    const publishInput = callArgs[1] as {
      tenantId: string;
      contactId: string;
      decisionId: string;
      toEmail: string;
      composed: { subject: string; body: string; unsubscribeUrl: string };
      connectionId: string;
    };
    expect(publishInput.tenantId).toBe(TENANT_A);
    expect(publishInput.contactId).toBe(CONTACT_A);
    expect(publishInput.decisionId).toBe("decision_brain_v1");
    expect(publishInput.toEmail).toBe("alice@acme.com");
    expect(publishInput.composed.subject).toBe("Quick question");
    expect(publishInput.composed.body).toContain("Alice");
    expect(publishInput.composed.unsubscribeUrl).toContain("/unsubscribe/");
    expect(publishInput.composed.unsubscribeUrl).toContain(CONTACT_A);
    expect(publishInput.connectionId).toBe("conn_email_active");
  });

  // ── KAN-816: Reply-To wiring regression — KAN-815c dispatch passes
  //    resolved Reply-To address through to publishActionSend. Confirms the
  //    customer-reply loop is architecturally wired (recipient replies route
  //    to <inboxSlug>@leads.<LEAD_INBOX_DOMAIN> instead of the From address).
  it("KAN-816: send_follow_up dispatch resolves tenant Reply-To + passes through to publishActionSend", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    setupPhase2DispatchMocks();

    await postEnvelope(buildPushEnvelope());

    expect(resolveReplyToForTenantMock).toHaveBeenCalledOnce();
    expect(resolveReplyToForTenantMock.mock.calls[0]![1]).toBe(TENANT_A);

    const publishInput = publishActionSendMock.mock.calls[0]![1] as { replyTo?: string };
    expect(publishInput.replyTo).toBe("c03065f6@leads.axisone.ca");
  });

  // ── KAN-816: Reply-To omitted when tenant has no inboxSlug (graceful)
  it("KAN-816: send_follow_up dispatch omits Reply-To when tenant has no inboxSlug (warn-and-continue)", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    setupPhase2DispatchMocks();
    resolveReplyToForTenantMock.mockReset();
    resolveReplyToForTenantMock.mockResolvedValueOnce(null); // no inboxSlug

    await postEnvelope(buildPushEnvelope());

    const publishInput = publishActionSendMock.mock.calls[0]![1] as { replyTo?: string };
    expect(publishInput.replyTo).toBeUndefined();
    // dispatch still proceeds — Reply-To omission is graceful
    expect(publishActionSendMock).toHaveBeenCalledOnce();
  });

  // ── Test 5 — send_follow_up + shape returns no_shape → publishActionSend NOT called
  it("Brain send_follow_up + shape returns no_shape → publishActionSend NOT called; warn log", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "send_follow_up", suggestedChannel: "email" }),
    );
    shapeMessageMock.mockResolvedValueOnce({
      type: "no_shape",
      dealId: DEAL_A,
      reason: "Message Shaper fallback: LLM call failed.",
    });

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    expect(shapeMessageMock).toHaveBeenCalledOnce();
    expect(evaluateSendPolicyMock).not.toHaveBeenCalled();
    expect(publishActionSendMock).not.toHaveBeenCalled();
    expect(decisionCreateMock).not.toHaveBeenCalled();
  });

  // ── Test 6 — send_follow_up + shape allow + policy deny → publishActionSend NOT called
  it("Brain send_follow_up + shape allow + policy deny → publishActionSend NOT called; warn log with ruleViolated", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "send_follow_up", suggestedChannel: "email" }),
    );
    shapeMessageMock.mockResolvedValueOnce(buildShapedMessageFixture({ channel: "email" }));
    dealFindUniqueMock.mockResolvedValueOnce({
      id: DEAL_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      contact: { id: CONTACT_A, email: "alice@acme.com" },
    });
    evaluateSendPolicyMock.mockResolvedValueOnce({
      type: "deny",
      reason: "Contact suppressed for email: email_unsubscribe on 2026-04-01T12:00:00.000Z",
      ruleViolated: "suppression",
    });

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    expect(evaluateSendPolicyMock).toHaveBeenCalledOnce();
    expect(publishActionSendMock).not.toHaveBeenCalled();
    expect(decisionCreateMock).not.toHaveBeenCalled();
  });

  // ── Test 7 — send_follow_up + shape allow + policy defer → publishActionSend NOT called
  it("Brain send_follow_up + shape allow + policy defer → publishActionSend NOT called; info log with deferUntil", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "send_follow_up", suggestedChannel: "email" }),
    );
    shapeMessageMock.mockResolvedValueOnce(buildShapedMessageFixture({ channel: "email" }));
    dealFindUniqueMock.mockResolvedValueOnce({
      id: DEAL_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      contact: { id: CONTACT_A, email: "alice@acme.com" },
    });
    evaluateSendPolicyMock.mockResolvedValueOnce({
      type: "defer",
      reason: "Outside tenant send window (9:00-21:00 UTC)",
      deferUntil: new Date("2026-05-04T09:00:00.000Z"),
    });

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    expect(publishActionSendMock).not.toHaveBeenCalled();
    expect(decisionCreateMock).not.toHaveBeenCalled();
  });

  // ── Test 8 — Brain throws → Phase 2 wiring caught, no propagation, inbound still committed (regression)
  it("Brain throws → Phase 2 wiring caught (response still 200, engagement-write committed)", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockRejectedValueOnce(new Error("Brain Service unavailable"));

    const res = await postEnvelope(buildPushEnvelope());

    // Inbound chain succeeded — engagement was committed BEFORE Brain wiring.
    expect(res.status).toBe(200);
    expect(dealCreateMock).toHaveBeenCalledOnce(); // Phase 1 write happened
    // Phase 2 fired Brain but failed; downstream consumers never invoked.
    expect(evaluateDealStateMock).toHaveBeenCalledOnce();
    expect(evaluateStageTransitionMock).not.toHaveBeenCalled();
    expect(shapeMessageMock).not.toHaveBeenCalled();
  });

  // ── Test 9 — evaluateDealState called exactly ONCE per inbound (no double-eval)
  it("evaluateDealState called exactly ONCE per inbound (no double-eval)", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    setupPhase2DispatchMocks();

    await postEnvelope(buildPushEnvelope());

    expect(evaluateDealStateMock).toHaveBeenCalledOnce();
  });

  // ── Test 10 — engagement-write commits BEFORE Phase 2 wiring runs (atomicity sequencing)
  it("engagement-write transaction commits BEFORE Phase 2 Brain eval fires", async () => {
    setupHappyPathMocks();
    const callOrder: string[] = [];
    transactionMock.mockReset();
    transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      callOrder.push("tx-start");
      const tx = {
        deal: { create: dealCreateMock },
        dealStageHistory: { create: dealStageHistoryCreateMock },
      };
      const result = await cb(tx);
      callOrder.push("tx-commit");
      return result;
    });
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockImplementationOnce(async () => {
      callOrder.push("brain-eval");
      return buildBrainDecisionFixture({ type: "wait_for_response" });
    });

    await postEnvelope(buildPushEnvelope());

    expect(callOrder).toEqual(["tx-start", "tx-commit", "brain-eval"]);
  });

  // ── Test 11 — KAN-815c Decision row written with spec'd shape
  it("send_follow_up dispatch writes Decision row with brain_phase_2_v1 strategy + Brain metadata", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    setupPhase2DispatchMocks();

    await postEnvelope(buildPushEnvelope());

    expect(decisionCreateMock).toHaveBeenCalledOnce();
    const decisionArgs = decisionCreateMock.mock.calls[0]![0] as {
      data: {
        tenantId: string;
        contactId: string;
        strategySelected: string;
        actionType: string;
        confidence: number;
        reasoning: string;
        metadata: Record<string, unknown>;
      };
    };
    expect(decisionArgs.data.tenantId).toBe(TENANT_A);
    expect(decisionArgs.data.contactId).toBe(CONTACT_A);
    expect(decisionArgs.data.strategySelected).toBe("brain_phase_2_v1");
    expect(decisionArgs.data.actionType).toBe("send_follow_up");
    expect(decisionArgs.data.confidence).toBe(0.85);
    expect(decisionArgs.data.metadata).toMatchObject({
      dealId: DEAL_A,
      brainModelTier: "reasoning",
      shaperTier: "reasoning",
    });
  });

  // ── Test 12 — KAN-815c channel skip: shape returns sms → publishActionSend NOT called, info log
  it("send_follow_up + shape returns channel=sms → publishActionSend NOT called (Phase 3 deferred)", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "send_follow_up", suggestedChannel: "sms" }),
    );
    shapeMessageMock.mockResolvedValueOnce(buildShapedMessageFixture({ channel: "sms" }));

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    expect(shapeMessageMock).toHaveBeenCalledOnce();
    // Channel skip happens BEFORE policy / connection lookup / publish.
    expect(evaluateSendPolicyMock).not.toHaveBeenCalled();
    expect(dealFindUniqueMock).not.toHaveBeenCalled();
    expect(publishActionSendMock).not.toHaveBeenCalled();
    expect(decisionCreateMock).not.toHaveBeenCalled();
  });

  // ── Test 13 — KAN-815c connection lookup miss: resolveEmailConnectionId returns null → no dispatch
  it("send_follow_up + policy allow + no ACTIVE EMAIL ChannelConnection → publishActionSend NOT called; warn log", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "send_follow_up", suggestedChannel: "email" }),
    );
    shapeMessageMock.mockResolvedValueOnce(buildShapedMessageFixture({ channel: "email" }));
    dealFindUniqueMock.mockResolvedValueOnce({
      id: DEAL_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      contact: { id: CONTACT_A, email: "alice@acme.com" },
    });
    evaluateSendPolicyMock.mockResolvedValueOnce({ type: "allow", reason: "ok" });
    resolveEmailConnectionIdMock.mockResolvedValueOnce(null); // no active connection

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    expect(resolveEmailConnectionIdMock).toHaveBeenCalledOnce();
    expect(decisionCreateMock).not.toHaveBeenCalled(); // Decision row not written when dispatch can't happen
    expect(publishActionSendMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// KAN-819 — Deal continuity for multi-turn AI conversations
// ─────────────────────────────────────────────

describe("KAN-819 — Deal continuity for multi-turn AI conversations", () => {
  const REUSED_DEAL_ID = "cmoreused0001m7wb000000000";
  const STAGE_NEW = "stage_new_open";

  function buildOpenDeal(overrides: Partial<{ id: string; createdAt: Date; stageName: string }> = {}) {
    return {
      id: overrides.id ?? REUSED_DEAL_ID,
      contactId: CONTACT_A,
      tenantId: TENANT_A,
      pipelineId: PIPELINE_A,
      currentStageId: STAGE_NEW,
      createdAt: overrides.createdAt ?? new Date("2026-05-04T19:21:12.275Z"),
      currentStage: {
        id: STAGE_NEW,
        name: overrides.stageName ?? "New",
        outcomeType: "open" as const,
      },
    };
  }

  // ── Test 1 — First-turn (regression): no existing open Deals → existing
  //    bootstrap+assign+create path. Confirms KAN-819 doesn't break the
  //    pre-Sprint-10 happy path.
  it("first-turn (no existing open Deal) → bootstrap+assign+create path runs unchanged", async () => {
    setupHappyPathMocks();
    dealFindManyMock.mockResolvedValueOnce([]); // explicit override for clarity

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    // Continuity check fired
    expect(dealFindManyMock).toHaveBeenCalledOnce();
    expect(dealFindManyMock.mock.calls[0]![0]).toMatchObject({
      where: {
        contactId: CONTACT_A,
        currentStage: { outcomeType: "open" },
      },
      orderBy: { createdAt: "desc" },
    });
    // First-turn path: bootstrap + assign + create all ran
    expect(ensureTenantHasDefaultPipelineMock).toHaveBeenCalledOnce();
    expect(assignLeadToPipelineMock).toHaveBeenCalledOnce();
    expect(dealCreateMock).toHaveBeenCalledOnce();
    expect(dealStageHistoryCreateMock).toHaveBeenCalledOnce();
    expect(logEngagementMock).toHaveBeenCalledOnce();
  });

  // ── Test 2 — Multi-turn (one existing open Deal): reuse + skip bootstrap/
  //    assign/create + still write Engagement attached to existing Deal.
  it("multi-turn (one existing open Deal) → reuse, skip bootstrap+assign+create, write Engagement to existing Deal", async () => {
    setupHappyPathMocks();
    dealFindManyMock.mockReset();
    dealFindManyMock.mockResolvedValueOnce([buildOpenDeal()]);
    const infoSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    // Skipped bootstrap/assign/create
    expect(ensureTenantHasDefaultPipelineMock).not.toHaveBeenCalled();
    expect(assignLeadToPipelineMock).not.toHaveBeenCalled();
    expect(dealCreateMock).not.toHaveBeenCalled();
    expect(dealStageHistoryCreateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    // Still wrote Engagement attached to REUSED Deal
    expect(normalizeInboundMock).toHaveBeenCalledOnce();
    expect(logEngagementMock).toHaveBeenCalledOnce();
    const engArgs = logEngagementMock.mock.calls[0]![1] as {
      dealId: string;
      contactId: string;
      tenantId: string;
      metadata: Record<string, unknown>;
    };
    expect(engArgs.dealId).toBe(REUSED_DEAL_ID);
    expect(engArgs.contactId).toBe(CONTACT_A);
    expect(engArgs.tenantId).toBe(TENANT_A);
    expect(engArgs.metadata.kan819Reused).toBe(true);
    // info log emitted with the reuse marker
    expect(
      infoSpy.mock.calls.some((args) =>
        String(args[0] ?? "").includes("kan-819-reusing-existing-open-deal-multi-turn"),
      ),
    ).toBe(true);
    infoSpy.mockRestore();
  });

  // ── Test 3 — Multi-turn anomaly: 2+ open Deals → reuse most recent +
  //    emit constraint-violation warn log with all deal ids.
  it("multi-turn anomaly (multiple open Deals) → reuse most recent + warn with all deal ids", async () => {
    setupHappyPathMocks();
    const olderDeal = buildOpenDeal({
      id: "cmorolder0001m7wb000000000",
      createdAt: new Date("2026-05-04T18:00:00.000Z"),
    });
    const newestDeal = buildOpenDeal({
      id: "cmornewest0001m7wb000000000",
      createdAt: new Date("2026-05-04T19:30:00.000Z"),
    });
    dealFindManyMock.mockReset();
    // The handler relies on orderBy:createdAt-desc — emulate that here.
    dealFindManyMock.mockResolvedValueOnce([newestDeal, olderDeal]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    // Reuse picked the most recent (first in desc-ordered findMany)
    const engArgs = logEngagementMock.mock.calls[0]![1] as { dealId: string };
    expect(engArgs.dealId).toBe(newestDeal.id);
    // Warn log emitted with all deal ids (most-recent + the rest)
    const warnLine = warnSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .find((s) => s.includes("kan-819-multiple-open-deals-violates-constraint-using-most-recent"));
    expect(warnLine).toBeDefined();
    expect(warnLine).toContain(`reusingDealId=${newestDeal.id}`);
    expect(warnLine).toContain(`openDealCount=2`);
    expect(warnLine).toContain(olderDeal.id);
    warnSpy.mockRestore();
  });

  // ── Test 4 — Multi-cycle: only CLOSED Deals exist → first-turn path (new
  //    Deal). The findMany filter currentStage.outcomeType='open' excludes
  //    closed Deals server-side, so this test mirrors that contract by
  //    returning [] from the mock.
  it("multi-cycle (existing closed Deals only) → first-turn path runs (closed Deals excluded by query)", async () => {
    setupHappyPathMocks();
    // currentStage.outcomeType='open' filter at the DB level excludes any
    // terminal_won / terminal_lost / etc. — so the mock returns [] even
    // though a closed Deal exists for this Contact in real data.
    dealFindManyMock.mockReset();
    dealFindManyMock.mockResolvedValueOnce([]);

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    expect(ensureTenantHasDefaultPipelineMock).toHaveBeenCalledOnce();
    expect(assignLeadToPipelineMock).toHaveBeenCalledOnce();
    expect(dealCreateMock).toHaveBeenCalledOnce(); // new Deal for the new turn
  });

  // ── Test 5 — Idempotency: same eventId fires twice on multi-turn path →
  //    correlationId UNIQUE on Engagement makes the second a no-op (logEngagement
  //    has internal dedup; here we verify the handler still returns 200 + the
  //    correlationId is set so the dedup works).
  it("multi-turn idempotency — same eventId fires twice → 200 both times, correlationId set on Engagement for dedup", async () => {
    setupHappyPathMocks();
    dealFindManyMock.mockReset();
    dealFindManyMock.mockResolvedValue([buildOpenDeal()]); // persistent: returns same deal for both calls
    const eventId = "550e8400-e29b-41d4-a716-446655440042";

    const res1 = await postEnvelope(buildPushEnvelope({ eventId }));
    const res2 = await postEnvelope(buildPushEnvelope({ eventId }));

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // Both calls hit logEngagement; the helper's own correlationId-dedup
    // makes the second a no-op against the DB. Here we just confirm the
    // handler computed and passed the correlationId so dedup is possible.
    expect(logEngagementMock).toHaveBeenCalledTimes(2);
    const corrId1 = (logEngagementMock.mock.calls[0]![1] as { correlationId: string }).correlationId;
    const corrId2 = (logEngagementMock.mock.calls[1]![1] as { correlationId: string }).correlationId;
    expect(corrId1).toBe(`engagement:lead-received:${eventId}`);
    expect(corrId2).toBe(corrId1);
  });

  // ── Test 6 — Brain re-eval reads the REUSED Deal (not a wrong Deal). On
  //    multi-turn, evaluateDealState must be invoked with the existing
  //    dealId so it sees the full prior conversation history.
  it("multi-turn → evaluateDealState invoked with reused Deal id (not new one)", async () => {
    setupHappyPathMocks();
    dealFindManyMock.mockReset();
    dealFindManyMock.mockResolvedValueOnce([buildOpenDeal()]);

    await postEnvelope(buildPushEnvelope());

    expect(evaluateDealStateMock).toHaveBeenCalledOnce();
    // Brain receives the REUSED dealId, not DEAL_A (which would only be
    // produced by the first-turn writePhase1Deal path that was skipped).
    expect(evaluateDealStateMock.mock.calls[0]![1]).toBe(REUSED_DEAL_ID);
    // Sanity: dealCreateMock NOT called (proving the reused id wasn't a fresh write)
    expect(dealCreateMock).not.toHaveBeenCalled();
  });
});
