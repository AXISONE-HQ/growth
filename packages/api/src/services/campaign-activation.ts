/**
 * KAN-1010 — SAE PR5: audience.activate() + audience.pause().
 *
 * The trigger that wakes the autonomous Decision Engine for committed
 * campaigns. Closes Milestone 1.
 *
 * # Safety architecture (pre-conditions live in PR1-PR4)
 *
 *   PR1 (state model):     committed/paused enum values exist
 *   PR3 (consumer guards): decision.run no-ops unless
 *                           campaign.status='active' AND
 *                           audienceEvaluatedAt IS NOT NULL AND
 *                           stack.status='active'
 *   PR4 (cost cap):        per-tenant daily LLM $-cap + dedup window
 *                           fire-and-forget Redis increment post-eval
 *   Kill-switch:           Tenant.autoApproveEnabled=false → threshold
 *                           gate routes ALL outcomes to ESCALATED →
 *                           Escalation row, no action.decided publish
 *
 * PR5 = the deliberate handoff. activate() flips campaign.status to
 * 'active', creates ContactObjectiveStack entries (one per member; PR1
 * back-link populated), and drip-publishes decision.run per member at
 * a rate-limited cadence. pause() is the stop lever: flips status +
 * stack rows to 'paused' so the PR3 consumer guard fails for every
 * in-flight / redelivered event.
 *
 * # What this DOES NOT do
 *
 *   - NO send-path code. activate/pause only publish decision.run and
 *     flip status; the existing PR3 consumer + Decision Engine governance
 *     chain handle the rest. Grep-provable (test extends PR3/PR4 source-
 *     grep regression).
 *   - NO governance changes. autoApproveEnabled is untouched. M1 is
 *     escalate-only by construction.
 *   - NO Pub/Sub backlog purge on pause. The stack-status='paused' guard
 *     makes any queued events inert. Faster + simpler than purging.
 *
 * # Hooks pattern (per reference_hooks_pattern_for_purity)
 *
 * AuditLog writes and Pub/Sub publishes go through injected hooks so
 * unit tests capture each call verbatim and the inertness invariants
 * stay testable without bringing the full Prisma + Pub/Sub stack.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Default drip cap when ACTIVATE_DRIP_PUBLISHES_PER_SECOND env unset.
 *  10 pubs/sec → 13,584-member campaign takes ~23 min to fully publish.
 *  Cost cap (PR4) is the orthogonal bound on total $; this is the
 *  rate-bound to prevent consumer thundering-herd. */
export const DEFAULT_DRIP_PUBLISHES_PER_SECOND = 10;

/** Batch size for paginated stack-member reads in the drip publisher.
 *  Matches the campaign-materialize-push batch size for visual consistency. */
export const DRIP_BATCH_SIZE = 500;

// ─────────────────────────────────────────────
// Hook contracts
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
   *  row commits/rolls-back atomically with the state transition. */
  writeInTx: (
    tx: unknown,
    input: AuditLogWriteInput,
  ) => Promise<{ id: string }>;
}

export interface PubSubPublishHook {
  /** Publish a decision.run event. Returns the Pub/Sub messageId.
   *  Called in a loop by the drip publisher (rate-limited by caller). */
  publishDecisionRun: (args: {
    tenantId: string;
    contactId: string;
    campaignId: string;
  }) => Promise<string>;
}

export interface ActivateHooks {
  auditLog: AuditLogHook;
  pubsub: PubSubPublishHook;
}

export interface PauseHooks {
  auditLog: AuditLogHook;
}

// ─────────────────────────────────────────────
// Prisma surface (typed loosely; same posture as campaign-commit.ts)
// ─────────────────────────────────────────────

