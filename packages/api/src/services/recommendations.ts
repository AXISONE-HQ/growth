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
import { z } from 'zod';
import {
  publishActionDecided,
  type PubSubClient,
  type PublishActionInput,
} from './action-decided-publisher.js';
// KAN-1005 M2-5 — single canonical marker for sampled review entries.
// Lives in packages/shared so both apps/api (the sampling fork) and
// packages/api (this file's guard + queue filter) can import without
// crossing the rootDir boundary. Used here (a) to FILTER samples out
// of the default pending-approval queue (`listRecommendations`
// default kind='pending') and (b) to REJECT accept/modify on samples
// (the double-dispatch guard).
import { SAMPLED_TRIGGER_TYPE } from '@growth/shared';
// KAN-1140 Phase 3 PR 6 — reclassify path publishes synthetic LeadReceivedEvent
// to the same topic the webhook uses; the consumer's existing handler picks it
// up (with parseConfidenceOverride loop-guard set).
import { LEAD_RECEIVED_TOPIC, LeadReceivedEventSchema } from '@growth/shared';

// ─────────────────────────────────────────────
// Input shapes — keep zod-equivalent here so tests can import without zod
// ─────────────────────────────────────────────

export interface ListInput {
  status?: 'open' | 'claimed' | 'resolved' | 'dismissed';
  severity?: 'low' | 'medium' | 'high' | 'critical' | 'info';
  limit?: number;
  offset?: number;
  /**
   * KAN-1005 M2-5 — queue partition:
   *   - 'pending' (default): blocking escalations awaiting human decision.
   *     EXCLUDES sampled post-hoc reviews. This is the safety-critical
   *     default — a sample must never be presented as an actionable
   *     pending approval (the accept-guard prevents the double-dispatch,
   *     but the UX would be misleading without this filter).
   *   - 'sample':  post-hoc samples only (M2-5 auto-approve drift review).
   *   - 'all':     both (admin / dashboard view).
   *
   * Default 'pending' is intentional — operator default view stays
   * pending-only; sample review is an explicit opt-in.
   */
  kind?: 'pending' | 'sample' | 'all';
}

/**
 * KAN-1037 — Zod-validated SuggestedAction shape.
 *
 * The engine's structured action (actionType + channel + payload) is
 * persisted on the Escalation row's `originalAction` column at insert time
 * on engine-emit ESCALATED paths (runAgentic + runFreeform), then re-parsed
 * on read in `acceptRecommendation` to drive the accept-without-modify
 * dispatch fallback. SuggestedActionSchema.safeParse on read is the
 * defense-in-depth guard against malformed rows (corrupted JSON, schema
 * drift, pre-KAN-1037 NULL rows already short-circuit before parse).
 *
 * Shape is intentionally permissive on `payload` (Record<string, unknown>) —
 * downstream `publishActionDecided` does its own validation. This schema
 * just asserts the OUTER envelope so a wholly-malformed row never crashes
 * the acceptance path.
 */
export const SuggestedActionSchema = z.object({
  actionType: z.string(),
  channel: z.string().nullable(),
  payload: z.record(z.unknown()),
});

export type SuggestedAction = z.infer<typeof SuggestedActionSchema>;

export interface AcceptInput {
  id: string;
  modifiedAction?: SuggestedAction;
}

export interface ModifyInput {
  id: string;
  suggestedAction: string;
}

/**
 * KAN-1140 Phase 3 PR 6 — operator-corrected metadata for
 * parse_confidence_review escalations. All fields optional; at least one
 * must be supplied (handler asserts). Empty corrections are no-ops; the
 * loop-guard + synthetic-republish still runs so Brain can wake up on
 * the post-review event.
 */
