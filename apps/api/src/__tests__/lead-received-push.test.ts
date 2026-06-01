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
// KAN-814 — deferredSend mocks for supersession path + persistence on defer
const deferredSendUpdateManyMock = vi.fn();
const deferredSendCreateMock = vi.fn();

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

// KAN-1037-PR4.5 — escalation create + recent-Decision lookup for the
// new engine_proposed_action escalation consumer. Exported below for
// per-test stubbing.
const escalationCreateMock = vi.fn(async ({ select }: { select?: { id?: boolean } } = {}) =>
  select?.id ? { id: "esc_engine_proposed_a" } : { id: "esc_engine_proposed_a" },
);
const decisionFindFirstMock = vi.fn();
const auditLogCreateLeadReceivedMock = vi.fn().mockResolvedValue({ id: "audit_a" });

// KAN-1042 PR A2 — Tenant.findUnique for autoTransitionSubObjectives
// dispatcher-level governance read. Per-test default unset (resolves
// undefined → fail-safe escalate branch); explicit per-test mocks for
// the opt-in dispatch branch.
const tenantFindUniqueMock = vi.fn();
// KAN-1042 PR A2 — transitionSubObjectiveState mock for the dispatcher
// arm's auto-dispatch path. Resolves the canonical { ok, previousState,
// wasNoOp } shape; per-test overrides for assertion paths.
const transitionSubObjectiveStateMock = vi.fn(async () => ({
  ok: true as const,
  previousState: "unknown" as const,
  wasNoOp: false,
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    contact: { findUnique: contactFindUniqueMock },
    stage: { findFirst: stageFindFirstMock },
    deal: { findUnique: dealFindUniqueMock, findMany: dealFindManyMock },
    decision: { create: decisionCreateMock, findFirst: decisionFindFirstMock },
    engagement: { findUnique: vi.fn(), create: vi.fn() }, // KAN-819 — only invoked indirectly via mocked logEngagement
    deferredSend: {
      updateMany: deferredSendUpdateManyMock,
      create: deferredSendCreateMock,
    },
    // M3-2.5b — audit-log create is fire-and-forget after correlation tx commits.
    auditLog: { create: auditLogCreateLeadReceivedMock },
    // KAN-1037-PR4.5 — escalation create wired for the engine_proposed_action
    // consumer; mocked to return a stable id so tests can assert on its
    // presence in audit + observability assertions.
    escalation: { create: escalationCreateMock },
    // KAN-1042 PR A2 — tenant.findUnique for dispatcher-arm governance
    // read of Tenant.autoTransitionSubObjectives.
    tenant: { findUnique: tenantFindUniqueMock },
    $transaction: transactionMock,
  },
}));