export interface ActivatePrisma {
  $transaction: <T>(
    fn: (tx: ActivateTransactionClient) => Promise<T>,
  ) => Promise<T>;
  campaign: {
    findFirst: (args: {
      where: { id: string; tenantId: string };
      select: {
        id: true;
        status: true;
        audienceEvaluatedAt: true;
        objectiveId: true;
        priority: true;
        audienceSnapshotCount: true;
      };
    }) => Promise<{
      id: string;
      status: string;
      audienceEvaluatedAt: Date | null;
      objectiveId: string;
      priority: number;
      audienceSnapshotCount: number | null;
    } | null>;
  };
  campaignMembership: {
    findMany: (args: {
      where: { campaignId: string; tenantId: string; exitedAt: null };
      select: { contactId: true };
      take?: number;
      cursor?: { id: string };
      skip?: number;
      orderBy?: { id: 'asc' | 'desc' };
    }) => Promise<Array<{ contactId: string }>>;
  };
  contactObjectiveStack: {
    findMany: (args: {
      where: { campaignId: string; tenantId: string; status: { in: string[] } };
      select: { id: true; contactId: true };
      take?: number;
      cursor?: { id: string };
      skip?: number;
      orderBy?: { id: 'asc' };
    }) => Promise<Array<{ id: string; contactId: string }>>;
  };
}

