/**
 * KAN-774 — lead-received push subscriber unit tests.
 *
 * Mocks: prisma (via packages/api/src/services/lead-assignment.js dynamic import),
 * verifyPubsubOidc (via vi.mock on the module), assignLeadToPipeline (via vi.mock).
 *
 * Coverage:
 *   - OIDC verify success → assignment runs (rule mode)
 *   - OIDC verify failure → 401 + assignment NOT called
 *   - Malformed envelope → 200 ack-and-drop (poison-message defense)
 *   - Malformed inner payload (zod parse fail) → 200 ack-and-drop
 *   - assignLeadToPipeline throws → 500 (Pub/Sub retries)
 *   - assignLeadToPipeline returns escalated → 200 (escalation is valid, not error)
 *   - skipIfAssigned: true passed through to assignLeadToPipeline
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const verifyPubsubOidcMock = vi.fn();
const assignLeadToPipelineMock = vi.fn();

vi.mock("../lib/oidc-pubsub-verify.js", () => ({
  verifyPubsubOidc: verifyPubsubOidcMock,
}));

vi.mock("../prisma.js", () => ({
  prisma: { /* Prisma client mock — assignLeadToPipeline mock doesn't actually use it */ },
}));

// Variable-specifier dynamic import — mock via path inside the module.
// The subscriber loads it via: await import('../../../../packages/api/src/services/lead-assignment.js')
vi.mock("../../../../packages/api/src/services/lead-assignment.js", () => ({
  assignLeadToPipeline: assignLeadToPipelineMock,
}));

// Import AFTER mocks are set up.
const { leadReceivedPushApp } = await import("../subscribers/lead-received-push.js");

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const CONTACT_A = "22222222-2222-2222-2222-222222222222";

function buildLeadReceivedEvent(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date().toISOString();
  return {
    eventId: "evt_test_001",
    eventType: "lead.received" as const,
    version: "1.0" as const,
    publishedAt: now,
    tenantId: TENANT_A,
    contactId: CONTACT_A,
    source: "inbox_email" as const,
    metadata: {
      fromAddress: "test@example.com",
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

beforeEach(() => {
  verifyPubsubOidcMock.mockReset();
  assignLeadToPipelineMock.mockReset();
});

describe("KAN-774 — lead-received push subscriber", () => {
  it("OIDC verify success → assignment runs, returns 200", async () => {
    verifyPubsubOidcMock.mockResolvedValue(true);
    assignLeadToPipelineMock.mockResolvedValue({
      mode: "rule",
      ruleId: "rule_001",
      pipelineId: "pipeline_a",
      stageId: "stage_a",
    });

    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(200);
    expect(assignLeadToPipelineMock).toHaveBeenCalledOnce();
    const args = assignLeadToPipelineMock.mock.calls[0]!;
    expect(args[1]).toBe(CONTACT_A); // contactId
    expect(args[2]).toEqual({ skipIfAssigned: true });
  });

  it("OIDC verify failure → 401 + assignment NOT called", async () => {
    verifyPubsubOidcMock.mockResolvedValue(false);

    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(401);
    expect(assignLeadToPipelineMock).not.toHaveBeenCalled();
  });

  it("malformed envelope (no message.data) → 200 ack-and-drop, assignment NOT called", async () => {
    verifyPubsubOidcMock.mockResolvedValue(true);

    const res = await postEnvelope({ message: {} }); // missing data field
    expect(res.status).toBe(200);
    expect(assignLeadToPipelineMock).not.toHaveBeenCalled();
  });

  it("malformed inner payload (zod parse fails) → 200 ack-and-drop, assignment NOT called", async () => {
    verifyPubsubOidcMock.mockResolvedValue(true);

    // Valid envelope shape, but inner payload doesn't match LeadReceivedEventSchema
    // (missing required fields: tenantId, contactId, source, etc.)
    const badPayload = { eventType: "lead.received", contactId: "not-a-uuid" };
    const res = await postEnvelope({
      message: {
        data: Buffer.from(JSON.stringify(badPayload)).toString("base64"),
        messageId: "msg_bad",
      },
    });
    expect(res.status).toBe(200);
    expect(assignLeadToPipelineMock).not.toHaveBeenCalled();
  });

  it("assignLeadToPipeline throws → 500 (Pub/Sub retries)", async () => {
    verifyPubsubOidcMock.mockResolvedValue(true);
    assignLeadToPipelineMock.mockRejectedValue(new Error("DB connection failed"));

    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(500);
    expect(assignLeadToPipelineMock).toHaveBeenCalledOnce();
  });

  it("assignLeadToPipeline returns 'escalated' → 200 (escalation is valid, not error)", async () => {
    verifyPubsubOidcMock.mockResolvedValue(true);
    assignLeadToPipelineMock.mockResolvedValue({ mode: "escalated" });

    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(200);
    expect(assignLeadToPipelineMock).toHaveBeenCalledOnce();
  });

  it("assignLeadToPipeline returns 'unassigned' → 200 (valid governance decision)", async () => {
    verifyPubsubOidcMock.mockResolvedValue(true);
    assignLeadToPipelineMock.mockResolvedValue({ mode: "unassigned" });

    const res = await postEnvelope(buildPushEnvelope());
    expect(res.status).toBe(200);
    expect(assignLeadToPipelineMock).toHaveBeenCalledOnce();
  });
});