// M3-2.5b — resolve-active-deal module loader.
vi.mock("../../../../packages/api/src/services/resolve-active-deal.js", () => ({
  resolveActiveDealForContact: vi.fn(async () => null),
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

// KAN-1042 PR A2 — sub-objective-gap-tracker module mock for the
// dispatcher-arm's auto-dispatch path (Tenant.autoTransitionSubObjectives
// === true branch). Default returns the canonical extended return shape
// { ok, previousState, wasNoOp }; per-test overrides for arm assertions.
vi.mock("../../../../packages/api/src/services/sub-objective-gap-tracker.js", () => ({
  transitionSubObjectiveState: transitionSubObjectiveStateMock,
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
    source: "email_inbox" as const,
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
      companyName: null,
      phone: null,
      intentSummary: "Asking about pricing",
      qualificationSignals: ["pricing"],
    },
    extractionConfidence: "medium",
    extractionError: null,
  });
  logEngagementMock.mockResolvedValue({ id: "eng_a" });

  // $transaction: invoke the callback with a tx that has deal +
  // dealStageHistory delegates + M3-2.5b sidecar/engagement-update delegates.
  // The default sidecar findFirst returns null (no correlation match) so
  // existing tests don't accidentally trigger override; tests that exercise
  // correlation override per-case.
  transactionMock.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      deal: { create: dealCreateMock },
      dealStageHistory: { create: dealStageHistoryCreateMock },
      // M3-2.5b — inbound sidecar + correlation override + lookup paths.
      engagement: { update: vi.fn() },
      engagementEmailMetadata: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(),
      },
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
  // KAN-814 — supersession + persistence defaults. updateMany returns no
  // pending rows by default (no supersession noise in pre-Sprint-11-pre tests).
  // create resolves to a stub row id.
  deferredSendUpdateManyMock.mockReset();
  deferredSendUpdateManyMock.mockResolvedValue({ count: 0 });
  deferredSendCreateMock.mockReset();
  deferredSendCreateMock.mockResolvedValue({ id: "deferred_send_test_id" });
  // KAN-814 — `dealFindUnique` is now invoked TWICE per dispatched inbound:
  // (1) supersession lookup at top of wirePhase2Consumers (reads contactId
  //     only), (2) dispatch lookup inside dispatchPhase2Send (reads full
  //     shape). A default that satisfies BOTH lets existing tests' `mockResolvedValueOnce`
  //     queue the dispatch shape for either call without breaking the
  //     supersession's first-call read.
  dealFindUniqueMock.mockResolvedValue({
    id: DEAL_A,
    tenantId: TENANT_A,
    contactId: CONTACT_A,
    contact: { id: CONTACT_A, email: "alice@acme.com" },
  });
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

  // ── KAN-839 — first-turn write persists inbound bodyPreview into Engagement
  //    metadata so the Shaper's `## Recent inbound from contact` section can
  //    render the customer's verbatim words. Producer-consumer contract pin.
  it("KAN-839 — first-turn write persists bodyPreview to Engagement metadata", async () => {
    setupHappyPathMocks();
    normalizeInboundMock.mockResolvedValueOnce({
      source: "email",
      preParsed: {
        senderEmail: "alice@acme.com",
        senderNameGuess: null,
        subject: "Specific question about feature X",
        bodyText: "Do you support feature X for our use case?",
      },
      extracted: {
        firstName: null,
        lastName: null,
        companyName: null,
        phone: null,
        intentSummary: "Asking about feature X",
        qualificationSignals: ["feature_inquiry"],
      },
      extractionConfidence: "medium",
      extractionError: null,
    });

    await postEnvelope(buildPushEnvelope());

    const engArgs = logEngagementMock.mock.calls[0]![1] as {
      metadata: Record<string, unknown>;
    };
    expect(engArgs.metadata.bodyPreview).toBe("Do you support feature X for our use case?");
    expect(engArgs.metadata.subject).toBe("Specific question about feature X");
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

// ─────────────────────────────────────────────
// KAN-965 — objective_primary reaches writePhase1Deal end-to-end
//
// PROD smoke for the KAN-963 routing flip (2026-05-21) showed tier-1.5
// correctly returning mode='objective_primary' but the Phase-1 Deal-creation
// gate's hardcoded whitelist excluded that mode → Deal NEVER created.
// These tests pin the full path: assignment → gate → writePhase1Deal → Deal
// row written, so the silent-skip cannot regress.
//
// The gate is now an exhaustive switch over the AssignmentResult tagged-
// union; `default: never` makes a future-added mode a compile error rather
// than a runtime silent-skip.
// ─────────────────────────────────────────────

describe("KAN-965 — objective_primary mode reaches writePhase1Deal (routing-flip fix)", () => {
  const OBJECTIVE_PRIMARY_PIPELINE = "pipeline_objective_primary_a";
  const OBJECTIVE_ID = "obj_book_appt_a";

  it("objective_primary mode → Deal created on the objective-bound Pipeline", async () => {
    setupHappyPathMocks();
    assignLeadToPipelineMock.mockResolvedValue({
      mode: "objective_primary",
      pipelineId: OBJECTIVE_PRIMARY_PIPELINE,
      stageId: STAGE_INITIAL,
      objectiveId: OBJECTIVE_ID,
    });
    stageFindFirstMock.mockResolvedValue({ id: STAGE_INITIAL });

    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(200);

    // Deal IS created (regression pin — pre-KAN-965 the else-branch skipped this)
    expect(dealCreateMock).toHaveBeenCalledOnce();

    // The initial-stage lookup hit the objective-bound Pipeline, not the default one
    expect(stageFindFirstMock.mock.calls[0]![0]).toMatchObject({
      where: { pipelineId: OBJECTIVE_PRIMARY_PIPELINE, isInitial: true },
    });

    // The Deal carries the objective-bound pipelineId
    const dealArgs = (dealCreateMock.mock.calls[0]![0] as { data: { pipelineId: string; metadata: Record<string, unknown> } }).data;
    expect(dealArgs.pipelineId).toBe(OBJECTIVE_PRIMARY_PIPELINE);

    // Deal.metadata.assignmentMode stamped as 'objective_primary' for downstream observability
    expect(dealArgs.metadata).toMatchObject({
      source: "track_a_email_inbound",
      assignmentMode: "objective_primary",
    });
  });

  it("escalated + unassigned still skip Deal creation (gate refactor preserves sibling semantics)", async () => {
    // Re-pin the no-Deal branches after the exhaustive-switch refactor —
    // the test above could've passed even if escalated/unassigned started
    // writing Deals. This guards against that drift.
    setupHappyPathMocks();
    assignLeadToPipelineMock.mockResolvedValue({ mode: "escalated", escalationId: "esc_a" });
    let res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(200);
    expect(dealCreateMock).not.toHaveBeenCalled();

    dealCreateMock.mockClear();
    assignLeadToPipelineMock.mockResolvedValue({ mode: "unassigned", reason: "no_match" });
    res = await postEnvelope(buildPushEnvelope());
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
  // ── Test 1 — Brain wait_for_response → KAN-835 chain fires; chained call also returns
  //    wait_for_response → loop guard skip; no transition, no shape, no dispatch
  it("Brain returns wait_for_response → KAN-835 chain fires once; chained wait_for_response → loop-guard skip; no consumers", async () => {
    setupHappyPathMocks(); // Brain default = wait_for_response (persistent mock)

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    // KAN-835: initial Brain call returns wait_for_response → chain fires →
    // chained Brain call also returns wait_for_response (default persistent
    // mock) → loop-guard kan-835-chained-brain-not-acknowledgment branch.
    expect(evaluateDealStateMock).toHaveBeenCalledTimes(2);
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
    // KAN-834: engine call site MUST receive the dispatcher's first Brain
    // decision so the engine doesn't re-evaluate. This pin breaks loud if
    // the wire-through ever drops — the LLM-non-determinism class bug
    // from Sprint 11-pre Gmail smoke would silently re-emerge otherwise.
    const stageTransitionOpts = evaluateStageTransitionMock.mock.calls[0]![2] as {
      brainDecision?: { nextBestAction?: { type?: string } };
    };
    expect(stageTransitionOpts).toBeDefined();
    expect(stageTransitionOpts.brainDecision).toBeDefined();
    expect(stageTransitionOpts.brainDecision?.nextBestAction?.type).toBe("advance_stage");
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
    // KAN-814: supersession lookup at top of wirePhase2Consumers calls
    // dealFindUnique ONCE (just for contactId). The DISPATCH lookup
    // (full shape) doesn't happen because SMS short-circuits before
    // dispatchPhase2Send's deal-load. So exactly 1 call, not 0.
    expect(dealFindUniqueMock).toHaveBeenCalledOnce();
    expect(dealFindUniqueMock.mock.calls[0]![0]).toMatchObject({
      select: { contactId: true },
    });
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
    // M3-2.5b — multi-turn path NOW wraps Engagement + sidecar + override in
    // a $transaction for atomicity (pre-M3-2.5b it was bare prisma). The
    // transaction does NOT do a Deal write — that's still the assertion above.
    expect(transactionMock).toHaveBeenCalledOnce();
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
    // KAN-839 — multi-turn write also persists bodyPreview so first-turn and
    // follow-up Engagement rows render identically into the Shaper prompt.
    expect(engArgs.metadata.bodyPreview).toBe("Hi, can you send pricing?");
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

    // KAN-835: default mock returns wait_for_response on both calls →
    // initial + chained loop-guard skip → 2 calls. The reused-id pin is on
    // the FIRST (initial) call, where the dispatcher invokes Brain.
    expect(evaluateDealStateMock).toHaveBeenCalledTimes(2);
    // Brain receives the REUSED dealId, not DEAL_A (which would only be
    // produced by the first-turn writePhase1Deal path that was skipped).
    expect(evaluateDealStateMock.mock.calls[0]![1]).toBe(REUSED_DEAL_ID);
    // Sanity: dealCreateMock NOT called (proving the reused id wasn't a fresh write)
    expect(dealCreateMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// KAN-825 — post-stage-advance auto-follow-up chain
// ─────────────────────────────────────────────

describe("KAN-825 — post-stage-advance auto-follow-up chain", () => {
  // ── Test 1 — full chain: advance_stage → transition fires → chained Brain → send_follow_up → dispatch fires
  it("advance_stage → transition → chained Brain → send_follow_up → dispatch fires (full chain end-to-end)", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    // First Brain call: advance_stage
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "advance_stage", confidence: 0.78 }),
    );
    // Stage transition succeeds (typed shape with names per KAN-825)
    evaluateStageTransitionMock.mockResolvedValueOnce({
      type: "transitioned",
      dealId: DEAL_A,
      fromStageId: STAGE_INITIAL,
      toStageId: "stage_qualified",
      fromStageName: "New",
      toStageName: "Qualified",
      transitionRowId: "dsh_new",
    });
    // Chained Brain call: send_follow_up
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({
        type: "send_follow_up",
        suggestedChannel: "email",
        suggestedTone: "professional",
        confidence: 0.85,
      }),
    );
    // Dispatch path mocks
    shapeMessageMock.mockResolvedValueOnce(buildShapedMessageFixture({ channel: "email" }));
    evaluateSendPolicyMock.mockResolvedValueOnce({ type: "allow", reason: "ok" });
    dealFindUniqueMock.mockResolvedValueOnce({
      id: DEAL_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      contact: { id: CONTACT_A, email: "alice@acme.com" },
    });
    resolveEmailConnectionIdMock.mockResolvedValueOnce("conn_email_active");
    decisionCreateMock.mockResolvedValueOnce({ id: "decision_chained_v1" });
    getPubSubClientMock.mockReturnValueOnce({ publish: vi.fn() });
    publishActionSendMock.mockResolvedValueOnce("pubsub_msg_chained");

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    // Stage transition fired
    expect(evaluateStageTransitionMock).toHaveBeenCalledOnce();
    // Brain called TWICE (initial advance_stage + chained)
    expect(evaluateDealStateMock).toHaveBeenCalledTimes(2);
    // Second Brain call carried the post_stage_advance trigger context
    const chainedCallOptions = evaluateDealStateMock.mock.calls[1]![2] as {
      triggerContext?: string;
      postStageAdvance?: { fromStageName: string; toStageName: string };
    };
    expect(chainedCallOptions.triggerContext).toBe("post_stage_advance");
    expect(chainedCallOptions.postStageAdvance).toEqual({
      fromStageName: "New",
      toStageName: "Qualified",
    });
    // Dispatch fired with the CHAINED decision's id
    expect(publishActionSendMock).toHaveBeenCalledOnce();
    expect(decisionCreateMock).toHaveBeenCalledOnce();
  });

  // ── Test 2 — loop guard: chained Brain returns advance_stage AGAIN → no recursion + warn log
  it("chained Brain returns advance_stage → loop guard fires kan-825-chained-brain-not-follow-up warn, no recursion", async () => {
    setupHappyPathMocks();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "advance_stage" }),
    );
    evaluateStageTransitionMock.mockResolvedValueOnce({
      type: "transitioned",
      dealId: DEAL_A,
      fromStageId: STAGE_INITIAL,
      toStageId: "stage_qualified",
      fromStageName: "New",
      toStageName: "Qualified",
      transitionRowId: "dsh_new",
    });
    // Chained Brain returns advance_stage AGAIN — must NOT recurse
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({
        type: "advance_stage",
        confidence: 0.7,
        reasoning: "Should not recurse here",
      }),
    );

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    // Brain called exactly TWICE (initial + chained); NO third call
    expect(evaluateDealStateMock).toHaveBeenCalledTimes(2);
    // Stage transition fired exactly once (the chained advance did NOT trigger another transition)
    expect(evaluateStageTransitionMock).toHaveBeenCalledOnce();
    // No dispatch — chained Brain didn't return send_follow_up
    expect(publishActionSendMock).not.toHaveBeenCalled();
    expect(decisionCreateMock).not.toHaveBeenCalled();
    // Warn log emitted with the loop-guard marker
    const loopGuardLine = warnSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .find((s) => s.includes("kan-825-chained-brain-not-follow-up"));
    expect(loopGuardLine).toBeDefined();
    expect(loopGuardLine).toContain("chainedAction=advance_stage");
    expect(loopGuardLine).toContain("Should not recurse here");
    warnSpy.mockRestore();
  });

  // ── Test 3 — chained Brain returns wait_for_response → no outbound, no further chaining, no warning (silent honor)
  it("chained Brain returns wait_for_response → no outbound, no warning (silent honor)", async () => {
    setupHappyPathMocks();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "advance_stage" }),
    );
    evaluateStageTransitionMock.mockResolvedValueOnce({
      type: "transitioned",
      dealId: DEAL_A,
      fromStageId: STAGE_INITIAL,
      toStageId: "stage_qualified",
      fromStageName: "New",
      toStageName: "Qualified",
      transitionRowId: "dsh_new",
    });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({
        type: "wait_for_response",
        confidence: 0.6,
        reasoning: "Contact asked us to wait",
      }),
    );

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    // Loop-guard warn DOES fire (the chain is honored even when Brain
    // chooses to wait — the warn is for "chained Brain didn't pick
    // send_follow_up" so we can monitor decision distribution).
    const loopGuardLine = warnSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .find((s) => s.includes("kan-825-chained-brain-not-follow-up"));
    expect(loopGuardLine).toBeDefined();
    expect(loopGuardLine).toContain("chainedAction=wait_for_response");
    // No dispatch
    expect(publishActionSendMock).not.toHaveBeenCalled();
    expect(decisionCreateMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // ── Test 4 — defensive: chained=true caller never re-enters chain (future-proofing for additional origins)
  it("isChainedInvocation=true context — chain logic does not re-fire (defensive future-proofing)", async () => {
    // This test is structural: we can't reach this state from production
    // today (only one origin = inbound), but the local-boolean guard means
    // a future operator-trigger or other origin can pass isChainedInvocation
    // safely without runaway chains. We simulate by having the chained
    // Brain decision route through dispatchPhase2Send WITHOUT a re-enter.
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "advance_stage" }),
    );
    evaluateStageTransitionMock.mockResolvedValueOnce({
      type: "transitioned",
      dealId: DEAL_A,
      fromStageId: STAGE_INITIAL,
      toStageId: "stage_qualified",
      fromStageName: "New",
      toStageName: "Qualified",
      transitionRowId: "dsh_new",
    });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "send_follow_up", suggestedChannel: "email" }),
    );
    shapeMessageMock.mockResolvedValueOnce(buildShapedMessageFixture({ channel: "email" }));
    evaluateSendPolicyMock.mockResolvedValueOnce({ type: "allow", reason: "ok" });
    dealFindUniqueMock.mockResolvedValueOnce({
      id: DEAL_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      contact: { id: CONTACT_A, email: "alice@acme.com" },
    });
    resolveEmailConnectionIdMock.mockResolvedValueOnce("conn_email_active");
    decisionCreateMock.mockResolvedValueOnce({ id: "decision_chained_v1" });
    getPubSubClientMock.mockReturnValueOnce({ publish: vi.fn() });
    publishActionSendMock.mockResolvedValueOnce("pubsub_msg_x");

    await postEnvelope(buildPushEnvelope());

    // Brain called twice total (initial + chained). Even though the
    // chained Brain's `send_follow_up` triggers dispatch, dispatch does
    // NOT loop back through wirePhase2Consumers. Total Brain calls = 2.
    expect(evaluateDealStateMock).toHaveBeenCalledTimes(2);
    expect(evaluateStageTransitionMock).toHaveBeenCalledOnce();
  });

  // ── Test 5 — Decision row count: ONE row written per spec (KAN-832 caveat)
  it("KAN-832 caveat: only the chained send_follow_up writes a Decision row (one row total, not two)", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "advance_stage" }),
    );
    evaluateStageTransitionMock.mockResolvedValueOnce({
      type: "transitioned",
      dealId: DEAL_A,
      fromStageId: STAGE_INITIAL,
      toStageId: "stage_qualified",
      fromStageName: "New",
      toStageName: "Qualified",
      transitionRowId: "dsh_new",
    });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "send_follow_up", suggestedChannel: "email" }),
    );
    shapeMessageMock.mockResolvedValueOnce(buildShapedMessageFixture({ channel: "email" }));
    evaluateSendPolicyMock.mockResolvedValueOnce({ type: "allow", reason: "ok" });
    dealFindUniqueMock.mockResolvedValueOnce({
      id: DEAL_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      contact: { id: CONTACT_A, email: "alice@acme.com" },
    });
    resolveEmailConnectionIdMock.mockResolvedValueOnce("conn_email_active");
    decisionCreateMock.mockResolvedValueOnce({ id: "decision_chained_v1" });
    getPubSubClientMock.mockReturnValueOnce({ publish: vi.fn() });
    publishActionSendMock.mockResolvedValueOnce("pubsub_msg_x");

    await postEnvelope(buildPushEnvelope());

    // Today's audit posture (KAN-832 future fix): only one Decision row.
    // The original advance_stage's audit lives in DealStageHistory.metadata.
    expect(decisionCreateMock).toHaveBeenCalledOnce();
    const decisionArgs = decisionCreateMock.mock.calls[0]![0] as {
      data: { actionType: string };
    };
    expect(decisionArgs.data.actionType).toBe("send_follow_up");
  });

  // ── Test 6 — Sentinel-token field-name pin (the load-bearing contract pin)
  it("sentinel-token pin: chained Brain call's options carry literal post_stage_advance + stage names", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "advance_stage" }),
    );
    evaluateStageTransitionMock.mockResolvedValueOnce({
      type: "transitioned",
      dealId: DEAL_A,
      fromStageId: STAGE_INITIAL,
      toStageId: "stage_qualified",
      fromStageName: "New",
      toStageName: "Qualified",
      transitionRowId: "dsh_new",
    });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "wait_for_response" }),
    );

    await postEnvelope(buildPushEnvelope());

    // Pin: chained call's options carry the LITERAL string 'post_stage_advance'
    // (no camelCase drift to 'postStageAdvance' on the enum value side; field
    // names on the postStageAdvance object are the camelCase fromStageName /
    // toStageName which is intentional shape).
    expect(evaluateDealStateMock).toHaveBeenCalledTimes(2);
    const chainedOpts = evaluateDealStateMock.mock.calls[1]![2] as Record<string, unknown>;
    expect(chainedOpts.triggerContext).toBe("post_stage_advance");
    const psa = chainedOpts.postStageAdvance as Record<string, unknown>;
    expect(psa.fromStageName).toBe("New");
    expect(psa.toStageName).toBe("Qualified");
  });

  // ── Test 7 — chain does NOT fire when Stage Transition Engine returns skipped/no_transition
  it("Stage Transition skipped (already_terminal) → no chain fires, no chained Brain call", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "advance_stage" }),
    );
    evaluateStageTransitionMock.mockResolvedValueOnce({
      type: "skipped",
      dealId: DEAL_A,
      reason: "already_terminal",
    });

    await postEnvelope(buildPushEnvelope());

    // Only 1 Brain call (the initial); chain never fires when transition skips
    expect(evaluateDealStateMock).toHaveBeenCalledOnce();
    expect(publishActionSendMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// KAN-814 — supersession + persistence-on-defer
// (sub-cohort 1 of the Sprint 11-pre deferred_send queue work)
// ─────────────────────────────────────────────

describe("KAN-814 — supersession + persistence-on-defer", () => {
  // ── Test 1 — supersession on fresh inbound: pending deferred_send → cancelled
  it("fresh inbound on (deal, contact) with pending deferred_send → updateMany marks pending → cancelled with cancelReason=superseded_by_fresh_inbound", async () => {
    setupHappyPathMocks();
    deferredSendUpdateManyMock.mockResolvedValueOnce({ count: 1 });
    dealFindUniqueMock.mockResolvedValueOnce({ contactId: CONTACT_A });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await postEnvelope(buildPushEnvelope());

    expect(deferredSendUpdateManyMock).toHaveBeenCalledOnce();
    const updateArgs = deferredSendUpdateManyMock.mock.calls[0]![0] as {
      where: { dealId: string; contactId: string; status: string };
      data: { status: string; cancelReason: string };
    };
    expect(updateArgs.where.contactId).toBe(CONTACT_A);
    expect(updateArgs.where.status).toBe("pending");
    expect(updateArgs.data.status).toBe("cancelled");
    expect(updateArgs.data.cancelReason).toBe("superseded_by_fresh_inbound");
    const supersededLine = logSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .find((s) => s.includes("kan-814-deferred-send-superseded"));
    expect(supersededLine).toBeDefined();
    expect(supersededLine).toContain("cancelledRows=1");
    logSpy.mockRestore();
  });

  // ── Test 2 — supersession with no pending rows: silent (no log spam)
  it("fresh inbound with no pending deferred_send → updateMany returns count=0 → no superseded log", async () => {
    setupHappyPathMocks();
    deferredSendUpdateManyMock.mockResolvedValueOnce({ count: 0 });
    dealFindUniqueMock.mockResolvedValueOnce({ contactId: CONTACT_A });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await postEnvelope(buildPushEnvelope());

    expect(deferredSendUpdateManyMock).toHaveBeenCalledOnce();
    const supersededLine = logSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .find((s) => s.includes("kan-814-deferred-send-superseded"));
    expect(supersededLine).toBeUndefined();
    logSpy.mockRestore();
  });

  // ── Test 3 — persistence on defer: deferredSend.create with full payload
  it("Send Policy defer → deferredSend.create with brainDecision + composed + contactEmail in payload", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "send_follow_up", suggestedChannel: "email" }),
    );
    shapeMessageMock.mockResolvedValueOnce(buildShapedMessageFixture({ channel: "email" }));
    dealFindUniqueMock.mockResolvedValueOnce({ contactId: CONTACT_A });
    dealFindUniqueMock.mockResolvedValueOnce({
      id: DEAL_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      contact: { id: CONTACT_A, email: "alice@acme.com" },
    });
    const deferUntil = new Date("2026-05-05T13:00:00.000Z");
    evaluateSendPolicyMock.mockResolvedValueOnce({
      type: "defer",
      reason: "Outside tenant send window",
      deferUntil,
    });

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    expect(publishActionSendMock).not.toHaveBeenCalled();
    expect(decisionCreateMock).not.toHaveBeenCalled();
    expect(deferredSendCreateMock).toHaveBeenCalledOnce();
    const createArgs = deferredSendCreateMock.mock.calls[0]![0] as {
      data: {
        tenantId: string;
        dealId: string;
        contactId: string;
        deferUntil: Date;
        deferReason: string;
        status: string;
        attempts: number;
        payload: {
          brainDecision: unknown;
          composed: { subject: string; body: string };
          contactEmail: string;
        };
      };
    };
    expect(createArgs.data.tenantId).toBe(TENANT_A);
    expect(createArgs.data.dealId).toBe(DEAL_A);
    expect(createArgs.data.contactId).toBe(CONTACT_A);
    expect(createArgs.data.status).toBe("pending");
    expect(createArgs.data.attempts).toBe(0);
    expect(createArgs.data.deferUntil).toEqual(deferUntil);
    expect(createArgs.data.deferReason).toContain("Outside tenant send window");
    expect(createArgs.data.payload.contactEmail).toBe("alice@acme.com");
    expect(createArgs.data.payload.composed.body).toContain("Alice");
    expect(createArgs.data.payload.brainDecision).toBeDefined();
  });

  // ── Test 4 — persistence-on-defer is non-fatal: create throws → 200 + error log, no propagation
  it("deferredSend.create throws → handler logs error but returns 200 (non-fatal degradation)", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "send_follow_up", suggestedChannel: "email" }),
    );
    shapeMessageMock.mockResolvedValueOnce(buildShapedMessageFixture({ channel: "email" }));
    dealFindUniqueMock.mockResolvedValueOnce({ contactId: CONTACT_A });
    dealFindUniqueMock.mockResolvedValueOnce({
      id: DEAL_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      contact: { id: CONTACT_A, email: "alice@acme.com" },
    });
    evaluateSendPolicyMock.mockResolvedValueOnce({
      type: "defer",
      reason: "outside window",
      deferUntil: new Date("2026-05-05T13:00:00.000Z"),
    });
    deferredSendCreateMock.mockReset();
    deferredSendCreateMock.mockRejectedValueOnce(new Error("DB write failed"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    const errorLine = errorSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .find((s) => s.includes("phase-2-send-policy-deferred-persist-failed"));
    expect(errorLine).toBeDefined();
    errorSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────
// KAN-835 — wait_for_response chain (Sprint 11-pre extension)
// Mirror of KAN-825's architecture for the third silence-producing
// decision class. Empirical anchor: 4 wait_for_response inbounds across
// Sprint 10 + Sprint 11-pre Deal Y → 0 customer-visible outbounds.
// ─────────────────────────────────────────────

describe("KAN-835 — wait_for_response chain", () => {
  // ── Test 1 — full chain: wait_for_response → chained Brain → send_follow_up → dispatch
  it("Brain wait_for_response → chained Brain → send_follow_up → dispatch fires (full chain end-to-end)", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    // First Brain call: wait_for_response
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "wait_for_response", confidence: 0.85 }),
    );
    // Chained Brain call: send_follow_up acknowledgment
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({
        type: "send_follow_up",
        suggestedChannel: "email",
        suggestedTone: "professional",
        confidence: 0.88,
        reasoning: "Brief acknowledgment per KAN-835 directive.",
      }),
    );
    // Dispatch path mocks
    shapeMessageMock.mockResolvedValueOnce(buildShapedMessageFixture({ channel: "email" }));
    evaluateSendPolicyMock.mockResolvedValueOnce({ type: "allow", reason: "ok" });
    dealFindUniqueMock.mockResolvedValueOnce({
      id: DEAL_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      contact: { id: CONTACT_A, email: "alice@acme.com" },
    });
    resolveEmailConnectionIdMock.mockResolvedValueOnce("conn_email_active");
    decisionCreateMock.mockResolvedValueOnce({ id: "decision_kan835_chained" });
    getPubSubClientMock.mockReturnValueOnce({ publish: vi.fn() });
    publishActionSendMock.mockResolvedValueOnce("pubsub_msg_kan835");

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    // Brain called TWICE (initial wait_for_response + chained)
    expect(evaluateDealStateMock).toHaveBeenCalledTimes(2);
    // Chained call carried the post_wait_acknowledgment trigger context
    const chainedOpts = evaluateDealStateMock.mock.calls[1]![2] as {
      triggerContext?: string;
    };
    expect(chainedOpts.triggerContext).toBe("post_wait_acknowledgment");
    // Stage Transition NOT fired (wait_for_response doesn't trigger transition)
    expect(evaluateStageTransitionMock).not.toHaveBeenCalled();
    // Dispatch fired with the CHAINED decision's id
    expect(publishActionSendMock).toHaveBeenCalledOnce();
    expect(decisionCreateMock).toHaveBeenCalledOnce();
  });

  // ── Test 2 — loop guard: chained Brain returns wait_for_response AGAIN → no recursion + warn
  it("chained Brain returns wait_for_response → kan-835-chained-brain-not-acknowledgment warn, no recursion, no outbound", async () => {
    setupHappyPathMocks();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "wait_for_response" }),
    );
    // Chained Brain returns wait_for_response AGAIN — must NOT recurse (Option a strict)
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({
        type: "wait_for_response",
        confidence: 0.7,
        reasoning: "Directive failure — chained call still wants to wait.",
      }),
    );

    const res = await postEnvelope(buildPushEnvelope());

    expect(res.status).toBe(200);
    expect(evaluateDealStateMock).toHaveBeenCalledTimes(2);
    expect(publishActionSendMock).not.toHaveBeenCalled();
    expect(decisionCreateMock).not.toHaveBeenCalled();
    const warnLine = warnSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .find((s) => s.includes("kan-835-chained-brain-not-acknowledgment"));
    expect(warnLine).toBeDefined();
    expect(warnLine).toContain("chainedAction=wait_for_response");
    expect(warnLine).toContain("Directive failure");
    warnSpy.mockRestore();
  });

  // ── Test 3 — chained Brain returns advance_stage → no recursion + warn (wrong context)
  it("chained Brain returns advance_stage → warn (wrong context — Deal state didn't change), no outbound", async () => {
    setupHappyPathMocks();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "wait_for_response" }),
    );
    // Chained Brain returns advance_stage — wrong on this chain context
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({
        type: "advance_stage",
        confidence: 0.6,
        reasoning: "Stage didn't change — directive failure.",
      }),
    );

    await postEnvelope(buildPushEnvelope());

    expect(evaluateDealStateMock).toHaveBeenCalledTimes(2);
    // Stage Transition NOT fired from the chained advance_stage (the chain's
    // log+skip path doesn't route to engine).
    expect(evaluateStageTransitionMock).not.toHaveBeenCalled();
    expect(publishActionSendMock).not.toHaveBeenCalled();
    const warnLine = warnSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .find((s) => s.includes("kan-835-chained-brain-not-acknowledgment"));
    expect(warnLine).toBeDefined();
    expect(warnLine).toContain("chainedAction=advance_stage");
    warnSpy.mockRestore();
  });

  // ── Test 4 — chained Brain returns escalate_to_human → log-only stub (Sprint 11b will wire full flow)
  it("chained Brain returns escalate_to_human → kan-835-chained-brain-escalate log (Sprint 11b stub)", async () => {
    setupHappyPathMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "wait_for_response" }),
    );
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({
        type: "escalate_to_human",
        confidence: 0.91,
        reasoning: "Quote requires human approval per directive carve-out.",
      }),
    );

    await postEnvelope(buildPushEnvelope());

    expect(evaluateDealStateMock).toHaveBeenCalledTimes(2);
    expect(publishActionSendMock).not.toHaveBeenCalled();
    const escalateLine = logSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .find((s) => s.includes("kan-835-chained-brain-escalate"));
    expect(escalateLine).toBeDefined();
    expect(escalateLine).toContain("chainedAction=escalate_to_human");
    expect(escalateLine).toContain("Sprint 11b");
    logSpy.mockRestore();
  });

  // ── Test 5 — sentinel-token pin: chained call's options carry literal post_wait_acknowledgment
  it("sentinel-token pin: chained Brain call options carry literal post_wait_acknowledgment", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "wait_for_response" }),
    );
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "wait_for_response" }), // doesn't matter for this test
    );

    await postEnvelope(buildPushEnvelope());

    expect(evaluateDealStateMock).toHaveBeenCalledTimes(2);
    const chainedOpts = evaluateDealStateMock.mock.calls[1]![2] as Record<string, unknown>;
    // The literal string — no camelCase drift to 'postWaitAcknowledgment'
    expect(chainedOpts.triggerContext).toBe("post_wait_acknowledgment");
  });

  // ── Test 6 — Decision row count caveat (KAN-832 sibling): chained send_follow_up writes ONE Decision row
  it("KAN-832 caveat: only the chained send_follow_up writes a Decision row (one row total)", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "wait_for_response" }),
    );
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "send_follow_up", suggestedChannel: "email" }),
    );
    shapeMessageMock.mockResolvedValueOnce(buildShapedMessageFixture({ channel: "email" }));
    evaluateSendPolicyMock.mockResolvedValueOnce({ type: "allow", reason: "ok" });
    dealFindUniqueMock.mockResolvedValueOnce({
      id: DEAL_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      contact: { id: CONTACT_A, email: "alice@acme.com" },
    });
    resolveEmailConnectionIdMock.mockResolvedValueOnce("conn_email_active");
    decisionCreateMock.mockResolvedValueOnce({ id: "decision_kan835_v1" });
    getPubSubClientMock.mockReturnValueOnce({ publish: vi.fn() });
    publishActionSendMock.mockResolvedValueOnce("pubsub_msg_kan835_b");

    await postEnvelope(buildPushEnvelope());

    // Today's audit posture (KAN-832 future fix): only one Decision row.
    // The original wait_for_response writes no row; the chained send_follow_up
    // writes via the KAN-815c shim during dispatch.
    expect(decisionCreateMock).toHaveBeenCalledOnce();
    const decisionArgs = decisionCreateMock.mock.calls[0]![0] as {
      data: { actionType: string };
    };
    expect(decisionArgs.data.actionType).toBe("send_follow_up");
  });
});

