/**
 * KAN-739 — Sprint 3 / S3.2 — agentic tool surface real handlers.
 *
 * Handler-only swap on the stub surface frozen in KAN-738. The
 * `agentic-decision-runner.ts` tool-dispatch loop is unchanged; this file
 * provides the real implementations that the runner dispatches into.
 *
 * Tenant scope: every handler verifies the requested resource (contactId /
 * pipelineId) belongs to ctx.tenantId BEFORE issuing the read query. On
 * mismatch, returns a neutral forbidden error (NEUTRAL_FORBIDDEN_MESSAGES
 * from @growth/shared) — never the other tenant's data, never leaking that
 * the resource exists in another tenant.
 *
 * Audit logging: every successful tool call writes one AuditLog row via the
 * ToolHandlerContext.recordToolCall callback wired in agentic-decision-runner.ts.
 * Best-effort — never fail a tool dispatch on audit-log persistence failure.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * PII redaction posture (path A — privileged write)
 * ──────────────────────────────────────────────────────────────────────────
 * Audit log payloads are kept privileged: `inputSnippet` (first 500 chars
 * of stringified input) + `contactId` + `toolName` + operational metadata
 * (latency_ms, result_bytes). Tool result payloads themselves are NOT
 * persisted. Reads remain tenant-scoped via existing AuditLog row controls.
 *
 * KAN-748 tracks the future redaction strategy (hash contactId, redact PII
 * patterns in inputSnippet, etc.) — triggered by privacy review, customer
 * DSAR, or cross-tenant audit-tooling becoming a feature. Current scale
 * (V1, agentic activity not yet > 5 tenants) does not warrant the cost.
 *
 * Result size cap: each handler wraps its return in capResult (50KB default).
 * Larger payloads are replaced with a truncation marker — defensive against
 * a single bad query payload exceeding LLM context budget mid-loop.
 */
import type { PrismaClient } from "@prisma/client";
import {
  NEUTRAL_FORBIDDEN_MESSAGES,
  TOOL_RESULT_CAP_BYTES,
  type ToolName,
} from "@growth/shared";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

export function capResult<T>(
  result: T,
  capBytes: number = TOOL_RESULT_CAP_BYTES,
): T | { error: "truncated"; original_size_kb: number } {
  const json = JSON.stringify(result);
  if (json.length > capBytes) {
    return {
      error: "truncated",
      original_size_kb: Math.round(json.length / 1024),
    };
  }
  return result;
}

export function forbidden(kind: keyof typeof NEUTRAL_FORBIDDEN_MESSAGES): {
  error: "forbidden";
  message: string;
} {
  return {
    error: "forbidden",
    message: NEUTRAL_FORBIDDEN_MESSAGES[kind],
  };
}

// ─────────────────────────────────────────────
// Handler context (extends KAN-738 ToolHandlerContext with prisma + an
// audit-write hook). agentic-decision-runner.ts threads prisma in from
// its caller (runShadow / runAgentic).
// ─────────────────────────────────────────────

export interface RealToolHandlerContext {
  prisma: PrismaClient;
  tenantId: string;
  contactId: string;
}

// ─────────────────────────────────────────────
// 1. get_contact_context
// ─────────────────────────────────────────────

interface GetContactContextInput {
  contactId: string;
}

export async function getContactContext(
  input: GetContactContextInput,
  ctx: RealToolHandlerContext,
): Promise<unknown> {
  const contact = await ctx.prisma.contact.findFirst({
    where: { id: input.contactId, tenantId: ctx.tenantId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      lifecycleStage: true,
      segment: true,
      source: true,
      currentPipelineId: true,
      currentStageId: true,
      microObjectiveProgress: true,
      enteredStageAt: true,
      currentPipeline: { select: { id: true, name: true, objectiveType: true } },
      currentStage: { select: { id: true, name: true, order: true, isInitial: true, isTerminal: true } },
    },
  });
  if (!contact) return forbidden("contact");

  const [recentDecisions, recentOutcomes] = await Promise.all([
    ctx.prisma.decision.findMany({
      where: { tenantId: ctx.tenantId, contactId: input.contactId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        strategySelected: true,
        actionType: true,
        confidence: true,
        reasoning: true,
        createdAt: true,
      },
    }),
    ctx.prisma.outcome.findMany({
      where: { tenantId: ctx.tenantId, contactId: input.contactId },
      orderBy: { recordedAt: "desc" },
      take: 5,
      select: {
        id: true,
        result: true,
        reasonCategory: true,
        recordedAt: true,
      },
    }),
  ]);

  return capResult({
    contact: {
      id: contact.id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      lifecycleStage: contact.lifecycleStage,
      segment: contact.segment,
      source: contact.source,
      enteredStageAt: contact.enteredStageAt,
      microObjectiveProgress: contact.microObjectiveProgress,
    },
    pipeline: contact.currentPipeline,
    stage: contact.currentStage,
    recentDecisions,
    recentOutcomes,
  });
}