export interface ReclassifyInput {
  id: string;
  correctedFormat?: string;
  correctedLanguage?: string;
  correctedVendor?: string;
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
  // KAN-1005 M2-5 — kind filter. Default 'pending' EXCLUDES sampled
  // post-hoc reviews so a sample never appears as an actionable
  // pending approval. UI opts in via kind='sample' or kind='all'.
  const kind = input.kind ?? 'pending';
  const triggerTypeFilter =
    kind === 'sample'
      ? { triggerType: SAMPLED_TRIGGER_TYPE }
      : kind === 'pending'
        ? { triggerType: { not: SAMPLED_TRIGGER_TYPE } }
        : {}; // 'all' — no triggerType filter
  const where = {
    tenantId,
    ...(input.status ? { status: input.status } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
    ...triggerTypeFilter,
  };

  const [rows, total] = await Promise.all([
    prisma.escalation.findMany({
      where,
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      skip: offset,
      take: limit,
      include: {
        contact: {
          // KAN-1102 — `companyName` added so the Dashboard Escalation Queue
          // panel can render "FirstName LastName — Company" without a
          // separate Contact fetch. Class-fix bonus: the canonical
          // `/escalations` page consumer also benefits (audit during build).
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            companyName: true,
          },
        },
      },
    }),
    prisma.escalation.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      contactId: r.contactId,
      contact: r.contact, // KAN-1102 — now includes `companyName` per the select above
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

  // KAN-1037-PR5 — Trigger inbound context for engine_proposed_action
  // escalations (PR4.5 path). The escalation was created BECAUSE the
  // engine evaluated a contact reply and emitted escalate_to_human —
  // operators need to see what reply triggered the escalation, prominently,
  // above the engine's suggested action.
  //
  // Conditional derivation per PR5 Phase 1 confirmation: skip the
  // engagement query for non-engine-proposed escalations (the common
  // case — CONFIDENCE_BELOW_THRESHOLD / AGENTIC_GATE_DECISION /
  // guardrail_block / lead_assignment_below_threshold / SAMPLED_*).
  //
  // Source of truth for the trigger inbound: the contact's most recent
  // `email_received` engagement. The PR4.5 escalation create site doesn't
  // store an inboundEngagementId reference (KAN-1044 deferred); the
  // chronological lookup is the cleanest proxy at fetch time.
  let triggerInbound: TriggerInbound | null = null;
  if (row.triggerType === 'engine_proposed_action') {
    const inbound = await prisma.engagement.findFirst({
      where: {
        tenantId,
        contactId: row.contactId,
        engagementType: 'email_received',
      },
      orderBy: { occurredAt: 'desc' },
      select: {
        id: true,
        occurredAt: true,
        signalClass: true,
        metadata: true,
      },
    });
    if (inbound) {
      const meta = (inbound.metadata ?? {}) as Record<string, unknown>;
      triggerInbound = {
        id: inbound.id,
        bodyPreview: typeof meta.bodyPreview === 'string' ? meta.bodyPreview : '',
        fromAddress: typeof meta.senderEmail === 'string' ? meta.senderEmail : '',
        subject: typeof meta.subject === 'string' ? meta.subject : '',
        occurredAt: inbound.occurredAt.toISOString(),
        signalClass: inbound.signalClass,
      };
    }
  }

  // KAN-1037-PR5 — Per Phase 1 finding #1 (audit chain join):
  // `triggerDecisionId` on the `decision_re_evaluated` audit row points
  // at the ORIGINATING outbound's Decision (the outbound the contact
  // replied to). The escalation row's `decisionId` field points at the
  // most-recent Decision on the contact at create time (PR4.5's
  // `recentDecision` lookup) — usually a DIFFERENT Decision than the
  // trigger. Both are useful: the originator gives "what we said," the
  // recent gives "where we are." UI surfaces both with navigation.
  let triggerDecisionId: string | null = null;
  if (row.triggerType === 'engine_proposed_action') {
    const reEvalAudit = await prisma.auditLog.findFirst({
      where: {
        tenantId,
        actionType: 'decision_re_evaluated',
        payload: { path: ['contactId'], equals: row.contactId },
      },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    if (reEvalAudit) {
      const payload = (reEvalAudit.payload ?? {}) as Record<string, unknown>;
      if (typeof payload.triggerDecisionId === 'string') {
        triggerDecisionId = payload.triggerDecisionId;
      }
    }
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
    // KAN-1037-PR5 — additive fields for the new TriggerContextBlock
    // rendering. Null/undefined on non-engine-proposed escalations so
    // the UI conditional renders cleanly.
    triggerInbound,
    triggerDecisionId,
  };
}

/**
 * KAN-1037-PR5 — Trigger inbound shape for engine_proposed_action
 * escalations. Surfaces the contact's reply that triggered the engine's
 * escalation decision so operators see the "why" above the "what."
 */
export interface TriggerInbound {
  id: string;
  bodyPreview: string;
  fromAddress: string;
  subject: string;
  occurredAt: string;
  signalClass: string;
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
  // KAN-1005 M2-5 — exposed so accept/modify can guard against samples.
  triggerType: string;
  aiSuggestion: string | null;
  context: unknown;
  // KAN-1037 — engine-emitted SuggestedAction persisted at insert (runAgentic
  // + runFreeform paths). Read by acceptRecommendation as the fallback when
  // input.modifiedAction is null; safeParse'd via SuggestedActionSchema.
  originalAction: unknown;
  // M3-1b follow-up — `metadata` exposed so the accept route can auto-carry
  // discoveryTarget from the original Decision when the operator's
  // modifiedAction.payload omits it (the route was silently stripping
  // discovery directives on accept-to-dispatch).
  decision: { strategySelected: string; confidence: number; reasoning: string | null; metadata: unknown } | null;
}> {
  const row = await prisma.escalation.findFirst({
    where: { id, tenantId },
    include: {
      decision: { select: { strategySelected: true, confidence: true, reasoning: true, metadata: true } },
    },
  });
  if (!row) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Recommendation not found' });
  }
  return row;
}

/**
 * KAN-1005 M2-5 — double-dispatch guard. The single canonical check used
 * by accept() and modify() to reject sampled post-hoc review entries.
 *
 * Keys on `triggerType === SAMPLED_TRIGGER_TYPE` (NOT a combination of
 * fields — single source of truth, closed loop with maybeEnqueueSampledReview
 * which ALWAYS sets that marker). Re-publishing action.decided for a
 * sampled (already-executed) action would cause a double-dispatch; this
 * guard makes that impossible.
 *
 * Throws TRPCError FORBIDDEN (not BAD_REQUEST) — semantic: this action is
 * categorically not permitted on this entry type, not a transient
 * validation issue. dismiss() is the correct disposition for samples
 * (means "acknowledged").
 */
function assertNotSample(
  escalation: { triggerType: string },
  operation: 'accept' | 'modify',
): void {
  if (escalation.triggerType === SAMPLED_TRIGGER_TYPE) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        `Cannot ${operation} an auto-approve sampled review — the action ` +
        `already executed. Use dismiss to acknowledge, or flag for drift ` +
        `via the sample review surface.`,
    });
  }
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

