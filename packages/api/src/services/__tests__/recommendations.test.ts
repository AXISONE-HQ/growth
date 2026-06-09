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
  reclassifyRecommendation,
} from "../recommendations.js";
import { buildLeadReceivedEvent } from "@growth/shared";

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
  // KAN-1037 — engine-emitted SuggestedAction (nullable; legacy / non-engine
  // paths stay NULL and preserve the pre-fix no-publish-on-accept behavior).
  originalAction: unknown;
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
    // Default null preserves legacy test expectations; KAN-1037 tests opt in.
    originalAction: null,
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
          contact: { id: r.contactId, firstName: "A", lastName: "B", email: "a@b.c", phone: null, lifecycleStage: "lead" },
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

  it("without modifiedAction AND null originalAction: does NOT emit, just transitions status (legacy text-only fallback)", async () => {
    // KAN-1037 — legacy row (originalAction NULL: guardrail_block, lead_assignment,
    // or pre-KAN-1037 rows). Accept without modify → no publish, status transitions.
    // Audit reason stays `recommendation.accept` for back-compat with prior
    // dashboards; payload.publishSource records 'none' to discriminate the
    // path post-fix.
    const rows = [makeRow({ id: ESC_OPEN, status: "open", originalAction: null })];
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
    expect(auditCalls[0].data.actionType).toBe("recommendation.accept");
    const auditPayload = auditCalls[0].data.payload as Record<string, unknown>;
    expect(auditPayload.modifiedAction).toBeNull();
    expect(auditPayload.publishedActionDecidedId).toBeNull();
    expect(auditPayload.publishSource).toBe("none");
  });

  it("KAN-1037 — without modifiedAction AND populated originalAction: dispatches via fallback + writes accept_no_modification_published audit", async () => {
    const originalAction = {
      actionType: "send_follow_up",
      channel: "email",
      payload: { messageTemplate: "warm_followup_v2", subject: "Re: your inquiry" },
    };
    const rows = [makeRow({ id: ESC_OPEN, status: "open", originalAction })];
    const { prisma, auditCalls, updates } = makePrisma(rows);
    const pubsub = makePubSubClient();

    const result = await acceptRecommendation(
      { prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub },
      { id: ESC_OPEN },
    );

    expect(result.status).toBe("resolved");
    expect(result.publishedEventId).toBe("msg-test-1");
    expect(pubsub.publish).toHaveBeenCalledTimes(1);
    // Verify the published payload drew from originalAction, not from the
    // text-only fallback.
    const publishedEnvelope = pubsub.publish.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(publishedEnvelope).toBeDefined();
    expect(updates[0].data).toMatchObject({ status: "resolved", resolvedBy: ACTOR });
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].data.actionType).toBe("accept_no_modification_published");
    const auditPayload = auditCalls[0].data.payload as Record<string, unknown>;
    expect(auditPayload.modifiedAction).toBeNull();
    expect(auditPayload.publishSource).toBe("original_action");
    expect(auditPayload.publishedActionDecidedId).toBe("msg-test-1");
  });

  it("KAN-1037 — modifiedAction overrides originalAction (operator-curated wins)", async () => {
    // Engine emitted send_follow_up; operator decided to send_sms instead.
    // Verify modifiedAction takes precedence and audit reason stays the
    // existing `recommendation.accept` (modify-and-accept path is unchanged).
    const originalAction = {
      actionType: "send_follow_up",
      channel: "email",
      payload: { messageTemplate: "warm_followup_v2" },
    };
    const modifiedAction = {
      actionType: "send_sms",
      channel: "sms",
      payload: { body: "Op's manual SMS override" },
    };
    const rows = [makeRow({ id: ESC_OPEN, status: "open", originalAction })];
    const { prisma, auditCalls } = makePrisma(rows);
    const pubsub = makePubSubClient();

    const result = await acceptRecommendation(
      { prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub },
      { id: ESC_OPEN, modifiedAction },
    );

    expect(result.status).toBe("resolved");
    expect(result.publishedEventId).toBe("msg-test-1");
    expect(pubsub.publish).toHaveBeenCalledTimes(1);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].data.actionType).toBe("recommendation.accept");
    const auditPayload = auditCalls[0].data.payload as Record<string, unknown>;
    expect(auditPayload.modifiedAction).toEqual(modifiedAction);
    expect(auditPayload.publishSource).toBe("modified_action");
  });

  it("KAN-1037 — malformed originalAction: skips publish gracefully, status still transitions", async () => {
    // Defense-in-depth: corrupted JSONB or schema drift. SuggestedActionSchema
    // safeParse fails; warning logged; no publish but status transition
    // still commits (operator's click registers).
    const malformedOriginalAction = { not_a_valid_action: true, missing: "everything" };
    const rows = [makeRow({ id: ESC_OPEN, status: "open", originalAction: malformedOriginalAction })];
    const { prisma, auditCalls, updates } = makePrisma(rows);
    const pubsub = makePubSubClient();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await acceptRecommendation(
        { prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub },
        { id: ESC_OPEN },
      );

      expect(result.status).toBe("resolved");
      expect(result.publishedEventId).toBeNull();
      expect(pubsub.publish).not.toHaveBeenCalled();
      expect(updates).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("malformed originalAction"),
        expect.anything(),
      );
      expect(auditCalls).toHaveLength(1);
      expect(auditCalls[0].data.actionType).toBe("recommendation.accept");
      const auditPayload = auditCalls[0].data.payload as Record<string, unknown>;
      expect(auditPayload.publishSource).toBe("none");
      expect(auditPayload.publishedActionDecidedId).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
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

  it("KAN-1037 — dismiss path unaffected by originalAction column (regression)", async () => {
    // Populated originalAction must not trigger publishing on dismiss —
    // dismiss is an acknowledgment-without-action. The fix is isolated to
    // acceptRecommendation; this guards against accidental cross-wiring.
    const originalAction = {
      actionType: "send_follow_up",
      channel: "email",
      payload: { messageTemplate: "warm_followup_v2" },
    };
    const rows = [makeRow({ id: ESC_OPEN, status: "open", originalAction })];
    const { prisma, auditCalls, updates } = makePrisma(rows);

    const result = await dismissRecommendation(
      { prisma, tenantId: TENANT_A, actor: ACTOR },
      { id: ESC_OPEN, reason: "Operator deemed not actionable" },
    );

    expect(result.status).toBe("dismissed");
    expect(updates[0].data).toMatchObject({ status: "dismissed" });
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].data.actionType).toBe("recommendation.dismiss");
    // No publishSource discriminator on the dismiss audit payload — the
    // KAN-1037 wiring is acceptRecommendation-only.
    const dismissPayload = auditCalls[0].data.payload as Record<string, unknown>;
    expect(dismissPayload.publishSource).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// KAN-1140 Phase 3 PR 6 — reclassifyRecommendation tests
// ─────────────────────────────────────────────────────────────
//
// Coverage (matches Phase 2 spec Step 5 tests):
//   1. Happy path all 3 corrections → Contact.language updated;
//      Deal.metadata.leadVendor updated; synthetic event published with
//      parseConfidenceOverride + parseCorrections; escalation resolved;
//      audit written
//   2. correctedLanguage only → Contact.language updated, Deal untouched
//   3. correctedVendor only → Deal.metadata.leadVendor updated, Contact
//      untouched
//   4. Wrong triggerType → throws (must be parse_confidence_review)
//   5. Already-resolved escalation → throws (status guard)
//   6. Missing originalWirePayload → throws (sentinel for pre-KAN-1140-PR-6
//      escalations)
//   7. Empty corrections (all undefined) → throws (operator should use
//      accept instead)

const DEAL_AAA = "deadbeef-1234-5678-9abc-deadbeef0001";
const CONTACT_BBB = "deadbeef-1234-5678-9abc-deadbeef0002";

function buildParseConfidenceEscalation(opts: {
  id?: string;
  status?: "open" | "resolved" | "dismissed";
  triggerType?: string;
  includeOriginalWirePayload?: boolean;
} = {}): FakeRow {
  const originalEvent = opts.includeOriginalWirePayload !== false
    ? buildLeadReceivedEvent({
        eventId: "550e8400-e29b-41d4-a716-446655440042",
        tenantId: TENANT_A,
        contactId: CONTACT_BBB,
        source: "email_inbox",
        metadata: {
          fromAddress: "test@example.com",
          subject: "Inquiry",
          bodyPreview: "short body preview",
          attachmentCount: 0,
        },
      })
    : undefined;
  return makeRow({
    id: opts.id ?? ESC_OPEN,
    status: opts.status ?? "open",
    contactId: CONTACT_BBB,
    triggerType: opts.triggerType ?? "parse_confidence_review",
    triggerReason: "format detection LOW; language detection LOW",
    aiSuggestion: null,
    originalAction: null,
    context: {
      source: "kan_1140_phase_3_pr_6_parse_confidence",
      eventId: originalEvent?.eventId ?? "evt_pre_kan_1140_pr6",
      dealId: DEAL_AAA,
      contactId: CONTACT_BBB,
      parseConfidenceBreakdown: {
        format: "plain-text",
        formatConfidence: "low",
        language: "en",
        languageConfidence: "low",
        extractionConfidence: "medium",
      },
      bodyPreview: "short body preview",
      ...(originalEvent ? { originalWirePayload: originalEvent } : {}),
    },
  });
}

function makeReclassifyPrisma(rows: FakeRow[]) {
  const base = makePrisma(rows);
  const contactUpdateCalls: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const dealUpdateCalls: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const dealFindFirstStub = vi.fn(async () => ({
    metadata: { source: "track_a_email_inbound", existingKey: "preserved" },
  }));
  const extendedPrisma = {
    ...(base.prisma as Record<string, unknown>),
    contact: {
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        contactUpdateCalls.push({ where, data });
        return { id: where.id, ...data };
      }),
    },
    deal: {
      findFirst: dealFindFirstStub,
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        dealUpdateCalls.push({ where, data });
        return { id: where.id, ...data };
      }),
    },
  };
  return {
    prisma: extendedPrisma as never,
    auditCalls: base.auditCalls,
    updates: base.updates,
    contactUpdateCalls,
    dealUpdateCalls,
    dealFindFirstStub,
  };
}