export interface ActivateTransactionClient {
  campaign: {
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<{ id: string; status: string }>;
  };
  campaignMembership: {
    findMany: (args: {
      where: { campaignId: string; tenantId: string };
      select: { contactId: true };
    }) => Promise<Array<{ contactId: string }>>;
  };
  contactObjectiveStack: {
    createMany: (args: {
      data: Array<{
        tenantId: string;
        contactId: string;
        objectiveId: string;
        campaignId: string;
        priority: number;
        status: 'active';
      }>;
      skipDuplicates?: boolean;
    }) => Promise<{ count: number }>;
    updateMany: (args: {
      where: { tenantId: string; campaignId: string; status?: { in: string[] } | string };
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
}

// ─────────────────────────────────────────────
// activate()
// ─────────────────────────────────────────────

export const ActivateInputSchema = z.object({
  campaignId: z.string().uuid(),
  userId: z.string().optional(),
});
export type ActivateInput = z.infer<typeof ActivateInputSchema>;

export type ActivateResult =
  | {
      kind: 'activated';
      campaignId: string;
      memberCount: number;
      stackEntriesCreated: number;
      stackEntriesReactivated: number;
      dripPublishesPerSecond: number;
    }
  | {
      kind: 'already_active';
      campaignId: string;
      memberCount: number;
    }
  | {
      kind: 'rejected';
      campaignId: string;
      reason:
        | 'campaign_not_found'
        | 'audience_not_evaluated'
        | 'status_draft'
        | 'status_paused'
        | 'status_completed'
        | 'status_archived';
      currentStatus?: string;
    };

/**
 * Activate a committed campaign. Returns immediately after the tx commits
 * + the drip-publish hook is dispatched (fire-and-forget). UI shows the
 * member count + drip rate; full progress is in Cloud Logging.
 *
 * Idempotent: re-invoking on an active campaign returns kind='already_active'
 * without re-publishing decision.run events.
 *
 * INERT in the sense PR3 made it INERT for un-active campaigns:
 *   - decision.run events ARE published by activate
 *   - but the consumer's PR3+PR4 gates STILL run on every event
 *   - under autoApproveEnabled=false the kill-switch routes all
 *     decisions to ESCALATED → Escalation row, no action.decided
 *
 * This is the meaning of "M1 ships escalate-only by construction":
 * the only path to a send is auto-approve=true (M2 territory).
 */
export async function activateCampaign(
  prisma: ActivatePrisma,
  tenantId: string,
  input: ActivateInput,
  hooks: ActivateHooks,
  opts: {
    /** Drip-publish rate; default DEFAULT_DRIP_PUBLISHES_PER_SECOND.
     *  Production wires from ACTIVATE_DRIP_PUBLISHES_PER_SECOND env var. */
    publishesPerSecond?: number;
  } = {},
): Promise<ActivateResult> {
  const parsed = ActivateInputSchema.parse(input);
  const publishesPerSecond =
    opts.publishesPerSecond ?? DEFAULT_DRIP_PUBLISHES_PER_SECOND;

  // ── Precondition lookup ───────────────────────────────────
  const campaign = await prisma.campaign.findFirst({
    where: { id: parsed.campaignId, tenantId },
    select: {
      id: true,
      status: true,
      audienceEvaluatedAt: true,
      objectiveId: true,
      priority: true,
      audienceSnapshotCount: true,
    },
  });
  if (!campaign) {
    return {
      kind: 'rejected',
      campaignId: parsed.campaignId,
      reason: 'campaign_not_found',
    };
  }

  // Idempotency on active → no-op, no re-publish
  if (campaign.status === 'active') {
    // Count current members so the response is meaningful.
    const members = await prisma.campaignMembership.findMany({
      where: { campaignId: campaign.id, tenantId, exitedAt: null },
      select: { contactId: true },
    });
    return {
      kind: 'already_active',
      campaignId: campaign.id,
      memberCount: members.length,
    };
  }

  // Non-committed states → reject with named reason
  if (campaign.status !== 'committed') {
    const reasonMap: Record<string, ActivateResult & { kind: 'rejected' }> = {
      draft: {
        kind: 'rejected',
        campaignId: campaign.id,
        reason: 'status_draft',
        currentStatus: 'draft',
      },
      paused: {
        kind: 'rejected',
        campaignId: campaign.id,
        reason: 'status_paused',
        currentStatus: 'paused',
      },
      completed: {
        kind: 'rejected',
        campaignId: campaign.id,
        reason: 'status_completed',
        currentStatus: 'completed',
      },
      archived: {
        kind: 'rejected',
        campaignId: campaign.id,
        reason: 'status_archived',
        currentStatus: 'archived',
      },
    };
    return (
      reasonMap[campaign.status] ?? {
        kind: 'rejected',
        campaignId: campaign.id,
        reason: 'status_draft',
        currentStatus: campaign.status,
      }
    );
  }

  // PR3 interlock: audienceEvaluatedAt IS NOT NULL — refuse to wake a
  // partially-materialized snapshot. The PR3 decision-run-push consumer
  // ALSO gates on this defensively; activate gates here so the operator
  // sees a clear error rather than a silent no-op queue of guard-rejections.
  if (campaign.audienceEvaluatedAt === null) {
    return {
      kind: 'rejected',
      campaignId: campaign.id,
      reason: 'audience_not_evaluated',
      currentStatus: campaign.status,
    };
  }

  // ── Tx: status flip + stack upsert + audit log ────────────
  const txResult = await prisma.$transaction(async (tx) => {
    // Load members (within tx for read-consistency; cheap, snapshot count
    // already known from campaign.audienceSnapshotCount).
    const members = await tx.campaignMembership.findMany({
      where: { campaignId: campaign.id, tenantId },
      select: { contactId: true },
    });

    // UPSERT stack entries: createMany skipDuplicates handles the
    // never-existed-before case (most contacts on first activate). The
    // separate updateMany below flips any existing-but-paused/blocked
    // entries to 'active' (handles pause→activate cycle + the edge case
    // of cross-campaign-same-objective collisions where the existing
    // stack row stays put with its current campaignId — that gap is
    // documented in the PR description; affects cross-campaign sharing
    // of the same objective, not in single-tenant M1 reality).
    const created = await tx.contactObjectiveStack.createMany({
      data: members.map((m) => ({
        tenantId,
        contactId: m.contactId,
        objectiveId: campaign.objectiveId,
        campaignId: campaign.id,
        priority: campaign.priority,
        status: 'active' as const,
      })),
      skipDuplicates: true,
    });

    const reactivated = await tx.contactObjectiveStack.updateMany({
      where: {
        tenantId,
        campaignId: campaign.id,
        status: { in: ['paused', 'blocked'] },
      },
      data: { status: 'active' },
    });

    // Flip campaign status + bump activatedAt (semantic now == "engine
    // handoff fired at"; overwrites the KAN-1002 "membership snapshotted
    // at" timestamp).
    await tx.campaign.update({
      where: { id: campaign.id },
      data: { status: 'active', activatedAt: new Date() },
    });

    await hooks.auditLog.writeInTx(tx, {
      tenantId,
      actor: input.userId ?? 'system',
      actionType: 'campaign.activated',
      payload: {
        campaignId: campaign.id,
        memberCount: members.length,
        stackEntriesCreated: created.count,
        stackEntriesReactivated: reactivated.count,
        dripPublishesPerSecond: publishesPerSecond,
      },
      reasoning:
        'KAN-1010 SAE PR5 activate — campaign.status → active; stack entries upserted; decision.run drip-publish dispatched. Under autoApproveEnabled=false every eval lands as an Escalation row (M1 escalate-only).',
    });

    return {
      memberCount: members.length,
      stackEntriesCreated: created.count,
      stackEntriesReactivated: reactivated.count,
    };
  });

  // ── Post-tx: drip-publish decision.run per member (fire-and-forget) ──
  // NEVER throws to caller. The drip walks the just-created stack rows
  // (status='active', campaignId-tagged) rather than the membership list
  // so reactivated rows are picked up correctly + paused/blocked entries
  // that didn't get reactivated (e.g., during a race) are excluded.
  void dripPublishDecisionRun(
    prisma,
    {
      tenantId,
      campaignId: campaign.id,
      publishesPerSecond,
    },
    hooks.pubsub,
  ).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        type: 'campaign_activate_drip_failed',
        tenantId,
        campaignId: campaign.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  });

  return {
    kind: 'activated',
    campaignId: campaign.id,
    memberCount: txResult.memberCount,
    stackEntriesCreated: txResult.stackEntriesCreated,
    stackEntriesReactivated: txResult.stackEntriesReactivated,
    dripPublishesPerSecond: publishesPerSecond,
  };
}

// ─────────────────────────────────────────────
// pause()
// ─────────────────────────────────────────────

export const PauseInputSchema = z.object({
  campaignId: z.string().uuid(),
  userId: z.string().optional(),
});
export type PauseInput = z.infer<typeof PauseInputSchema>;

export type PauseResult =
  | {
      kind: 'paused';
      campaignId: string;
      stackEntriesPaused: number;
    }
  | {
      kind: 'already_inactive';
      campaignId: string;
      currentStatus: string;
    }
  | {
      kind: 'rejected';
      campaignId: string;
      reason: 'campaign_not_found' | 'status_draft' | 'status_committed';
      currentStatus?: string;
    };

/**
 * Pause an active campaign. The stop lever (Gate 6 of the SAE safety
 * architecture). Flips campaign.status='paused' + updateMany the
 * campaign's stack rows to status='paused' so the PR3 consumer guard
 * fails on every in-flight or redelivered decision.run.
 *
 * Idempotent on already-inactive states (paused/completed/archived).
 * draft/committed get rejected (there's nothing to halt).
 *
 * Does NOT purge the Pub/Sub backlog: the stack-status guard is what
 * makes queued events inert. Faster + simpler than purging.
 */
export async function pauseCampaign(
  prisma: ActivatePrisma,
  tenantId: string,
  input: PauseInput,
  hooks: PauseHooks,
): Promise<PauseResult> {
  const parsed = PauseInputSchema.parse(input);

  const campaign = await prisma.campaign.findFirst({
    where: { id: parsed.campaignId, tenantId },
    select: {
      id: true,
      status: true,
      audienceEvaluatedAt: true,
      objectiveId: true,
      priority: true,
      audienceSnapshotCount: true,
    },
  });
  if (!campaign) {
    return {
      kind: 'rejected',
      campaignId: parsed.campaignId,
      reason: 'campaign_not_found',
    };
  }

  if (campaign.status === 'paused' || campaign.status === 'archived' || campaign.status === 'completed') {
    return {
      kind: 'already_inactive',
      campaignId: campaign.id,
      currentStatus: campaign.status,
    };
  }

  if (campaign.status === 'draft' || campaign.status === 'committed') {
    return {
      kind: 'rejected',
      campaignId: campaign.id,
      reason: campaign.status === 'draft' ? 'status_draft' : 'status_committed',
      currentStatus: campaign.status,
    };
  }

  // status === 'active' → pause it
  const result = await prisma.$transaction(async (tx) => {
    const stackUpdate = await tx.contactObjectiveStack.updateMany({
      where: {
        tenantId,
        campaignId: campaign.id,
        status: 'active',
      },
      data: { status: 'paused' },
    });

    await tx.campaign.update({
      where: { id: campaign.id },
      data: { status: 'paused' },
    });

    await hooks.auditLog.writeInTx(tx, {
      tenantId,
      actor: input.userId ?? 'system',
      actionType: 'campaign.paused',
      payload: {
        campaignId: campaign.id,
        stackEntriesPaused: stackUpdate.count,
      },
      reasoning:
        'KAN-1010 SAE PR5 pause — campaign.status → paused; stack rows → paused. Pub/Sub backlog NOT purged; PR3 consumer guard makes queued events inert.',
    });

    return { stackEntriesPaused: stackUpdate.count };
  });

  return {
    kind: 'paused',
    campaignId: campaign.id,
    stackEntriesPaused: result.stackEntriesPaused,
  };
}

// ─────────────────────────────────────────────
// Drip publisher
// ─────────────────────────────────────────────

export interface DripPublishArgs {
  tenantId: string;
  campaignId: string;
  publishesPerSecond: number;
  /** Optional sleep impl for testability. Defaults to real setTimeout-based
   *  sleep; tests inject a controlled stub. */
  sleep?: (ms: number) => Promise<void>;
}

export interface DripPublishResult {
  totalStackEntriesProcessed: number;
  totalPublished: number;
  totalPublishErrors: number;
  batchCount: number;
}

/**
 * Drip-publish decision.run events for every active stack entry tagged
 * to a campaign. Paginated to avoid loading thousands of rows; rate-
 * limited so the consumer doesn't thundering-herd the LLM path.
 *
 * Loop shape:
 *   - Fetch DRIP_BATCH_SIZE active stack rows (cursor-paginated by id asc)
 *   - For each row: publish + count
 *   - Sleep enough to maintain publishesPerSecond
 *   - Repeat until empty page
 *
 * Errors per publish are structured-logged + counted; the loop continues
 * (one bad message shouldn't halt the entire campaign activation). The
 * loop itself can throw on DB outage → caller (activate's fire-and-
 * forget IIFE) catches + structured-logs.
 */
export async function dripPublishDecisionRun(
  prisma: ActivatePrisma,
  args: DripPublishArgs,
  pubsub: PubSubPublishHook,
): Promise<DripPublishResult> {
  const sleep =
    args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interPublishMs = Math.max(1, Math.floor(1000 / args.publishesPerSecond));

  let cursor: string | undefined = undefined;
  let totalStackEntriesProcessed = 0;
  let totalPublished = 0;
  let totalPublishErrors = 0;
  let batchCount = 0;

  while (true) {
    const rows = await prisma.contactObjectiveStack.findMany({
      where: {
        tenantId: args.tenantId,
        campaignId: args.campaignId,
        // Re-check active inside the loop — pause() during the drip can
        // flip rows to 'paused' mid-flight and we should respect that.
        status: { in: ['active'] },
      },
      select: { id: true, contactId: true },
      take: DRIP_BATCH_SIZE,
      orderBy: { id: 'asc' },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (rows.length === 0) break;
    batchCount += 1;
    totalStackEntriesProcessed += rows.length;

    for (const row of rows) {
      try {
        await pubsub.publishDecisionRun({
          tenantId: args.tenantId,
          contactId: row.contactId,
          campaignId: args.campaignId,
        });
        totalPublished += 1;
      } catch (err) {
        totalPublishErrors += 1;
        // eslint-disable-next-line no-console
        console.error(
          JSON.stringify({
            type: 'decision_run_drip_publish_error',
            tenantId: args.tenantId,
            campaignId: args.campaignId,
            contactId: row.contactId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      await sleep(interPublishMs);
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        type: 'decision_run_drip_progress',
        tenantId: args.tenantId,
        campaignId: args.campaignId,
        batchNumber: batchCount,
        totalStackEntriesProcessed,
        totalPublished,
        totalPublishErrors,
      }),
    );

    if (rows.length < DRIP_BATCH_SIZE) break;
    cursor = rows[rows.length - 1]!.id;
  }

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      type: 'decision_run_drip_complete',
      tenantId: args.tenantId,
      campaignId: args.campaignId,
      totalStackEntriesProcessed,
      totalPublished,
      totalPublishErrors,
      batchCount,
    }),
  );

  return {
    totalStackEntriesProcessed,
    totalPublished,
    totalPublishErrors,
    batchCount,
  };
}
