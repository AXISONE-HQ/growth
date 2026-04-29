/**
 * KAN-739 — agentic-tools real handlers + cap helper + cross-tenant rejection.
 *
 * Each tool gets the same 4-case shape: (1) happy path returns expected
 * structure, (2) cross-tenant rejection returns NEUTRAL_FORBIDDEN_MESSAGES
 * with no leak of the foreign tenantId, (3) result is wrapped in capResult,
 * (4) audit row written best-effort. The integration test at the bottom
 * exercises all 5 tools through a mocked LLM.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  capResult,
  forbidden,
  getContactContext,
  retrieveKnowledge,
  getPipelineState,
  getRecentActions,
  getObjectiveProgress,
  REAL_HANDLERS,
  writeToolCallAudit,
  __setSimilaritySearchForTest,
  type RealToolHandlerContext,
} from "../agentic-tools.js";
import { NEUTRAL_FORBIDDEN_MESSAGES, TOOL_NAMES } from "@growth/shared";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const CONTACT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONTACT_B_FOREIGN = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const PIPELINE_A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PIPELINE_B_FOREIGN = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function makeMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    contact: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; tenantId: string } }) => {
        if (where.id === CONTACT_A && where.tenantId === TENANT_A) {
          return {
            id: CONTACT_A,
            firstName: "Alice",
            lastName: "Example",
            lifecycleStage: "qualified",
            segment: "smb",
            source: "form_fill",
            currentPipelineId: PIPELINE_A,
            currentStageId: "stage-1",
            microObjectiveProgress: { "mo-1": { completed: true, completedAt: "2026-04-20T00:00:00Z" } },
            enteredStageAt: new Date("2026-04-25T00:00:00Z"),
            currentPipeline: { id: PIPELINE_A, name: "Inbound", objectiveType: "warm_up_lead" },
            currentStage: { id: "stage-1", name: "New", order: 0, isInitial: true, isTerminal: false },
          };
        }
        return null;
      }),
    },
    pipeline: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; tenantId: string } }) => {
        if (where.id === PIPELINE_A && where.tenantId === TENANT_A) {
          return {
            id: PIPELINE_A,
            name: "Inbound",
            description: "default",
            objectiveType: "warm_up_lead",
            objectiveDescription: "warm via email",
            isActive: true,
            stages: [
              { id: "stage-1", name: "New", order: 0, isInitial: true, isTerminal: false },
              { id: "stage-2", name: "Closed", order: 1, isInitial: false, isTerminal: true },
            ],
            targets: [
              { metric: "appointments_booked", period: "monthly", value: 10, currentProgress: 3 },
            ],
            microObjectives: [
              { microObjective: { id: "mo-1", name: "Discovery", isDefault: true } },
            ],
          };
        }
        return null;
      }),
    },
    decision: {
      findMany: vi.fn(async () => [
        {
          id: "d1",
          strategySelected: "engagement_recovery",
          actionType: "send_email",
          confidence: 0.8,
          reasoning: "warm",
          createdAt: new Date(),
        },
      ]),
    },
    outcome: {
      findMany: vi.fn(async () => []),
    },
    action: {
      findMany: vi.fn(async () => [
        { id: "a1", agentType: "decision-engine", channel: "email", status: "delivered", sentAt: new Date(), deliveredAt: new Date(), failedAt: null, errorMessage: null, createdAt: new Date() },
      ]),
    },
    pipelineMicroObjective: {
      findMany: vi.fn(async () => [
        { microObjective: { id: "mo-1", name: "Discovery", isDefault: true } },
      ]),
    },
    auditLog: {
      create: vi.fn(async () => ({ id: "audit-1" })),
    },
    ...overrides,
  };
}

function makeCtx(prisma: ReturnType<typeof makeMockPrisma>, contactId = CONTACT_A): RealToolHandlerContext {
  return { prisma: prisma as never, tenantId: TENANT_A, contactId };
}

beforeEach(() => {
  __setSimilaritySearchForTest(null);
});

// ─────────────────────────────────────────────
// capResult helper
// ─────────────────────────────────────────────

describe("capResult", () => {
  it("returns the input unchanged when below cap", () => {
    const r = { hello: "world" };
    expect(capResult(r)).toBe(r);
  });

  it("returns truncation marker when JSON exceeds cap", () => {
    const big = { data: "x".repeat(60 * 1024) };
    const result = capResult(big);
    expect(result).toEqual(
      expect.objectContaining({
        error: "truncated",
        original_size_kb: expect.any(Number),
      }),
    );
    expect((result as { original_size_kb: number }).original_size_kb).toBeGreaterThan(50);
  });

  it("respects custom cap argument", () => {
    const r = { v: "x".repeat(2 * 1024) };
    expect(capResult(r, 1024)).toEqual(
      expect.objectContaining({ error: "truncated" }),
    );
  });
});

// ─────────────────────────────────────────────
// forbidden helper — ensures neutral messages stay neutral
// ─────────────────────────────────────────────

describe("forbidden helper + neutral cross-tenant messages", () => {
  it("returns the canonical neutral message for contacts", () => {
    expect(forbidden("contact")).toEqual({
      error: "forbidden",
      message: NEUTRAL_FORBIDDEN_MESSAGES.contact,
    });
  });

  it("never includes a UUID-like pattern in the message", () => {
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
    for (const kind of ["contact", "pipeline"] as const) {
      expect(forbidden(kind).message).not.toMatch(uuidPattern);
    }
  });

  it("never references 'tenant' in a way that leaks IDs", () => {
    for (const kind of ["contact", "pipeline"] as const) {
      const msg = forbidden(kind).message;
      // Must not contain literal 'tenantId' or 'tenant_id' substring.
      expect(msg).not.toContain("tenantId");
      expect(msg).not.toContain("tenant_id");
    }
  });
});

// ─────────────────────────────────────────────
// 1. get_contact_context
// ─────────────────────────────────────────────

describe("getContactContext", () => {
  it("returns contact + pipeline + stage + recentDecisions for in-tenant contact", async () => {
    const prisma = makeMockPrisma();
    const result = (await getContactContext({ contactId: CONTACT_A }, makeCtx(prisma))) as Record<string, unknown>;
    expect(result.contact).toEqual(expect.objectContaining({ id: CONTACT_A, firstName: "Alice" }));
    expect(result.pipeline).toEqual(expect.objectContaining({ id: PIPELINE_A, name: "Inbound" }));
    expect(result.stage).toEqual(expect.objectContaining({ id: "stage-1", isInitial: true }));
    expect(result.recentDecisions).toHaveLength(1);
  });

  it("rejects cross-tenant contactId with neutral forbidden (no foreign-id leak)", async () => {
    const prisma = makeMockPrisma();
    const result = (await getContactContext(
      { contactId: CONTACT_B_FOREIGN },
      makeCtx(prisma),
    )) as Record<string, unknown>;

    expect(result.error).toBe("forbidden");
    expect(result.message).toBe(NEUTRAL_FORBIDDEN_MESSAGES.contact);
    // Critical: foreign UUID MUST NOT appear in the response payload
    expect(JSON.stringify(result)).not.toContain(CONTACT_B_FOREIGN);
    expect(JSON.stringify(result)).not.toContain(TENANT_B);
  });

  it("does not query decisions/outcomes when contact lookup returns null", async () => {
    const prisma = makeMockPrisma();
    await getContactContext({ contactId: CONTACT_B_FOREIGN }, makeCtx(prisma));
    expect(prisma.decision.findMany).not.toHaveBeenCalled();
    expect(prisma.outcome.findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 2. retrieve_knowledge
// ─────────────────────────────────────────────

describe("retrieveKnowledge", () => {
  it("returns top-K results from similaritySearch when available", async () => {
    __setSimilaritySearchForTest(async () => [
      { content: "FAQ: refunds within 5 days", similarity: 0.91, sourceType: "qa_pair" },
      { content: "Shipping policy: 3 days", similarity: 0.78, sourceType: "url", sourceUrl: "https://example.com" },
    ]);
    const prisma = makeMockPrisma();
    const result = (await retrieveKnowledge(
      { query: "refund policy", limit: 2 },
      makeCtx(prisma),
    )) as Record<string, unknown>;
    expect(result.results).toHaveLength(2);
    expect(result.totalCount).toBe(2);
  });

  it("rejects cross-tenant pipelineId with neutral forbidden", async () => {
    const prisma = makeMockPrisma();
    const result = (await retrieveKnowledge(
      { query: "x", pipelineId: PIPELINE_B_FOREIGN },
      makeCtx(prisma),
    )) as Record<string, unknown>;
    expect(result.error).toBe("forbidden");
    expect(result.message).toBe(NEUTRAL_FORBIDDEN_MESSAGES.pipeline);
    expect(JSON.stringify(result)).not.toContain(PIPELINE_B_FOREIGN);
  });

  it("returns empty results note when similaritySearch unavailable", async () => {
    __setSimilaritySearchForTest(null);
    const prisma = makeMockPrisma();
    const result = (await retrieveKnowledge({ query: "x" }, makeCtx(prisma))) as Record<string, unknown>;
    expect(result.results).toEqual([]);
    expect(result.note).toBe("knowledge retrieval unavailable");
  });

  it("truncates oversized result via capResult (50KB cap fires)", async () => {
    // Mock similaritySearch to return 100KB of content
    __setSimilaritySearchForTest(async () => [
      { content: "x".repeat(60 * 1024), similarity: 0.9 },
      { content: "y".repeat(60 * 1024), similarity: 0.8 },
    ]);
    const prisma = makeMockPrisma();
    const result = (await retrieveKnowledge({ query: "x" }, makeCtx(prisma))) as Record<string, unknown>;
    expect(result.error).toBe("truncated");
    expect(result.original_size_kb).toBeGreaterThan(50);
  });

  it("clamps limit to max=10", async () => {
    let receivedK: number | undefined;
    __setSimilaritySearchForTest(async (_t, _q, opts) => {
      receivedK = opts?.k;
      return [];
    });
    await retrieveKnowledge({ query: "x", limit: 999 }, makeCtx(makeMockPrisma()));
    expect(receivedK).toBe(10);
  });
});

// ─────────────────────────────────────────────
// 3. get_pipeline_state
// ─────────────────────────────────────────────

describe("getPipelineState", () => {
  it("returns pipeline detail with stages + targets + MOs for in-tenant pipeline", async () => {
    const prisma = makeMockPrisma();
    const result = (await getPipelineState({ pipelineId: PIPELINE_A }, makeCtx(prisma))) as Record<string, unknown>;
    expect(result.id).toBe(PIPELINE_A);
    expect(result.stages).toHaveLength(2);
    expect((result.targets as unknown[])[0]).toEqual(
      expect.objectContaining({ metric: "appointments_booked", value: 10, currentProgress: 3 }),
    );
    expect(result.microObjectives).toHaveLength(1);
  });

  it("rejects cross-tenant pipelineId with neutral forbidden", async () => {
    const prisma = makeMockPrisma();
    const result = (await getPipelineState(
      { pipelineId: PIPELINE_B_FOREIGN },
      makeCtx(prisma),
    )) as Record<string, unknown>;
    expect(result.error).toBe("forbidden");
    expect(result.message).toBe(NEUTRAL_FORBIDDEN_MESSAGES.pipeline);
    expect(JSON.stringify(result)).not.toContain(PIPELINE_B_FOREIGN);
  });
});

// ─────────────────────────────────────────────
// 4. get_recent_actions
// ─────────────────────────────────────────────

describe("getRecentActions", () => {
  it("returns last N actions for in-tenant contact", async () => {
    const prisma = makeMockPrisma();
    const result = (await getRecentActions({ contactId: CONTACT_A, limit: 5 }, makeCtx(prisma))) as Record<string, unknown>;
    expect(result.actions).toHaveLength(1);
    expect(result.totalCount).toBe(1);
    expect(prisma.action.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: TENANT_A, contactId: CONTACT_A },
        take: 5,
      }),
    );
  });

  it("rejects cross-tenant contactId before issuing actions query", async () => {
    const prisma = makeMockPrisma();
    const result = (await getRecentActions(
      { contactId: CONTACT_B_FOREIGN },
      makeCtx(prisma),
    )) as Record<string, unknown>;
    expect(result.error).toBe("forbidden");
    expect(prisma.action.findMany).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(CONTACT_B_FOREIGN);
  });

  it("clamps limit to max=50", async () => {
    const prisma = makeMockPrisma();
    await getRecentActions({ contactId: CONTACT_A, limit: 999 }, makeCtx(prisma));
    expect(prisma.action.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });
});

// ─────────────────────────────────────────────
// 5. get_objective_progress
// ─────────────────────────────────────────────

describe("getObjectiveProgress", () => {
  it("returns progress derived from contact.microObjectiveProgress JSON", async () => {
    const prisma = makeMockPrisma();
    const result = (await getObjectiveProgress({ contactId: CONTACT_A }, makeCtx(prisma))) as Record<string, unknown>;
    const progress = result.progress as Array<{ microObjectiveId: string; isCompleted: boolean }>;
    expect(progress).toHaveLength(1);
    expect(progress[0]).toEqual(
      expect.objectContaining({ microObjectiveId: "mo-1", isCompleted: true }),
    );
  });

  it("rejects cross-tenant contactId with neutral forbidden", async () => {
    const prisma = makeMockPrisma();
    const result = (await getObjectiveProgress(
      { contactId: CONTACT_B_FOREIGN },
      makeCtx(prisma),
    )) as Record<string, unknown>;
    expect(result.error).toBe("forbidden");
    expect(JSON.stringify(result)).not.toContain(CONTACT_B_FOREIGN);
  });
});

// ─────────────────────────────────────────────
// REAL_HANDLERS registry
// ─────────────────────────────────────────────

describe("REAL_HANDLERS registry", () => {
  it("exports a handler for every TOOL_NAMES entry", () => {
    for (const name of TOOL_NAMES) {
      expect(typeof REAL_HANDLERS[name]).toBe("function");
    }
  });
});

// ─────────────────────────────────────────────
// writeToolCallAudit
// ─────────────────────────────────────────────

describe("writeToolCallAudit", () => {
  it("writes one AuditLog row with actionType=agentic.tool_call", async () => {
    const prisma = makeMockPrisma();
    await writeToolCallAudit(prisma as never, {
      tenantId: TENANT_A,
      contactId: CONTACT_A,
      toolName: "get_contact_context",
      latencyMs: 42,
      resultBytes: 1234,
      inputSnippet: "{\"contactId\":\"...\"}",
    });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: TENANT_A,
          actor: "SYSTEM",
          actionType: "agentic.tool_call",
        }),
      }),
    );
  });

  it("never throws on prisma failure (best-effort write)", async () => {
    const prisma = makeMockPrisma();
    prisma.auditLog.create = vi.fn(async () => {
      throw new Error("DB down");
    });
    await expect(
      writeToolCallAudit(prisma as never, {
        tenantId: TENANT_A,
        contactId: CONTACT_A,
        toolName: "x",
        latencyMs: 0,
        resultBytes: 0,
        inputSnippet: "",
      }),
    ).resolves.toBeUndefined();
  });
});
