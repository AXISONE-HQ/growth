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
import { PubSub } from '@google-cloud/pubsub';
import { prisma } from '../prisma.js';
import { verifyPubsubOidc } from '../lib/oidc-pubsub-verify.js';
import {
  // KAN-1009 SAE PR4 — Redis-backed daily counter (cost cap) +
  // USD-typed convenience wrappers around it.
  getTodayCostUsd,
  incrementTodayCostUsd,
  // KAN-1005 M2-1 — generic integer-counter primitives, reused for the
  // autonomous-action counter (ACTION_COUNT_COUNTER_SCOPE above).
  getTodayCount,
  incrementToday,
  // KAN-1005 M2-4 — hourly-window sibling for sub-day rate / error
  // signals (the breaker's action-rate spike + error-rate climb
  // sources). Same lib, second window — no parallel tracker.
  incrementHourly,
} from '../lib/per-tenant-daily-counter.js';
import {
  // KAN-1005 M2-4 — circuit breaker (machine-speed auto-pause).
  evaluateBreakerState,
  tripBreaker,
  resolveBreakerThresholds,
  secondsUntilUtcMidnight,
  BREAKER_SCOPE_COST,
  BREAKER_SCOPE_RATE,
  BREAKER_SCOPE_ERROR,
  ACTION_COUNT_HOURLY_SCOPE,
  ERROR_COUNT_HOURLY_SCOPE,
  COOLDOWN_SECONDS,
} from '../lib/circuit-breaker.js';
import { getRedisClient } from '../services/redis-client.js';

// ─────────────────────────────────────────────
// KAN-1018 — error classifier (persistent vs transient routing).
// Variable-specifier dynamic import to match the rest of cross-rootDir
// access in apps/api (per reference_variable_specifier_dynamic_import).
// ─────────────────────────────────────────────
interface ErrorClassifierModule {
  classifyError: (err: unknown) => { category: 'persistent' | 'transient'; reasonCode: string };
}
let _errorClassifierModule: ErrorClassifierModule | null = null;
async function loadErrorClassifierModule(): Promise<ErrorClassifierModule> {
  if (_errorClassifierModule) return _errorClassifierModule;
  const spec = '../../../../packages/api/src/services/error-classifier.js';
  _errorClassifierModule = (await import(spec)) as ErrorClassifierModule;
  return _errorClassifierModule;
}

// ─────────────────────────────────────────────
// KAN-1018 — DLQ publisher. On persistent classification, the handler
// EXPLICITLY publishes to decision.run.dlq (rather than waiting for 5
// nack-retries to auto-dead-letter — which would re-fire the eval up to
// 5× and cost-storm). Transient errors take the auto-dead-letter path
// (handler returns 500 → Pub/Sub retries up to maxAttempts=5 → DLQ).
// Both flows land in the same DLQ consumer (decision-run-dlq subscriber),
// distinguished by the `dlqSource` attribute below.
// ─────────────────────────────────────────────
const DECISION_RUN_DLQ_TOPIC = 'decision.run.dlq';
let _pubsubClient: PubSub | null = null;
function getPubSubClient(): PubSub {
  if (!_pubsubClient) _pubsubClient = new PubSub();
  return _pubsubClient;
}
/** Test seam. */
export function __setDecisionRunPushPubsubForTest(client: PubSub | null): void {
  _pubsubClient = client;
}

// ─────────────────────────────────────────────
// Variable-specifier dynamic import for the cross-rootDir Decision Engine
// entry point. Same pattern the rest of apps/api uses.
//
// KAN-1005 M2-4 follow-up — the input type is now imported from
// @growth/shared (the canonical, cross-rootDir-clean cohort) rather
// than hand-redeclared locally. The hand-redeclaration class silently
// drifted three times: cast-loose Prisma access, KAN-1005 M2-6b
// synthetic decisionId, and the M2-4 breakerState drop that the S4
// smoke surfaced. Shared types eliminate the drift class structurally
// — both this caller and the packages/api implementation compile-check
// against the same single source of truth.
// ─────────────────────────────────────────────

import type { RunForContactInput } from '@growth/shared';

