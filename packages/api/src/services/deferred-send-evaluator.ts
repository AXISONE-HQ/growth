/**
 * KAN-814 — Deferred send evaluator.
 * KAN-1119 — Atomic CTE claim + 'processing' intermediate state + status-
 *            guarded mark helpers + publish-failure revert (sibling to
 *            KAN-1046's engine-path discipline, now extended to action_send).
 *
 * Pure module. Cron worker (Cloud Scheduler → growth-api
 * `/internal/cron/deferred-send-evaluator`) calls `processPendingDeferredSends`
 * every 5 minutes. The evaluator:
 *
 *   1. KAN-1119: Atomically claims pending rows whose `defer_until <= NOW()`
 *      via a CTE that SELECTs with `FOR UPDATE SKIP LOCKED` and UPDATEs
 *      them to `status='processing'` in a single statement. Concurrent
 *      workers' CTEs see 'processing' and skip — no double-claim.
 *   2. For each claimed row, re-evaluates Send Policy.
 *   3. On `allow` → writes the Decision row (KAN-815c shim pattern, deferred
 *      to re-dispatch time per spec) + dispatches via `publishActionSend` +
 *      marks row `dispatched` via status-guarded updateMany. On publish
 *      failure → reverts 'processing' → 'pending' for next-tick retry
 *      (KAN-1119 extending KAN-1046's discipline to action_send path).
 *   4. On still-`defer` → increments attempts, advances `defer_until`,
 *      reverts 'processing' → 'pending'. After `maxAttempts` retries
 *      (default 12 → ~24h with 2-hour cadence) → marks row `expired`.
 *   5. On `deny` → marks row `cancelled` with `cancelReason='policy_now_denies'`
 *      (e.g., contact unsubscribed during the defer window).
 *
 * Status state machine (KAN-1119):
 *
 *     pending  ──[CTE atomic claim]──▶  processing
 *     processing ──[markDispatched]──▶  dispatched   (terminal)
 *     processing ──[markExpired]────▶   expired      (terminal)
 *     processing ──[markCancelled]──▶   cancelled    (terminal)
 *     processing ──[reDefer]────────▶   pending      (loop with new defer_until)
 *     processing ──[markRevertToPending]▶ pending    (publish-failure recovery)
 *
 * Race-window contract with KAN-814 supersession (fresh inbound on
 * (deal, contact) cancels deferred rows): the evaluator's mark helpers
 * status-guard on 'processing' via updateMany; the supersession matches
 * `status IN ('pending', 'processing')`. Two outcomes:
 *   - Supersession wins → mark* updateMany returns count=0 → publish skipped
 *     (action_send path) or "superseded after publish" logged (action_decided
 *     path where Pub/Sub fired pre-mark per KAN-1046 publish-flag ordering).
 *   - Evaluator wins → terminal status reached before supersession runs →
 *     supersession's IN-filter doesn't match → cancelledRows=0 (no-op).
 *
 * Idempotency: each row's `id` is a natural anchor. Worker crash mid-process
 * is safe — the catch path in `processPendingDeferredSends` calls
 * `markRevertToPending` so failed rows return to 'pending' for the next tick.
 *
 * Pure-module discipline: caller (the cron HTTP route) handles auth +
 * shape the trigger. This module accepts a PrismaClient + dependency-
 * injected `evaluateSendPolicy` + `publishActionSend` + `resolveEmailConnectionId`
 * + `resolveReplyToForTenant` so unit tests can mock cleanly without
 * touching prisma or the publish layer.
 *
 * Sibling pattern to:
 *   - feedback_brain_service_pure_module_pattern (zero callers wired in this
 *     module; route handler does the wiring)
 *   - feedback_phase_2_wiring_decision_row_shim_for_legacy_publishactionsend
 *     (Decision row written DURING dispatch, not before)
 *   - feedback_state_machine_extensions_must_enumerate_recovery_paths
 *     (16th memo candidate banked from KAN-1119 — every state machine
 *     extension must enumerate all recovery paths that previously
 *     assumed rows retained their original state)
 */
