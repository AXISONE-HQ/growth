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
import { assembleContext } from './context-assembler';
import { logAndPublish, AuditActionType, AuditActorType } from './audit-logger';
import { publishActionDecided, publishEscalationTriggered } from './action-decided-publisher';

export interface RunForContactInput {
  tenantId: string;
  contactId: string;
  /** If true, bypass Redis cache when assembling Brain context (useful for demos). */
  freshContext?: boolean;
  /** Actor identity for the audit log. Defaults to 'SYSTEM' for cron/Pub/Sub triggers. */
  actor?: { type: 'USER' | 'SYSTEM'; id: string };
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

export async function runDecisionForContact(
  prisma: PrismaClient,
  input: RunForContactInput
): Promise<RunForContactResult> {
  const started = Date.now();
  const { tenantId, contactId, actor = { type: 'SYSTEM', id: 'decision-engine' } } = input;

  // 1. Verify the contact exists and belongs to the tenant (defense-in-depth; router
  //    also does this via protectedProcedure, but we re-check for Pub/Sub callers).
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId },
    include: { tenant: true },
  });
  if (!contact) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `Contact ${contactId} not in tenant` });
  }

  const tenant = contact.tenant;
  const confidenceThreshold = (tenant.confidenceThreshold ?? 70) / 100; // stored as 0-100 int

  // 2. Assemble Brain context (Redis-cached per spec; <200ms target).
  const context = await assembleContext({
    prisma,
    tenantId,
    contactId,
    freshContext: input.freshContext ?? false,
  });

  // 3. Objective Gap — which sub-objectives are missing for this contact?
  const gaps: any = await (analyzeGapsForContact as any)({ prisma, tenantId, contactId, context });

  // 4. Strategy Selector (Sonnet) — pick Direct / Re-engage / Trust / Guided.
  const strategyRaw: any = await (selectStrategy as any)({ prisma, tenantId, contactId, gaps, context });
  const strategy: any = strategyRaw?.strategy ?? strategyRaw;

  // 5. Action Determiner (Sonnet) — single best next action.
  //    Input shape: ActionDeterminerInputSchema (contactContext + brainContext).
  const actionRaw: any = (determineAction as any)({
    strategy,
    contactContext: (context as any).contactContext ?? context,
    brainContext: (context as any).brainContext ?? {},
  });
  const action: any = actionRaw?.action ?? actionRaw;

  // 6. Confidence Scorer (Haiku) — score 0-1.
  const confidenceRaw: any = await (scoreConfidence as any)({
    strategy,
    action,
    contactContext: (context as any).contactContext ?? context,
    brainContext: (context as any).brainContext ?? {},
  });
  const confidence: number = typeof confidenceRaw === 'number' ? confidenceRaw : (confidenceRaw?.score ?? confidenceRaw?.confidence ?? 0);

  // 7. Threshold Gate — execute vs escalate.
  const gateRaw: any = (evaluateThreshold as any)({ confidence, threshold: confidenceThreshold });
  const gateDecision: string = typeof gateRaw === 'string' ? gateRaw : (gateRaw?.decision ?? gateRaw?.result ?? 'fail');
  const outcome: 'EXECUTED' | 'ESCALATED' =
    gateDecision === 'pass' || gateDecision === 'PASS' || gateDecision === 'execute' ? 'EXECUTED' : 'ESCALATED';

  const strategyType: string = strategy?.type ?? strategy?.selected ?? String(strategy);
  const actionType: string = action?.type ?? action?.actionType ?? String(action);

  const reasoning = [
    `Strategy: ${strategyType}`,
    `Action: ${actionType}`,
    `Confidence: ${(confidence * 100).toFixed(0)}% vs threshold ${(confidenceThreshold * 100).toFixed(0)}%`,
    `Outcome: ${outcome}`,
  ].join(' · ');

  // 8. Persist Decision row + (optionally) an Escalation row, then audit + Pub/Sub.
  const decision = await prisma.$transaction(async (tx) => {
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
      // Escalation model field names may differ per schema. Wrap in try/catch
      // so a schema mismatch doesn't crash the whole decision.
      try {
        await (tx as any).escalation.create({
          data: {
            tenantId,
            contactId,
            decisionId: row.id,
            reason: 'CONFIDENCE_BELOW_THRESHOLD',
            priority: confidence < 0.4 ? 'HIGH' : 'MEDIUM',
            status: 'PENDING',
            context: { confidence, threshold: confidenceThreshold, strategy, action } as unknown as Record<string, unknown>,
          },
        });
      } catch (err) {
        console.error('[runDecisionForContact] escalation.create failed (schema mismatch?):', err);
      }
    }

    return row;
  });

  // 9. Audit log (fire-and-forget; dual-write Cloud Logging + Cloud SQL inside).
  //    ⚠️ logAndPublish input = AuditLoggerInputSchema — check lines ~120–240 of
  //    audit-logger.ts for exact shape. The enum values below may need quoting.
  await logAndPublish({
    prisma,
    tenantId,
    actorType: actor.type === 'SYSTEM' ? 'system' : 'user',
    actorId: actor.id,
    actionType: outcome === 'EXECUTED' ? 'decision' : 'escalate',
    target: { type: 'contact', id: contactId, name: `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim() || contact.email || contactId },
    result: 'success',
    summary: reasoning,
    metadata: { decisionId: decision.id, strategy: strategyType, action: actionType, confidence },
  } as any).catch((err: unknown) => {
    // Never fail the decision because of audit logging hiccups; just log.
    console.error('[runDecisionForContact] audit-logger failed:', err);
  });

  // 10. Publish Pub/Sub event on the appropriate topic.
  //     ⚠️ publishActionDecided / publishEscalationTriggered expect the
  //     corresponding *Event* object. Use the builder helpers:
  //       - buildActionDecidedEvent(...)        (line 193 of action-decided-publisher.ts)
  //       - buildEscalationTriggeredEvent(...)  (line 246)
  //     Their input shapes are the zod schemas at the top of the file.
  const publishOp =
    outcome === 'EXECUTED'
      ? publishActionDecided({
          tenantId,
          contactId,
          decisionId: decision.id,
          strategy: strategyType,
          action,
          confidence,
        } as any)
      : publishEscalationTriggered({
          tenantId,
          contactId,
          decisionId: decision.id,
          confidence,
          reason: 'CONFIDENCE_BELOW_THRESHOLD',
        } as any);

  await publishOp.catch((err: unknown) => {
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
