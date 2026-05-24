/**
 * KAN-1001 Campaign Layer Slice 3a — commit & materialize (INERT).
 * KAN-1004 SAE PR1 — status='committed' (was 'active'; the earlier name
 * was a misnomer — committed campaigns are observable but no autonomous
 * consumer evaluates members. 'active' is now reserved for PR3's
 * engine-active state).
 *
 * Pure service module called by the apps/api/src/router.ts tRPC layer.
 * Loaded via variable-specifier dynamic import (per
 * `reference_variable_specifier_dynamic_import.md`) to bypass TS6059.
 *
 * # What this does
 *
 *   1. Idempotency check — soft 5-minute window on (tenantId, name,
 *      status IN ('committed','active')). If a duplicate is in flight
 *      (e.g., user double-clicked Commit), return the existing IDs
 *      without writing.
 *
 *   2. In a single $transaction:
 *      a. INSERT Campaign row (status='committed', activatedAt=now)
 *      b. INSERT Pipeline row + nested Stages (campaignId back-link)
 *      c. If audienceCount ≤ MEMBERSHIP_SYNC_LIMIT (500): INSERT
 *         CampaignMembership rows in batch (source='snapshot')
 *      d. INSERT AuditLog row (actor=userId or 'system'; actionType=
 *         'campaign.commit'; payload={campaignId,pipelineId,stageIds,
 *         audienceCount,membershipMode}).
 *
 *   3. If audienceCount > MEMBERSHIP_SYNC_LIMIT: AFTER the tx commits,
 *      kick off `materializeAudienceSnapshot` via the injected hook
 *      (`hooks.materializeAsync`). In-process fire-and-forget batched
 *      INSERT (deviation from "Cloud Tasks pattern" — flagged in the
 *      Phase 4 report; full Pub/Sub subscriber chain is a 3a follow-up).
 *      audienceEvaluatedAt + audienceSnapshotCount populated on success.
 *
 * # What this DOES NOT do (the INERT property)
 *
 *   - NO ContactObjectiveStack writes (no `create|createMany|upsert`)
 *   - NO Decision Engine handoff (no call to `runForContact`)
 *   - NO Pub/Sub publish to `action.*`, `decision.*`, `escalation.*`
 *   - NO LLM call (commit is deterministic; the LLM ran at propose time)
 *
 * Slice 3b adds the ContactObjectiveStack push that wakes the Decision
 * Engine, gated separately with its own auto-approve / governance audit.
 *
 * # Hooks pattern (per reference_hooks_pattern_for_purity)
 *
 * The transaction-internal AuditLog write + the post-commit async kick-
 * off both go through injected hooks. Keeps this module Prisma-only
 * (no Pub/Sub, no logger dep) so unit tests can capture each call
 * verbatim and the inertness invariants are testable.
 */
import type { AudienceConditions } from '@growth/shared';
import {
  AudienceConditionsSchema,
  CampaignProposalSchema,
  CampaignStrategyEnum,
  type CampaignProposal,
} from '@growth/shared';
import { conditionsToWhere } from './audience-router.js';

/** Below this, materialization runs in the commit tx synchronously.
 *  Above this, we return immediately and the caller's `materializeAsync`
 *  hook handles paginated batching out-of-band. 500 keeps tx wall-clock
 *  well under 1s for the sync path on PROD's PG instance. */
export const MEMBERSHIP_SYNC_LIMIT = 500;

/** Idempotency soft-window — a re-commit within this many minutes of an
 *  earlier active commit (same tenantId+name) returns the existing IDs.
 *  Tradeoff: too short → real double-click slips through; too long →
 *  legitimate re-use of the same name blocked. 5 min covers the user's
 *  retry/double-click bursts; document the constraint in the Phase 4
 *  report so we don't drift on it. */
export const IDEMPOTENCY_WINDOW_MINUTES = 5;

/** Batch size for paginated async materialization. PG can handle larger
 *  createMany batches; 500 is conservative for memory + per-batch tx
 *  duration. */
export const ASYNC_MATERIALIZE_BATCH = 500;

// ─────────────────────────────────────────────
// Hook contracts (injected by the tRPC layer)
// ─────────────────────────────────────────────

export interface AuditLogWriteInput {
  tenantId: string;
  actor: string;
  actionType: string;
  payload: Record<string, unknown>;
  reasoning: string;
}

