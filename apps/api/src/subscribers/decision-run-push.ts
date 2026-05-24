/**
 * KAN-1007 — SAE PR3: decision.run push subscriber (DORMANT).
 *
 * Wakeup consumer for the autonomous Decision Engine. SHIPS DORMANT in
 * PR3 — no app code publishes `decision.run` until SAE PR5
 * (`audience.activate()`). The hard guards below would refuse to evaluate
 * any contact whose Campaign isn't status='active', and PR1's backfill
 * relabeled every existing inert campaign to 'committed'. So even a
 * manually-published decision.run event during PR3's smoke will no-op.
 *
 * # Three hard guards (load-bearing safety property)
 *
 * Before any call to `runDecisionForContact`, the consumer asserts:
 *
 *   1. Campaign.status === 'active'
 *      — Nothing has this status until PR5's `audience.activate()` writes
 *        it. PR1 (KAN-1004) backfilled the 2 existing PROD campaigns from
 *        'active' (3a-era misnomer) to 'committed' specifically so this
 *        guard means what it says.
 *
 *   2. Campaign.audienceEvaluatedAt IS NOT NULL
 *      — The partial-materialization interlock from
 *        `feedback_3a_inert_3b_interlock_audience_evaluated_at`. The async
 *        materialize worker only sets this column on full completion;
 *        a half-snapshot (container restart mid-pagination, in-flight
 *        Pub/Sub redelivery) leaves it NULL. PR5's activate() will gate
 *        on it; this consumer ALSO gates defensively so a future PR5 bug
 *        that publishes too eagerly still gets caught here.
 *
 *   3. ContactObjectiveStack.status === 'active' for (tenantId, contactId, campaignId)
 *      — The stack-row guard. Pause flips this to 'paused' for the whole
 *        campaign; the consumer skips paused stacks even if the campaign
 *        itself flips back to 'active' later. Defense in depth.
 *
 * All three pass → call `runDecisionForContact({tenantId, contactId})`
 * UNMODIFIED. The function carries the entire existing governance chain
 * (threshold gate, auto-approve matrix, escalation rules, kill-switch).
 * Under `Tenant.autoApproveEnabled = false` (current AxisOne posture,
 * per KAN-1002 Phase 1 Finding 2), the call resolves as an Escalation
 * row + zero outbound sends.
 *
 * Any guard fails → structured-log + 200 (ack). No retry — the only thing
 * Pub/Sub redelivery would do is re-fire the guard rejection.
 *
 * # NOT in PR3
 *
 *   - De-dup state (PR4 — `stack.lastEvaluatedAt` window). Pub/Sub
 *     at-least-once means redelivery can re-fire runDecisionForContact;
 *     each call writes a fresh Decision row. Acceptable in PR3 because
 *     no publisher exists; PR4 lands the dedup before PR5 wires the
 *     real trigger.
 *   - Cost cap (PR4).
 *   - Any new send-path code. The function called is the same
 *     `runDecisionForContact` already exercised by manual playbook launches.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { verifyPubsubOidc } from '../lib/oidc-pubsub-verify.js';
import {
  // KAN-1009 SAE PR4 — Redis-backed daily counter (cost cap) +
  // USD-typed convenience wrappers around it.
  getTodayCostUsd,
  incrementTodayCostUsd,
} from '../lib/per-tenant-daily-counter.js';
import { getRedisClient } from '../services/redis-client.js';

// ─────────────────────────────────────────────
// Variable-specifier dynamic import for the cross-rootDir Decision Engine
// entry point. Same pattern the rest of apps/api uses.
// ─────────────────────────────────────────────

interface RunDecisionModule {
  runDecisionForContact: (
    prisma: unknown,
    input: { tenantId: string; contactId: string; actor?: { type: 'USER' | 'SYSTEM'; id: string } },
  ) => Promise<unknown>;
}
let _runDecisionModule: RunDecisionModule | null = null;
async function loadRunDecisionModule(): Promise<RunDecisionModule> {
  if (_runDecisionModule) return _runDecisionModule;
  const spec = '../../../../packages/api/src/services/run-decision-for-contact.js';
  _runDecisionModule = (await import(spec)) as RunDecisionModule;
  return _runDecisionModule;
}

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────

const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

const DecisionRunEventSchema = z.object({
  tenantId: z.string().uuid(),
  contactId: z.string().uuid(),
  campaignId: z.string().uuid(),
  /** Optional provenance — PR5's activate() sets this; future cron sources
   *  set 'recurring_cron' or 'data_change' so guard-rejection logs can be
   *  triaged by source. */
  source: z.enum(['activate', 'recurring_cron', 'data_change']).optional(),
});