  // KAN-1005 M2-5 — double-dispatch guard. Samples (auto-approve
  // post-hoc reviews) cannot be accepted; the action already executed.
  // MUST run BEFORE the terminal-status guard so a sample is always
  // rejected on its own merits (not as a side effect of being terminal).
  assertNotSample(before, 'accept');

  // Guard against double-resolve (status already terminal).
  if (before.status === 'resolved' || before.status === 'dismissed') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Recommendation already ${before.status}`,
    });
  }

  // KAN-1037 — Resolve action with originalAction fallback.
  //
  // Three branches:
  //   (1) input.modifiedAction present     → operator-curated structured action
  //                                          (UI Modify flow). Publish.
  //   (2) before.originalAction populated  → engine-emitted structured action
  //                                          persisted at insert (runAgentic /
  //                                          runFreeform ESCALATED paths).
  //                                          Operator accepted without
  //                                          modifying. Publish.
  //   (3) neither                          → legacy text-only fallback
  //                                          (guardrail_block, lead_assignment,
  //                                          pre-KAN-1037 rows). Status transition
  //                                          only; no publish. Preserves the pre-
  //                                          KAN-1037 contract on those paths.
  //
  // The downstream publish path is unchanged — the only thing that varies is
  // WHICH structured action drives it. safeParse on read is defense-in-depth
  // for corrupted JSONB (schema drift, hand-edited rows, etc.) — failure
  // degrades to branch 3 (status transition without publish) instead of
  // crashing the mutation.
  let publishedEventId: string | null = null;
  let auditActionType: string = 'recommendation.accept';
  const candidateAction: unknown = input.modifiedAction ?? before.originalAction ?? null;
  const parsedAction =
    candidateAction !== null ? SuggestedActionSchema.safeParse(candidateAction) : null;

  if (candidateAction !== null && parsedAction && !parsedAction.success) {
    // Defensive: malformed originalAction (schema drift, corrupted row,
    // pre-KAN-1037 garbage). Log + skip publish; status transition still
    // commits below. Operator's click registers; the missing dispatch
    // surfaces in audit log as the legacy `recommendation.accept` (no
    // publishedActionDecidedId) so ops can spot the parse failure.
    console.warn(
      `[recommendations.accept] Escalation ${before.id} has malformed originalAction; skipping publish`,
      parsedAction.error.flatten(),
    );
  } else if (parsedAction?.success && ctx.pubsubClient) {
    // KAN-1005 M2-6b — decisionId is now REQUIRED on PublishActionInput.
    // The originating Escalation MUST carry a real Decision row id for
    // the operator-accept dispatch to be FK-clean downstream. Skip
    // emission with a warn-log when the escalation was guardrail-block
    // or lead-assignment (decisionId=null per the Null-safe pattern at
    // line 23-25 docstring) — the status-transition still commits.
    if (!before.decisionId) {
      console.warn(
        `[recommendations.accept] skip publishActionDecided escalationId=${before.id} reason=null_decisionId — status-transition only; operator may need to manually dispatch the modified action`,
      );
    } else {
      // M3-1b follow-up — auto-carry discoveryTarget from the original
      // Decision when the operator's modifiedAction.payload omits it.
      // Pre-fix gap: the accept route assigned `actionPayload =
      // input.modifiedAction.payload` unconditionally → operator
      // accepting a discovery escalation through the standard UI flow
      // (which doesn't echo back the engine's discoveryTarget) stripped
      // the discovery directive → composeMessage downstream got no
      // gapContext → routine body produced instead of discovery body.
      // Operator-override-wins: if operator explicitly provides
      // discoveryTarget (even pointing at a different sub-objective),
      // their value is preserved, the original is NOT shadowed.
      // KAN-1043 tracks a follow-up cleanup that reads from
      // before.originalAction.payload (the new column) instead of digging
      // through decision.metadata — deferred to keep KAN-1037 surgical.
      const originalDiscoveryTarget = (
        before.decision?.metadata as
          | { action?: { actionPayload?: { discoveryTarget?: unknown } } }
          | undefined
      )?.action?.actionPayload?.discoveryTarget;
      const operatorPayload = parsedAction.data.payload;
      const mergedActionPayload =
        originalDiscoveryTarget !== undefined && operatorPayload.discoveryTarget === undefined
          ? { ...operatorPayload, discoveryTarget: originalDiscoveryTarget }
          : operatorPayload;