export interface AuditLogHook {
  /** Tx-aware write — receives the active TransactionClient so the audit
   *  row commits/rolls-back atomically with the campaign writes. */
  writeInTx: (
    tx: unknown,
    input: AuditLogWriteInput,
  ) => Promise<{ id: string }>;
}

export interface MaterializeAsyncHook {
  /** Called AFTER the commit tx succeeds. Fire-and-forget — must not
   *  block the caller. Errors get structured-logged inside the hook;
   *  the campaign is observable either way (audienceEvaluatedAt stays
   *  NULL until materialization completes). */
  kickOff: (args: {
    tenantId: string;
    campaignId: string;
    conditions: AudienceConditions;
  }) => void;
}

export interface CommitHooks {
  auditLog: AuditLogHook;
  materializeAsync: MaterializeAsyncHook;
}

// ─────────────────────────────────────────────
// Prisma surface (typed loosely — same posture as audience-router.ts)
// ─────────────────────────────────────────────

/** Minimal Prisma surface this module uses inside the transaction.
 *  Wider than AudiencePrisma — adds Campaign / Pipeline / Stage /
 *  CampaignMembership writes. */
export interface CommitPrisma {
  $transaction: <T>(
    fn: (tx: CommitTransactionClient) => Promise<T>,
  ) => Promise<T>;
  campaign: {
    findFirst: (args: {
      where: Record<string, unknown>;
      select?: Record<string, true>;
      orderBy?: Record<string, 'asc' | 'desc'>;
    }) => Promise<{
      id: string;
      pipelines?: Array<{ id: string }>;
    } | null>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
      select?: Record<string, true>;
    }) => Promise<{ id: string; status: string; archivedAt: Date | null }>;
  };
  contact: {
    count: (args: { where: Record<string, unknown> }) => Promise<number>;
    findMany: (args: {
      where: Record<string, unknown>;
      select: { id: true };
      take?: number;
      cursor?: { id: string };
      skip?: number;
      orderBy?: { id: 'asc' | 'desc' };
    }) => Promise<Array<{ id: string }>>;
  };
}

/** TransactionClient surface — same shape as CommitPrisma minus the
 *  $transaction recursion + extends with write delegates. */
export interface CommitTransactionClient {
  campaign: {
    findFirst: CommitPrisma['campaign']['findFirst'];
    create: (args: {
      data: Record<string, unknown>;
      select?: Record<string, true>;
    }) => Promise<{ id: string; tenantId: string; name: string }>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<{ id: string }>;
  };
  pipeline: {
    create: (args: {
      data: Record<string, unknown>;
      include?: Record<string, true>;
    }) => Promise<{
      id: string;
      stages: Array<{ id: string; order: number; name: string }>;
    }>;
  };
  contact: {
    count: (args: { where: Record<string, unknown> }) => Promise<number>;
    findMany: (args: {
      where: Record<string, unknown>;
      select: { id: true };
      take?: number;
      orderBy?: { id: 'asc' | 'desc' };
    }) => Promise<Array<{ id: string }>>;
  };
  campaignMembership: {
    createMany: (args: {
      data: Array<{
        tenantId: string;
        campaignId: string;
        contactId: string;
        source: 'snapshot' | 'dynamic_admit';
      }>;
      skipDuplicates?: boolean;
    }) => Promise<{ count: number }>;
  };
}

// ─────────────────────────────────────────────
// Input / output
// ─────────────────────────────────────────────

export interface CommitInput {
  /** Full validated proposal from the propose mutation. The tRPC layer
   *  re-parses via CampaignProposalSchema; this module ALSO re-parses
   *  defensively so direct service callers (future API consumers,
   *  tests) can't bypass the schema. */
  proposal: CampaignProposal;
  /** User-edited overrides — name + window (the only fields the UI
   *  allows editing in the proposal preview per Slice 2 UX). Optional;
   *  defaults to the proposal's values. */
  edits?: {
    name?: string;
    windowStartUtc?: string | null;
    windowEndUtc?: string | null;
  };
  /** Client-generated UUID for double-submit guard. Combined with the
   *  5-minute soft window check, this is the idempotency contract. */
  idempotencyKey: string;
  /** Acting user — written to AuditLog.actor + Campaign.createdByUserId.
   *  Optional for system-initiated commits (none in 3a, reserved for
   *  Slice 5 dynamic re-eval). */
  userId?: string;
}

export type MembershipMaterializationStatus =
  | 'materialized_sync'
  | 'deferred_async';