type DecisionRunGuardOutcome =
  | { ok: true; stack: { id: string; status: string; lastEvaluatedAt: Date } }
  | {
      ok: false;
      reason:
        | 'campaign_not_active'
        | 'audience_not_evaluated'
        | 'stack_not_active'
        | 'campaign_not_found'
        | 'stack_not_found';
    };

// ─────────────────────────────────────────────
// Guard evaluation (extracted for testability + grep-clarity)
//
// The 3-condition test in the brief is mechanical here. Each predicate has
// a dedicated reason code so guard-rejection logs are filterable in Cloud
// Logging without grepping free-text messages.
//
// KAN-1009 SAE PR4 — on success, returns the loaded stack record
// (id + status + lastEvaluatedAt) so the downstream dedup gate doesn't
// need a second findFirst roundtrip. The cost-cap + dedup gates run
// AFTER this function returns ok:true.
// ─────────────────────────────────────────────

interface DecisionRunGuardPrisma {
  campaign: {
    findFirst: (args: {
      where: { id: string; tenantId: string };
      select: { id: true; status: true; audienceEvaluatedAt: true };
    }) => Promise<{
      id: string;
      status: string;
      audienceEvaluatedAt: Date | null;
    } | null>;
  };
  contactObjectiveStack: {
    findFirst: (args: {
      where: {
        tenantId: string;
        contactId: string;
        campaignId: string;
      };
      select: { id: true; status: true; lastEvaluatedAt: true };
    }) => Promise<{
      id: string;
      status: string;
      lastEvaluatedAt: Date;
    } | null>;
  };
}

export async function evaluateDecisionRunGuards(
  prismaClient: DecisionRunGuardPrisma,
  event: { tenantId: string; contactId: string; campaignId: string },
): Promise<DecisionRunGuardOutcome> {
  const campaign = await prismaClient.campaign.findFirst({
    where: { id: event.campaignId, tenantId: event.tenantId },
    select: { id: true, status: true, audienceEvaluatedAt: true },
  });
  if (!campaign) {
    return { ok: false, reason: 'campaign_not_found' };
  }
  // Guard 1
  if (campaign.status !== 'active') {
    return { ok: false, reason: 'campaign_not_active' };
  }
  // Guard 2
  if (campaign.audienceEvaluatedAt === null) {
    return { ok: false, reason: 'audience_not_evaluated' };
  }
  // Guard 3
  const stack = await prismaClient.contactObjectiveStack.findFirst({
    where: {
      tenantId: event.tenantId,
      contactId: event.contactId,
      campaignId: event.campaignId,
    },
    // KAN-1009 — also fetch lastEvaluatedAt for downstream dedup gate
    select: { id: true, status: true, lastEvaluatedAt: true },
  });
  if (!stack) {
    return { ok: false, reason: 'stack_not_found' };
  }
  if (stack.status !== 'active') {
    return { ok: false, reason: 'stack_not_active' };
  }
  return { ok: true, stack };
}

// ─────────────────────────────────────────────
// KAN-1009 SAE PR4 — cost-cap + de-dup gates
//
// Run AFTER the 3 hard guards pass, BEFORE runDecisionForContact.
// Both gates resolve to a single reason code ('cost_cap_exceeded' or
// 'dedup_recent_eval') so the structured log is filterable downstream.
// ─────────────────────────────────────────────

/**
 * Conservative default daily cost cap when Tenant.dailyLlmCostCapUsd is
 * NULL and the env-override (DECISION_RUN_DAILY_COST_CAP_USD_DEFAULT) is
 * unset. At ~$0.10/eval estimated cost, $10/day → ~100 evals/day per
 * tenant — bounded enough that an accidental large activation can't run
 * away before someone notices.
 */