import type { PrismaClient } from '@prisma/client';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type DeferredSendStatus = 'pending' | 'dispatched' | 'expired' | 'cancelled';

export interface DeferredSendPayload {
  brainDecision: Record<string, unknown>;
  composed: { subject: string; body: string; tone?: string };
  contactEmail: string;
  shaperTier?: string;
  shaperInputTokens?: number;
  shaperOutputTokens?: number;
  originalEventId?: string;
}

/**
 * KAN-1005 M2-2 — engine-path payload shape. Stashed verbatim by
 * action-decided-push.ts when send-policy returns `defer`; the cron worker
 * re-publishes the event via publishActionDecided so the full chain
 * (compose + guardrail + dispatch) reruns post-defer.
 */
export interface DeferredEngineActionDecidedPayload {
  actionDecidedEvent: Record<string, unknown>;
  originalEventId?: string;
}

export interface ProcessOptions {
  /** Default 100 — max rows claimed per cron invocation. */
  batchSize?: number;
  /** Default 12 → ~24h with 2-hour cadence. */
  maxAttempts?: number;
  /** Default 2h — how far to push defer_until forward on a still-deferred re-eval. */
  retryIntervalMs?: number;
  /** Dependency injection for testability. Production wires the canonical
   *  evaluateSendPolicy from packages/api/src/services/send-policy.ts. */
  evaluateSendPolicy: (
    prisma: PrismaClient,
    tenantId: string,
    contactId: string,
    message: { channel: 'email' },
  ) => Promise<
    | { type: 'allow'; reason: string }
    | { type: 'deny'; reason: string; ruleViolated: string }
    | { type: 'defer'; reason: string; deferUntil: Date }
  >;
  /** publishActionSend from message-composer.ts. Used for replayVia='action_send'
   *  (Lead Inbox, pre-shaped message). */
  publishActionSend: (
    pubsubClient: unknown,
    args: {
      tenantId: string;
      contactId: string;
      decisionId: string;
      toEmail: string;
      composed: { subject: string; body: string; unsubscribeUrl: string };
      connectionId: string;
      replyTo?: string;
    },
  ) => Promise<string>;
  /**
   * KAN-1005 M2-2 — engine-path replay publisher. Used for
   * replayVia='action_decided' (engine path): cron re-publishes the
   * verbatim ActionDecidedEvent so the full chain reruns. Optional for
   * back-compat with callers that only handle Lead Inbox rows.
   *
   * KAN-1046 — production wires this to `republishActionDecidedEvent`
   * (re-validator), not `publishActionDecided` (builder). The builder
   * expects flat `PublishActionInput` and threw `ZodError` on every
   * replay because the stashed payload is the already-built nested
   * envelope. Re-validator `safeParse`s the envelope and publishes it
   * verbatim. Return shape widened to include `published` so the
   * dispatcher can keep rows in `pending` on publish failure rather
   * than silently marking them `dispatched`.
   */
  publishActionDecided?: (
    pubsubClient: unknown,
    event: Record<string, unknown>,
  ) => Promise<{ published: boolean; messageId: string | null }>;
  /** resolveEmailConnectionId from message-composer.ts. */
  resolveEmailConnectionId: (prisma: PrismaClient, tenantId: string) => Promise<string | null>;
  /** resolveReplyToForTenant from message-composer.ts. */
  resolveReplyToForTenant: (prisma: PrismaClient, tenantId: string) => Promise<string | null>;
  /** Pub/Sub client factory (KAN-815c lifecycle pattern). */
  getPubSubClient: () => unknown;
  /** Public webhook base URL — used to build unsubscribeUrl on re-dispatch.
   *  Defaults to env.PUBLIC_WEBHOOK_BASE_URL or 'https://example.invalid'. */
  publicWebhookBaseUrl?: string;
}

export interface ProcessResult {
  totalClaimed: number;
  dispatched: number;
  reDeferred: number;
  expired: number;
  cancelled: number;
  errors: number;
  rowResults: RowResult[];
}