export interface CommitResult {
  /** True when the idempotency check found an existing active campaign
   *  with the same (tenantId, name) inside the window. */
  alreadyExisted: boolean;
  campaignId: string;
  pipelineId: string;
  stageIds: string[];
  audienceCount: number;
  membershipStatus: MembershipMaterializationStatus;
  /** Count of CampaignMembership rows inserted inside the commit tx.
   *  Always 0 when membershipStatus === 'deferred_async'. */
  membershipSnapshotCountSync: number;
}

// ─────────────────────────────────────────────
// Pipeline.objectiveType derivation
// ─────────────────────────────────────────────

/** Pipeline.objectiveType is REQUIRED (enum: warm_up_lead | book_appointment
 *  | buy_online | send_quote). The Objective row carries free-form type
 *  string ('reactivate', 'book_appointment', 'upsell', etc.). When the
 *  Objective.type matches one of the 4 enum values verbatim, use it; else
 *  fall back to a strategy-derived default. This is a Phase 1 dual-read
 *  artifact — Phase 2 routing reads Campaign.id, not Pipeline.objectiveType,
 *  so any reasonable default is forward-safe. */
type PipelineObjectiveTypeValue =
  | 'warm_up_lead'
  | 'book_appointment'
  | 'buy_online'
  | 'send_quote';

const PIPELINE_OBJECTIVE_TYPE_VALUES = new Set<PipelineObjectiveTypeValue>([
  'warm_up_lead',
  'book_appointment',
  'buy_online',
  'send_quote',
]);

function derivePipelineObjectiveType(
  objectiveType: string,
  strategy: CampaignProposal['strategy'],
): PipelineObjectiveTypeValue {
  if (PIPELINE_OBJECTIVE_TYPE_VALUES.has(objectiveType as PipelineObjectiveTypeValue)) {
    return objectiveType as PipelineObjectiveTypeValue;
  }
  // Strategy → reasonable default. Phase 2 retires this column entirely;
  // until then, route to the closest legacy semantic.
  switch (strategy) {
    case 'direct':
      return 'book_appointment';
    case 're_engage':
      return 'warm_up_lead';
    case 'trust_build':
      return 'warm_up_lead';
    case 'guided':
      return 'warm_up_lead';
  }
}

// ─────────────────────────────────────────────
// Commit
// ─────────────────────────────────────────────

/**
 * KAN-1001 Slice 3a — commit a validated proposal into Campaign +
 * Pipeline + Stages + initial CampaignMembership snapshot.
 *
 * Returns the persisted IDs + the materialization status. Throws on:
 *   - Proposal fails CampaignProposalSchema.parse (defense-in-depth)
 *   - Conditions fail AudienceConditionsSchema.parse
 *   - Transaction fails for any reason (no partial writes)
 *
 * INERT: never writes ContactObjectiveStack, never calls runForContact,
 * never publishes action.* events. Tested via inertness fixtures in
 * campaign-commit.test.ts.
 */