      const publishInput: PublishActionInput = {
        tenantId: ctx.tenantId,
        contactId: before.contactId,
        objectiveId:
          ((before.context as Record<string, unknown> | null)?.objectiveId as string | undefined) ??
          'unknown',
        // KAN-1005 M2-6b — real Decision row id from the originating
        // escalation; downstream consumers FK-reference this.
        decisionId: before.decisionId,
        actionType: parsedAction.data.actionType,
        channel: parsedAction.data.channel,
        actionPayload: mergedActionPayload,
        selectedStrategy: before.decision?.strategySelected ?? 'human_override',
        confidenceScore: before.decision?.confidence ?? 1.0,
        strategyReasoning: before.decision?.reasoning ?? `Operator accepted recommendation ${before.id}`,
        actionReasoning: `human_override via recommendations.accept`,
        // KAN-1005 M2-5 — approve-to-send path is an OPERATOR-curated
        // decision (the operator explicitly accepted/modified the AI's
        // proposed action). Marked 'approve_to_send' so action-decided-
        // push.ts SKIPS sampling.
        decisionSource: 'approve_to_send',
      };
      try {
        const result = await publishActionDecided(ctx.pubsubClient, publishInput);
        publishedEventId = result.messageId ?? null;
        // KAN-1037 — discriminate audit by which branch fired the publish.
        // accept_no_modification_published flags the new originalAction-
        // backed dispatch; modify-and-accept retains the existing reason
        // for back-compat with prior audit dashboards.
        auditActionType = input.modifiedAction
          ? 'recommendation.accept'
          : 'accept_no_modification_published';
      } catch (err) {
        console.error(`[recommendations.accept] publishActionDecided failed escalationId=${before.id}:`, err);
        // Don't fail the mutation — operator already committed. The escalation
        // still resolves; missing emit is logged for ops to retry manually.
      }
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

  await writeAuditBestEffort(ctx.prisma, ctx.tenantId, ctx.actor, auditActionType, {
    escalationId: before.id,
    beforeStatus: before.status,
    afterStatus: 'resolved',
    modifiedAction: input.modifiedAction ?? null,
    // KAN-1037 — record whether the publish drew from operator modify, the
    // engine-emitted originalAction fallback, or neither. Enables ops to
    // trace the post-fix dispatch behavior across the queue.
    publishSource: parsedAction?.success
      ? input.modifiedAction
        ? 'modified_action'
        : 'original_action'
      : 'none',
    publishedActionDecidedId: publishedEventId,
  });

