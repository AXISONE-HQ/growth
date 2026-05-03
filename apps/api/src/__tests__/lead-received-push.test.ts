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

// KAN-815 — Phase 2 substrate mocks
const evaluateDealStateMock = vi.fn();
const evaluateStageTransitionMock = vi.fn();
const shapeMessageMock = vi.fn();
const evaluateSendPolicyMock = vi.fn();
const publishActionSendMock = vi.fn();
const resolveEmailConnectionIdMock = vi.fn();
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
    deal: { findUnique: dealFindUniqueMock },
    decision: { create: decisionCreateMock },
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
  getPubSubClientMock.mockReset();
  dealFindUniqueMock.mockReset();
  decisionCreateMock.mockReset();
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