export async function commitCampaign(
  prisma: CommitPrisma,
  tenantId: string,
  input: CommitInput,
  hooks: CommitHooks,
): Promise<CommitResult> {
  // Defense-in-depth re-parse — service-direct callers (e.g., tests,
  // future internal API consumers) get the same validation the tRPC
  // layer applies.
  const proposal = CampaignProposalSchema.parse(input.proposal);
  const conditions = AudienceConditionsSchema.parse(
    proposal.audience.conditions,
  );
  CampaignStrategyEnum.parse(proposal.strategy);

  // Apply edits — UI allows name + window overrides on the proposal card.
  const effectiveName = (input.edits?.name ?? proposal.name).trim();
  if (effectiveName.length === 0 || effectiveName.length > 200) {
    throw new Error('commit: campaign name must be 1-200 characters');
  }
  const effectiveWindowStart =
    input.edits?.windowStartUtc !== undefined
      ? input.edits.windowStartUtc
      : proposal.windowStartUtc;
  const effectiveWindowEnd =
    input.edits?.windowEndUtc !== undefined
      ? input.edits.windowEndUtc
      : proposal.windowEndUtc;

  // ─── Idempotency: soft-window dedupe on (tenantId, name, active) ──
  // Looks for an active campaign with the same name created in the
  // last IDEMPOTENCY_WINDOW_MINUTES. If found, treat the call as a
  // retry: return the existing IDs WITHOUT writing anything new. This
  // is intentionally soft (not a UNIQUE constraint at the DB layer)
  // because campaign names ARE expected to repeat over time as users
  // re-run successful patterns.
  const windowCutoff = new Date(
    Date.now() - IDEMPOTENCY_WINDOW_MINUTES * 60 * 1000,
  );
  const existing = await prisma.campaign.findFirst({
    where: {
      tenantId,
      name: effectiveName,
      // KAN-1004 SAE PR1 — fresh commits land 'committed'. PR3-activated
      // ones may be 'active'; both are valid "this proposal already
      // produced a real campaign" hits within the soft window.
      status: { in: ['committed', 'active'] },
      createdAt: { gte: windowCutoff },
    },
    select: { id: true, pipelines: true },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    return {
      alreadyExisted: true,
      campaignId: existing.id,
      pipelineId: existing.pipelines?.[0]?.id ?? '',
      stageIds: [],
      audienceCount: 0,
      membershipStatus: 'materialized_sync',
      membershipSnapshotCountSync: 0,
    };
  }

  // ─── Pre-tx audience count (fresh; not the propose-time snapshot) ──
  // Routes the sync vs async decision. We use a fresh count rather than
  // the proposal's audience.count because the proposal may be stale
  // (audience grew between propose and commit).
  const freshCount = await prisma.contact.count({
    where: { AND: [{ tenantId }, conditionsToWhere(conditions)] },
  });

  const goSync = freshCount <= MEMBERSHIP_SYNC_LIMIT;

  // ─── Single transaction: Campaign + Pipeline + Stages + (sync) ─────
  const txResult = await prisma.$transaction(async (tx) => {
    const pipelineObjectiveType = derivePipelineObjectiveType(
      proposal.objective.type,
      proposal.strategy,
    );

    const nowIso = new Date();
    const campaignRow = await tx.campaign.create({
      data: {
        tenantId,
        name: effectiveName,
        nlIntent: null, // Phase 1: NL intent retained in Cloud Logging
                        //          jsonPayload.type='campaign_propose'; durable
                        //          intent capture is a later slice.
        objectiveId: proposal.objective.id,
        strategy: proposal.strategy,
        audienceConditions: conditions as unknown as object,
        audienceMode: 'static',
        audienceEvaluatedAt: goSync ? nowIso : null,
        audienceSnapshotCount: goSync ? freshCount : null,
        historicalValueUsdAtActivation: proposal.audience.historicalValueUsd,
        windowStart: effectiveWindowStart ? new Date(effectiveWindowStart) : null,
        windowEnd: effectiveWindowEnd ? new Date(effectiveWindowEnd) : null,
        // KAN-1004 SAE PR1 — commits land at status='committed' (INERT).
        // Slice 3a's earlier 'active' was a misnomer: a committed campaign
        // is observable but no autonomous consumer evaluates its members.
        // 'active' is now RESERVED for PR3's engine-active state (after
        // publish-on-activate fires). PR1 also backfills the 2 existing
        // PROD rows from active→committed so the consumer's status filter
        // (PR3) is meaningful from day one.
        status: 'committed',
        priority: 100,
        // activatedAt remains set on commit — it captures the moment the
        // membership snapshot is taken. PR3 will introduce a separate
        // engineActivatedAt-equivalent (or reuse this column) for the
        // distinct "engine handoff fired" moment. Until then, treat
        // activatedAt as "membership snapshotted at" for committed rows.
        activatedAt: nowIso,
        createdByUserId: input.userId ?? null,
      },
      select: { id: true, tenantId: true, name: true },
    });

    const pipelineRow = await tx.pipeline.create({
      data: {
        tenantId,
        name: effectiveName,
        description: `Pipeline owned by Campaign ${campaignRow.id}`,
        isActive: true,
        objectiveType: pipelineObjectiveType,
        objectiveDescription: proposal.objective.name,
        objectiveId: proposal.objective.id,
        campaignId: campaignRow.id,
        stages: {
          create: proposal.proposedStages.map((s, idx) => ({
            name: s.name,
            order: s.order,
            isInitial: idx === 0,
            isTerminal: false,
            outcomeType: 'open' as const,
          })),
        },
      },
      include: { stages: true },
    });

    let syncMembershipCount = 0;
    if (goSync && freshCount > 0) {
      // Sync materialization: fetch up to MEMBERSHIP_SYNC_LIMIT contact
      // IDs, batch-INSERT CampaignMembership rows (skipDuplicates honors
      // the @@unique([campaignId, contactId]) index — defensive against
      // any rare concurrent dynamic-admit race in Slice 5).
      const contacts = await tx.contact.findMany({
        where: { AND: [{ tenantId }, conditionsToWhere(conditions)] },
        select: { id: true },
        take: MEMBERSHIP_SYNC_LIMIT,
        orderBy: { id: 'asc' },
      });
      if (contacts.length > 0) {
        const inserted = await tx.campaignMembership.createMany({
          data: contacts.map((c) => ({
            tenantId,
            campaignId: campaignRow.id,
            contactId: c.id,
            source: 'snapshot' as const,
          })),
          skipDuplicates: true,
        });
        syncMembershipCount = inserted.count;
      }
    }

    // ─── Audit log (in-tx; commits/rolls-back atomically with Campaign) ─
    await hooks.auditLog.writeInTx(tx, {
      tenantId,
      actor: input.userId ?? 'system',
      actionType: 'campaign.commit',
      payload: {
        campaignId: campaignRow.id,
        pipelineId: pipelineRow.id,
        stageIds: pipelineRow.stages.map((s) => s.id),
        audienceCount: freshCount,
        membershipMode: goSync ? 'materialized_sync' : 'deferred_async',
        membershipSnapshotCountSync: syncMembershipCount,
        idempotencyKey: input.idempotencyKey,
        proposalStrategy: proposal.strategy,
        proposalObjectiveId: proposal.objective.id,
      },
      reasoning:
        'KAN-1001 Slice 3a commit — Campaign + Pipeline + initial membership snapshot persisted. INERT: no ContactObjectiveStack writes, no Decision Engine handoff, no action publishes.',
    });

    return {
      campaignId: campaignRow.id,
      pipelineId: pipelineRow.id,
      stageIds: pipelineRow.stages
        .sort((a, b) => a.order - b.order)
        .map((s) => s.id),
      syncMembershipCount,
    };
  });

  // ─── Post-tx: fire-and-forget async materialization for large audiences ─
  // NEVER throws to the caller; the hook captures + structured-logs any
  // failure. Campaign is observable either way — audienceEvaluatedAt
  // stays NULL until the worker completes, which Slice 3b's activation
  // path will check before proceeding.
  if (!goSync) {
    hooks.materializeAsync.kickOff({
      tenantId,
      campaignId: txResult.campaignId,
      conditions,
    });
  }

  return {
    alreadyExisted: false,
    campaignId: txResult.campaignId,
    pipelineId: txResult.pipelineId,
    stageIds: txResult.stageIds,
    audienceCount: freshCount,
    membershipStatus: goSync ? 'materialized_sync' : 'deferred_async',
    membershipSnapshotCountSync: txResult.syncMembershipCount,
  };
}

// ─────────────────────────────────────────────
// Archive (lifecycle transition)
// ─────────────────────────────────────────────

export interface ArchiveInput {
  campaignId: string;
  userId?: string;
}

export interface ArchiveResult {
  campaignId: string;
  status: 'archived';
  archivedAt: Date;
}

/**
 * KAN-1001 Slice 3a — archive lifecycle transition (tenant-scoped).
 *
 * Sets status='archived' + archivedAt=now. Tenant scoping enforced via
 * the WHERE clause — passing a campaignId from another tenant raises
 * "Campaign not found in tenant scope" (intentionally generic — same
 * shape as the rest of the protected procedures' not-found errors).
 *
 * NOTE: the brief asked for 'paused' lifecycle too, but the CampaignStatus
 * enum (draft | active | completed | archived) does NOT include 'paused'.
 * Adding 'paused' would be an additive schema migration; deferred to 3b
 * if Slice 3b's activation path needs pause/resume. Archive is enough
 * for the 3a "can be stopped" contract — archived campaigns are hidden
 * from the UI and don't accept new admits.
 */
export async function archiveCampaign(
  prisma: CommitPrisma,
  tenantId: string,
  input: ArchiveInput,
  hooks: { auditLog: AuditLogHook },
): Promise<ArchiveResult> {
  // Tenant-scoped lookup (defensive — the update below also enforces).
  const found = await prisma.campaign.findFirst({
    where: { id: input.campaignId, tenantId },
    select: { id: true },
  });
  if (!found) {
    throw new Error('Campaign not found in tenant scope');
  }

  const archivedAt = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    const updateRes = await tx.campaign.update({
      where: { id: input.campaignId },
      data: { status: 'archived', archivedAt },
    });
    await hooks.auditLog.writeInTx(tx, {
      tenantId,
      actor: input.userId ?? 'system',
      actionType: 'campaign.archive',
      payload: { campaignId: input.campaignId, archivedAt: archivedAt.toISOString() },
      reasoning:
        'KAN-1001 Slice 3a archive — campaign hidden + halted. INERT: no other side effects.',
    });
    return updateRes;
  });

  return {
    campaignId: updated.id,
    status: 'archived',
    archivedAt,
  };
}