// ─────────────────────────────────────────────
// KAN-828 fix-forward — caller-side wire-up tests
// Verify lead-received-push passes redis + openai args to all 3
// evaluateDealState call sites + the shapeMessage call site. Without
// this wire-up, Brain Service + Message Shaper treat the args as
// "retrieval disabled" and silently skip the ## Company knowledge
// section — which is the production gap surfaced by the post-deploy
// smoke (515-token Brain prompt matched pre-feature baseline exactly).
//
// Tests assert the call args contain `redis` + `openai` keys (truthy
// or null — both are accepted by Brain/Shaper). In test env without
// OPENAI_API_KEY, openai resolves to null; we accept that as the
// wire-up shape proof.
// ─────────────────────────────────────────────

describe("KAN-828 fix-forward — caller-side wire-up", () => {
  it("Test 1 — initial evaluateDealState call passes redis + openai in options", async () => {
    setupHappyPathMocks();
    setupPhase2DispatchMocks();

    await postEnvelope(buildPushEnvelope());

    expect(evaluateDealStateMock).toHaveBeenCalled();
    const opts = evaluateDealStateMock.mock.calls[0]![2] as Record<string, unknown>;
    // Both keys present (values may be null in test env where OPENAI_API_KEY
    // is unset; the wire-up contract is "the keys exist on the options").
    expect(opts).toHaveProperty("redis");
    expect(opts).toHaveProperty("openai");
  });

  it("Test 2 — KAN-825 chained evaluateDealState (post_stage_advance) passes redis + openai", async () => {
    setupHappyPathMocks();
    evaluateDealStateMock.mockReset();
    // First Brain call: advance_stage → triggers KAN-825 chain
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "advance_stage", confidence: 0.78 }),
    );
    // Stage transition success enables the chain
    evaluateStageTransitionMock.mockResolvedValueOnce({
      type: "transitioned",
      dealId: DEAL_A,
      fromStageId: STAGE_INITIAL,
      toStageId: "stage_qualified",
      transitionRowId: "dsh_new",
      fromStageName: "New",
      toStageName: "Qualified",
    });
    // Chained Brain: send_follow_up → dispatch fires
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecisionFixture({ type: "send_follow_up", suggestedChannel: "email" }),
    );
    shapeMessageMock.mockResolvedValueOnce(buildShapedMessageFixture({ channel: "email" }));
    evaluateSendPolicyMock.mockResolvedValueOnce({ type: "allow", reason: "ok" });
    dealFindUniqueMock.mockResolvedValueOnce({
      id: DEAL_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      contact: { id: CONTACT_A, email: "alice@acme.com" },
    });
    resolveEmailConnectionIdMock.mockResolvedValueOnce("conn_email_active");
    decisionCreateMock.mockResolvedValueOnce({ id: "decision_chained_v1" });
    getPubSubClientMock.mockReturnValueOnce({ publish: vi.fn() });
    publishActionSendMock.mockResolvedValueOnce("pubsub_msg_chained");

    await postEnvelope(buildPushEnvelope());

    expect(evaluateDealStateMock).toHaveBeenCalledTimes(2);
    // Chained call's options (call index 1) — verify wire-up
    const chainedOpts = evaluateDealStateMock.mock.calls[1]![2] as Record<string, unknown>;
    expect(chainedOpts.triggerContext).toBe("post_stage_advance");
    expect(chainedOpts).toHaveProperty("redis");
    expect(chainedOpts).toHaveProperty("openai");
  });

  it("Test 3 — KAN-835 chained evaluateDealState (post_wait_acknowledgment) passes redis + openai", async () => {
    setupHappyPathMocks(); // default: wait_for_response on first Brain call
    // Default mock returns wait_for_response → KAN-835 chain fires →
    // chained call also returns wait_for_response (mock persistent) →
    // loop guard fires. 2 Brain calls total.

    await postEnvelope(buildPushEnvelope());

    expect(evaluateDealStateMock).toHaveBeenCalledTimes(2);
    const chainedOpts = evaluateDealStateMock.mock.calls[1]![2] as Record<string, unknown>;
    expect(chainedOpts.triggerContext).toBe("post_wait_acknowledgment");
    expect(chainedOpts).toHaveProperty("redis");
    expect(chainedOpts).toHaveProperty("openai");
  });

  it("Test 4 — shapeMessage call passes redis + openai in options", async () => {
    setupHappyPathMocks();
    setupPhase2DispatchMocks();

    await postEnvelope(buildPushEnvelope());

    expect(shapeMessageMock).toHaveBeenCalled();
    const shapeOpts = shapeMessageMock.mock.calls[0]![2] as Record<string, unknown>;
    // Existing brainDecision pre-pass arg + the new redis/openai wire-up
    expect(shapeOpts).toHaveProperty("brainDecision");
    expect(shapeOpts).toHaveProperty("redis");
    expect(shapeOpts).toHaveProperty("openai");
  });
});

