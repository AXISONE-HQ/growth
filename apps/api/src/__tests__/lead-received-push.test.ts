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

vi.mock("../lib/oidc-pubsub-verify.js", () => ({
  verifyPubsubOidc: verifyPubsubOidcMock,
}));

vi.mock("../prisma.js", () => ({
  prisma: {
    contact: { findUnique: contactFindUniqueMock },
    stage: { findFirst: stageFindFirstMock },
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
});

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