// ─────────────────────────────────────────────
// Async materialization worker (in-process)
// ─────────────────────────────────────────────

export interface MaterializePrisma {
  contact: {
    findMany: (args: {
      where: Record<string, unknown>;
      select: { id: true };
      take?: number;
      cursor?: { id: string };
      skip?: number;
      orderBy?: { id: 'asc' | 'desc' };
    }) => Promise<Array<{ id: string }>>;
  };
  campaignMembership: {
    createMany: (args: {
      data: Array<{
        tenantId: string;
        campaignId: string;
        contactId: string;
        source: 'snapshot' | 'dynamic_admit';
      }>;
      skipDuplicates?: boolean;
    }) => Promise<{ count: number }>;
  };
  campaign: {
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<{ id: string }>;
  };
}

export interface MaterializeResult {
  campaignId: string;
  totalContactsScanned: number;
  totalMembershipInserted: number;
  batchCount: number;
}

/**
 * KAN-1001 Slice 3a — paginated async materialization.
 *
 * Called by the post-commit `materializeAsync` hook in the tRPC layer.
 * Pages contacts by ascending id, inserts CampaignMembership rows per
 * batch with skipDuplicates (defensive: the @@unique constraint catches
 * the rare race between sync + async paths if MEMBERSHIP_SYNC_LIMIT is
 * tuned downward and a future Slice 5 cron is also writing).
 *
 * Updates Campaign.audienceEvaluatedAt + audienceSnapshotCount at the
 * end. Failure mode: container restart mid-pagination → partial
 * snapshot, audienceEvaluatedAt stays NULL — Slice 3b's activation
 * path MUST gate on `audienceEvaluatedAt IS NOT NULL` (or trigger
 * re-materialization) before pushing ContactObjectiveStack entries.
 *
 * In-process choice (instead of Pub/Sub subscriber) is a documented
 * deviation from the brief's "Cloud Tasks pattern" — see the Phase 4
 * report. Full Pub/Sub subscriber chain (apps/api/src/subscribers/
 * campaign-materialize-push.ts + Terraform topic + IAM + OIDC verify)
 * tracked as a 3a follow-up. The in-process worker is correct for the
 * INERT 3a slice; durability matters more when Slice 3b adds activation.
 */