// ─────────────────────────────────────────────
// KAN-1037-PR4.5 — direct wirePhase2Consumers tests
//
// New tests for the precomputed-decision pass-through (load-bearing
// defense against cognitive-blind double-eval that would discard PR4's
// latestInbound-aware reasoning) AND the new engine_proposed_action
// escalation consumer (closes the dispatch loop on escalate_to_human).
//
// Dynamic import inside each `it` block: a top-level static import of
// `../subscribers/lead-received-push.js` would get hoisted above the
// const mock declarations at lines 31-65, causing a TDZ violation
// (vi.mock factories evaluate at module-load time; they reference
// `contactFindUniqueMock` etc. which aren't initialized yet). Dynamic
// import defers the module load to test-run time, well after all const
// initializations have completed.
// ─────────────────────────────────────────────

// Lazy-loaded reference to the exported orchestrator. Dynamic-imported
// once on first use; subsequent calls reuse the cached module. Avoids the
// top-level static-import TDZ issue described above.
let cachedWireFn:
  | ((
      dealId: string,
      eventId: string,
      isChainedInvocation?: boolean,
      precomputedDecision?: unknown,
    ) => Promise<void>)
  | null = null;
async function getWirePhase2Consumers() {
  if (cachedWireFn) return cachedWireFn;
  const mod = (await import("../subscribers/lead-received-push.js")) as {
    wirePhase2Consumers: (
      dealId: string,
      eventId: string,
      isChainedInvocation?: boolean,
      precomputedDecision?: unknown,
    ) => Promise<void>;
  };
  cachedWireFn = mod.wirePhase2Consumers;
  return cachedWireFn;
}