export interface RowResult {
  id: string;
  outcome: 'dispatched' | 're_deferred' | 'expired' | 'cancelled' | 'error';
  reason?: string;
  /** Present on dispatched outcomes. */
  decisionId?: string;
  /** Present on dispatched outcomes — Pub/Sub message id from publishActionSend. */
  pubsubMessageId?: string;
  /** Present on error outcomes. */
  error?: string;
}

// Internal raw shape for the claimed row.
interface ClaimedRow {
  id: string;
  tenant_id: string;
  /** KAN-1005 M2-2 — nullable. Engine-path defers may have no Deal anchor. */
  deal_id: string | null;
  contact_id: string;
  /** Shape depends on replay_via — Lead Inbox: DeferredSendPayload;
   *  engine path: DeferredEngineActionDecidedPayload. */
  payload: DeferredSendPayload | DeferredEngineActionDecidedPayload;
  defer_until: Date;
  attempts: number;
  /** KAN-1005 M2-2 — defaults to 'action_send' for pre-M2-2 rows (column
   *  default in the migration). */
  replay_via: string;
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Process all pending deferred-send rows whose defer_until has elapsed.
 *
 * Concurrency-safe — uses `FOR UPDATE SKIP LOCKED` to claim rows; multiple
 * cron workers running concurrently will each claim a disjoint subset and
 * not double-process.
 */
export async function processPendingDeferredSends(
  prisma: PrismaClient,
  opts: ProcessOptions,
): Promise<ProcessResult> {
  const batchSize = opts.batchSize ?? 100;
  const maxAttempts = opts.maxAttempts ?? 12;
  const retryIntervalMs = opts.retryIntervalMs ?? 2 * 60 * 60 * 1000; // 2h
  const result: ProcessResult = {
    totalClaimed: 0,
    dispatched: 0,
    reDeferred: 0,
    expired: 0,
    cancelled: 0,
    errors: 0,
    rowResults: [],
  };

  // KAN-1119 — Atomic claim via CTE. The previous SELECT-only-with-
  // FOR-UPDATE-SKIP-LOCKED implementation was concurrency-unsafe:
  // `$queryRaw` runs each statement as a single auto-committed
  // transaction, so the row locks acquired by `FOR UPDATE SKIP LOCKED`
  // were released the moment the SELECT returned. A concurrent worker's
  // SELECT would then see the same `status='pending'` rows and re-claim
  // them, producing double-send when ticks overlap (high-load batches,
  // Cloud Run autoscale, scheduler retries, operator-triggered ticks).
  //
  // The CTE wraps SELECT + UPDATE in a single statement. Postgres holds
  // the row locks for the entire CTE's duration, and the UPDATE
  // transitions claimed rows from 'pending' to 'processing' BEFORE the
  // lock releases. A concurrent worker's CTE re-SELECT then sees
  // 'processing' (which the WHERE clause excludes) and skips. Mark-*
  // helpers below status-guard on 'processing' as defense-in-depth
  // (catches the supersession-mid-processing race; see KAN-814 +
  // KAN-1119 race-window contract documented at processOneRow).
  //
  // Two-stage processing preserved: (1) claim in this CTE, (2) process
  // each row in its own auto-committed update via the mark-* helpers.
  // Avoids holding a long lock if dispatch hangs (publishActionSend
  // blocked, Pub/Sub backpressure, etc.).
  const claimed = await prisma.$queryRaw<ClaimedRow[]>`
    WITH locked AS (
      SELECT id FROM deferred_sends
      WHERE status = 'pending' AND defer_until <= NOW()
      ORDER BY defer_until ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE deferred_sends ds
    SET status = 'processing', last_attempt_at = NOW()
    FROM locked
    WHERE ds.id = locked.id
    RETURNING ds.id, ds.tenant_id, ds.deal_id, ds.contact_id, ds.payload, ds.defer_until, ds.attempts, ds.replay_via
  `;

  result.totalClaimed = claimed.length;

  for (const row of claimed) {
    try {
      const rowResult = await processOneRow(prisma, row, {
        ...opts,
        maxAttempts,
        retryIntervalMs,
      });
      result.rowResults.push(rowResult);
      switch (rowResult.outcome) {
        case 'dispatched':
          result.dispatched++;
          break;
        case 're_deferred':
          result.reDeferred++;
          break;
        case 'expired':
          result.expired++;
          break;
        case 'cancelled':
          result.cancelled++;
          break;
      }
    } catch (err) {
      const errMsg = (err as Error)?.message ?? String(err);
      console.error(
        `[deferred-send-evaluator] row-process-failed id=${row.id} err=${errMsg}`,
      );
      result.errors++;
      result.rowResults.push({
        id: row.id,
        outcome: 'error',
        error: errMsg,
      });
      // KAN-1119 — revert from 'processing' back to 'pending' so the next
      // cron tick re-claims this row. Without this, the CTE atomic claim
      // leaves errored rows stuck in 'processing' (the WHERE clause filters
      // on 'pending' only). Preserves KAN-1046's "failed rows stay pending
      // for next-tick retry" semantic now that claim is a state transition.
      // Status-guarded so a supersession that cancelled the row mid-flight
      // doesn't get clobbered back to 'pending'.
      await markRevertToPending(prisma, row.id).catch((revertErr: unknown) => {
        console.warn(
          `[deferred-send-evaluator] revert-to-pending-failed id=${row.id} err=${(revertErr as Error)?.message ?? String(revertErr)}`,
        );
      });
      // KAN-1046 — surface the failure via AuditLog so silent
      // catch+retry loops are queryable post-hoc. Greppable via
      // actionType='deferred_send_replay_failed'. Best-effort —
      // a failed audit write must not destabilize the catch path.
      void prisma.auditLog
        .create({
          data: {
            tenantId: row.tenant_id,
            actor: 'cron_deferred_send_evaluator',
            actionType: 'deferred_send_replay_failed',
            reasoning: errMsg,
            payload: {
              rowId: row.id,
              replayVia: row.replay_via,
              contactId: row.contact_id,
              dealId: row.deal_id,
              attempts: row.attempts,
            },
          },
        })
        .catch((auditErr: unknown) => {
          console.warn(
            `[deferred-send-evaluator] audit-emit-replay-failed-failed id=${row.id} err=${(auditErr as Error)?.message ?? String(auditErr)}`,
          );
        });
      // Don't re-throw — process the rest of the batch. Failed rows
      // reverted to 'pending' (above) and will be retried on the next
      // cron tick.
    }
  }

  console.log(
    `[deferred-send-evaluator] tick-complete totalClaimed=${result.totalClaimed} dispatched=${result.dispatched} reDeferred=${result.reDeferred} expired=${result.expired} cancelled=${result.cancelled} errors=${result.errors}`,
  );

  return result;
}

async function processOneRow(
  prisma: PrismaClient,
  row: ClaimedRow,
  opts: ProcessOptions & { maxAttempts: number; retryIntervalMs: number },
): Promise<RowResult> {
  // Re-evaluate Send Policy. Send Policy reads tenant settings + recent
  // engagement state — both could have changed between defer and now.
  const policy = await opts.evaluateSendPolicy(prisma, row.tenant_id, row.contact_id, {
    channel: 'email',
  });

  if (policy.type === 'deny') {
    await markCancelled(prisma, row.id, 'policy_now_denies');
    console.warn(
      `[deferred-send-evaluator] row-cancelled id=${row.id} reason=policy_now_denies originalDeferReason=${policy.reason}`,
    );
    return { id: row.id, outcome: 'cancelled', reason: 'policy_now_denies' };
  }

  if (policy.type === 'defer') {
    const newAttempts = row.attempts + 1;
    if (newAttempts >= opts.maxAttempts) {
      await markExpired(prisma, row.id, newAttempts);
      console.warn(
        `[deferred-send-evaluator] row-expired id=${row.id} attempts=${newAttempts} maxAttempts=${opts.maxAttempts} originalDeferReason=${policy.reason}`,
      );
      return { id: row.id, outcome: 'expired', reason: 'max_attempts_reached' };
    }
    // Re-defer. Push defer_until forward by retryIntervalMs from now,
    // OR honor policy.deferUntil if it's later (e.g., next tenant window).
    const nextDeferUntil = new Date(
      Math.max(Date.now() + opts.retryIntervalMs, policy.deferUntil.getTime()),
    );
    await reDefer(prisma, row.id, nextDeferUntil, newAttempts);
    return { id: row.id, outcome: 're_deferred', reason: policy.reason };
  }

  // policy.type === 'allow' → dispatch.
  // KAN-1005 M2-2 — switch on replay_via discriminator.
  //   - 'action_send'    → Lead Inbox path (pre-shaped message, skip
  //                        re-compose, dispatch directly).
  //   - 'action_decided' → engine path (re-publish ActionDecidedEvent;
  //                        full chain reruns).
  // Default 'action_send' (the column default) covers pre-M2-2 rows
  // written by KAN-814 Lead Inbox before this PR shipped.
  if (row.replay_via === 'action_decided') {
    return dispatchActionDecidedReplay(prisma, row, opts);
  }
  return dispatchActionSendReplay(prisma, row, opts);
}

/**
 * KAN-1005 M2-2 — engine-path replay. Re-publishes the stashed
 * ActionDecidedEvent so the subscriber chain (action-decided-push.ts →
 * compose + guardrail + dispatch) reruns. Send-policy is NOT re-evaluated
 * here — the caller (processOneRow) already did that and confirmed
 * 'allow'; the subscriber will skip its own send-policy gate as a
 * harmless redundancy (the gate is idempotent + cheap).
 *
 * Decision row NOT written here; the downstream subscriber doesn't write
 * one either (engine path's decisionId comes from the original
 * runDecisionForContact emission, which already wrote a Decision before
 * publishing action.decided).
 */
async function dispatchActionDecidedReplay(
  prisma: PrismaClient,
  row: ClaimedRow,
  opts: ProcessOptions & { maxAttempts: number; retryIntervalMs: number },
): Promise<RowResult> {
  if (!opts.publishActionDecided) {
    // Caller didn't wire the engine-path publisher but has an
    // engine-path row claimed. Treat as configuration error: cancel
    // with audit, alert operator. Better than silent loss.
    await markCancelled(prisma, row.id, 'engine_replay_unconfigured');
    console.error(
      `[deferred-send-evaluator] row-cancelled id=${row.id} reason=engine_replay_unconfigured replayVia=action_decided — caller did not provide publishActionDecided`,
    );
    return {
      id: row.id,
      outcome: 'cancelled',
      reason: 'engine_replay_unconfigured',
    };
  }

  const enginePayload = row.payload as DeferredEngineActionDecidedPayload;
  if (!enginePayload.actionDecidedEvent) {
    // Payload shape doesn't match replay_via — defensive guard. Cancel.
    await markCancelled(prisma, row.id, 'engine_replay_payload_malformed');
    console.error(
      `[deferred-send-evaluator] row-cancelled id=${row.id} reason=engine_replay_payload_malformed — payload missing actionDecidedEvent field`,
    );
    return {
      id: row.id,
      outcome: 'cancelled',
      reason: 'engine_replay_payload_malformed',
    };
  }

  const pubsubClient = opts.getPubSubClient();
  const result = await opts.publishActionDecided(pubsubClient, enginePayload.actionDecidedEvent);

  // KAN-1046 — honor the publisher's `published` flag. Pre-fix this
  // dispatcher always called markDispatched, so corrupted-envelope
  // re-validation failures and Pub/Sub publish errors silently
  // transitioned rows to `dispatched`. Now: failed publish leaves the
  // row in `pending` for next-tick retry; the audit row written by the
  // caller (processPendingDeferredSends catch path) surfaces drift via
  // actionType='deferred_send_replay_failed'.
  if (!result.published) {
    // KAN-1119 — revert from 'processing' → 'pending' so the next cron
    // tick re-claims. Without this, the CTE atomic claim leaves the row
    // stuck in 'processing' (next tick's WHERE filters on 'pending').
    // Status-guarded inside markRevertToPending — supersession-cancelled
    // rows aren't touched.
    await markRevertToPending(prisma, row.id).catch((revertErr: unknown) => {
      console.warn(
        `[deferred-send-evaluator] engine-revert-to-pending-failed id=${row.id} err=${(revertErr as Error)?.message ?? String(revertErr)}`,
      );
    });
    console.error(
      `[deferred-send-evaluator] engine-row-publish-failed id=${row.id} replayVia=action_decided attempts=${row.attempts + 1} — row reverted to pending`,
    );
    return {
      id: row.id,
      outcome: 'error',
      error: 'engine_replay_publish_failed',
    };
  }

  const dispatched = await markDispatched(prisma, row.id, row.attempts + 1);
  if (!dispatched.updated) {
    // KAN-1119 race-window contract: supersession-cancelled the row between
    // our publish and our terminal status update. Message already went out
    // (Pub/Sub fired pre-markDispatched per the KAN-1046 publish-flag
    // ordering). Row state is now 'cancelled' (set by supersession).
    // Logging this rare branch so operators can correlate "dispatched
    // outcome with no terminal status update" if it ever surfaces.
    console.warn(
      `[deferred-send-evaluator] engine-row-superseded-after-publish id=${row.id} pubsubMessageId=${result.messageId} — message already published`,
    );
  }

  console.log(
    `[deferred-send-evaluator] engine-row-dispatched id=${row.id} pubsubMessageId=${result.messageId} replayVia=action_decided attempts=${row.attempts + 1}`,
  );

  return {
    id: row.id,
    outcome: 'dispatched',
    pubsubMessageId: result.messageId ?? undefined,
  };
}

/**
 * KAN-814 Lead Inbox path — pre-shaped message, dispatch via
 * publishActionSend. Decision row written at re-dispatch time
 * (KAN-815c shim).
 */
async function dispatchActionSendReplay(
  prisma: PrismaClient,
  row: ClaimedRow,
  opts: ProcessOptions & { maxAttempts: number; retryIntervalMs: number },
): Promise<RowResult> {
  // Resolve current connectionId + replyTo at re-dispatch time (Brain's
  // T1 message intent stays fixed; transport resolves to current state).
  const connectionId = await opts.resolveEmailConnectionId(prisma, row.tenant_id);
  if (!connectionId) {
    // Connection went away between defer and re-dispatch. Cancel + audit;
    // requires operator intervention to re-add a ChannelConnection.
    await markCancelled(prisma, row.id, 'no_active_email_connection_at_redispatch');
    console.warn(
      `[deferred-send-evaluator] row-cancelled id=${row.id} reason=no_active_email_connection_at_redispatch`,
    );
    return { id: row.id, outcome: 'cancelled', reason: 'no_active_email_connection_at_redispatch' };
  }

  const replyTo = await opts.resolveReplyToForTenant(prisma, row.tenant_id);

  const leadPayload = row.payload as DeferredSendPayload;

  // Write Decision row at re-dispatch time (KAN-815c shim pattern).
  const brainDecision = leadPayload.brainDecision as {
    nextBestAction?: { type?: string; reasoning?: string };
    confidence?: number;
    modelTier?: string;
    evaluatedAt?: string;
    llmInputTokens?: number;
    llmOutputTokens?: number;
    currentStateSnapshot?: { currentStageName?: string; daysInCurrentStage?: number };
  };
  const decisionRow = await prisma.decision.create({
    data: {
      tenantId: row.tenant_id,
      contactId: row.contact_id,
      strategySelected: 'brain_phase_2_v1',
      actionType: brainDecision.nextBestAction?.type ?? 'send_follow_up',
      confidence: brainDecision.confidence ?? 0,
      reasoning: brainDecision.nextBestAction?.reasoning ?? '(no reasoning recorded)',
      metadata: {
        // KAN-814: re-dispatched-from-deferred audit anchor.
        redispatchedFromDeferredSendId: row.id,
        deferredSendCreatedAt: undefined, // filled by analytics join on deferred_sends.created_at
        dealId: row.deal_id,
        originalEventId: leadPayload.originalEventId,
        brainEvaluatedAt: brainDecision.evaluatedAt,
        brainModelTier: brainDecision.modelTier,
        brainInputTokens: brainDecision.llmInputTokens,
        brainOutputTokens: brainDecision.llmOutputTokens,
        currentStageName: brainDecision.currentStateSnapshot?.currentStageName,
        daysInCurrentStage: brainDecision.currentStateSnapshot?.daysInCurrentStage,
        shaperTier: leadPayload.shaperTier,
        shaperInputTokens: leadPayload.shaperInputTokens,
        shaperOutputTokens: leadPayload.shaperOutputTokens,
        shapedTone: leadPayload.composed.tone,
      },
    },
  });

  const publicWebhookBaseUrl =
    opts.publicWebhookBaseUrl ?? process.env.PUBLIC_WEBHOOK_BASE_URL ?? 'https://example.invalid';
  const composedWithUnsubscribe = {
    subject: leadPayload.composed.subject,
    body: leadPayload.composed.body,
    unsubscribeUrl: `${publicWebhookBaseUrl}/unsubscribe/${row.contact_id}`,
  };

  const pubsubClient = opts.getPubSubClient();
  let messageId: string;
  try {
    messageId = await opts.publishActionSend(pubsubClient, {
      tenantId: row.tenant_id,
      contactId: row.contact_id,
      decisionId: decisionRow.id,
      toEmail: leadPayload.contactEmail,
      composed: composedWithUnsubscribe,
      connectionId,
      ...(replyTo ? { replyTo } : {}),
    });
  } catch (publishErr) {
    // KAN-1119 — sibling fix to KAN-1046's engine-path publish-error
    // handling. Pre-KAN-1119 the action_send path had NO publish-error
    // recovery — an exception from publishActionSend propagated up to
    // the processPendingDeferredSends catch (which now calls revert),
    // but only because of the catch-path safety net. Explicit revert
    // here means a publish-failure logged at this site doesn't depend
    // on the outer catch path semantics. Decision row was already
    // written above; it will be re-written by the next cron-tick
    // re-dispatch (KAN-815c shim accepts duplicate Decision rows as
    // analytics-only; the dispatched message is what counts).
    await markRevertToPending(prisma, row.id).catch((revertErr: unknown) => {
      console.warn(
        `[deferred-send-evaluator] action-send-revert-to-pending-failed id=${row.id} err=${(revertErr as Error)?.message ?? String(revertErr)}`,
      );
    });
    console.error(
      `[deferred-send-evaluator] action-send-publish-failed id=${row.id} attempts=${row.attempts + 1} — row reverted to pending; err=${(publishErr as Error)?.message ?? String(publishErr)}`,
    );
    throw publishErr;
  }

  const dispatched = await markDispatched(prisma, row.id, row.attempts + 1);
  if (!dispatched.updated) {
    // KAN-1119 race-window contract: supersession-cancelled the row between
    // our publish and our terminal status update. Message already went out.
    // Row state is now 'cancelled' (set by supersession). Logged for
    // operator correlation; not an error condition.
    console.warn(
      `[deferred-send-evaluator] action-send-row-superseded-after-publish id=${row.id} pubsubMessageId=${messageId} — message already published`,
    );
  }

  console.log(
    `[deferred-send-evaluator] row-dispatched id=${row.id} dealId=${row.deal_id} decisionId=${decisionRow.id} pubsubMessageId=${messageId} attempts=${row.attempts + 1}`,
  );

  return {
    id: row.id,
    outcome: 'dispatched',
    decisionId: decisionRow.id,
    pubsubMessageId: messageId,
  };
}

// ─────────────────────────────────────────────
// State transitions
// ─────────────────────────────────────────────

// KAN-1119 — All terminal/loop transitions status-guard on 'processing'. The
// CTE atomic claim transitions 'pending' → 'processing'; helpers below only
// match 'processing'-state rows. If a row was transitioned out of 'processing'
// (e.g., supersession cancelled it mid-flight), `updateMany` returns count=0
// and the caller learns via `{ updated: false }`. Callers then SKIP any
// downstream side effects (Pub/Sub publish, Decision row write, etc.) since
// the row is no longer ours to dispatch.
//
// reDefer transitions 'processing' → 'pending' (re-defer cycle); markDispatched /
// markExpired / markCancelled are terminal transitions out of 'processing'.

async function markDispatched(
  prisma: PrismaClient,
  id: string,
  attempts: number,
): Promise<{ updated: boolean }> {
  const result = await (
    prisma as unknown as {
      deferredSend: { updateMany: (args: unknown) => Promise<{ count: number }> };
    }
  ).deferredSend.updateMany({
    where: { id, status: 'processing' },
    data: { status: 'dispatched', attempts, lastAttemptAt: new Date() },
  });
  return { updated: result.count === 1 };
}

async function reDefer(
  prisma: PrismaClient,
  id: string,
  newDeferUntil: Date,
  newAttempts: number,
): Promise<{ updated: boolean }> {
  const result = await (
    prisma as unknown as {
      deferredSend: { updateMany: (args: unknown) => Promise<{ count: number }> };
    }
  ).deferredSend.updateMany({
    where: { id, status: 'processing' },
    data: {
      status: 'pending',
      attempts: newAttempts,
      deferUntil: newDeferUntil,
      lastAttemptAt: new Date(),
    },
  });
  return { updated: result.count === 1 };
}

async function markExpired(
  prisma: PrismaClient,
  id: string,
  attempts: number,
): Promise<{ updated: boolean }> {
  const result = await (
    prisma as unknown as {
      deferredSend: { updateMany: (args: unknown) => Promise<{ count: number }> };
    }
  ).deferredSend.updateMany({
    where: { id, status: 'processing' },
    data: { status: 'expired', attempts, lastAttemptAt: new Date() },
  });
  return { updated: result.count === 1 };
}

async function markCancelled(
  prisma: PrismaClient,
  id: string,
  reason: string,
): Promise<{ updated: boolean }> {
  const result = await (
    prisma as unknown as {
      deferredSend: { updateMany: (args: unknown) => Promise<{ count: number }> };
    }
  ).deferredSend.updateMany({
    where: { id, status: 'processing' },
    data: { status: 'cancelled', cancelReason: reason, lastAttemptAt: new Date() },
  });
  return { updated: result.count === 1 };
}

/**
 * KAN-1119 — Revert a claimed row from 'processing' back to 'pending' so the
 * next cron tick re-claims it. Used on publish-failure recovery paths
 * (preserves KAN-1046's "leave the row pending for retry" semantic now that
 * the CTE atomic claim transitions rows OUT of 'pending' at claim time).
 *
 * KAN-1046 originally fixed the engine-path dispatcher's silent-mark-dispatched-
 * on-publish-failure bug. KAN-1119 extends the same discipline to the
 * action_send path (which historically had no publish-error handling — a
 * sibling gap surfaced during the KAN-1119 cascade discovery).
 *
 * Status-guarded on 'processing' so supersession-cancelled rows aren't
 * accidentally reverted back to 'pending'.
 */
async function markRevertToPending(
  prisma: PrismaClient,
  id: string,
): Promise<{ updated: boolean }> {
  const result = await (
    prisma as unknown as {
      deferredSend: { updateMany: (args: unknown) => Promise<{ count: number }> };
    }
  ).deferredSend.updateMany({
    where: { id, status: 'processing' },
    // attempts NOT incremented — the claim wasn't a real send attempt.
    data: { status: 'pending', lastAttemptAt: new Date() },
  });
  return { updated: result.count === 1 };
}