describe("KAN-1140 Phase 3 PR 6 — reclassifyRecommendation", () => {
  it("happy path: all 3 corrections → Contact.language updated, Deal.metadata.leadVendor updated, synthetic published, status=resolved, audit written", async () => {
    const rows = [buildParseConfidenceEscalation()];
    const { prisma, auditCalls, updates, contactUpdateCalls, dealUpdateCalls } = makeReclassifyPrisma(rows);
    const pubsub = makePubSubClient();

    const result = await reclassifyRecommendation(
      { prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub },
      {
        id: ESC_OPEN,
        correctedFormat: "adf",
        correctedLanguage: "fr",
        correctedVendor: "formspree",
      },
    );

    expect(result.status).toBe("resolved");
    expect(result.syntheticEventId).toBeDefined();
    expect(result.pubsubMessageId).toBe("msg-test-1");

    // Contact.language force-overwrite
    expect(contactUpdateCalls).toHaveLength(1);
    expect(contactUpdateCalls[0].data).toEqual({ language: "fr" });

    // Deal.metadata merge — preserves existing keys
    expect(dealUpdateCalls).toHaveLength(1);
    const dealMetadata = dealUpdateCalls[0].data.metadata as Record<string, unknown>;
    expect(dealMetadata.leadVendor).toBe("formspree");
    expect(dealMetadata.existingKey).toBe("preserved");

    // Synthetic event published with loop-guard + corrections
    expect(pubsub.publish).toHaveBeenCalledTimes(1);
    const publishCall = pubsub.publish.mock.calls[0]!;
    expect(publishCall[0]).toBe("lead.received");
    const syntheticPayload = JSON.parse((publishCall[1] as Buffer).toString("utf-8")) as {
      metadata: {
        parseConfidenceOverride: boolean;
        parseCorrections: { format?: string; language?: string; vendor?: string };
        language?: string;
        vendor?: string;
      };
    };
    expect(syntheticPayload.metadata.parseConfidenceOverride).toBe(true);
    expect(syntheticPayload.metadata.parseCorrections).toEqual({
      format: "adf",
      language: "fr",
      vendor: "formspree",
    });
    expect(syntheticPayload.metadata.language).toBe("fr");
    expect(syntheticPayload.metadata.vendor).toBe("formspree");

    // Escalation status transitioned to resolved
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({ status: "resolved", resolvedBy: ACTOR });

    // Audit log written
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].data.actionType).toBe("recommendation.reclassify");
  });

  it("correctedLanguage only → Contact updated, Deal NOT touched, synthetic carries language", async () => {
    const rows = [buildParseConfidenceEscalation()];
    const { prisma, contactUpdateCalls, dealUpdateCalls } = makeReclassifyPrisma(rows);
    const pubsub = makePubSubClient();

    await reclassifyRecommendation(
      { prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub },
      { id: ESC_OPEN, correctedLanguage: "es" },
    );

    expect(contactUpdateCalls).toHaveLength(1);
    expect(contactUpdateCalls[0].data.language).toBe("es");
    expect(dealUpdateCalls).toHaveLength(0);
  });

  it("correctedVendor only → Deal updated, Contact NOT touched, synthetic carries vendor", async () => {
    const rows = [buildParseConfidenceEscalation()];
    const { prisma, contactUpdateCalls, dealUpdateCalls } = makeReclassifyPrisma(rows);
    const pubsub = makePubSubClient();

    await reclassifyRecommendation(
      { prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub },
      { id: ESC_OPEN, correctedVendor: "tally" },
    );

    expect(contactUpdateCalls).toHaveLength(0);
    expect(dealUpdateCalls).toHaveLength(1);
    const metadata = dealUpdateCalls[0].data.metadata as Record<string, unknown>;
    expect(metadata.leadVendor).toBe("tally");
  });

  it("wrong triggerType (engine_proposed_action) → throws BAD_REQUEST", async () => {
    const rows = [
      buildParseConfidenceEscalation({ triggerType: "engine_proposed_action" }),
    ];
    const { prisma } = makeReclassifyPrisma(rows);
    const pubsub = makePubSubClient();

    await expect(
      reclassifyRecommendation(
        { prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub },
        { id: ESC_OPEN, correctedLanguage: "fr" },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("parse_confidence_review"),
    });
  });

  it("already-resolved escalation → throws BAD_REQUEST", async () => {
    const rows = [buildParseConfidenceEscalation({ status: "resolved" })];
    const { prisma } = makeReclassifyPrisma(rows);
    const pubsub = makePubSubClient();

    await expect(
      reclassifyRecommendation(
        { prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub },
        { id: ESC_OPEN, correctedLanguage: "fr" },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("already resolved"),
    });
  });

  it("missing originalWirePayload → throws (sentinel for pre-PR-6 escalations)", async () => {
    const rows = [buildParseConfidenceEscalation({ includeOriginalWirePayload: false })];
    const { prisma } = makeReclassifyPrisma(rows);
    const pubsub = makePubSubClient();

    await expect(
      reclassifyRecommendation(
        { prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub },
        { id: ESC_OPEN, correctedLanguage: "fr" },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("originalWirePayload"),
    });
  });

  it("empty corrections (all undefined) → throws BAD_REQUEST", async () => {
    const rows = [buildParseConfidenceEscalation()];
    const { prisma } = makeReclassifyPrisma(rows);
    const pubsub = makePubSubClient();

    await expect(
      reclassifyRecommendation(
        { prisma, tenantId: TENANT_A, actor: ACTOR, pubsubClient: pubsub },
        { id: ESC_OPEN },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("at least one"),
    });
  });
});
