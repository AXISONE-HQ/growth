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
import { z } from 'zod';

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
import { analyzeGapsForContact } from './objective-gap-analyzer.js';
import { selectStrategy } from './strategy-selector.js';
import { determineAction } from './action-determiner.js';
import { scoreConfidence } from './confidence-scorer.js';
import { evaluateThreshold, type ThresholdGateInput } from './threshold-gate.js';

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
  // KAN-1028 — env-var gate for the agentic-shadow path. When
  // DISABLE_AGENTIC_SHADOW=true, the loader throws → runShadow's
  // `.catch(() => null)` at line 361 converts to null → the parallel
  // agentic dispatch at line 364 short-circuits to Promise.reject →
  // allSettled returns [rules=fulfilled, agentic=rejected] → runShadow
  // returns the rules result + writes an AgenticShadowDecision row with
  // agenticError='agentic loop module unavailable'.
  //
  // Why this matters for M1: `runFreeform` (the rules-based path) makes
  // ZERO LLM calls (verified — pipeline modules don't import llm-client).
  // ALL the LLM spend in the 2026-05-25 incidents came from the parallel
  // agentic-shadow. With shadow disabled, M1 escalate-only runs at $0
  // LLM cost. The agentic-shadow generates M2 divergence-log data that
  // M1 doesn't consume — so disabling it during M1 has no production
  // impact beyond losing shadow-divergence telemetry for the smoke window.
  //
  // Smoke posture: env set in deploy-api.yml for the M1-closing smoke
  // window. PO removes via separate small PR at M1-close (or as part of
  // the M1-prod shadow-on/off product decision).
  if (process.env.DISABLE_AGENTIC_SHADOW === 'true') {
    throw new Error('agentic-shadow disabled via DISABLE_AGENTIC_SHADOW env var');
  }
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
} from './context-assembler.js';
import {
  logAndPublish,
  InMemoryAuditPubSubClient,
  type AuditEntry,
  type AuditLogStore,
  type AuditPubSubClient,
} from './audit-logger.js';
import {
  publishActionDecided,
  publishEscalationTriggered,
} from './action-decided-publisher.js';
import { getPubSubClient } from '../lib/pubsub-client.js';

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
   * KAN-1005 M2-1 — autonomous-action count for today (UTC), keyed per-tenant.
   * Caller (decision-run-push) reads from Redis (action_count:tenant:<id>:<UTCYYYYMMDD>)
   * BEFORE invoking the engine; engine threads to evaluateThresholdWithMatrix
   * where the daily-action-limit gate consumes it. Omit (or 0) when not
   * relevant (sync trpc paths, tests). Engine treats undefined as 0
   * (gate skips daily-limit check when dailyActionLimit is also undefined).
   */
  dailyAutoActionCount?: number;
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
    // KAN-1022 — load the contact's most recent open Deal so the assembler
    // can read pipeline/stage/microObjectiveProgress from the post-KAN-791
    // source-of-truth (Contact's read-shim columns are mostly NULL in PROD).
    async getCurrentDeal(contactId, tenantId) {
      const d = await prisma.deal.findFirst({
        where: { contactId, tenantId, status: 'open' },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          pipelineId: true,
          currentStageId: true,
          microObjectiveProgress: true,
        },
      });
      if (!d) return null;
      return {
        id: d.id,
        pipelineId: d.pipelineId,
        currentStageId: d.currentStageId,
        microObjectiveProgress: (d.microObjectiveProgress ?? {}) as Record<string, unknown>,
      };
    },
    async getContactState(contactId, objectiveId) {
      // KAN-959 — repointed from contactState to contactObjectiveStack.
      // The hook signature (interface) keeps the legacy name for the
      // run-decision-for-contact orchestrator's consumer surface;
      // implementation reads the new table.
      // KAN-1023 audit: stripped `(prisma as any).contactObjectiveStack?.`
      // cast. Delegate exists on PrismaClient (verified via generated client);
      // optional-chain was guarding against a delegate-missing case that
      // never occurs.
      const s = await prisma.contactObjectiveStack.findFirst({
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
      // KAN-1023 audit: stripped `(prisma as any).action?.` cast.
      const rows = await prisma.action.findMany({
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
      // KAN-1023 audit: stripped `(prisma as any).*?.` casts on pipeline,
      // stage, pipelineMicroObjective, knowledgeFilter delegates. All exist
      // on the typed PrismaClient (verified). Optional-chain was guarding
      // delegate-missing cases that don't occur. Inner-row `any` types
      // preserved for now (separate audit scope: shape-of-returned-row).
      const p = await prisma.pipeline.findUnique({
        where: { id: pipelineId },
        include: { targets: true },
      });
      if (!p) return null;
      const s = stageId
        ? await prisma.stage.findUnique({ where: { id: stageId } })
        : null;
      const pmoRows = (await prisma.pipelineMicroObjective.findMany({
        where: { pipelineId, isActive: true },
        include: { microObjective: true },
      })) ?? [];
      const filterRows = (await prisma.knowledgeFilter.findMany({
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
    // KAN-1023 audit: stripped structural cast on agenticShadowDecision.
    await prisma.agenticShadowDecision.create({
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
        // KAN-1005 M2-1: thread caller-provided count to the gate
        dailyAutoActionCount: input.dailyAutoActionCount,
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
      // KAN-1005 M2-5 — decision-source discriminator. agentic_live
      // is sample-eligible (downstream action-decided-push.ts samples
      // a configurable % into the human-review queue for drift
      // detection).
      decisionSource: 'agentic_live',
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
/**
 * KAN-1005 M2-1 (Gap B) — defensive Zod parse for the autoEscalateFlags
 * blob embedded inside Tenant.guardrailSettings (Json column).
 *
 * Schema: `{ autoEscalateFlags: string[] }` (with `.passthrough()` so
 * unrelated keys in guardrailSettings don't trip the parse).
 *
 * Failure modes — all yield `[]` (safe default, matches current
 * AxisOne PROD state where guardrailSettings is empty `{}`):
 *   - input is null/undefined  → []
 *   - input is not an object   → []
 *   - autoEscalateFlags missing → []
 *   - autoEscalateFlags is not an array of strings → []
 *
 * Empty array means the daily-limit + aiPermissions checks still gate
 * autonomy; this is safe. KAN-1029 lesson: malformed blob fails toward
 * the safer outcome (more escalations), not a crash.
 */
const GuardrailSettingsSchema = z
  .object({
    autoEscalateFlags: z.array(z.string()).default([]),
  })
  .passthrough();

function parseAutoEscalateFlags(guardrailSettings: unknown): string[] {
  const parsed = GuardrailSettingsSchema.safeParse(guardrailSettings ?? {});
  if (!parsed.success) return [];
  return parsed.data.autoEscalateFlags;
}

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
    /** KAN-1005 M2-1 — autonomous-action count today (UTC, per-tenant).
     *  Caller passes from Redis read; gate enforces against
     *  Tenant.dailyActionLimit. Defaults to 0 if not provided. */
    dailyAutoActionCount?: number;
    /** KAN-1005 M2-4 — circuit breaker state. Caller (apps/api) reads
     *  from Redis via `evaluateBreakerState(redis, tenantId)` BEFORE
     *  invoking the engine, threads through here, gate enforces at
     *  step 3 of the evaluateThreshold ladder. Optional for back-
     *  compat (omitted → no breaker check); production caller always
     *  reads + passes. */
    breakerState?: {
      tripped: boolean;
      scope?: string;
      isGlobal?: boolean;
      reason?: string;
      failClosed?: boolean;
    };
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
      // KAN-1005 M2-1 — Gap B: autoEscalateFlags lives inside
      // Tenant.guardrailSettings Json (no schema migration). Defensive
      // Zod parse with safe defaults — KAN-1029 lesson applied (malformed
      // blob fails toward escalate by yielding [], same as missing).
      autoEscalateFlags: parseAutoEscalateFlags(tenantRaw.guardrailSettings),
      // KAN-1005 M2-3 — `blockedActionTypes` removed. Collapsed into the
      // unified aiPermissions.actionTypes tri-value: 'blocked' is the
      // third value (hard off). Eliminates the dead column-less stub.
      requireHumanApproval: (tenantRaw.requireHumanApproval ?? false) as boolean,
      autoApproveEnabled: (tenantRaw.autoApproveEnabled ?? true) as boolean,
      // KAN-1005 M2-1 — Gap A: real per-tenant daily limit, was stubbed
      // to a non-existent column before (`tenantRaw.maxDailyAutoActions`
      // undefined → gate skipped). Maps Prisma `dailyActionLimit` (Int,
      // default 100) → gate's `maxDailyAutoActions`.
      maxDailyAutoActions: (tenantRaw.dailyActionLimit ?? undefined) as number | undefined,
      // KAN-1005 M2-1 — Gap C: stored-but-unenforced aiPermissions now
      // passed to the gate. The gate parses defensively (default-deny)
      // and escalates any action type not explicitly marked 'auto'.
      // Empty {} (AxisOne today) → all actions escalate even with
      // autoApproveEnabled=true: triple-gate safety (flip + permissions
      // + redirect). M2-3 will populate actionTypes defaults.
      aiPermissions: (tenantRaw.aiPermissions ?? {}) as Record<string, unknown>,
    },
    stageMatrix: stageMatrix as ThresholdGateInput['stageMatrix'],
    pipelineMatrix: pipelineMatrix as ThresholdGateInput['pipelineMatrix'],
    dailyAutoActionCount: args.dailyAutoActionCount ?? 0,
    // KAN-1005 M2-4 — caller-provided circuit breaker state. Falls
    // through to default { tripped: false } when omitted (back-compat
    // for callers that haven't migrated; production caller in
    // apps/api always reads + passes).
    breakerState: args.breakerState ?? { tripped: false },
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
      // KAN-1005 M2-5 — decision-source discriminator. Playbook steps are
      // human-curated and pre-vetted at creation; NOT autonomous
      // decisions. Marked 'playbook' so action-decided-push.ts SKIPS
      // sampling for these.
      decisionSource: 'playbook',
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

  // KAN-1025: resolve objectiveId for the engine pipeline. The 4 pipeline
  // steps (gaps/strategy/action/confidence) all require objectiveId as a
  // typed input. Load from the active ContactObjectiveStack row — the same
  // source that decision-run-push.ts guard logic uses. For M1 reality
  // (1-tenant, single-objective warm_up), this is deterministic; if a future
  // multi-objective contact needs a specific objective passed in, add
  // `objectiveId?: string` to RunForContactInput then.
  const activeStack = await prisma.contactObjectiveStack.findFirst({
    where: { tenantId, contactId, status: 'active' },
    orderBy: { priority: 'desc' },
    select: { objectiveId: true },
  });
  if (!activeStack) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `No active ContactObjectiveStack row for contact ${contactId} in tenant ${tenantId}`,
    });
  }
  const objectiveId = activeStack.objectiveId;

  // 2. Objective Gap.
  // KAN-1025: stripped `(analyzeGapsForContact as any)({...})` cast. The cast
  // hid a signature mismatch (4-positional fn called with 1 object arg) that
  // caused the 2026-05-25 15:35Z PROD incident ($0.0955, 3 retries). Now
  // passes positional args correctly.
  const gaps = await analyzeGapsForContact(prisma, tenantId, contactId, objectiveId);

  // 3. Strategy Selector.
  // KAN-1025: stripped `(selectStrategy as any)({...})` cast. Now passes the
  // typed StrategySelectionInput shape, sourcing fields from gaps + context.
  const strategyResult = await selectStrategy({
    contactId,
    tenantId,
    objectiveId,
    objectiveType: gaps.objectiveType,
    overallProgress: gaps.overallProgress,
    overallHealth: gaps.overallHealth,
    gapCount: gaps.gapCount,
    primaryGap: gaps.primaryGap,
    recommendedStrategy: gaps.recommendedStrategy,
    contactContext: {
      lifecycleStage: context.contact.lifecycleStage,
      segment: context.contact.segment,
      lastInteractionDaysAgo: context.contact.lastInteractionDaysAgo,
      totalInteractions: context.contact.totalInteractions,
      responseRate: context.contact.responseRate,
      preferredChannel: context.contact.preferredChannel,
      dataQualityScore: context.contact.dataQualityScore,
    },
    brainContext: {
      companyTruth: context.brain.companyTruth,
      blueprintStrategies: context.brain.blueprintStrategies,
      strategyWeights: context.brain.strategyWeights,
    },
  });

  // 4. Action Determiner.
  // KAN-1025: stripped `(determineAction as any)({...})` cast. Now passes the
  // typed ActionDeterminerInput shape, threading strategy result + simpler
  // primaryGap shape (suggestedActions only, not weight/priorityScore).
  const actionResult = determineAction({
    contactId,
    tenantId,
    objectiveId,
    selectedStrategy: strategyResult.selectedStrategy,
    strategyConfidence: strategyResult.confidence,
    strategyReasoning: strategyResult.reasoning,
    primaryGap: gaps.primaryGap
      ? {
          subObjectiveId: gaps.primaryGap.subObjectiveId,
          subObjectiveName: gaps.primaryGap.subObjectiveName,
          category: gaps.primaryGap.category,
          severity: gaps.primaryGap.severity,
          reason: gaps.primaryGap.reason,
          suggestedActions: gaps.primaryGap.suggestedActions,
        }
      : null,
    contactContext: {
      name: context.contact.name,
      lifecycleStage: context.contact.lifecycleStage,
      segment: context.contact.segment,
      lastInteractionDaysAgo: context.contact.lastInteractionDaysAgo,
      totalInteractions: context.contact.totalInteractions,
      responseRate: context.contact.responseRate,
      preferredChannel: context.contact.preferredChannel,
      timezone: context.contact.timezone,
    },
    brainContext: {
      companyTruth: context.brain.companyTruth,
      products: context.brain.products,
      tone: context.brain.tone,
      constraints: context.brain.constraints,
    },
  });

  // 5. Confidence Scorer.
  // KAN-1025: stripped `(scoreConfidence as any)({...})` cast. Now passes the
  // typed ConfidenceScorerInput shape, sourcing fields from strategy + action
  // results + context.
  const confidenceResult = await scoreConfidence({
    contactId,
    tenantId,
    objectiveId,
    strategyConfidence: strategyResult.confidence,
    selectedStrategy: strategyResult.selectedStrategy,
    actionType: actionResult.actionType,
    actionReasoning: actionResult.reasoning,
    contactSignals: {
      dataQualityScore: context.contact.dataQualityScore,
      responseRate: context.contact.responseRate,
      lastInteractionDaysAgo: context.contact.lastInteractionDaysAgo,
      totalInteractions: context.contact.totalInteractions,
      lifecycleStage: context.contact.lifecycleStage,
    },
    gapContext: gaps.primaryGap
      ? {
          gapSeverity: gaps.primaryGap.severity,
          gapReason: gaps.primaryGap.reason,
          suggestedActionsCount: gaps.primaryGap.suggestedActions.length,
        }
      : undefined,
    brainSignals: {
      hasBlueprintStrategies: (context.brain.blueprintStrategies?.length ?? 0) > 0,
      hasCompanyTruth: !!context.brain.companyTruth,
    },
  });

  // KAN-1025: typed return-field reads — replaces the previous fallback
  // chains (`strategyRaw?.strategy ?? strategyRaw` etc.) that were masking
  // the broken pipeline. The fallbacks coincidentally let whole-result-objects
  // flow through; downstream `String(strategy)` produced `"[object Object]"`
  // and `confidence` resolved to `0`. With typed access, all downstream
  // consumers receive real semantic values.
  //
  // Variables retained for downstream code compatibility:
  //   - `strategy` + `action`: full result objects (preserves audit-trail
  //     intent in Decision.metadata + Escalation.context — same JSON
  //     persistence shape the broken-fallback path was accidentally
  //     producing, now cleanly typed).
  //   - `strategyType` / `actionType` / `channel`: type strings for the
  //     threshold gate's matrix-key lookup.
  //   - `confidence`: normalized to 0..1 (scoreConfidence returns 0..100;
  //     the downstream comparisons and gate input already expect/multiply
  //     accordingly).
  const strategy = strategyResult;
  const action = actionResult;
  const strategyType: string = strategyResult.selectedStrategy;
  const actionType: string = actionResult.actionType;
  const channel: string | null = actionResult.channel;
  const confidence: number = confidenceResult.overallConfidence / 100;

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
      actionPayload: (action?.actionPayload ?? {}) as Record<string, unknown>,
      actionReasoning: `Action: ${actionType}`,
      selectedStrategy: strategyType,
      strategyReasoning: `Strategy: ${strategyType}`,
      // KAN-1025: use the resolved objectiveId (loaded from active stack
      // at the top of runShadow); no longer fall back to 'unknown' sentinel.
      objectiveId,
      riskFlags: [],
      overallConfidence: confidence * 100, // 0..1 → 0..100 (gate input scale)
      // KAN-1005 M2-1: thread caller-provided count to the gate
      dailyAutoActionCount: input.dailyAutoActionCount,
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
          actionPayload: (action?.actionPayload ?? {}) as Record<string, unknown>,
          selectedStrategy: strategyType,
          confidenceScore: confidence,
          strategyReasoning: strategy?.reasoning ?? '',
          actionReasoning: action?.reasoning ?? '',
          // KAN-1005 M2-5 — runFreeform (rules-based engine) is sample-
          // eligible alongside runAgentic. action-decided-push.ts samples
          // a configurable % for drift detection.
          decisionSource: 'freeform',
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
            payload: (action?.actionPayload ?? {}) as Record<string, unknown>,
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
    action: { type: actionType, payload: action?.actionPayload ?? {} },
    confidence,
    outcome,
    reasoning,
    latencyMs: Date.now() - started,
  };
}