// ─────────────────────────────────────────────
// 2. retrieve_knowledge — wraps brain-embeddings.similaritySearch
//    via variable-specifier dynamic import (TS6059 hygiene).
// ─────────────────────────────────────────────

interface RetrieveKnowledgeInput {
  query: string;
  pipelineId?: string;
  limit?: number;
}

interface SimilarityHit {
  content: string;
  similarity: number;
  sourceType?: string;
  sourceUrl?: string | null;
}

type SimilaritySearchFn = (
  tenantId: string,
  query: string,
  opts?: { k?: number; pipelineId?: string },
) => Promise<SimilarityHit[]>;

let _similaritySearch: SimilaritySearchFn | null = null;
let _similaritySearchAttempted = false;

async function loadSimilaritySearch(): Promise<SimilaritySearchFn | null> {
  if (_similaritySearchAttempted) return _similaritySearch;
  _similaritySearchAttempted = true;
  try {
    const spec = "./brain-embeddings.js";
    const mod = (await import(spec)) as { similaritySearch?: SimilaritySearchFn };
    if (typeof mod.similaritySearch === "function") {
      _similaritySearch = mod.similaritySearch;
      return _similaritySearch;
    }
  } catch {
    // brain-embeddings module unavailable — handler degrades gracefully.
  }
  return null;
}

/**
 * Test seam — bypass the dynamic loader. Pass null to force "unavailable"
 * (handler returns empty results note); pass a function to inject a mock.
 * Tests that want to re-test the loader path can call
 * `__setSimilaritySearchForTest(null, { resetAttempted: true })`.
 */
export function __setSimilaritySearchForTest(
  fn: SimilaritySearchFn | null,
  opts: { resetAttempted?: boolean } = {},
): void {
  _similaritySearch = fn;
  _similaritySearchAttempted = !opts.resetAttempted ? true : false;
}

