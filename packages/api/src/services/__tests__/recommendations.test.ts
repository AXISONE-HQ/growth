/**
 * KAN-754 — recommendations service.
 *
 * Coverage matches the AC + 5 reinforcements:
 *   - list paginates + filters
 *   - getDetail returns full context (decision panel populated when decisionId
 *     present, null when null — guardrail/assignment paths)
 *   - accept emits action.decided when modifiedAction provided + writes audit
 *   - accept (no modifiedAction) does NOT emit, just transitions status
 *   - modify updates aiSuggestion only, no emission
 *   - dismiss does NOT emit, status -> dismissed, audit written
 *   - cross-tenant rejection: tenant A admin cannot accept tenant B's row
 *   - audit-log write failure does NOT fail the mutation (best-effort)
 *   - terminal-state guards: accept/modify/dismiss reject already-resolved/dismissed
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listRecommendations,
  getRecommendationDetail,
  acceptRecommendation,
  modifyRecommendation,
  dismissRecommendation,
} from "../recommendations.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const ACTOR = "uid-fred";
const ESC_OPEN = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ESC_RESOLVED = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ESC_NULL_DECISION = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ESC_FOREIGN = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const DECISION_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const CONTACT_A = "abcdef01-1111-1111-1111-111111111111";

interface FakeRow {
  id: string;
  tenantId: string;
  contactId: string;
  decisionId: string | null;
  severity: string;
  status: string;
  triggerType: string;
  triggerReason: string | null;
  aiSuggestion: string | null;
  context: unknown;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function makeRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: ESC_OPEN,
    tenantId: TENANT_A,
    contactId: CONTACT_A,
    decisionId: DECISION_ID,
    severity: "medium",
    status: "open",
    triggerType: "AGENTIC_GATE_DECISION",
    triggerReason: "low confidence",
    aiSuggestion: "send_email via email",
    context: { confidence: 0.3, strategy: "warm_up_lead" },
    resolvedBy: null,
    resolvedAt: null,
    createdAt: new Date("2026-04-29T18:00:00Z"),
    updatedAt: new Date("2026-04-29T18:00:00Z"),
    ...overrides,
  };
}

function makePrisma(rows: FakeRow[], opts: { auditFails?: boolean } = {}) {
  const auditCalls: Array<{ data: Record<string, unknown> }> = [];
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const fake = {
    escalation: {
      findMany: vi.fn(async ({ where, skip, take }: { where: { tenantId: string; status?: string; severity?: string }; skip?: number; take?: number }) => {
        const filtered = rows.filter(
          (r) =>
            r.tenantId === where.tenantId &&
            (!where.status || r.status === where.status) &&
            (!where.severity || r.severity === where.severity),
        );
        const sliced = filtered.slice(skip ?? 0, (skip ?? 0) + (take ?? 20));
        return sliced.map((r) => ({
          ...r,
          contact: { id: r.contactId, firstName: "A", lastName: "B", email: "a@b.c" },
        }));
      }),
      count: vi.fn(async ({ where }: { where: { tenantId: string; status?: string } }) =>
        rows.filter((r) => r.tenantId === where.tenantId && (!where.status || r.status === where.status)).length,
      ),
      findFirst: vi.fn(async ({ where }: { where: { id: string; tenantId: string } }) => {
        const r = rows.find((row) => row.id === where.id && row.tenantId === where.tenantId);
        if (!r) return null;
        return {
          ...r,
          contact: { id: r.contactId, firstName: "A", lastName: "B", email: "a@b.c", phone: null, lifecycleStage: "new" },
          decision: r.decisionId
            ? {
                id: r.decisionId,
                strategySelected: "warm_up_lead",
                actionType: "send_email",
                confidence: 0.3,
                reasoning: "low confidence",
                metadata: { outcome: "ESCALATED" },
                createdAt: new Date("2026-04-29T17:55:00Z"),
              }
            : null,
        };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ where, data });
        const r = rows.find((row) => row.id === where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data);
        return r;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.auditFails) throw new Error("audit-log connection broken");
        auditCalls.push({ data });
        return { id: "audit-1", ...data };
      }),
    },
  };
  return { prisma: fake as never, auditCalls, updates };
}

function makePubSubClient(opts: { fails?: boolean } = {}) {
  return {
    // PubSubClient.publish returns a messageId string per the contract in
    // packages/api/src/services/action-decided-publisher.ts.
    publish: vi.fn(async (): Promise<string> => {
      if (opts.fails) throw new Error("pubsub down");
      return "msg-test-1";
    }),
  };
}

describe("KAN-754 — listRecommendations", () => {
  it("paginates + filters by status", async () => {
    const rows = [
      makeRow({ id: "e1", status: "open", severity: "high" }),
      makeRow({ id: "e2", status: "open", severity: "medium" }),
      makeRow({ id: "e3", status: "resolved", severity: "low" }),
    ];
    const { prisma } = makePrisma(rows);

    const result = await listRecommendations(prisma, TENANT_A, { status: "open", limit: 10, offset: 0 });
    expect(result.total).toBe(2);
    expect(result.items.map((i) => i.id)).toEqual(["e1", "e2"]);
  });

  it("filters by severity", async () => {
    const rows = [
      makeRow({ id: "e1", severity: "high" }),
      makeRow({ id: "e2", severity: "medium" }),
    ];
    const { prisma } = makePrisma(rows);

    const result = await listRecommendations(prisma, TENANT_A, { severity: "high", limit: 10, offset: 0 });
    expect(result.items.map((i) => i.id)).toEqual(["e1"]);
  });

  it("excludes other-tenant rows", async () => {
    const rows = [
      makeRow({ id: "e1", tenantId: TENANT_A }),
      makeRow({ id: "e2", tenantId: TENANT_B }),
    ];
    const { prisma } = makePrisma(rows);

    const result = await listRecommendations(prisma, TENANT_A, { limit: 10, offset: 0 });
    expect(result.items.map((i) => i.id)).toEqual(["e1"]);
  });
});

describe("KAN-754 — getRecommendationDetail", () => {
  it("returns full context with decision panel when decisionId present", async () => {
    const rows = [makeRow({ id: ESC_OPEN, decisionId: DECISION_ID })];
    const { prisma } = makePrisma(rows);

    const detail = await getRecommendationDetail(prisma, TENANT_A, ESC_OPEN);
    expect(detail.id).toBe(ESC_OPEN);
    expect(detail.decision).not.toBeNull();
    expect(detail.decision?.id).toBe(DECISION_ID);
  });

  it("returns decision: null when decisionId is null (guardrail/assignment paths)", async () => {
    // KAN-750 reinforcement #2: null-safe decisionId. Guardrail-block +
    // lead-assignment paths write Escalations with decisionId=null. Detail
    // endpoint returns decision: null cleanly; UI hides the panel.
    const rows = [makeRow({ id: ESC_NULL_DECISION, decisionId: null })];
    const { prisma } = makePrisma(rows);

    const detail = await getRecommendationDetail(prisma, TENANT_A, ESC_NULL_DECISION);
    expect(detail.decisionId).toBeNull();
    expect(detail.decision).toBeNull();
    // Other context still present — escalation row stands on its own
    expect(detail.aiSuggestion).toBe("send_email via email");
    expect(detail.triggerType).toBe("AGENTIC_GATE_DECISION");
  });

  it("rejects cross-tenant access with NOT_FOUND (no leak)", async () => {
    const rows = [makeRow({ id: ESC_FOREIGN, tenantId: TENANT_B })];
    const { prisma } = makePrisma(rows);

    await expect(getRecommendationDetail(prisma, TENANT_A, ESC_FOREIGN)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("KAN-754 — acceptRecommendation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("with modifiedAction: emits action.decided + transitions to resolved + writes audit", async () => {
    const rows = [makeRow({ id: ESC_OPEN, status: "open" })];
    const { prisma, auditCalls, updates } = makePrisma(rows);
    const pubsub = makePubSubClient();

    const modifiedAction = {
      actionType: "send_email",
      channel: "email",
      payload: { subject: "Operator override", body: "..." },
    };

    const result = await acceptRecommendation(
      { prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub },
      { id: ESC_OPEN, modifiedAction },
    );

    expect(result.status).toBe("resolved");
    expect(result.publishedEventId).toBe("msg-test-1");
    expect(pubsub.publish).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({ status: "resolved", resolvedBy: ACTOR });
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].data).toMatchObject({
      tenantId: TENANT_A,
      actor: ACTOR,
      actionType: "recommendation.accept",
    });
    const auditPayload = auditCalls[0].data.payload as Record<string, unknown>;
    expect(auditPayload.escalationId).toBe(ESC_OPEN);
    expect(auditPayload.beforeStatus).toBe("open");
    expect(auditPayload.afterStatus).toBe("resolved");
    expect(auditPayload.modifiedAction).toEqual(modifiedAction);
    expect(auditPayload.publishedActionDecidedId).toBe("msg-test-1");
  });

  it("without modifiedAction: does NOT emit, just transitions status (default human_review path)", async () => {
    const rows = [makeRow({ id: ESC_OPEN, status: "open" })];
    const { prisma, auditCalls } = makePrisma(rows);
    const pubsub = makePubSubClient();

    const result = await acceptRecommendation(
      { prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub },
      { id: ESC_OPEN },
    );

    expect(result.status).toBe("resolved");
    expect(result.publishedEventId).toBeNull();
    expect(pubsub.publish).not.toHaveBeenCalled();
    expect(auditCalls).toHaveLength(1);
    const auditPayload = auditCalls[0].data.payload as Record<string, unknown>;
    expect(auditPayload.modifiedAction).toBeNull();
    expect(auditPayload.publishedActionDecidedId).toBeNull();
  });

  it("emit failure does NOT fail the mutation (operator already committed)", async () => {
    const rows = [makeRow({ id: ESC_OPEN, status: "open" })];
    const { prisma, auditCalls } = makePrisma(rows);
    const pubsub = makePubSubClient({ fails: true });

    const result = await acceptRecommendation(
      { prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub },
      {
        id: ESC_OPEN,
        modifiedAction: { actionType: "send_email", channel: "email", payload: {} },
      },
    );

    expect(result.status).toBe("resolved");
    expect(result.publishedEventId).toBeNull();
    expect(auditCalls).toHaveLength(1);
  });

  it("cross-tenant rejection (NOT_FOUND, no leak)", async () => {
    const rows = [makeRow({ id: ESC_FOREIGN, tenantId: TENANT_B })];
    const { prisma } = makePrisma(rows);
    const pubsub = makePubSubClient();

    await expect(
      acceptRecommendation(
        { prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub },
        { id: ESC_FOREIGN },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects already-resolved row (BAD_REQUEST)", async () => {
    const rows = [makeRow({ id: ESC_RESOLVED, status: "resolved" })];
    const { prisma } = makePrisma(rows);
    const pubsub = makePubSubClient();

    await expect(
      acceptRecommendation({ prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub }, { id: ESC_RESOLVED }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("audit-log write failure does NOT fail the mutation (best-effort)", async () => {
    const rows = [makeRow({ id: ESC_OPEN, status: "open" })];
    const { prisma, updates } = makePrisma(rows, { auditFails: true });
    const pubsub = makePubSubClient();

    const result = await acceptRecommendation(
      { prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub },
      { id: ESC_OPEN },
    );

    expect(result.status).toBe("resolved");
    expect(updates).toHaveLength(1);
  });
});

describe("KAN-754 — modifyRecommendation", () => {
  it("updates aiSuggestion only, does NOT emit, writes audit", async () => {
    const rows = [makeRow({ id: ESC_OPEN, aiSuggestion: "send_email via email" })];
    const { prisma, auditCalls, updates } = makePrisma(rows);

    const result = await modifyRecommendation(
      { prisma, tenantId: TENANT_A, actor: ACTOR },
      { id: ESC_OPEN, suggestedAction: "send_sms via sms" },
    );

    expect(result.aiSuggestion).toBe("send_sms via sms");
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toEqual({ aiSuggestion: "send_sms via sms" });
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].data).toMatchObject({ actionType: "recommendation.modify" });
    const payload = auditCalls[0].data.payload as Record<string, unknown>;
    expect(payload.beforeSuggestion).toBe("send_email via email");
    expect(payload.afterSuggestion).toBe("send_sms via sms");
  });

  it("rejects already-resolved row", async () => {
    const rows = [makeRow({ id: ESC_RESOLVED, status: "resolved" })];
    const { prisma } = makePrisma(rows);
    await expect(
      modifyRecommendation({ prisma, tenantId: TENANT_A, actor: ACTOR }, { id: ESC_RESOLVED, suggestedAction: "x" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("KAN-754 — dismissRecommendation", () => {
  it("transitions to dismissed, does NOT emit, writes audit with reason", async () => {
    const rows = [makeRow({ id: ESC_OPEN, status: "open" })];
    const { prisma, auditCalls, updates } = makePrisma(rows);

    const result = await dismissRecommendation(
      { prisma, tenantId: TENANT_A, actor: ACTOR },
      { id: ESC_OPEN, reason: "Duplicate of prior escalation" },
    );

    expect(result.status).toBe("dismissed");
    expect(updates[0].data).toMatchObject({ status: "dismissed", resolvedBy: ACTOR });
    expect(auditCalls[0].data).toMatchObject({ actionType: "recommendation.dismiss" });
    const payload = auditCalls[0].data.payload as Record<string, unknown>;
    expect(payload.dismissReason).toBe("Duplicate of prior escalation");
  });

  it("cross-tenant rejection", async () => {
    const rows = [makeRow({ id: ESC_FOREIGN, tenantId: TENANT_B })];
    const { prisma } = makePrisma(rows);
    await expect(
      dismissRecommendation({ prisma, tenantId: TENANT_A, actor: ACTOR }, { id: ESC_FOREIGN, reason: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