describe("KAN-1037-PR4.5 — wirePhase2Consumers precomputed-decision skip", () => {
  beforeEach(() => {
    setupHappyPathMocks();
    // Reset specific PR4.5 mocks.
    escalationCreateMock.mockClear();
    escalationCreateMock.mockResolvedValue({ id: "esc_engine_proposed_a" });
    decisionFindFirstMock.mockClear();
    decisionFindFirstMock.mockResolvedValue({ id: "decision_trigger_a" });
    auditLogCreateLeadReceivedMock.mockClear();
    auditLogCreateLeadReceivedMock.mockResolvedValue({ id: "audit_a" });
    dealFindUniqueMock.mockResolvedValue({
      id: DEAL_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
    });
  });

  it("CRITICAL DEFENSE: precomputed decision SKIPS the internal evaluateDealState call", async () => {
    // The load-bearing test. If wirePhase2Consumers re-evaluates Brain
    // when a precomputed decision is provided, PR4's latestInbound-aware
    // reasoning gets discarded (the second eval has no latestInbound
    // option). This is exactly what KAN-1037-PR4.5 prevents.
    evaluateDealStateMock.mockClear();
    const precomputed = buildBrainDecisionFixture({ type: "no_action", confidence: 0.55 });

    await (await getWirePhase2Consumers())(DEAL_A, "evt_pr4_5_defense", false, precomputed as never);

    // Brain MUST NOT have been called — the precomputed decision flows
    // straight through to the consumer routing.
    expect(evaluateDealStateMock).not.toHaveBeenCalled();
  });

  it("back-compat: 3-arg legacy call (no precomputed) still triggers internal eval", async () => {
    evaluateDealStateMock.mockClear();
    // Default mock returns wait_for_response — KAN-835 chain may fire,
    // but the FIRST eval at L1338 is what we're pinning here.
    await (await getWirePhase2Consumers())(DEAL_A, "evt_pr4_5_legacy");

    // At least one eval — the L1338 initial call. KAN-835 chain may
    // produce additional calls; we assert ≥1 to keep this test focused
    // on the back-compat path.
    expect(evaluateDealStateMock).toHaveBeenCalled();
  });

  it("precomputed advance_stage decision routes to stage-transition (consumer dispatch preserved)", async () => {
    evaluateStageTransitionMock.mockClear();
    evaluateStageTransitionMock.mockResolvedValueOnce({
      type: "skipped",
      dealId: DEAL_A,
      reason: "test_stub",
    });
    const precomputed = buildBrainDecisionFixture({ type: "advance_stage", confidence: 0.8 });

    await (await getWirePhase2Consumers())(DEAL_A, "evt_advance", false, precomputed as never);

    // Consumer routing still works post-refactor.
    expect(evaluateStageTransitionMock).toHaveBeenCalledTimes(1);
    // The precomputed decision is threaded into the consumer arg.
    const stageOpts = evaluateStageTransitionMock.mock.calls[0]![2] as {
      brainDecision?: { nextBestAction?: { type?: string } };
    };
    expect(stageOpts.brainDecision?.nextBestAction?.type).toBe("advance_stage");
  });
});