export async function materializeAudienceSnapshot(
  prisma: MaterializePrisma,
  args: {
    tenantId: string;
    campaignId: string;
    conditions: AudienceConditions;
  },
): Promise<MaterializeResult> {
  const conditions = AudienceConditionsSchema.parse(args.conditions);
  const where: Record<string, unknown> = {
    AND: [{ tenantId: args.tenantId }, conditionsToWhere(conditions)],
  };

  let cursor: string | undefined = undefined;
  let totalContactsScanned = 0;
  let totalMembershipInserted = 0;
  let batchCount = 0;

  while (true) {
    const rows = await prisma.contact.findMany({
      where,
      select: { id: true },
      take: ASYNC_MATERIALIZE_BATCH,
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;

    totalContactsScanned += rows.length;
    batchCount += 1;

    const ins = await prisma.campaignMembership.createMany({
      data: rows.map((r) => ({
        tenantId: args.tenantId,
        campaignId: args.campaignId,
        contactId: r.id,
        source: 'snapshot' as const,
      })),
      skipDuplicates: true,
    });
    totalMembershipInserted += ins.count;

    if (rows.length < ASYNC_MATERIALIZE_BATCH) break;
    cursor = rows[rows.length - 1]!.id;
  }

  await prisma.campaign.update({
    where: { id: args.campaignId },
    data: {
      audienceEvaluatedAt: new Date(),
      audienceSnapshotCount: totalContactsScanned,
    },
  });

  return {
    campaignId: args.campaignId,
    totalContactsScanned,
    totalMembershipInserted,
    batchCount,
  };
}
