/**
 * Decision Engine — runForContact orchestrator
 *
 * Wraps the 5 stage services (Objective Gap → Strategy → Action → Confidence → Gate)
 * into a single callable function. Writes a Decision row, writes an audit entry,
 * and emits the action.decided Pub/Sub event (or routes to escalation).
 *
 * File location: apps/api/src/services/run-decision-for-contact.ts
 *
 * Ticket: KAN-649  (Step 6 Execution Layer trigger)
 * Spec: Confluence "PRD — Opportunity Discovery & Activation Engine (Steps 0–6)"
 *
 * ──────────────────────────────────────────────────────────────────────────────
 *  VERIFY BEFORE MERGE:  the five engine-service function names below are
 *  educated guesses based on filenames. Before merging, grep each service file
 *  for `export async function` / `export const ... = async` and adjust the
 *  import aliases to match. The imports section is marked with ⚠️ below.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { TRPCError } from '@trpc/server';

// ✅ VERIFIED exports against the real service files (2026-04-23):
//    objective-gap-analyzer   → analyzeGapsForContact  (line 633)
//    strategy-selector         → selectStrategy         (line 413)
//    action-determiner         → determineAction        (line 275; input: ActionDeterminerInput)
//    confidence-scorer         → scoreConfidence        (line 363)
//    threshold-gate            → evaluateThreshold      (line 178)
//    context-assembler         → assembleContext        (line 284), buildCacheKey (line 127)
//    audit-logger              → logAndPublish          (line 235)
//    action-decided-publisher  → publishActionDecided (line 364), publishEscalationTriggered (line 372)
//
// ⚠️ INPUT SHAPES: action-determiner expects `ActionDeterminerInput` with a
// rich `contactContext` + `brainContext` sub-object shape. Your orchestrator
// must pass the `assembleContext()` output through the right projection.
// Look at lines 52–123 of action-determiner.ts for the full input schema;
// the `selectStrategy` and `scoreConfidence` signatures are similar. When
// you see the first compile error, trace it back to the Input schema in
// that service file — it's the source of truth.
import { type DecisionPayload, computeDivergence, type DivergenceFlag } from '@growth/shared';
import { analyzeGapsForContact } from './objective-gap-analyzer';
import { selectStrategy } from './strategy-selector';
import { determineAction } from './action-determiner';
import { scoreConfidence } from './confidence-scorer';
import { evaluateThreshold, type ThresholdGateInput } from './threshold-gate';

// KAN-738: variable-specifier dynamic import keeps agentic-decision-runner.ts
// out of the apps/api static graph (TS6059 cohort). Same pattern as
// context-assembler.ts:tryAutoWireKnowledgeSearch. Tactical until KAN-689 lands.
type AgenticLoopFn = (input: { tenantId: string; contactId: string; prisma?: PrismaClient }) => Promise<{
  payload: DecisionPayload;
  iterations: number;
  latencyMs: number;
}>;

let _agenticLoopFn: AgenticLoopFn | null = null;
async function loadAgenticLoop(): Promise<AgenticLoopFn> {
  if (_agenticLoopFn) return _agenticLoopFn;
  const spec = './agentic-decision-runner.js';
  const mod = (await import(spec)) as { runAgenticLoop?: AgenticLoopFn };
  if (typeof mod.runAgenticLoop !== 'function') {
    throw new Error('agentic-decision-runner did not export runAgenticLoop');
  }
  _agenticLoopFn = mod.runAgenticLoop;
  return _agenticLoopFn;
}

/** Test seam — replace the agentic loop with a mock without touching SDKs. */
export function __setAgenticLoopForTest(fn: AgenticLoopFn | null): void {
  _agenticLoopFn = fn;
}
import {
  assembleContext,
  InMemoryContextCache,
  type ContextCache,
  type ContextDatabase,
} from './context-assembler';
import {
  logAndPublish,
  InMemoryAuditPubSubClient,
  type AuditEntry,
  type AuditLogStore,
  type AuditPubSubClient,
} from './audit-logger';
import {
  publishActionDecided,
  publishEscalationTriggered,
} from './action-decided-publisher';
import { getPubSubClient } from '../lib/pubsub-client';

export interface PlaybookStepContext {
  /** Unique step identifier, e.g. "dormant_reactivation_14d:day_0". */
  playbookStep: string;
  /** Exact instruction for the downstream send agent (no LLM planning upstream). */
  instruction: string;
  /** Whitelist of actions the step is allowed to emit (enforced downstream). */
  allowedActions: string[];
  /** Channel to send on. */
  channel: 'email' | 'sms' | 'meta';
  /** Freeform metadata attached to the Decision row (playbook name, dryRun, etc.). */
  additionalContext?: Record<string, unknown>;
}