describe("KAN-1037-PR4.5 — engine_proposed_action escalation consumer", () => {
  beforeEach(() => {
    setupHappyPathMocks();
    escalationCreateMock.mockClear();
    escalationCreateMock.mockResolvedValue({ id: "esc_engine_proposed_a" });
    decisionFindFirstMock.mockClear();
    decisionFindFirstMock.mockResolvedValue({ id: "decision_trigger_a" });
    auditLogCreateLeadReceivedMock.mockClear();
    auditLogCreateLeadReceivedMock.mockResolvedValue({ id: "audit_a" });
    dealFindUniqueMock.mockResolvedValue({
      id: DEAL_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
    });
  });

  it("precomputed escalate_to_human → creates Escalation row with engine_proposed_action triggerType + originalAction + decisionId", async () => {
    const precomputed = buildBrainDecisionFixture({
      type: "escalate_to_human",
      confidence: 0.85,
      reasoning:
        "Contact requested 30-min call Tuesday afternoon; test-redirect tag requires human review.",
      suggestedChannel: "email",
      suggestedTone: "professional",
    });

    await (await getWirePhase2Consumers())(DEAL_A, "evt_escalate", false, precomputed as never);

    // The load-bearing PR4.5 assertion: the engine's escalate_to_human
    // decision produces an Escalation row.
    expect(escalationCreateMock).toHaveBeenCalledTimes(1);
    const createArgs = escalationCreateMock.mock.calls[0]![0] as {
      data: {
        tenantId: string;
        contactId: string;
        decisionId: string | null;
        triggerType: string;
        aiSuggestion: string;
        originalAction: { actionType: string; channel: string | null; payload: Record<string, unknown> };
        status: string;
        context: { source: string };
      };
    };

    expect(createArgs.data.tenantId).toBe(TENANT_A);
    expect(createArgs.data.contactId).toBe(CONTACT_A);
    // KAN-657 cuid — populated from the recent Decision lookup (PR4.5 finding #3).
    expect(createArgs.data.decisionId).toBe("decision_trigger_a");
    // New discriminator value.
    expect(createArgs.data.triggerType).toBe("engine_proposed_action");
    // Brain's reasoning text surfaces in aiSuggestion for the queue UI.
    expect(createArgs.data.aiSuggestion).toContain("30-min call");
    expect(createArgs.data.status).toBe("open");
    // KAN-1037 PR1's originalAction column populated — operator's
    // accept-without-modify dispatches via this (status-transition only
    // for escalate_to_human; operator should modify to compose).
    expect(createArgs.data.originalAction).toEqual({
      actionType: "escalate_to_human",
      channel: "email",
      payload: expect.objectContaining({
        reasoning: expect.stringContaining("30-min call"),
        suggestedTone: "professional",
        brainConfidence: 0.85,
        brainModelTier: "reasoning",
      }),
    });
    // Forensic context for operator inspection.
    expect(createArgs.data.context.source).toBe("kan_1037_pr4_5_engine_proposal");
  });

  it("escalate_to_human + chained invocation context: NO escalation (chain-depth guard prevents double-escalation)", async () => {
    const precomputed = buildBrainDecisionFixture({
      type: "escalate_to_human",
      confidence: 0.85,
    });

    // 3rd arg = true (chained) per the KAN-825/835 chained-call posture.
    await (await getWirePhase2Consumers())(DEAL_A, "evt_chained_escalate", true, precomputed as never);

    expect(escalationCreateMock).not.toHaveBeenCalled();
  });

  it("escalate_to_human + Deal lookup miss: log + skip, no escalation, no throw", async () => {
    dealFindUniqueMock.mockReset();
    dealFindUniqueMock.mockResolvedValue(null); // Deal lookup miss
    const precomputed = buildBrainDecisionFixture({
      type: "escalate_to_human",
      confidence: 0.85,
    });

    await expect(
      (await getWirePhase2Consumers())(DEAL_A, "evt_no_deal", false, precomputed as never),
    ).resolves.not.toThrow();
    expect(escalationCreateMock).not.toHaveBeenCalled();
  });

  it("escalate_to_human + null recent Decision: escalation created with decisionId: null (back-compat with KAN-1005 M2-6b null-safe pattern)", async () => {
    decisionFindFirstMock.mockReset();
    decisionFindFirstMock.mockResolvedValue(null); // No prior Decision
    const precomputed = buildBrainDecisionFixture({
      type: "escalate_to_human",
      confidence: 0.85,
    });

    await (await getWirePhase2Consumers())(DEAL_A, "evt_null_decision", false, precomputed as never);

    expect(escalationCreateMock).toHaveBeenCalledTimes(1);
    const createArgs = escalationCreateMock.mock.calls[0]![0] as {
      data: { decisionId: string | null };
    };
    expect(createArgs.data.decisionId).toBeNull();
  });

  it("escalate_to_human consumer error is logged + swallowed (best-effort posture)", async () => {
    escalationCreateMock.mockRejectedValueOnce(new Error("prisma-down: connection lost"));
    const precomputed = buildBrainDecisionFixture({
      type: "escalate_to_human",
      confidence: 0.85,
    });

    // No throw — consumer is best-effort per the fire-and-forget boundary
    // at the contact-replied-push.ts caller.
    await expect(
      (await getWirePhase2Consumers())(DEAL_A, "evt_create_fail", false, precomputed as never),
    ).resolves.not.toThrow();
  });
});