export async function retrieveKnowledge(
  input: RetrieveKnowledgeInput,
  ctx: RealToolHandlerContext,
): Promise<unknown> {
  // Optional pipeline filter — verify pipeline belongs to ctx.tenantId before
  // honoring the filter. Foreign pipelineId returns forbidden.
  if (input.pipelineId) {
    const pipeline = await ctx.prisma.pipeline.findFirst({
      where: { id: input.pipelineId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!pipeline) return forbidden("pipeline");
  }

  const search = await loadSimilaritySearch();
  if (!search) {
    return capResult({ results: [], totalCount: 0, note: "knowledge retrieval unavailable" });
  }

  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
  const hits = await search(ctx.tenantId, input.query, {
    k: limit,
    pipelineId: input.pipelineId,
  });

  return capResult({
    results: hits.map((h) => ({
      content: h.content,
      similarity: h.similarity,
      sourceType: h.sourceType ?? null,
      sourceUrl: h.sourceUrl ?? null,
    })),
    totalCount: hits.length,
  });
}

// ─────────────────────────────────────────────
// 3. get_pipeline_state
// ─────────────────────────────────────────────

interface GetPipelineStateInput {
  pipelineId: string;
}

export async function getPipelineState(
  input: GetPipelineStateInput,
  ctx: RealToolHandlerContext,
): Promise<unknown> {
  const pipeline = await ctx.prisma.pipeline.findFirst({
    where: { id: input.pipelineId, tenantId: ctx.tenantId },
    select: {
      id: true,
      name: true,
      description: true,
      objectiveType: true,
      objectiveDescription: true,
      isActive: true,
      stages: {
        orderBy: { order: "asc" },
        select: { id: true, name: true, order: true, isInitial: true, isTerminal: true },
      },
      targets: {
        select: { metric: true, period: true, value: true, currentProgress: true },
      },
      microObjectives: {
        where: { isActive: true },
        select: {
          microObjective: { select: { id: true, name: true, isDefault: true } },
        },
      },
    },
  });
  if (!pipeline) return forbidden("pipeline");

  return capResult({
    id: pipeline.id,
    name: pipeline.name,
    description: pipeline.description,
    objectiveType: pipeline.objectiveType,
    objectiveDescription: pipeline.objectiveDescription,
    isActive: pipeline.isActive,
    stages: pipeline.stages,
    targets: pipeline.targets.map((t) => ({
      metric: t.metric,
      period: t.period,
      value: typeof t.value === "object" && t.value !== null && "toNumber" in t.value
        ? (t.value as { toNumber: () => number }).toNumber()
        : Number(t.value),
      currentProgress: t.currentProgress == null
        ? null
        : typeof t.currentProgress === "object" && "toNumber" in t.currentProgress
        ? (t.currentProgress as { toNumber: () => number }).toNumber()
        : Number(t.currentProgress),
    })),
    microObjectives: pipeline.microObjectives.map((pmo) => pmo.microObjective),
  });
}

// ─────────────────────────────────────────────
// 4. get_recent_actions
// ─────────────────────────────────────────────

interface GetRecentActionsInput {
  contactId: string;
  limit?: number;
}

export async function getRecentActions(
  input: GetRecentActionsInput,
  ctx: RealToolHandlerContext,
): Promise<unknown> {
  const contact = await ctx.prisma.contact.findFirst({
    where: { id: input.contactId, tenantId: ctx.tenantId },
    select: { id: true },
  });
  if (!contact) return forbidden("contact");

  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const actions = await ctx.prisma.action.findMany({
    where: { tenantId: ctx.tenantId, contactId: input.contactId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      agentType: true,
      channel: true,
      status: true,
      sentAt: true,
      deliveredAt: true,
      failedAt: true,
      errorMessage: true,
      createdAt: true,
    },
  });

  return capResult({ actions, totalCount: actions.length });
}

// ─────────────────────────────────────────────
// 5. get_objective_progress
// ─────────────────────────────────────────────

interface GetObjectiveProgressInput {
  contactId: string;
}

export async function getObjectiveProgress(
  input: GetObjectiveProgressInput,
  ctx: RealToolHandlerContext,
): Promise<unknown> {
  const contact = await ctx.prisma.contact.findFirst({
    where: { id: input.contactId, tenantId: ctx.tenantId },
    select: { id: true, microObjectiveProgress: true, currentPipelineId: true },
  });
  if (!contact) return forbidden("contact");

  // Pipeline-attached MO names for context — read all MOs the current
  // pipeline activates, join with progress JSON on the contact.
  const pipelineMOs = contact.currentPipelineId
    ? await ctx.prisma.pipelineMicroObjective.findMany({
        where: { pipelineId: contact.currentPipelineId, isActive: true },
        select: { microObjective: { select: { id: true, name: true, isDefault: true } } },
      })
    : [];

  const progress = (contact.microObjectiveProgress ?? {}) as Record<
    string,
    { completed?: boolean; completedAt?: string }
  >;

  return capResult({
    progress: pipelineMOs.map((pmo) => ({
      microObjectiveId: pmo.microObjective.id,
      name: pmo.microObjective.name,
      isDefault: pmo.microObjective.isDefault,
      isCompleted: progress[pmo.microObjective.id]?.completed === true,
      completedAt: progress[pmo.microObjective.id]?.completedAt ?? null,
    })),
  });
}

// ─────────────────────────────────────────────
// Real handler registry (keyed by ToolName)
// ─────────────────────────────────────────────

export const REAL_HANDLERS: Record<
  ToolName,
  (input: unknown, ctx: RealToolHandlerContext) => Promise<unknown>
> = {
  get_contact_context: (input, ctx) =>
    getContactContext(input as GetContactContextInput, ctx),
  retrieve_knowledge: (input, ctx) =>
    retrieveKnowledge(input as RetrieveKnowledgeInput, ctx),
  get_pipeline_state: (input, ctx) =>
    getPipelineState(input as GetPipelineStateInput, ctx),
  get_recent_actions: (input, ctx) =>
    getRecentActions(input as GetRecentActionsInput, ctx),
  get_objective_progress: (input, ctx) =>
    getObjectiveProgress(input as GetObjectiveProgressInput, ctx),
};

/**
 * Best-effort audit log row for a single tool call. Never fails the dispatch.
 * Read by KAN-745 (cost-doubling observability) for per-tenant aggregation.
 */
export async function writeToolCallAudit(
  prisma: PrismaClient,
  row: {
    tenantId: string;
    contactId: string;
    toolName: string;
    latencyMs: number;
    resultBytes: number;
    inputSnippet: string;
  },
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: row.tenantId,
        actor: "SYSTEM",
        actionType: "agentic.tool_call",
        reasoning: `tool=${row.toolName} latency_ms=${row.latencyMs} result_bytes=${row.resultBytes}`,
        payload: {
          contactId: row.contactId,
          toolName: row.toolName,
          latencyMs: row.latencyMs,
          resultBytes: row.resultBytes,
          inputSnippet: row.inputSnippet,
        } as unknown as object,
      },
    });
  } catch (err) {
    console.error("[agentic-tools] writeToolCallAudit failed (best-effort):", err);
  }
}