export const DEFAULT_DAILY_COST_CAP_USD = 10.0;

/**
 * Fixed cost estimate per eval, used to increment the Redis counter
 * post-success. Brief estimate: $0.05–0.20/eval (2-5 LLM calls at
 * Sonnet reasoning-tier pricing). Midpoint $0.10. Documented as an
 * approximation — truth lives in KAN-745 LlmCostRollup; this is the
 * safety-cap signal, not a billing instrument.
 */
export const ESTIMATED_COST_PER_EVAL_USD = 0.1;

/** Dedup window covers Pub/Sub redelivery (~50 min max with retry policy
 *  10s-600s × 5 attempts). 30 min is enough for redelivery defense in
 *  PR4; the M2 recurring-cron will want a longer window (24h) — tune
 *  then.
 */
export const DEDUP_WINDOW_MINUTES = 30;

/** Redis counter scope. Keys: cost_cap_usd:tenant:<tenantId>:<UTCYYYYMMDD>. */
export const COST_CAP_COUNTER_SCOPE = 'cost_cap_usd';

export type CostCapDedupOutcome =
  | { ok: true; resolvedCapUsd: number; spendTodayUsd: number }
  | {
      ok: false;
      reason: 'cost_cap_exceeded' | 'dedup_recent_eval' | 'cost_signal_unavailable';
      // Diagnostic fields per reason (best-effort; not always populated):
      resolvedCapUsd?: number;
      spendTodayUsd?: number;
      lastEvaluatedAt?: Date;
      windowMinutes?: number;
      counterError?: string;
    };

/**
 * Resolve the effective cap for a tenant:
 *   1. Tenant.dailyLlmCostCapUsd (per-tenant override)
 *   2. DECISION_RUN_DAILY_COST_CAP_USD_DEFAULT env var (deploy-time override)
 *   3. DEFAULT_DAILY_COST_CAP_USD constant ($10)
 *
 * Returns the float USD value used in the gate comparison.
 */
export function resolveDailyCostCapUsd(
  tenantOverride: number | null | undefined,
): number {
  if (tenantOverride != null) return tenantOverride;
  const envOverride = parseFloat(
    process.env.DECISION_RUN_DAILY_COST_CAP_USD_DEFAULT ?? '',
  );
  if (Number.isFinite(envOverride) && envOverride > 0) return envOverride;
  return DEFAULT_DAILY_COST_CAP_USD;
}

interface CostCapDedupPrisma {
  tenant: {
    findUnique: (args: {
      where: { id: string };
      select: { dailyLlmCostCapUsd: true };
    }) => Promise<{ dailyLlmCostCapUsd: { toString(): string } | null } | null>;
  };
}

interface RedisLike {
  get: (key: string) => Promise<string | null>;
}

/**
 * Evaluate the cost-cap + dedup gates for a (tenantId, contactId, stack)
 * triple. Read-only — never mutates Redis or the DB. The
 * `incrementCostCounter` + `updateLastEvaluatedAt` calls happen in the
 * post-success path of the handler.
 *
 * **Fail-safe posture:** if the Redis counter read throws (network /
 * timeout / Redis down), this function returns `cost_signal_unavailable`.
 * The handler MUST fail closed (skip the eval) rather than run unbounded.
 * Bias toward inaction when the cost signal is unreliable.
 */