// ─────────────────────────────────────────────
// KAN-1042 PR A2 — engine-proposed sub-objective transition consumer
//
// New dispatcher arm in wirePhase2Consumers — fires on
// `brainDecision.nextBestAction.type === 'transition_sub_objective'`.
// Phase 1 Q6 dispatcher-level governance (NOT a high-stakes clamp):
//
//   - Tenant.autoTransitionSubObjectives === false (default + missing-
//     row fail-safe) → escalate to Recommendations queue with
//     triggerType='engine_proposed_action' + originalAction populated
//     (KAN-1037 PR1 operator-accept fallback path).
//   - Tenant.autoTransitionSubObjectives === true (opt-in) → call
//     transitionSubObjectiveState with source='engine' + engineContext.
//
// Chain-depth guard mirrors PR4.5's escalate_to_human consumer.
// Defensive payload-missing guard since parseLlmResponse already enforces
// presence at PR A1 — guard logs + returns without throwing.
// ─────────────────────────────────────────────

// Helper to construct a transition_sub_objective BrainDecision fixture.
// Separate from buildBrainDecisionFixture because the type union there
// doesn't include the PR A1 vocab extension (preserves existing tests
// untouched).
function buildTransitionBrainDecision(overrides: {
  subObjectiveKey?: "timeline" | "budget" | "authority" | "need" | "motivation";
  toState?: "known" | "not_applicable";
  value?: string | number | null;
  confidence?: number;
  reasoning?: string;
} = {}) {
  return {
    dealId: DEAL_A,
    evaluatedAt: new Date(),
    currentStateSnapshot: {
      dealStatus: "open",
      currentStageName: "Qualified",
      currentStageOutcomeType: "open",
      daysInCurrentStage: 0,
      engagementCount: 1,
      lastEngagementType: "email_received",
      lastEngagementClass: "positive",
      daysSinceLastEngagement: 0,
      moProgressPercent: null,
      pipelineName: "KAN-1042 Verify Pipeline",
      pipelineObjectiveType: "book_appointment",
    },
    nextBestAction: {
      type: "transition_sub_objective" as const,
      reasoning:
        overrides.reasoning ??
        'Contact replied "looking to start in Q3" — timeline now known.',
      subObjectiveTransition: {
        subObjectiveKey: overrides.subObjectiveKey ?? "timeline",
        toState: overrides.toState ?? "known",
        value: overrides.value ?? "Q3 2026",
      },
    },
    confidence: overrides.confidence ?? 0.82,
    modelTier: "reasoning" as const,
    llmInputTokens: 520,
    llmOutputTokens: 95,
  };
}