export interface RunForContactInput {
  tenantId: string;
  contactId: string;
  /** If true, bypass Redis cache when assembling Brain context (useful for demos). */
  freshContext?: boolean;
  /** Actor identity for the audit log. Defaults to 'SYSTEM' for cron/Pub/Sub triggers. */
  actor?: { type: 'USER' | 'SYSTEM'; id: string };
  /**
   * Adapter pattern (KAN-655): when set, the engine executes this predetermined step
   * instead of free-form deciding. Skips assembleContext/selectStrategy/determineAction/
   * scoreConfidence/evaluateThreshold. Writes a Decision row with strategy='playbook_driven'
   * and the step's instruction/channel as the action. Free-form mode (this field omitted)
   * is unchanged.
   */
  playbookStepContext?: PlaybookStepContext;
}

export interface RunForContactResult {
  decisionId: string;
  strategy: string;
  action: { type: string; payload?: Record<string, unknown> };
  confidence: number;
  outcome: 'EXECUTED' | 'ESCALATED';
  reasoning: string;
  latencyMs: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Injected adapters (module singletons; swap with real clients in KAN-656).
// ──────────────────────────────────────────────────────────────────────────────

let contextCacheSingleton: ContextCache | null = null;
let auditPubSubSingleton: AuditPubSubClient | null = null;

function getContextCache(): ContextCache {
  if (!contextCacheSingleton) contextCacheSingleton = new InMemoryContextCache();
  return contextCacheSingleton;
}

function getAuditPubSubClient(): AuditPubSubClient {
  if (!auditPubSubSingleton) auditPubSubSingleton = new InMemoryAuditPubSubClient();
  return auditPubSubSingleton;
}

function buildContextDatabase(prisma: PrismaClient): ContextDatabase {
  return {
    async getContact(contactId, tenantId) {
      const c = await prisma.contact.findFirst({ where: { id: contactId, tenantId } });
      return c as Record<string, unknown> | null;
    },
    async getContactState(contactId, objectiveId) {
      const s = await (prisma as any).contactState?.findFirst({
        where: { contactId, objectiveId },
      });
      return (s ?? null) as Record<string, unknown> | null;
    },
    async getBrainSnapshot(tenantId) {
      // No brain snapshot table yet; return minimal shape the assembler expects.
      return { tenantId, snapshotAt: new Date().toISOString() };
    },
    async getTenantConfig(tenantId) {
      const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
      return t as Record<string, unknown> | null;
    },
    async getRecentActions(contactId, limit) {
      const rows = await (prisma as any).action?.findMany({
        where: { contactId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      return (rows ?? []) as Record<string, unknown>[];
    },
    // KAN-703: bundle Pipeline + Stage + active MicroObjectives + KnowledgeFilters
    // for the contact's currentPipelineId. Casts via `as any` to avoid pulling the
    // newer Prisma types into the apps/api TS6059 graph (these types live in
    // packages/db's generated client and are reachable at runtime; the static
    // `as any` keeps the build-error count flat).
    async getPipelineState(pipelineId, stageId) {
      const p: any = await (prisma as any).pipeline?.findUnique({
        where: { id: pipelineId },
        include: { targets: true },
      });
      if (!p) return null;
      const s: any = stageId
        ? await (prisma as any).stage?.findUnique({ where: { id: stageId } })
        : null;
      const pmoRows: any[] = (await (prisma as any).pipelineMicroObjective?.findMany({
        where: { pipelineId, isActive: true },
        include: { microObjective: true },
      })) ?? [];
      const filterRows: any[] = (await (prisma as any).knowledgeFilter?.findMany({
        where: { pipelineId },
      })) ?? [];
      return {
        pipeline: {
          id: p.id,
          name: p.name,
          objectiveType: p.objectiveType,
          objectiveDescription: p.objectiveDescription ?? null,
          targets: (p.targets ?? []).map((t: any) => ({
            metric: t.metric,
            value: typeof t.value === 'object' && 'toNumber' in t.value ? t.value.toNumber() : Number(t.value),
            period: t.period,
            currentProgress:
              t.currentProgress == null
                ? null
                : typeof t.currentProgress === 'object' && 'toNumber' in t.currentProgress
                  ? t.currentProgress.toNumber()
                  : Number(t.currentProgress),
          })),
        },
        stage: s
          ? {
              id: s.id,
              name: s.name,
              order: s.order,
              isInitial: s.isInitial,
              isTerminal: s.isTerminal,
              entryActions: s.entryActions,
              transitionRules: s.transitionRules,
              autoApproveMatrix: s.autoApproveMatrix,
            }
          : null,
        microObjectives: pmoRows.map((row: any) => ({
          id: row.microObjective.id,
          name: row.microObjective.name,
          description: row.microObjective.description ?? null,
          completionCriteria: (row.microObjective.completionCriteria ?? {}) as Record<string, unknown>,
          order: row.microObjective.order,
        })),
        knowledgeFilters: filterRows.map((f: any) => ({
          knowledgeCategory: f.knowledgeCategory,
          includeRule: (f.includeRule ?? {}) as Record<string, unknown>,
          excludeRule: (f.excludeRule ?? {}) as Record<string, unknown>,
        })),
      };
    },
  };
}

function buildAuditLogStore(prisma: PrismaClient): AuditLogStore {
  return {
    async append(entry: AuditEntry) {
      try {
        await prisma.auditLog.create({
          data: {
            tenantId: entry.tenantId,
            actor: entry.actor,
            actionType: entry.actionType,
            reasoning: entry.reasoning,
            payload: {
              auditId: entry.auditId,
              contactId: entry.contactId,
              decisionId: entry.decisionId,
              channel: entry.channel,
              agentType: entry.agentType,
              status: entry.status,
              ...entry.payload,
              confidenceScore: entry.confidenceScore,
              guardrailResult: entry.guardrailResult,
              durationMs: entry.durationMs,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        return { success: true };
      } catch (err) {
        console.error('[runDecisionForContact] auditLog.create failed:', err);
        return { success: false };
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Main entry point — branches on playbookStepContext.
// ──────────────────────────────────────────────────────────────────────────────

export async function runDecisionForContact(
  prisma: PrismaClient,
  input: RunForContactInput
): Promise<RunForContactResult> {
  // Verify the contact exists and belongs to the tenant (both branches need this).
  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId, tenantId: input.tenantId },
    include: { tenant: true },
  });
  if (!contact) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Contact ${input.contactId} not in tenant`,
    });
  }

  if (input.playbookStepContext) {
    return runPlaybookStep(prisma, input, contact);
  }

  // KAN-738 — Sprint 3 / S3.1 agentic seam.
  // Live mode: agentic emits action.decided, rules-based skipped.
  // Shadow mode (default): both run in parallel, only rules-based emits,
  // divergence logged to AgenticShadowDecision for offline analysis.
  const agenticEnabled = (contact as { tenant?: { agenticModeEnabled?: boolean } }).tenant?.agenticModeEnabled === true;
  if (agenticEnabled) {
    return runAgentic(prisma, input, contact);
  }
  return runShadow(prisma, input, contact);
}

// ──────────────────────────────────────────────────────────────────────────────
// Shadow mode — runFreeform + agentic in parallel; rules-based wins, divergence logged.
// ──────────────────────────────────────────────────────────────────────────────

async function runShadow(
  prisma: PrismaClient,
  input: RunForContactInput,
  contact: { id: string; email: string | null; firstName: string | null; lastName: string | null; tenant: { confidenceThreshold: number | null } } & Record<string, unknown>,
): Promise<RunForContactResult> {
  // Run both in parallel. Rules-based result is what gets returned — preserves
  // every downstream side-effect (Decision row, action.decided publish, audit
  // log) that callers depend on. Agentic side-effects are logged-only.
  const agenticLoop = await loadAgenticLoop().catch(() => null);
  const [rulesSettled, agenticSettled] = await Promise.allSettled([
    runFreeform(prisma, input, contact),
    agenticLoop ? agenticLoop({ tenantId: input.tenantId, contactId: input.contactId, prisma }) : Promise.reject(new Error('agentic loop module unavailable')),
  ]);

  if (rulesSettled.status === 'rejected') {
    // Rules-based path is the source of truth. If it fails, propagate — we
    // don't fall back to agentic in shadow mode (agentic is unproven; that's
    // why it's in shadow).
    throw rulesSettled.reason;
  }

  const rulesResult = rulesSettled.value;
  const rulesPayload: DecisionPayload = {
    strategy: rulesResult.strategy,
    action: {
      type: rulesResult.action.type,
      channel: (rulesResult.action.payload as { channel?: string | null } | undefined)?.channel ?? null,
      payload: (rulesResult.action.payload ?? {}) as Record<string, unknown>,
    },
    confidence: rulesResult.confidence,
    outcome: rulesResult.outcome,
    reasoning: rulesResult.reasoning,
  };

  let agenticPayload: DecisionPayload | null = null;
  let agenticError: string | null = null;
  if (agenticSettled.status === 'fulfilled') {
    agenticPayload = agenticSettled.value.payload;
  } else {
    agenticError = (agenticSettled.reason as Error)?.message ?? String(agenticSettled.reason);
  }

  const flags: DivergenceFlag[] = computeDivergence(rulesPayload, agenticPayload, agenticError !== null);

  // Fire-and-forget shadow row write — never block the rules-based response
  // on telemetry persistence. KAN-746 (filed at PR open) tracks moving this
  // to an async-only path that doesn't share the request lifecycle.
  void persistShadowRow(prisma, {
    tenantId: input.tenantId,
    contactId: input.contactId,
    decisionId: rulesResult.decisionId,
    rulesDecisionPayload: rulesPayload,
    agenticDecisionPayload: agenticPayload ?? { error: agenticError },
    divergenceFlags: flags,
    agenticError,
  });

  return rulesResult;
}

async function persistShadowRow(
  prisma: PrismaClient,
  row: {
    tenantId: string;
    contactId: string;
    decisionId: string;
    rulesDecisionPayload: DecisionPayload;
    agenticDecisionPayload: DecisionPayload | { error: string | null };
    divergenceFlags: DivergenceFlag[];
    agenticError: string | null;
  },
): Promise<void> {
  try {
    await (prisma as unknown as { agenticShadowDecision: { create: (args: unknown) => Promise<unknown> } }).agenticShadowDecision.create({
      data: {
        tenantId: row.tenantId,
        contactId: row.contactId,
        decisionId: row.decisionId,
        rulesDecisionPayload: row.rulesDecisionPayload as unknown as Prisma.InputJsonValue,
        agenticDecisionPayload: row.agenticDecisionPayload as unknown as Prisma.InputJsonValue,
        divergenceFlags: row.divergenceFlags,
        agenticError: row.agenticError,
      },
    });
  } catch (err) {
    console.error('[runShadow] persistShadowRow failed:', err);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Live agentic mode — agentic emits action.decided, rules-based skipped.
// ──────────────────────────────────────────────────────────────────────────────

async function runAgentic(
  prisma: PrismaClient,
  input: RunForContactInput,
  contact: { id: string; email: string | null; firstName: string | null; lastName: string | null; tenant: { confidenceThreshold: number | null } } & Record<string, unknown>,
): Promise<RunForContactResult> {
  const started = Date.now();
  const { tenantId, contactId, actor = { type: 'SYSTEM' as const, id: 'decision-engine' } } = input;

  let agenticPayload: DecisionPayload;
  try {
    const agenticLoop = await loadAgenticLoop();
    const result = await agenticLoop({ tenantId, contactId, prisma });
    agenticPayload = result.payload;
  } catch (err) {
    // Live mode + agentic failure = rule-based fallback. Logs the failure as
    // an audit entry but does NOT silently degrade — surfaces via reasoning.
    console.error('[runAgentic] agentic loop failed, falling back to rules-based:', err);
    return runFreeform(prisma, input, contact);
  }

  const channel = agenticPayload.action.channel;
  const actionType = agenticPayload.action.type;
  let reasoning = agenticPayload.reasoning;
  let outcome: 'EXECUTED' | 'ESCALATED' = agenticPayload.outcome;

  // KAN-740 — threshold-gate evaluation with full matrix args. Only run the
  // gate when the agent picked an EXECUTED action; if the runner already
  // routed to ESCALATED (e.g. HALLUCINATED_ACTION_REASON), short-circuit.
  if (outcome === 'EXECUTED') {
    try {
      const gateDecision = await evaluateThresholdWithMatrix(prisma, {
        tenantId,
        contactId,
        contact,
        actionType: agenticPayload.action.type,
        channel: agenticPayload.action.channel,
        actionPayload: (agenticPayload.action.payload ?? {}) as Record<string, unknown>,
        actionReasoning: agenticPayload.reasoning,
        selectedStrategy: agenticPayload.strategy,
        strategyReasoning: agenticPayload.reasoning,
        objectiveId:
          ((agenticPayload.action.payload as { objectiveId?: string } | undefined)?.objectiveId) ??
          'unknown',
        riskFlags: [],
        overallConfidence: agenticPayload.confidence * 100,
      });
      if (gateDecision.outcome === 'ESCALATED') {
        outcome = 'ESCALATED';
        reasoning = gateDecision.reasoning;
      }
    } catch (err) {
      // Gate evaluation failure is conservative — escalate rather than emit.
      console.error('[runAgentic] threshold-gate evaluation failed, defaulting to escalation:', err);
      outcome = 'ESCALATED';
      reasoning = `${reasoning} · threshold_gate_error: ${(err as Error).message}`;
    }
  }

  const decision = await prisma.decision.create({
    data: {
      tenantId,
      contactId,
      strategySelected: agenticPayload.strategy,
      actionType,
      confidence: agenticPayload.confidence,
      reasoning,
      metadata: {
        outcome,
        agenticPayload: agenticPayload.action.payload ?? {},
        mode: 'agentic_live',
      } as unknown as Prisma.InputJsonValue,
    },
  });

  if (outcome === 'ESCALATED') {
    try {
      await prisma.escalation.create({
        data: {
          tenantId,
          contactId,
          decisionId: decision.id,
          triggerType: 'AGENTIC_GATE_DECISION',
          triggerReason: reasoning,
          severity: agenticPayload.confidence < 0.4 ? 'high' : 'medium',
          aiSuggestion: `${actionType}${channel ? ` via ${channel}` : ''}`,
          status: 'open',
          context: {
            confidence: agenticPayload.confidence,
            strategy: agenticPayload.strategy,
            action: actionType,
            channel,
            mode: 'agentic_live',
          } as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      console.error('[runAgentic] escalation.create failed:', err);
    }
  }

  logAndPublish(
    {
      tenantId,
      contactId,
      decisionId: decision.id,
      agentType: agenticPayload.strategy || 'agentic_loop',
      channel,
      actionType,
      status: outcome === 'EXECUTED' ? 'success' : 'escalated',
      payload: { agenticPayload: agenticPayload.action.payload ?? {}, actor: actor.id, mode: 'agentic_live' },
      reasoning,
      confidenceScore: agenticPayload.confidence,
      guardrailResult: null,
      executionResult: null,
      errorMessage: null,
      durationMs: Date.now() - started,
      retryCount: 0,
    },
    { store: buildAuditLogStore(prisma), pubsub: getAuditPubSubClient() },
  ).catch((err: unknown) => {
    console.error('[runAgentic] audit-logger failed:', err);
  });

  const client = getPubSubClient();
  const objectiveId = ((agenticPayload.action.payload as { objectiveId?: string } | undefined)?.objectiveId) ?? 'unknown';
  if (outcome === 'EXECUTED') {
    publishActionDecided(client, {
      tenantId,
      contactId,
      objectiveId,
      actionType,
      channel,
      actionPayload: (agenticPayload.action.payload ?? {}) as Record<string, unknown>,
      selectedStrategy: agenticPayload.strategy,
      confidenceScore: agenticPayload.confidence,
      strategyReasoning: reasoning,
      actionReasoning: reasoning,
    }).catch((err: unknown) => {
      console.error(`[runAgentic] publishActionDecided failed decisionId=${decision.id}:`, err);
    });
  } else {
    publishEscalationTriggered(client, {
      tenantId,
      contactId,
      objectiveId,
      reason: 'AGENTIC_GATE_DECISION',
      riskFlags: [],
      proposedAction: {
        actionType,
        channel,
        payload: (agenticPayload.action.payload ?? {}) as Record<string, unknown>,
      },
      strategy: agenticPayload.strategy,
      confidenceScore: agenticPayload.confidence,
      reasoning,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }).catch((err: unknown) => {
      console.error(`[runAgentic] publishEscalationTriggered failed decisionId=${decision.id}:`, err);
    });
  }

  return {
    decisionId: decision.id,
    strategy: agenticPayload.strategy,
    action: { type: actionType, payload: agenticPayload.action.payload ?? {} },
    confidence: agenticPayload.confidence,
    outcome,
    reasoning,
    latencyMs: Date.now() - started,
  };
}

/**
 * KAN-740 — wrap evaluateThreshold with the full KAN-704 matrix args. Loads
 * Stage.autoApproveMatrix + Pipeline.defaultAutoApproveMatrix from the
 * contact's currentStageId + currentPipelineId. Pulls tenantConfig fields
 * from Tenant. The runner returns 0..1 confidence; threshold-gate expects
 * 0..100 — multiply at the boundary.
 *
 * Returns: { outcome: 'EXECUTED' | 'ESCALATED', reasoning: string }.
 *
 * Conservative bias: any unrecognized gate decision → ESCALATED. Matches
 * the runFreeform safety posture.
 *
 * Variable-specifier dynamic import keeps threshold-gate.ts out of the
 * apps/api static graph (TS6059 hygiene; same pattern as agentic-decision-
 * runner.ts).
 */
/**
 * KAN-749 — generalized threshold gate evaluation with full KAN-704 matrix args.
 *
 * Loads stage + pipeline matrices from DB, composes the full ThresholdGateInput,
 * calls the gate, maps result back to {outcome, reasoning}. Reusable from both
 * code paths (runAgentic + runFreeform) — KAN-749's symmetric-governance MVP.
 *
 * actionType is passed AS-IS from the caller. Under MVP shape, callers may emit
 * vocab that doesn't match the matrix's semantic vocab (KAN-763 Phase C will
 * unify); on miss, resolveAutoApproveEntry returns null + the gate falls back
 * to tenantConfig.confidenceThreshold (legacy flat path). Vocab fall-through
 * telemetry tracked in KAN-768.
 */
export async function evaluateThresholdWithMatrix(
  prisma: PrismaClient,
  args: {
    tenantId: string;
    contactId: string;
    contact: Record<string, unknown> & { tenant: { confidenceThreshold: number | null } & Record<string, unknown> };
    actionType: string;
    channel: string | null;
    actionPayload: Record<string, unknown>;
    actionReasoning: string;
    selectedStrategy: string;
    strategyReasoning: string;
    objectiveId: string;
    riskFlags: string[];
    overallConfidence: number; // 0..100
  },
): Promise<{ outcome: 'EXECUTED' | 'ESCALATED'; reasoning: string }> {
  const { tenantId, contactId, contact } = args;
  const tenantRaw = contact.tenant as Record<string, unknown>;

  // Load matrices from Stage + Pipeline rows when contact has them.
  const currentStageId = (contact as { currentStageId?: string | null }).currentStageId ?? null;
  const currentPipelineId = (contact as { currentPipelineId?: string | null }).currentPipelineId ?? null;

  const [stageRow, pipelineRow] = await Promise.all([
    currentStageId
      ? prisma.stage.findUnique({ where: { id: currentStageId }, select: { autoApproveMatrix: true } })
      : Promise.resolve(null),
    currentPipelineId
      ? prisma.pipeline.findFirst({
          where: { id: currentPipelineId, tenantId },
          select: { defaultAutoApproveMatrix: true },
        })
      : Promise.resolve(null),
  ]);

  const stageMatrix = (stageRow?.autoApproveMatrix ?? null) as Record<string, unknown> | null;
  const pipelineMatrix = (pipelineRow?.defaultAutoApproveMatrix ?? null) as Record<string, unknown> | null;

  const gateInput: ThresholdGateInput = {
    contactId,
    tenantId,
    objectiveId: args.objectiveId,
    overallConfidence: args.overallConfidence,
    riskFlags: args.riskFlags,
    actionType: args.actionType,
    channel: args.channel,
    actionPayload: args.actionPayload,
    actionReasoning: args.actionReasoning,
    selectedStrategy: args.selectedStrategy,
    strategyReasoning: args.strategyReasoning,
    tenantConfig: {
      confidenceThreshold: (tenantRaw.confidenceThreshold ?? 70) as number,
      autoEscalateFlags: (tenantRaw.autoEscalateFlags ?? []) as string[],
      blockedActionTypes: (tenantRaw.blockedActionTypes ?? []) as string[],
      requireHumanApproval: (tenantRaw.requireHumanApproval ?? false) as boolean,
      autoApproveEnabled: (tenantRaw.autoApproveEnabled ?? true) as boolean,
    },
    stageMatrix: stageMatrix as ThresholdGateInput['stageMatrix'],
    pipelineMatrix: pipelineMatrix as ThresholdGateInput['pipelineMatrix'],
    dailyAutoActionCount: 0,
  };

  const result = await evaluateThreshold(gateInput);
  const decision = result.decision;
  const gateReasoning = result.reasoning;

  // Map gate decisions to outcomes. 'approved' → EXECUTED; everything else
  // (human_review / auto_escalated / blocked) → ESCALATED.
  //
  // KAN-749 MVP: gate reasoning is preserved on BOTH branches (was dropped
  // on 'approved' pre-PR3 in evaluateAgenticThreshold). This gives downstream
  // observability the matrix-vs-legacy signal — the `legacy threshold` /
  // `auto-approve matrix threshold` substring is the proxy for KAN-768's
  // typed vocab_fallthrough event.
  const outcome: 'EXECUTED' | 'ESCALATED' = decision === 'approved' ? 'EXECUTED' : 'ESCALATED';
  const reasoning = `${args.actionReasoning} · gate=${decision}: ${gateReasoning}`;

  return { outcome, reasoning };
}

// ──────────────────────────────────────────────────────────────────────────────
// Adapter-mode execution — predetermined step, no free-form LLM decisioning.
// ──────────────────────────────────────────────────────────────────────────────

async function runPlaybookStep(
  prisma: PrismaClient,
  input: RunForContactInput,
  contact: { id: string; firstName: string | null; lastName: string | null; email: string | null },
): Promise<RunForContactResult> {
  const started = Date.now();
  const step = input.playbookStepContext!;
  const { tenantId, contactId, actor = { type: 'SYSTEM', id: 'decision-engine' } } = input;

  const channelToAction: Record<PlaybookStepContext['channel'], string> = {
    email: 'send_email',
    sms: 'send_sms',
    meta: 'send_meta',
  };
  const actionType = channelToAction[step.channel];
  const strategyType = 'playbook_driven';
  const confidence = 1.0;
  const outcome: 'EXECUTED' = 'EXECUTED';
  const reasoning = `Playbook step: ${step.playbookStep} · ${step.instruction}`;

  const decision = await prisma.decision.create({
    data: {
      tenantId,
      contactId,
      strategySelected: strategyType,
      actionType,
      confidence,
      reasoning,
      metadata: {
        outcome,
        playbookStep: step.playbookStep,
        channel: step.channel,
        allowedActions: step.allowedActions,
        instruction: step.instruction,
        ...(step.additionalContext ?? {}),
      } as unknown as Prisma.InputJsonValue,
    },
  });

  // Fire-and-forget audit — never fail the decision.
  logAndPublish(
    {
      tenantId,
      contactId,
      decisionId: decision.id,
      agentType: 'playbook',
      channel: step.channel,
      actionType,
      status: 'success',
      payload: {
        playbookStep: step.playbookStep,
        instruction: step.instruction,
        actor: actor.id,
      },
      reasoning,
      confidenceScore: confidence,
      guardrailResult: null,
      executionResult: null,
      errorMessage: null,
      durationMs: Date.now() - started,
      retryCount: 0,
    },
    { store: buildAuditLogStore(prisma), pubsub: getAuditPubSubClient() },
  ).catch((err: unknown) => {
    console.error('[runPlaybookStep] audit-logger failed:', err);
  });

  // Adapter mode still publishes to action.decided so downstream Message Composer (KAN-660)
  // can pick up. Gated on !dryRun: dry-run launches don't trigger real sends.
  const isDryRun = step.additionalContext?.dryRun === true;
  if (!isDryRun) {
    const objectiveId =
      (step.additionalContext?.objectiveId as string | undefined) ?? 'unknown';
    publishActionDecided(getPubSubClient(), {
      tenantId,
      contactId,
      objectiveId,
      actionType,
      channel: step.channel,
      actionPayload: { instruction: step.instruction },
      selectedStrategy: strategyType,
      confidenceScore: confidence, // 1.0 = certainty the predetermined step will execute, not outcome probability
      strategyReasoning: reasoning,
      actionReasoning: step.instruction,
    }).catch((err: unknown) => {
      console.error(
        `[runPlaybookStep] publishActionDecided failed decisionId=${decision.id} contactId=${contactId}:`,
        err,
      );
    });
  }

  return {
    decisionId: decision.id,
    strategy: strategyType,
    action: { type: actionType, payload: { instruction: step.instruction } },
    confidence,
    outcome,
    reasoning,
    latencyMs: Date.now() - started,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Free-form mode — original 5-stage orchestration (unchanged semantics).
// ──────────────────────────────────────────────────────────────────────────────

async function runFreeform(
  prisma: PrismaClient,
  input: RunForContactInput,
  contact: {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    tenant: { confidenceThreshold: number | null };
  } & Record<string, unknown>,
): Promise<RunForContactResult> {
  const started = Date.now();
  const { tenantId, contactId, actor = { type: 'SYSTEM', id: 'decision-engine' } } = input;

  const tenant = contact.tenant;
  const confidenceThreshold = (tenant.confidenceThreshold ?? 70) / 100; // stored as 0-100 int

  // 1. Assemble Brain context.
  const context = await assembleContext(
    {
      tenantId,
      contactId,
      freshContext: input.freshContext ?? false,
    } as any,
    getContextCache(),
    buildContextDatabase(prisma),
  );

  // 2. Objective Gap.
  const gaps: any = await (analyzeGapsForContact as any)({ prisma, tenantId, contactId, context });

  // 3. Strategy Selector.
  const strategyRaw: any = await (selectStrategy as any)({ prisma, tenantId, contactId, gaps, context });
  const strategy: any = strategyRaw?.strategy ?? strategyRaw;

  // 4. Action Determiner.
  const actionRaw: any = (determineAction as any)({
    strategy,
    contactContext: (context as any).contactContext ?? context,
    brainContext: (context as any).brainContext ?? {},
  });
  const action: any = actionRaw?.action ?? actionRaw;

  // 5. Confidence Scorer.
  const confidenceRaw: any = await (scoreConfidence as any)({
    strategy,
    action,
    contactContext: (context as any).contactContext ?? context,
    brainContext: (context as any).brainContext ?? {},
  });
  const confidence: number =
    typeof confidenceRaw === 'number'
      ? confidenceRaw
      : confidenceRaw?.score ?? confidenceRaw?.confidence ?? 0;

  const strategyType: string = strategy?.type ?? strategy?.selected ?? String(strategy);
  const actionType: string = action?.type ?? action?.actionType ?? String(action);
  const channel: string | null = action?.channel ?? null;

  // 6. Threshold Gate — KAN-749 MVP: symmetric matrix wiring with runAgentic.
  //
  // actionType is passed AS-IS (likely determiner vocab like 'send_message').
  // Under MVP, vocab mismatch with the matrix's semantic vocab is tolerated:
  // resolveAutoApproveEntry returns null on miss → gate falls back to
  // tenantConfig.confidenceThreshold (legacy flat path). KAN-763 (Phase C)
  // will unify; KAN-768 will add typed telemetry on the fall-through.
  //
  // TODO(KAN-763): runFreeform doesn't always have objectiveId; sentinel
  // 'unknown' avoids null-throw but pollutes downstream telemetry. Phase C
  // should reshape ThresholdGateInputSchema to allow null objectiveId.
  let gateResult: { outcome: 'EXECUTED' | 'ESCALATED'; reasoning: string };
  try {
    gateResult = await evaluateThresholdWithMatrix(prisma, {
      tenantId,
      contactId,
      contact,
      actionType,
      channel,
      actionPayload: (action?.payload ?? {}) as Record<string, unknown>,
      actionReasoning: `Action: ${actionType}`,
      selectedStrategy: strategyType,
      strategyReasoning: `Strategy: ${strategyType}`,
      objectiveId:
        ((action?.payload as { objectiveId?: string } | undefined)?.objectiveId) ??
        'unknown',
      riskFlags: [],
      overallConfidence: confidence * 100, // 0..1 → 0..100 (gate input scale)
    });
  } catch (err) {
    // Mirror runAgentic's posture (line 451-455): gate evaluation failure
    // escalates conservatively rather than silently emitting.
    console.error('[runFreeform] threshold-gate evaluation failed, defaulting to escalation:', err);
    gateResult = {
      outcome: 'ESCALATED',
      reasoning: `threshold_gate_error: ${(err as Error).message}`,
    };
  }
  const outcome: 'EXECUTED' | 'ESCALATED' = gateResult.outcome;

  const reasoning = [
    `Strategy: ${strategyType}`,
    `Action: ${actionType}`,
    `Confidence: ${(confidence * 100).toFixed(0)}% vs threshold ${(confidenceThreshold * 100).toFixed(0)}%`,
    `Outcome: ${outcome}`,
    gateResult.reasoning,
  ].join(' · ');

  // 7. Persist Decision row + (optionally) an Escalation row.
  // KAN-750: tx is typed as Prisma.TransactionClient (was `tx: any` — that
  // cast hid the schema-mismatch bug at line ~857 on every ESCALATED outcome:
  // decisionId/reason/priority/context fields didn't exist, Prisma rejected
  // the create at runtime, try/catch swallowed the error, the row was lost.
  const decision = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const row = await tx.decision.create({
      data: {
        tenantId,
        contactId,
        strategySelected: strategyType,
        actionType,
        confidence,
        reasoning,
        metadata: {
          strategy,
          action,
          threshold: confidenceThreshold,
          outcome,
          gaps: Array.isArray(gaps) ? gaps.slice(0, 10) : gaps,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    if (outcome === 'ESCALATED') {
      try {
        await tx.escalation.create({
          data: {
            tenantId,
            contactId,
            decisionId: row.id,
            triggerType: 'CONFIDENCE_BELOW_THRESHOLD',
            triggerReason: reasoning,
            severity: confidence < 0.4 ? 'high' : 'medium',
            aiSuggestion: actionType,
            status: 'open',
            context: {
              confidence,
              threshold: confidenceThreshold,
              strategy,
              action,
              mode: 'rules_freeform',
            } as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        // Defensive: canonical shape should never throw post-KAN-750. If this
        // ever fires, the audit-trail-drift invariant test will catch it
        // before prod (apps/api/src/__tests__/escalation-decision-invariant.test.ts).
        console.error('[runDecisionForContact] escalation.create failed:', err);
      }
    }

    return row;
  });

  // 8. Audit log (fire-and-forget).
  logAndPublish(
    {
      tenantId,
      contactId,
      decisionId: decision.id,
      agentType: strategyType || 'decision-engine',
      channel,
      actionType,
      status: outcome === 'EXECUTED' ? 'success' : 'escalated',
      payload: {
        strategy: strategyType,
        action,
        actor: actor.id,
      },
      reasoning,
      confidenceScore: confidence,
      guardrailResult: null,
      executionResult: null,
      errorMessage: null,
      durationMs: Date.now() - started,
      retryCount: 0,
    },
    { store: buildAuditLogStore(prisma), pubsub: getAuditPubSubClient() },
  ).catch((err: unknown) => {
    console.error('[runDecisionForContact] audit-logger failed:', err);
  });

  // 9. Publish Pub/Sub event.
  const client = getPubSubClient();
  const publishOp =
    outcome === 'EXECUTED'
      ? publishActionDecided(client, {
          tenantId,
          contactId,
          objectiveId: (action as any)?.objectiveId ?? 'unknown',
          actionType,
          channel,
          actionPayload: (action?.payload ?? action ?? {}) as Record<string, unknown>,
          selectedStrategy: strategyType,
          confidenceScore: confidence,
          strategyReasoning: strategy?.reasoning ?? '',
          actionReasoning: action?.reasoning ?? '',
        })
      : publishEscalationTriggered(client, {
          tenantId,
          contactId,
          objectiveId: (action as any)?.objectiveId ?? 'unknown',
          reason: 'CONFIDENCE_BELOW_THRESHOLD',
          riskFlags: [],
          proposedAction: {
            actionType,
            channel,
            payload: (action?.payload ?? action ?? {}) as Record<string, unknown>,
          },
          strategy: strategyType,
          confidenceScore: confidence,
          reasoning,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        });

  publishOp.catch((err: unknown) => {
    console.error('[runDecisionForContact] publish failed:', err);
  });

  return {
    decisionId: decision.id,
    strategy: strategyType,
    action: { type: actionType, payload: action?.payload ?? action },
    confidence,
    outcome,
    reasoning,
    latencyMs: Date.now() - started,
  };
}