export async function evaluateCostCapAndDedupGates(
  prismaClient: CostCapDedupPrisma,
  redis: RedisLike,
  args: {
    tenantId: string;
    stack: { id: string; lastEvaluatedAt: Date };
    now?: Date;
  },
): Promise<CostCapDedupOutcome> {
  const now = args.now ?? new Date();

  // ── DEDUP GATE ──────────────────────────────────────────────
  const minutesSinceLastEval =
    (now.getTime() - args.stack.lastEvaluatedAt.getTime()) / 60_000;
  if (minutesSinceLastEval < DEDUP_WINDOW_MINUTES) {
    return {
      ok: false,
      reason: 'dedup_recent_eval',
      lastEvaluatedAt: args.stack.lastEvaluatedAt,
      windowMinutes: DEDUP_WINDOW_MINUTES,
    };
  }

  // ── COST CAP GATE ───────────────────────────────────────────
  const tenant = await prismaClient.tenant.findUnique({
    where: { id: args.tenantId },
    select: { dailyLlmCostCapUsd: true },
  });
  const tenantOverride = tenant?.dailyLlmCostCapUsd
    ? Number(tenant.dailyLlmCostCapUsd.toString())
    : null;
  const resolvedCapUsd = resolveDailyCostCapUsd(tenantOverride);

  let spendTodayUsd: number;
  try {
    spendTodayUsd = await getTodayCostUsd(
      redis,
      COST_CAP_COUNTER_SCOPE,
      args.tenantId,
      now,
    );
  } catch (err) {
    // FAIL-SAFE: cost signal unavailable → SKIP the eval (caller-decided
    // posture; the handler returns 200 ack to avoid Pub/Sub retry storm
    // against a Redis outage, then ops investigates).
    return {
      ok: false,
      reason: 'cost_signal_unavailable',
      resolvedCapUsd,
      counterError: err instanceof Error ? err.message : String(err),
    };
  }

  if (spendTodayUsd >= resolvedCapUsd) {
    return {
      ok: false,
      reason: 'cost_cap_exceeded',
      resolvedCapUsd,
      spendTodayUsd,
    };
  }

  return { ok: true, resolvedCapUsd, spendTodayUsd };
}

// ─────────────────────────────────────────────
// Hono app
// ─────────────────────────────────────────────

export const decisionRunPushApp = new Hono();

