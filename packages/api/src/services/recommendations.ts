/**
 * KAN-754 — Recommendations service.
 *
 * "Next best action per escalation" — replaces the broken pre-KAN-689
 * `escalationsRouter` (snake_case + non-existent fields). Reads canonical
 * Escalation rows post-KAN-750: every row carries decisionId (when scope
 * had a Decision), context JSONB, severity, triggerType, triggerReason,
 * aiSuggestion, status. Escalation IS the recommendation — no new table.
 *
 * Five operator actions:
 *   - list({ status?, severity?, limit, offset })       — paginated queue
 *   - getDetail(id)                                      — full context for the drawer
 *   - accept({ id, modifiedAction? })                    — emit action.decided + resolve
 *   - modify({ id, suggestedAction })                    — update aiSuggestion only
 *   - dismiss({ id, reason })                            — resolve without emit
 *
 * Tenant isolation: every query/mutation filters on tenantId from ctx; cross-
 * tenant access returns NOT_FOUND. Best-effort AuditLog writes per
 * `reference_agentic_tool_surface` discipline (never fail the mutation on
 * audit-log write failure). action.decided emission via canonical
 * `publishActionDecided` (per `reference_agentic_action_emission`).
 *
 * Null-safe decisionId: guardrail-block + lead-assignment paths write
 * Escalations with decisionId=null. getDetail returns `decision: null` for
 * those rows — UI hides the Decision context panel cleanly.
 */
import { TRPCError } from '@trpc/server';
import type { PrismaClient } from '@prisma/client';
import {
  publishActionDecided,
  type PubSubClient,
  type PublishActionInput,
} from './action-decided-publisher.js';

// ─────────────────────────────────────────────
// Input shapes — keep zod-equivalent here so tests can import without zod
// ─────────────────────────────────────────────

export interface ListInput {
  status?: 'open' | 'claimed' | 'resolved' | 'dismissed';
  severity?: 'low' | 'medium' | 'high' | 'critical';
  limit?: number;
  offset?: number;
}

export interface SuggestedAction {
  actionType: string;
  channel: string | null;
  payload: Record<string, unknown>;
}

export interface AcceptInput {
  id: string;
  modifiedAction?: SuggestedAction;
}

export interface ModifyInput {
  id: string;
  suggestedAction: string;
}

export interface DismissInput {
  id: string;
  reason: string;
}

// ─────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, limit));
}

export async function listRecommendations(
  prisma: PrismaClient,
  tenantId: string,
  input: ListInput,
) {
  const limit = clampLimit(input.limit);
  const offset = Math.max(0, input.offset ?? 0);
  const where = {
    tenantId,
    ...(input.status ? { status: input.status } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.escalation.findMany({
      where,
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      skip: offset,
      take: limit,
      include: {
        contact: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    }),
    prisma.escalation.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      contactId: r.contactId,
      contact: r.contact,
      decisionId: r.decisionId, // null for guardrail-block / lead-assignment paths
      severity: r.severity,
      status: r.status,
      triggerType: r.triggerType,
      triggerReason: r.triggerReason,
      aiSuggestion: r.aiSuggestion,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      resolvedBy: r.resolvedBy,
      resolvedAt: r.resolvedAt,
    })),
    total,
    limit,
    offset,
  };
}

export async function getRecommendationDetail(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
) {
  const row = await prisma.escalation.findFirst({
    where: { id, tenantId },
    include: {
      contact: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          lifecycleStage: true,
        },
      },
      decision: true, // null when decisionId is null — Prisma handles gracefully
    },
  });

  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Recommendation not found' });
  }

  // Decision payload is null for non-agentic-decision-driven escalations
  // (guardrail-block, lead-assignment). UI hides the panel cleanly when null.
  return {
    id: row.id,
    contactId: row.contactId,
    contact: row.contact,
    decisionId: row.decisionId,
    decision: row.decision
      ? {
          id: row.decision.id,
          strategySelected: row.decision.strategySelected,
          actionType: row.decision.actionType,
          confidence: row.decision.confidence,
          reasoning: row.decision.reasoning,
          metadata: row.decision.metadata,
          createdAt: row.decision.createdAt,
        }
      : null,
    severity: row.severity,
    status: row.status,
    triggerType: row.triggerType,
    triggerReason: row.triggerReason,
    aiSuggestion: row.aiSuggestion,
    context: row.context,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt,
  };
}

interface MutationContext {
  prisma: PrismaClient;
  tenantId: string;
  actor: string;
  pubsubClient?: PubSubClient | null;
}

async function loadEscalation(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
): Promise<{
  id: string;
  status: string;
  contactId: string;
  decisionId: string | null;
  severity: string;
  aiSuggestion: string | null;
  context: unknown;
  decision: { strategySelected: string; confidence: number; reasoning: string | null } | null;
}> {
  const row = await prisma.escalation.findFirst({
    where: { id, tenantId },
    include: {
      decision: { select: { strategySelected: true, confidence: true, reasoning: true } },
    },
  });
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Recommendation not found' });
  }
  return row;
}