describe("KAN-1042 PR A2 — transition_sub_objective dispatcher arm", () => {
  beforeEach(() => {
    setupHappyPathMocks();
    escalationCreateMock.mockClear();
    escalationCreateMock.mockResolvedValue({ id: "esc_transition_proposed_a" });
    decisionFindFirstMock.mockClear();
    decisionFindFirstMock.mockResolvedValue({ id: "decision_trigger_a" });
    tenantFindUniqueMock.mockReset();
    transitionSubObjectiveStateMock.mockClear();
    transitionSubObjectiveStateMock.mockResolvedValue({
      ok: true as const,
      previousState: "unknown" as const,
      wasNoOp: false,
    });
    dealFindUniqueMock.mockResolvedValue({
      id: DEAL_A,
      tenantId: TENANT_A,
      contactId: CONTACT_A,
    });
  });

  it("ESCALATE path: autoTransitionSubObjectives=false → Escalation row created with engine_proposed_action triggerType + originalAction payload", async () => {
    // Phase 1 Q6 default: tenant opt-out → escalate via PR4.5's pattern.
    tenantFindUniqueMock.mockResolvedValue({ autoTransitionSubObjectives: false });
    const precomputed = buildTransitionBrainDecision({
      subObjectiveKey: "timeline",
      toState: "known",
      value: "Q3 2026",
      confidence: 0.82,
      reasoning: 'Contact replied "looking to start in Q3" — timeline now known.',
    });

    await (await getWirePhase2Consumers())(DEAL_A, "evt_transition_escalate", false, precomputed as never);

    // Auto-dispatch path NOT taken — tenant opted out.
    expect(transitionSubObjectiveStateMock).not.toHaveBeenCalled();
    // Escalate path taken — Escalation row created.
    expect(escalationCreateMock).toHaveBeenCalledTimes(1);
    const createArgs = escalationCreateMock.mock.calls[0]![0] as {
      data: {
        tenantId: string;
        contactId: string;
        decisionId: string | null;
        triggerType: string;
        originalAction: { actionType: string; channel: string | null; payload: Record<string, unknown> };
        context: Record<string, unknown>;
      };
    };
    expect(createArgs.data.tenantId).toBe(TENANT_A);
    expect(createArgs.data.contactId).toBe(CONTACT_A);
    expect(createArgs.data.decisionId).toBe("decision_trigger_a");
    expect(createArgs.data.triggerType).toBe("engine_proposed_action");
    // originalAction carries the transition payload for operator-accept
    // fallback (KAN-1037 PR1 path).
    expect(createArgs.data.originalAction.actionType).toBe("transition_sub_objective");
    expect(createArgs.data.originalAction.channel).toBeNull();
    expect(createArgs.data.originalAction.payload).toMatchObject({
      subObjectiveKey: "timeline",
      toState: "known",
      value: "Q3 2026",
      brainConfidence: 0.82,
    });
    // Context source discriminator for KAN-1042 telemetry.
    expect(createArgs.data.context.source).toBe("kan_1042_engine_transition_proposal");
    expect(createArgs.data.context.tenantOptIn).toBe(false);
  });

  it("DISPATCH path: autoTransitionSubObjectives=true → transitionSubObjectiveState called with source='engine' + engineContext", async () => {
    // Phase 1 Q6 opt-in: tenant flipped → auto-dispatch via the
    // sub-objective-gap-tracker.
    tenantFindUniqueMock.mockResolvedValue({ autoTransitionSubObjectives: true });
    transitionSubObjectiveStateMock.mockResolvedValueOnce({
      ok: true as const,
      previousState: "unknown" as const,
      wasNoOp: false,
    });
    const precomputed = buildTransitionBrainDecision({
      subObjectiveKey: "authority",
      toState: "known",
      value: "VP of Sales",
      confidence: 0.78,
      reasoning: 'Contact stated they are "VP of Sales".',
    });

    await (await getWirePhase2Consumers())(DEAL_A, "evt_transition_dispatch", false, precomputed as never);

    // Escalation NOT created — tenant opted in.
    expect(escalationCreateMock).not.toHaveBeenCalled();
    // Auto-dispatch fired — assert the extended signature contract.
    expect(transitionSubObjectiveStateMock).toHaveBeenCalledTimes(1);
    // Cast for tuple narrowing — vitest infers mock.calls[i] as tuple
    // from the inline factory's signature (zero-arg here), which loses
    // positional indexing.
    const args = transitionSubObjectiveStateMock.mock.calls[0] as unknown as [
      unknown,
      string,
      string,
      { contactId: string; subObjectiveKey: string; toState: string; value: string | number | null },
      'manual' | 'engine',
      { reasoning: string; confidence: number; decisionId: string | null; eventId: string },
    ];
    // arg[0] is prisma (mock proxy). args[1] tenantId, args[2] actor,
    // args[3] input, args[4] source, args[5] engineContext.
    expect(args[1]).toBe(TENANT_A);
    expect(args[2]).toBe("engine_agentic_live");
    expect(args[3]).toEqual({
      contactId: CONTACT_A,
      subObjectiveKey: "authority",
      toState: "known",
      value: "VP of Sales",
    });
    expect(args[4]).toBe("engine");
    expect(args[5]).toEqual({
      reasoning: 'Contact stated they are "VP of Sales".',
      confidence: 0.78,
      decisionId: "decision_trigger_a",
      eventId: "evt_transition_dispatch",
    });
  });

  it("CHAIN-DEPTH GUARD: isChainedInvocation=true → NO escalation, NO dispatch (mirrors PR4.5 posture)", async () => {
    tenantFindUniqueMock.mockResolvedValue({ autoTransitionSubObjectives: true });
    const precomputed = buildTransitionBrainDecision();

    // 3rd arg = true (chained). Both arms must skip to prevent
    // double-transition / double-escalation on the same inbound.
    await (await getWirePhase2Consumers())(DEAL_A, "evt_chained", true, precomputed as never);

    expect(escalationCreateMock).not.toHaveBeenCalled();
    expect(transitionSubObjectiveStateMock).not.toHaveBeenCalled();
  });

  it("DEFENSIVE GUARD: type=transition_sub_objective but subObjectiveTransition payload missing → log + skip (no escalation, no dispatch, no throw)", async () => {
    // Parser at brain-service.ts:892+ enforces payload presence; this
    // guard is defense-in-depth against any future parser bypass.
    tenantFindUniqueMock.mockResolvedValue({ autoTransitionSubObjectives: true });
    const precomputed = {
      dealId: DEAL_A,
      evaluatedAt: new Date(),
      currentStateSnapshot: buildTransitionBrainDecision().currentStateSnapshot,
      nextBestAction: {
        type: "transition_sub_objective" as const,
        reasoning: "stray emission with no payload",
        // subObjectiveTransition INTENTIONALLY OMITTED
      },
      confidence: 0.7,
      modelTier: "reasoning" as const,
      llmInputTokens: 100,
      llmOutputTokens: 50,
    };

    await expect(
      (await getWirePhase2Consumers())(DEAL_A, "evt_no_payload", false, precomputed as never),
    ).resolves.not.toThrow();
    expect(escalationCreateMock).not.toHaveBeenCalled();
    expect(transitionSubObjectiveStateMock).not.toHaveBeenCalled();
  });
});