decisionRunPushApp.post('/decision-run', async (c) => {
  if (!(await verifyPubsubOidc(c))) {
    return c.text('unauthorized', 401);
  }

  let envelope: z.infer<typeof PushEnvelopeSchema>;
  try {
    envelope = PushEnvelopeSchema.parse(await c.req.json());
  } catch (err) {
    console.error(
      `[decision-run-push] malformed envelope: ${(err as Error)?.message ?? String(err)}`,
    );
    return c.text('ok', 200);
  }

  let event: z.infer<typeof DecisionRunEventSchema>;
  try {
    const decoded = Buffer.from(envelope.message.data, 'base64').toString('utf8');
    event = DecisionRunEventSchema.parse(JSON.parse(decoded));
  } catch (err) {
    console.error(
      `[decision-run-push] malformed event: ${(err as Error)?.message ?? String(err)}`,
    );
    return c.text('ok', 200);
  }

  // ─── 3 HARD GUARDS (PR3) ────────────────────────────────────
  const guardResult = await evaluateDecisionRunGuards(prisma, event);

  if (!guardResult.ok) {
    console.log(
      JSON.stringify({
        type: 'decision_run_guard_rejected',
        reason: guardResult.reason,
        tenantId: event.tenantId,
        contactId: event.contactId,
        campaignId: event.campaignId,
        source: event.source ?? 'unspecified',
        messageId: envelope.message.messageId,
      }),
    );
    // Ack — Pub/Sub redelivery would only re-fire the same guard rejection.
    return c.text('ok', 200);
  }

  // ─── KAN-1009 SAE PR4: COST-CAP + DE-DUP GATES ──────────────
  // Run AFTER the PR3 guards (which proved the path is INTENDED to run)
  // and BEFORE the Decision Engine call (which is the expensive part).
  // Fail-safe posture: a Redis outage routes to cost_signal_unavailable
  // → skip + ack. Bias toward inaction when the cost signal is
  // unreliable.
  const gateResult = await evaluateCostCapAndDedupGates(prisma, getRedisClient(), {
    tenantId: event.tenantId,
    stack: guardResult.stack,
  });

  if (!gateResult.ok) {
    console.log(
      JSON.stringify({
        type: 'decision_run_gate_rejected',
        reason: gateResult.reason,
        tenantId: event.tenantId,
        contactId: event.contactId,
        campaignId: event.campaignId,
        source: event.source ?? 'unspecified',
        messageId: envelope.message.messageId,
        // Diagnostic fields per reason
        resolvedCapUsd: gateResult.resolvedCapUsd,
        spendTodayUsd: gateResult.spendTodayUsd,
        lastEvaluatedAt: gateResult.lastEvaluatedAt?.toISOString(),
        windowMinutes: gateResult.windowMinutes,
        counterError: gateResult.counterError,
      }),
    );
    // Ack — same posture as PR3 guard rejections. The cap/dedup state
    // is stateful (will keep rejecting until the day resets or the
    // dedup window expires); redelivery would only re-fire the rejection.
    return c.text('ok', 200);
  }

  // ─── ALL GUARDS + GATES PASSED — call Decision Engine unmodified ──
  // Governance pass-through: runDecisionForContact carries the full chain
  // (threshold gate, auto-approve matrix, escalation rules, kill-switch).
  // Under autoApproveEnabled=false the kill-switch routes to ESCALATED
  // outcome → Escalation row written + escalation.triggered Pub/Sub; NO
  // action.decided publish, NO outbound. See KAN-1002 Phase 1 Finding 2.
  try {
    const { runDecisionForContact } = await loadRunDecisionModule();
    const decision = await runDecisionForContact(prisma, {
      tenantId: event.tenantId,
      contactId: event.contactId,
      actor: { type: 'SYSTEM', id: 'decision-run-push' },
    });

    // KAN-1009 — post-success: bump the cost counter + update the
    // stack's lastEvaluatedAt. Both are best-effort; failures here
    // structured-log but don't fail the response (the eval already
    // happened; the consumer-side accounting can lag).
    void (async () => {
      try {
        const newTotalUsd = await incrementTodayCostUsd(
          getRedisClient(),
          COST_CAP_COUNTER_SCOPE,
          event.tenantId,
          ESTIMATED_COST_PER_EVAL_USD,
        );
        console.log(
          JSON.stringify({
            type: 'decision_run_cost_counter_incremented',
            tenantId: event.tenantId,
            estimateDeltaUsd: ESTIMATED_COST_PER_EVAL_USD,
            newDailyTotalUsd: newTotalUsd,
            resolvedCapUsd: gateResult.resolvedCapUsd,
          }),
        );
      } catch (counterErr) {
        console.error(
          JSON.stringify({
            type: 'decision_run_cost_counter_failed',
            tenantId: event.tenantId,
            error: counterErr instanceof Error ? counterErr.message : String(counterErr),
          }),
        );
      }
    })();

    void (async () => {
      try {
        await prisma.contactObjectiveStack.update({
          where: { id: guardResult.stack.id },
          data: { lastEvaluatedAt: new Date() },
        });
      } catch (updateErr) {
        console.error(
          JSON.stringify({
            type: 'decision_run_last_evaluated_at_update_failed',
            tenantId: event.tenantId,
            stackId: guardResult.stack.id,
            error: updateErr instanceof Error ? updateErr.message : String(updateErr),
          }),
        );
      }
    })();

    console.log(
      JSON.stringify({
        type: 'decision_run_dispatched',
        tenantId: event.tenantId,
        contactId: event.contactId,
        campaignId: event.campaignId,
        source: event.source ?? 'unspecified',
        messageId: envelope.message.messageId,
        // Don't log the full decision (PII risk) — outcome/decisionId
        // only. Full payload is in the Decision row + audit log.
        decisionSummary:
          decision && typeof decision === 'object'
            ? {
                decisionId: (decision as { decisionId?: string }).decisionId,
                outcome: (decision as { outcome?: string }).outcome,
                strategy: (decision as { strategy?: string }).strategy,
              }
            : null,
      }),
    );
    return c.text('ok', 200);
  } catch (err) {
    console.error(
      JSON.stringify({
        type: 'decision_run_dispatched',
        status: 'failed',
        tenantId: event.tenantId,
        contactId: event.contactId,
        campaignId: event.campaignId,
        error: err instanceof Error ? err.message : String(err),
        messageId: envelope.message.messageId,
      }),
    );
    // Nack — runDecisionForContact transient errors (DB connection, LLM
    // timeout) merit Pub/Sub redelivery. Permanent errors burn through to
    // the DLQ after max_delivery_attempts.
    return c.text('retry', 500);
  }
});
