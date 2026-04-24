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

import type { PrismaClient } from '@prisma/client';
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
import { analyzeGapsForContact } from './objective-gap-analyzer';
import { selectStrategy } from './strategy-selector';
import { determineAction } from './action-determiner';
import { scoreConfidence } from './confidence-scorer';
import { evaluateThreshold } from './threshold-gate';
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
  InMemoryPubSubClient,
  type PubSubClient,
} from './action-decided-publisher';

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
let pubSubSingleton: PubSubClient | null = null;

function getContextCache(): ContextCache {
  if (!contextCacheSingleton) contextCacheSingleton = new InMemoryContextCache();
  return contextCacheSingleton;
}

function getAuditPubSubClient(): AuditPubSubClient {
  if (!auditPubSubSingleton) auditPubSubSingleton = new InMemoryAuditPubSubClient();
  return auditPubSubSingleton;
}

// TODO(KAN-656): replace with real @google-cloud/pubsub client. Currently in-memory,
// so action.decided events are dropped and no downstream (connectors/SendGrid) fires.
// The real consumer also listens on `action.send`, not `action.decided` — a topic-
// name bridge is needed before end-to-end email delivery works.
function getPubSubClient(): PubSubClient {
  if (!pubSubSingleton) pubSubSingleton = new InMemoryPubSubClient();
  return pubSubSingleton;
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
            } as unknown as Record<string, unknown>,
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
  return runFreeform(prisma, input, contact);
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
      } as unknown as Record<string, unknown>,
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

  // 6. Threshold Gate.
  const gateRaw: any = (evaluateThreshold as any)({ confidence, threshold: confidenceThreshold });
  const gateDecision: string =
    typeof gateRaw === 'string' ? gateRaw : gateRaw?.decision ?? gateRaw?.result ?? 'fail';
  const outcome: 'EXECUTED' | 'ESCALATED' =
    gateDecision === 'pass' || gateDecision === 'PASS' || gateDecision === 'execute'
      ? 'EXECUTED'
      : 'ESCALATED';

  const strategyType: string = strategy?.type ?? strategy?.selected ?? String(strategy);
  const actionType: string = action?.type ?? action?.actionType ?? String(action);
  const channel: string | null = action?.channel ?? null;

  const reasoning = [
    `Strategy: ${strategyType}`,
    `Action: ${actionType}`,
    `Confidence: ${(confidence * 100).toFixed(0)}% vs threshold ${(confidenceThreshold * 100).toFixed(0)}%`,
    `Outcome: ${outcome}`,
  ].join(' · ');

  // 7. Persist Decision row + (optionally) an Escalation row.
  const decision = await prisma.$transaction(async (tx: any) => {
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
        } as unknown as Record<string, unknown>,
      },
    });

    if (outcome === 'ESCALATED') {
      try {
        await tx.escalation.create({
          data: {
            tenantId,
            contactId,
            decisionId: row.id,
            reason: 'CONFIDENCE_BELOW_THRESHOLD',
            priority: confidence < 0.4 ? 'HIGH' : 'MEDIUM',
            status: 'PENDING',
            context: {
              confidence,
              threshold: confidenceThreshold,
              strategy,
              action,
            } as unknown as Record<string, unknown>,
          },
        });
      } catch (err) {
        console.error('[runDecisionForContact] escalation.create failed (schema mismatch?):', err);
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

  // 9. Publish Pub/Sub event. TODO(KAN-656): real client + action.send topic bridge.
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