  return { id: updated.id, status: updated.status, publishedEventId };
}

export async function modifyRecommendation(
  ctx: MutationContext,
  input: ModifyInput,
) {
  const before = await loadEscalation(ctx.prisma, ctx.tenantId, input.id);

  // KAN-1005 M2-5 — double-dispatch guard. Samples cannot be modified
  // (action already executed; modifying the AI's suggestion is
  // semantically nonsense post-hoc).
  assertNotSample(before, 'modify');

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

/**
 * KAN-1140 Phase 3 PR 6 — operator-corrected metadata path for
 * `parse_confidence_review` escalations.
 *
 * Flow:
 *  1. Load escalation + assert `triggerType === 'parse_confidence_review'`
 *     and status is non-terminal (open or claimed).
 *  2. Stamp persistence targets:
 *       - `correctedLanguage` → `Contact.language` (FORCE-overwrite —
 *         bypasses the consumer-side "preserve existing" guard at
 *         `lead-received-push.ts`. Operator-explicit; intent overrides
 *         prior auto-set).
 *       - `correctedVendor` → `Deal.metadata.leadVendor` (merge into
 *         existing jsonb; preserves siblings like `formSource` / `leadType`).
 *       - `correctedFormat` → forensic-only; lands on Engagement.metadata
 *         via the consumer's re-write of the synthetic event (NOT updated
 *         here; the synthetic-republish path is what gives us a fresh
 *         Engagement row with the corrected forensic stamp).
 *  3. Reconstruct the LeadReceivedEvent from
 *     `escalation.context.originalWirePayload` (stashed at insert time
 *     in `lead-received-push.ts` per the Q4 corrected-metadata persistence
 *     lock). Overlay:
 *       - `metadata.parseConfidenceOverride: true` (loop-guard — consumer
 *         skips the parse-confidence trigger on this event).
 *       - `metadata.parseCorrections: { format?, language?, vendor? }`
 *         (forensic forwarding; consumer lands on Engagement.metadata).
 *       - `metadata.language: correctedLanguage` (overwrites the wire
 *         value so lead-normalizer's locale block sees the corrected
 *         locale on the immediate re-normalize).
 *       - `metadata.vendor: correctedVendor` (overwrites for first-turn
 *         path; consumer's `writePhase1Deal` at L1614 lands on
 *         `Deal.metadata.leadVendor`).
 *  4. Publish the synthetic event to `lead.received` Pub/Sub.
 *  5. Mark escalation `resolved` + write audit log entry.
 *
 * Errors are categorized:
 *   - NOT_FOUND / BAD_REQUEST → bubble up to tRPC.
 *   - Publish failure → bubble up (operator can retry; escalation stays
 *     open). NOT swallowed because the operator clicked Reclassify and
 *     expects either success or a clear error.
 */
export async function reclassifyRecommendation(
  ctx: MutationContext,
  input: ReclassifyInput,
) {
  const before = await loadEscalation(ctx.prisma, ctx.tenantId, input.id);

  if (before.triggerType !== 'parse_confidence_review') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        `Reclassify is only valid for parse_confidence_review escalations; ` +
        `this escalation has triggerType=${before.triggerType}.`,
    });
  }

  if (before.status === 'resolved' || before.status === 'dismissed') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Recommendation already ${before.status}`,
    });
  }

  // At least one correction must be supplied — empty reclassify is a
  // no-op that should be done via accept (which is the "extraction was
  // right, just go" path).
  if (
    !input.correctedFormat &&
    !input.correctedLanguage &&
    !input.correctedVendor
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'Reclassify requires at least one of correctedFormat / correctedLanguage / correctedVendor. ' +
        'Use accept if the original extraction was correct.',
    });
  }

  // Extract the stashed wire payload — load-bearing for the synthetic-
  // republish step. Per the Q4 lock, lead-received-push.ts stashes the
  // full event on `escalation.context.originalWirePayload` so we can
  // reconstruct losslessly.
  const ctxBlob = (before.context ?? {}) as {
    originalWirePayload?: unknown;
    dealId?: string;
    contactId?: string;
  };
  const originalWirePayload = ctxBlob.originalWirePayload;
  if (!originalWirePayload) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message:
        'Escalation context is missing originalWirePayload — cannot reconstruct synthetic event. ' +
        'This escalation may predate KAN-1140 Phase 3 PR 6.',
    });
  }

  // Stamp persistence targets BEFORE publishing the synthetic event so
  // the consumer can observe the corrected state on re-read if needed.
  // Language: force-overwrite the consumer-side "preserve existing"
  // guard — operator-explicit intent.
  if (input.correctedLanguage) {
    await ctx.prisma.contact.update({
      where: { id: before.contactId },
      data: { language: input.correctedLanguage },
    });
  }

  // Vendor: merge into Deal.metadata jsonb (preserves siblings).
  // dealId is captured in escalation.context at insert time.
  if (input.correctedVendor && ctxBlob.dealId) {
    const deal = await ctx.prisma.deal.findFirst({
      where: { id: ctxBlob.dealId, tenantId: ctx.tenantId },
      select: { metadata: true },
    });
    if (deal) {
      const existingMetadata =
        (deal.metadata as Record<string, unknown> | null) ?? {};
      await ctx.prisma.deal.update({
        where: { id: ctxBlob.dealId },
        data: {
          metadata: {
            ...existingMetadata,
            leadVendor: input.correctedVendor,
          } as never,
        },
      });
    }
  }

  // Reconstruct + parse the synthetic event. Re-parsing through
  // LeadReceivedEventSchema catches any drift between the stashed
  // payload's shape and the current schema (defense-in-depth — schema
  // additions like KAN-1140 Phase 2 PR #306's `language` were optional,
  // so old stashes still parse cleanly; this guards future breaking
  // additions).
  const parsed = LeadReceivedEventSchema.safeParse(originalWirePayload);
  if (!parsed.success) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `Stashed originalWirePayload no longer parses against current LeadReceivedEventSchema: ${parsed.error.message}`,
    });
  }
  const syntheticEvent = {
    ...parsed.data,
    metadata: {
      ...parsed.data.metadata,
      // Loop-guard — consumer's parse-confidence check short-circuits.
      parseConfidenceOverride: true,
      // Forensic forwarding — consumer lands on Engagement.metadata
      // (first-turn path writes the new Engagement row with these
      // values; multi-turn path doesn't re-trigger here per Q-ADD-1
      // first-turn-only scope).
      parseCorrections: {
        ...(input.correctedFormat ? { format: input.correctedFormat } : {}),
        ...(input.correctedLanguage ? { language: input.correctedLanguage } : {}),
        ...(input.correctedVendor ? { vendor: input.correctedVendor } : {}),
      },
      // Overwrite wire values so the consumer's immediate re-normalize
      // sees the corrected locale (lead-normalizer's locale block in
      // packages/api/src/services/lead-normalizer.ts:415-417) and the
      // first-turn Deal write picks up the corrected vendor at
      // lead-received-push.ts:L1614.
      ...(input.correctedLanguage ? { language: input.correctedLanguage } : {}),
      ...(input.correctedVendor ? { vendor: input.correctedVendor } : {}),
    },
  };

  // Publish — failure bubbles up so operator can retry.
  if (!ctx.pubsubClient) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'pubsubClient missing on reclassify — cannot publish synthetic event.',
    });
  }
  const messageId = await ctx.pubsubClient.publish(
    LEAD_RECEIVED_TOPIC,
    Buffer.from(JSON.stringify(syntheticEvent)),
    {
      eventType: 'lead.received',
      version: '1.0',
      source: 'kan_1140_phase_3_pr_6_reclassify',
    },
  );

  // Mark escalation resolved AFTER publish succeeds.
  const updated = await ctx.prisma.escalation.update({
    where: { id: before.id },
    data: {
      status: 'resolved',
      resolvedBy: ctx.actor,
      resolvedAt: new Date(),
    },
  });

  await writeAuditBestEffort(ctx.prisma, ctx.tenantId, ctx.actor, 'recommendation.reclassify', {
    escalationId: before.id,
    beforeStatus: before.status,
    afterStatus: 'resolved',
    corrections: {
      ...(input.correctedFormat ? { format: input.correctedFormat } : {}),
      ...(input.correctedLanguage ? { language: input.correctedLanguage } : {}),
      ...(input.correctedVendor ? { vendor: input.correctedVendor } : {}),
    },
    syntheticEventId: syntheticEvent.eventId,
    pubsubMessageId: messageId,
  });

  return {
    id: updated.id,
    status: updated.status,
    syntheticEventId: syntheticEvent.eventId,
    pubsubMessageId: messageId,
  };
}