interface RunDecisionModule {
  runDecisionForContact: (
    prisma: unknown,
    input: RunForContactInput,
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

/**
 * KAN-1005 (M2-1) — Autonomous-action counter scope.
 * Keys: action_count:tenant:<tenantId>:<UTCYYYYMMDD>.
 *
 * Single counter, TWO consumers:
 *   1. M2-1 daily-action-limit gate (this PR) — read at gate-input
 *      build, written on the EXECUTE branch when outcome='EXECUTED'.
 *   2. M2-4 circuit breaker (future) — reads the same counter for
 *      autonomous-action-rate signal. No parallel rate-tracker.
 *
 * Today (auto-approve OFF PROD-wide), the EXECUTE branch is unreachable
 * so the counter is never incremented in PROD. M2-6b's auto-approve
 * flip makes the writer side live; this PR ships the gate enforcement
 * + the writer + the read site, all behind that flip.
 */
export const ACTION_COUNT_COUNTER_SCOPE = 'action_count';

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

    // KAN-1005 M2-4 — trip the circuit breaker on cost-cap exceedance
    // (HARD pause). TTL = seconds until next UTC midnight (auto-clears
    // when the daily cost counter resets). The cost gate ABOVE already
    // wrote its own structured log (`decision_run_gate_rejected reason=
    // cost_cap_exceeded`); per founder refinement 2026-05-27, M2-4 does
    // NOT emit a redundant audit row for this trigger — the trip is
    // reconstructable by joining the cost-gate log → breaker key
    // existence. Rate/error triggers (below) DO emit audit rows since
    // they're net-new signals.
    if (gateResult.reason === 'cost_cap_exceeded') {
      void (async () => {
        try {
          await tripBreaker(
            getRedisClient(),
            BREAKER_SCOPE_COST,
            event.tenantId,
            secondsUntilUtcMidnight(),
            `cost_cap_exceeded: ${gateResult.spendTodayUsd}/${gateResult.resolvedCapUsd} USD`,
          );
          console.log(
            JSON.stringify({
              type: 'circuit_breaker_tripped',
              scope: BREAKER_SCOPE_COST,
              tenantId: event.tenantId,
              reason: 'cost_cap_exceeded',
              spendTodayUsd: gateResult.spendTodayUsd,
              resolvedCapUsd: gateResult.resolvedCapUsd,
            }),
          );
        } catch (tripErr) {
          console.error(
            JSON.stringify({
              type: 'circuit_breaker_trip_failed',
              scope: BREAKER_SCOPE_COST,
              tenantId: event.tenantId,
              error: tripErr instanceof Error ? tripErr.message : String(tripErr),
            }),
          );
        }
      })();
    }

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
  // ─── KAN-1018 — engine-call try / catch / finally ─────────────────
  //
  // Replaces #217's interim catch-all-ack (which silently swallowed every
  // throw, ack 200, no retry) with A2 + A4:
  //   A2: counter increment moves to finally, gated on `engineStarted`.
  //       Pre-engine throws (dynamic-import fail, etc.) → flag stays
  //       false → no increment. Engine-execution throws → increment fires
  //       so retry-storm cost is bounded by the daily cap.
  //   A4: catch classifies the error. Persistent → ack 200 + EXPLICIT
  //       DLQ publish (no waste of 5 nack-retries). Transient → return
  //       500 → Pub/Sub auto-retries up to maxAttempts=5 → auto-DLQ if
  //       still failing. Both DLQ flows land in the same consumer with
  //       a `dlqSource` attribute discriminating them.
  // KAN-1005 M2-1 — read the daily autonomous-action count BEFORE the
  // engine call, pass it as input. The gate uses this to enforce the
  // per-tenant daily limit.
  //
  // FAIL-CLOSED on Redis error — defense-in-depth. The upstream cost-cap
  // gate is also fail-closed on the same Redis dependency, so in
  // practice this branch never fires (cost-cap aborts first). But the
  // shield is a load-bearing structural dependency; if a future code
  // path ever reaches the engine without replaying the cost-cap gate
  // (M2-7 recurring cron is the imminent example), a fail-OPEN
  // count=0 fall-through here would let unbounded autonomous actions
  // through (`0 < dailyActionLimit` always true). Mirror cost-cap's
  // pattern: Redis error → 200-ack + structured log + skip the eval.
  // A safety gate should be independently fail-safe, not dependent on
  // another gate's position in the call order.
  let dailyAutoActionCount: number;
  try {
    dailyAutoActionCount = await getTodayCount(
      getRedisClient(),
      ACTION_COUNT_COUNTER_SCOPE,
      event.tenantId,
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        type: 'decision_run_gate_rejected',
        reason: 'action_count_unavailable',
        tenantId: event.tenantId,
        contactId: event.contactId,
        campaignId: event.campaignId,
        messageId: envelope.message.messageId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    // Same posture as cost_signal_unavailable: 200-ack (no Pub/Sub
    // retry storm against a Redis outage), ops investigates.
    return c.text('ok', 200);
  }

  // KAN-1005 M2-4 — read circuit breaker state (3 scopes × 2 targets =
  // 6 keys via single MGET). Caller-reads-Redis-passes-to-engine pattern
  // mirrors dailyAutoActionCount (M2-1). Fail-CLOSED on Redis error:
  // `evaluateBreakerState` returns { tripped: true, failClosed: true }
  // so the gate escalates with an observable signal.
  //
  // Why read here (not skip to ack-200 like cost_signal_unavailable):
  // the breaker is intentionally tolerant of false-positives at the
  // expense of false-negatives — fail-closed means we escalate during
  // a Redis outage, which is the safe direction. The engine still gets
  // invoked but the threshold gate routes to escalate.
  const breakerState = await evaluateBreakerState(getRedisClient(), event.tenantId);

  let engineStarted = false;
  try {
    const { runDecisionForContact } = await loadRunDecisionModule();
    engineStarted = true; // → finally will increment the counter on throw too
    const decision = await runDecisionForContact(prisma, {
      tenantId: event.tenantId,
      contactId: event.contactId,
      actor: { type: 'SYSTEM', id: 'decision-run-push' },
      dailyAutoActionCount,
      breakerState,
    });

    // KAN-1005 M2-1 — increment the autonomous-action counter on the
    // EXECUTE branch (outcome='EXECUTED' = autonomous-dispatch path).
    // Today (auto-approve OFF PROD-wide) the engine routes EVERY
    // evaluation to ESCALATED → this branch is unreachable in PROD,
    // counter stays 0. M2-6b's flip makes it live. The fire-and-forget
    // increment failure logs but doesn't fail the response (same posture
    // as the cost counter increment).
    const outcome = (decision as { outcome?: string })?.outcome;
    if (outcome === 'EXECUTED') {
      void (async () => {
        try {
          // KAN-1005 M2-1 daily counter + M2-4 hourly counter — both
          // incremented on every EXECUTE so the breaker can read either
          // window. Same lib, two windows; not a parallel tracker.
          const [newDailyTotal, newHourlyTotal] = await Promise.all([
            incrementToday(
              getRedisClient(),
              ACTION_COUNT_COUNTER_SCOPE,
              event.tenantId,
              1,
            ),
            incrementHourly(
              getRedisClient(),
              ACTION_COUNT_HOURLY_SCOPE,
              event.tenantId,
              1,
            ),
          ]);
          console.log(
            JSON.stringify({
              type: 'autonomous_action_count_incremented',
              tenantId: event.tenantId,
              newDailyCount: newDailyTotal,
              newHourlyCount: newHourlyTotal,
            }),
          );

          // KAN-1005 M2-4 — check thresholds + trip the rate breaker
          // if exceeded. Per-tenant tunable via Tenant.settings.circuitBreaker.
          // Either hourly OR daily exceedance trips this scope.
          const tenantRow = await prisma.tenant.findUnique({
            where: { id: event.tenantId },
            select: { settings: true },
          });
          const thresholds = resolveBreakerThresholds(tenantRow?.settings);
          const dailyExceeded = newDailyTotal >= thresholds.dailyActionCap;
          const hourlyExceeded = newHourlyTotal >= thresholds.hourlyActionRate;
          if (dailyExceeded || hourlyExceeded) {
            const triggerSignal = hourlyExceeded
              ? `hourly_action_rate: ${newHourlyTotal}/${thresholds.hourlyActionRate}`
              : `daily_action_cap: ${newDailyTotal}/${thresholds.dailyActionCap}`;
            try {
              await tripBreaker(
                getRedisClient(),
                BREAKER_SCOPE_RATE,
                event.tenantId,
                COOLDOWN_SECONDS,
                triggerSignal,
              );
              console.log(
                JSON.stringify({
                  type: 'circuit_breaker_tripped',
                  scope: BREAKER_SCOPE_RATE,
                  tenantId: event.tenantId,
                  reason: triggerSignal,
                  newDailyCount: newDailyTotal,
                  newHourlyCount: newHourlyTotal,
                  cooldownSeconds: COOLDOWN_SECONDS,
                }),
              );
              // Audit-log the trip (best-effort). Rate-trip IS net-new
              // signal so we emit a row (unlike cost-cap which is already
              // audited by the cost gate).
              void prisma.auditLog
                .create({
                  data: {
                    tenantId: event.tenantId,
                    actor: 'circuit_breaker',
                    actionType: 'circuit_breaker_tripped',
                    reasoning: `Action-rate breaker tripped: ${triggerSignal}`,
                    payload: {
                      scope: BREAKER_SCOPE_RATE,
                      newDailyCount: newDailyTotal,
                      newHourlyCount: newHourlyTotal,
                      dailyThreshold: thresholds.dailyActionCap,
                      hourlyThreshold: thresholds.hourlyActionRate,
                      cooldownSeconds: COOLDOWN_SECONDS,
                    },
                  },
                })
                .catch((auditErr: unknown) => {
                  console.warn(
                    `[circuit-breaker] audit-emit-rate-trip-failed tenantId=${event.tenantId} err=${(auditErr as Error)?.message ?? String(auditErr)}`,
                  );
                });
            } catch (tripErr) {
              console.error(
                JSON.stringify({
                  type: 'circuit_breaker_trip_failed',
                  scope: BREAKER_SCOPE_RATE,
                  tenantId: event.tenantId,
                  error: tripErr instanceof Error ? tripErr.message : String(tripErr),
                }),
              );
            }
          }
        } catch (counterErr) {
          console.error(
            JSON.stringify({
              type: 'autonomous_action_count_failed',
              tenantId: event.tenantId,
              error: counterErr instanceof Error ? counterErr.message : String(counterErr),
            }),
          );
        }
      })();
    }

    // KAN-1010 F2 — stack lastEvaluatedAt update. Success-path only:
    // if the engine threw, NOT updating preserves the redeliver-after-fix
    // workflow (operator pushes a code fix + re-publishes the same
    // decision.run; dedup gate wouldn't block it). The storm concern
    // that originally motivated updating-on-error is now handled by the
    // classifier (persistent → no retry; transient → cap-bounded).
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
    // ── A4: classify ──────────────────────────────────────────────────
    let classified: { category: 'persistent' | 'transient'; reasonCode: string };
    try {
      const { classifyError } = await loadErrorClassifierModule();
      classified = classifyError(err);
    } catch {
      // Classifier load failure should never happen, but if it does,
      // fail-safe to persistent (don't auto-storm).
      classified = { category: 'persistent', reasonCode: 'classifier_load_failed' };
    }

    const errorPayload = {
      tenantId: event.tenantId,
      contactId: event.contactId,
      campaignId: event.campaignId,
      messageId: envelope.message.messageId,
      error: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.constructor?.name ?? err.name : typeof err,
      // Truncated stack — preserves diagnostic signal in the 200-ack path
      // without flooding logs with full stack traces from same-class
      // recurring errors.
      stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join(' | ') : undefined,
      classification: classified,
      engineStarted,
    };

    // KAN-1005 M2-4 — increment the hourly error counter on EVERY
    // classified error (persistent + transient). Counts include retries
    // by design: a retry storm on a single poison message reads as N
    // error-events, which IS a runaway worth pausing on (intentional
    // interpretation; calibration done with this in mind).
    void (async () => {
      try {
        const newHourlyErrorCount = await incrementHourly(
          getRedisClient(),
          ERROR_COUNT_HOURLY_SCOPE,
          event.tenantId,
          1,
        );
        const tenantRow = await prisma.tenant.findUnique({
          where: { id: event.tenantId },
          select: { settings: true },
        });
        const thresholds = resolveBreakerThresholds(tenantRow?.settings);
        if (newHourlyErrorCount >= thresholds.hourlyErrorRate) {
          const triggerSignal = `hourly_error_rate: ${newHourlyErrorCount}/${thresholds.hourlyErrorRate}`;
          await tripBreaker(
            getRedisClient(),
            BREAKER_SCOPE_ERROR,
            event.tenantId,
            COOLDOWN_SECONDS,
            triggerSignal,
          );
          console.log(
            JSON.stringify({
              type: 'circuit_breaker_tripped',
              scope: BREAKER_SCOPE_ERROR,
              tenantId: event.tenantId,
              reason: triggerSignal,
              newHourlyErrorCount,
              cooldownSeconds: COOLDOWN_SECONDS,
            }),
          );
          // Audit-log the trip (best-effort, distinct from rate trip
          // by scope in payload).
          void prisma.auditLog
            .create({
              data: {
                tenantId: event.tenantId,
                actor: 'circuit_breaker',
                actionType: 'circuit_breaker_tripped',
                reasoning: `Error-rate breaker tripped: ${triggerSignal}`,
                payload: {
                  scope: BREAKER_SCOPE_ERROR,
                  newHourlyErrorCount,
                  hourlyThreshold: thresholds.hourlyErrorRate,
                  cooldownSeconds: COOLDOWN_SECONDS,
                  // Diagnostic anchor — recent errors can be joined
                  // via this messageId on the structured-log side.
                  messageId: envelope.message.messageId,
                  classification: classified,
                },
              },
            })
            .catch((auditErr: unknown) => {
              console.warn(
                `[circuit-breaker] audit-emit-error-trip-failed tenantId=${event.tenantId} err=${(auditErr as Error)?.message ?? String(auditErr)}`,
              );
            });
        }
      } catch (counterErr) {
        console.error(
          JSON.stringify({
            type: 'circuit_breaker_error_counter_failed',
            tenantId: event.tenantId,
            error: counterErr instanceof Error ? counterErr.message : String(counterErr),
          }),
        );
      }
    })();

    if (classified.category === 'transient') {
      // ── Transient: return 500 so Pub/Sub auto-retries up to
      // maxAttempts=5. Counter increment in finally bounds storm cost.
      // After 5 nack-retries, the message auto-dead-letters to
      // decision.run.dlq (handled by the DLQ subscriber).
      console.warn(
        JSON.stringify({
          type: 'decision_run_transient_error',
          ...errorPayload,
        }),
      );
      return c.text('transient_error', 500);
    }

    // ── Persistent: ack 200 + EXPLICIT DLQ publish ────────────────────
    // Don't wait for 5 nack-retries to auto-dead-letter (that's a storm
    // we know can't recover). Publish the original event payload + the
    // classification context to the DLQ topic NOW.
    let dlqPublishedId: string | null = null;
    let dlqPublishError: string | null = null;
    try {
      const dlqMessage = JSON.stringify({
        originalEvent: event,
        originalMessageId: envelope.message.messageId,
        originalAttributes: envelope.message.attributes ?? {},
        classification: classified,
        error: errorPayload.error,
        errorName: errorPayload.errorName,
        stack: errorPayload.stack,
        engineStarted,
        publishedAt: new Date().toISOString(),
      });
      dlqPublishedId = await getPubSubClient()
        .topic(DECISION_RUN_DLQ_TOPIC)
        .publishMessage({
          data: Buffer.from(dlqMessage, 'utf8'),
          attributes: {
            dlqSource: 'persistent_classifier',
            originalMessageId: envelope.message.messageId ?? '',
            reasonCode: classified.reasonCode,
            tenantId: event.tenantId,
          },
        });
    } catch (publishErr) {
      // DLQ publish failed — best-effort. Log loudly so we know the
      // dead-letter signal got lost. Still ack 200 (the alternative is
      // returning 500 → retry storm, which is worse than losing one
      // DLQ-visibility signal).
      dlqPublishError = publishErr instanceof Error ? publishErr.message : String(publishErr);
    }

    console.error(
      JSON.stringify({
        type: 'decision_run_persistent_error',
        ...errorPayload,
        dlqPublishedId,
        dlqPublishError,
      }),
    );
    return c.text('persistent_error', 200);
  } finally {
    // ── A2: increment cost counter on EVERY engine-started invocation,
    // whether success or throw. Pre-engine throws (dynamic-import fail,
    // etc.) skip this because `engineStarted` stays false. For M1
    // (shadow off + runFreeform LLM-free), the structural correctness
    // matters more than the per-eval value — when shadow flips on in M2,
    // this path bounds transient-retry storms by the daily cap.
    //
    // Fire-and-forget; counter failure is logged but never affects the
    // response (the eval already happened; the consumer-side accounting
    // can lag without blocking subsequent decisions).
    if (engineStarted) {
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
    }
  }
});