async function writeAuditBestEffort(
  prisma: PrismaClient,
  tenantId: string,
  actor: string,
  actionType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId,
        actor,
        actionType,
        payload: payload as never,
      },
    });
  } catch (err) {
    // Best-effort per existing pattern — never fail the mutation on audit-log
    // write failure. Logged for ops visibility.
    console.error(`[recommendations] auditLog write failed for ${actionType}:`, err);
  }
}

export async function acceptRecommendation(
  ctx: MutationContext,
  input: AcceptInput,
) {
  const before = await loadEscalation(ctx.prisma, ctx.tenantId, input.id);

  // Guard against double-resolve (status already terminal).
  if (before.status === 'resolved' || before.status === 'dismissed') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Recommendation already ${before.status}`,
    });
  }

  // Resolve action: prefer modifiedAction over the AI's original aiSuggestion.
  // aiSuggestion is a free-form string; modifiedAction is the structured form
  // operators provide via the detail drawer's Modify button.
  const finalAction: SuggestedAction = input.modifiedAction ?? {
    actionType: 'human_review',
    channel: null,
    payload: { aiSuggestion: before.aiSuggestion ?? '' },
  };

  // Emit action.decided via canonical publisher (when payload structure is
  // sufficient — modifiedAction provides actionType+channel+payload). For the
  // default human_review path (aiSuggestion is text only, no structured
  // action), we skip emission — the operator's accept of a text suggestion
  // is purely a status transition. Only structured modifiedAction triggers
  // a real downstream emit.
  let publishedEventId: string | null = null;
  if (input.modifiedAction && ctx.pubsubClient) {
    const publishInput: PublishActionInput = {
      tenantId: ctx.tenantId,
      contactId: before.contactId,
      objectiveId:
        ((before.context as Record<string, unknown> | null)?.objectiveId as string | undefined) ??
        'unknown',
      actionType: input.modifiedAction.actionType,
      channel: input.modifiedAction.channel,
      actionPayload: input.modifiedAction.payload,
      selectedStrategy: before.decision?.strategySelected ?? 'human_override',
      confidenceScore: before.decision?.confidence ?? 1.0,
      strategyReasoning: before.decision?.reasoning ?? `Operator accepted recommendation ${before.id}`,
      actionReasoning: `human_override via recommendations.accept`,
    };
    try {
      const result = await publishActionDecided(ctx.pubsubClient, publishInput);
      publishedEventId = result.messageId ?? null;
    } catch (err) {
      console.error(`[recommendations.accept] publishActionDecided failed escalationId=${before.id}:`, err);
      // Don't fail the mutation — operator already committed. The escalation
      // still resolves; missing emit is logged for ops to retry manually.
    }
  }

  const updated = await ctx.prisma.escalation.update({
    where: { id: before.id },
    data: {
      status: 'resolved',
      resolvedBy: ctx.actor,
      resolvedAt: new Date(),
    },
  });

  await writeAuditBestEffort(ctx.prisma, ctx.tenantId, ctx.actor, 'recommendation.accept', {
    escalationId: before.id,
    beforeStatus: before.status,
    afterStatus: 'resolved',
    modifiedAction: input.modifiedAction ?? null,
    publishedActionDecidedId: publishedEventId,
  });

  return { id: updated.id, status: updated.status, publishedEventId };
}

export async function modifyRecommendation(
  ctx: MutationContext,
  input: ModifyInput,
) {
  const before = await loadEscalation(ctx.prisma, ctx.tenantId, input.id);

  if (before.status === 'resolved' || before.status === 'dismissed') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Cannot modify ${before.status} recommendation`,
    });
  }

  const updated = await ctx.prisma.escalation.update({
    where: { id: before.id },
    data: { aiSuggestion: input.suggestedAction },
  });

  await writeAuditBestEffort(ctx.prisma, ctx.tenantId, ctx.actor, 'recommendation.modify', {
    escalationId: before.id,
    beforeStatus: before.status,
    afterStatus: before.status,
    beforeSuggestion: before.aiSuggestion,
    afterSuggestion: input.suggestedAction,
  });

  return { id: updated.id, status: updated.status, aiSuggestion: updated.aiSuggestion };
}

export async function dismissRecommendation(
  ctx: MutationContext,
  input: DismissInput,
) {
  const before = await loadEscalation(ctx.prisma, ctx.tenantId, input.id);

  if (before.status === 'resolved' || before.status === 'dismissed') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Recommendation already ${before.status}`,
    });
  }

  const updated = await ctx.prisma.escalation.update({
    where: { id: before.id },
    data: {
      status: 'dismissed',
      resolvedBy: ctx.actor,
      resolvedAt: new Date(),
    },
  });

  await writeAuditBestEffort(ctx.prisma, ctx.tenantId, ctx.actor, 'recommendation.dismiss', {
    escalationId: before.id,
    beforeStatus: before.status,
    afterStatus: 'dismissed',
    dismissReason: input.reason,
  });

  return { id: updated.id, status: updated.status };
}
