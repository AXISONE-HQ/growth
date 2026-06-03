/**
 * KAN-1037-PR3/PR4 — `contact.replied` push subscriber.
 *
 * Cloud Run Pub/Sub push endpoint. Consumes the `contact.replied` topic
 * published from `lead-received-push.ts`'s
 * `emitContactRepliedIfCorrelated` helper (fires on every
 * `inbound_correlated` outcome from `writeSidecarAndCorrelate`).
 *
 * **PR4 SCOPE — engine re-evaluation with body-aware prompt.** Verifies
 * OIDC, parses envelope + event, applies Redis cooldown + in-flight
 * gates, then calls `brain-service.evaluateDealState(prisma, dealId, {
 * redis, openai, latestInbound })` with the reply context threaded into
 * the engine prompt. Brain's decision is captured in the
 * `decision_re_evaluated` audit row for cognitive-quality empirical
 * observation; the decision is NOT routed through downstream consumers
 * (stage-transition / send-policy / dispatch) — cognitive-risk is
 * isolated from dispatch-risk per the PR4 spec confirmation (a
 * follow-up PR wires the dispatch once cognition is empirically proven).
 *
 * **PR3 history:** prior implementation wrote a bookmark audit row
 * (`decision_re_evaluated_skipped_pr3_skeleton`) to prove the plumbing
 * fired end-to-end without taking engine risk. PR4 retires that bookmark
 * — the skeleton actionType no longer appears post-deploy (a verify
 * check is paste in the PR4 delivery report).
 *
 * **Topic + subscription provisioning** at `infra/terraform/contact-replied.tf`.
 * Push endpoint is `/pubsub/contact-replied` (mounted via
 * `app.route("/pubsub", contactRepliedPushApp)` at `index.ts`).
 *
 * Flow:
 *   Pub/Sub push → POST /pubsub/contact-replied → verifyPubsubOidc
 *   → PushEnvelopeSchema.parse → base64-decode → ContactRepliedEventSchema.parse
 *   → cooldown check (5min TTL — replies are high-signal, shorter than
 *     the 30-min general DEDUP at decision-run-push.ts:322)
 *   → in-flight check (30s NX TTL — anti-flapping on concurrent inbounds)
 *   → IF event.dealId === null: skip-with-audit
 *       (`decision_re_evaluated_skipped_no_deal`), set cooldown, 200
 *   → ELSE: evaluateDealState(prisma, dealId, { redis, openai, latestInbound })
 *           → write `decision_re_evaluated` audit with brainActionType +
 *             brainConfidence + brainReasoning + token counts
 *           → set cooldown key with `decisionId` value (5 min EX)
 *           → release in-flight lock via finally
 *           → 200.
 *
 * **OIDC discipline (KAN-732):** verifyPubsubOidc derives the expected
 * audience from the request URL — NO `CONTACT_REPLIED_AUDIENCE` env
 * var needed. Audience-mismatch class stays structurally impossible.
 * Structural regression test at
 * `apps/api/src/__tests__/knowledge-ingest-audience.test.ts`
 * (SUBSCRIBERS array; PR3 adds `contact-replied-push.ts`).
 *
 * **Redis discipline:** keys scoped `<tenantId>:<contactId>` — tenant-
 * isolated by construction. In-flight lock released in `finally` block
 * — orphan locks structurally impossible even on subscriber error.
 *
 * Error policy:
 *   - 200 (ack + drop) on malformed envelope or invalid event payload
 *     (poison-message defense; redelivery won't help if the producer
 *     emitted a bad shape).
 *   - 200 (ack + cooldown audit) when cooldown is active — operator-
 *     visible skip, not a failure.
 *   - 200 (ack + in-flight audit) when in-flight lock is held — concurrent
 *     processing already underway, drop this delivery.
 *   - 200 (ack + skeleton audit + cooldown set) on the happy path.
 *   - 401 on missing/invalid OIDC token.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import OpenAI from 'openai';
import { ContactRepliedEventSchema } from '@growth/shared';
import { prisma } from '../prisma.js';
import { verifyPubsubOidc } from '../lib/oidc-pubsub-verify.js';
import { getRedisClient } from '../services/redis-client.js';
// KAN-1037-PR4.5 — wire PR4's cognitive eval through the Phase 2
// dispatch chain (stage-transition, KAN-825/835 chains, send-policy,
// engine-proposed escalation consumer). Precomputed-decision pattern
// per KAN-834 — passing our pre-evaluated brainDecision in skips
// wirePhase2Consumers' internal evaluateDealState, avoiding a
// cognitive-blind double-eval that would discard PR4's latestInbound-
// aware reasoning. Direct sibling import (both subscribers live under
// apps/api/src/subscribers; no cross-rootDir boundary to bypass).
import { wirePhase2Consumers, type Phase2BrainDecision } from './lead-received-push.js';

// ─────────────────────────────────────────────
// OpenAI client (KAN-828 — Knowledge Layer retrieval injection)
//
// Mirrors the lazy-singleton + null-on-missing-key pattern in
// `lead-received-push.ts:103-112`. The OpenAI constructor throws
// synchronously on missing/empty `apiKey` even when invoked lazily —
// so in test envs without OPENAI_API_KEY we return null. Brain Service
// accepts `openai: null` and skips retrieval entirely. In Cloud Run with
// the secret injected, the real client is constructed on first call.
//
// Why inline (not shared module): single-PR scope; if a 3rd subscriber
// needs OpenAI, refactor to `apps/api/src/services/openai-client.ts`
// then. KAN-828 is the precedent; PR4 is the second consumer; threshold
// for extraction = 3.
// ─────────────────────────────────────────────
let _openai: OpenAI | null = null;
let _openaiAttempted = false;
function getOpenAIClient(): OpenAI | null {
  if (_openai || _openaiAttempted) return _openai;
  _openaiAttempted = true;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  _openai = new OpenAI({ apiKey });
  return _openai;
}

// ─────────────────────────────────────────────
// Brain Service dynamic-import boundary
//
// Variable-specifier dynamic import per
// `reference_variable_specifier_dynamic_import` (KAN-689 cohort) — keeps
// packages/api/src/services/brain-service.ts out of the static type
// graph for apps/api's tsc, bypassing TS6059 cross-rootDir errors. Local
// interface mirror declares the minimum surface PR4 actually calls.
//
// Sibling pattern at lead-received-push.ts:299-308; the local
// Phase2BrainDecision alias there + the inlined declaration here both
// derive from the brain-service.ts canonical `evaluateDealState` shape.
// Cross-package type drift IS a real risk; covered by the structural
// pin test in contact-replied-push.test.ts that asserts the local
// option keys map 1:1 with the keys the real EvaluateOptions exposes.
// ─────────────────────────────────────────────

/**
 * KAN-1058 (Phase B PR III) — local mirror of brain-service.ts's `ThreadTurn`
 * shape. Same sibling-discipline pattern as `BrainLatestInboundLocal` below
 * (KAN-1037-PR4 convention). Reply chain calls buildThreadContext at L398+
 * and threads the result into buildLatestInboundContext as `priorTurns`.
 *
 * Naming asymmetry with lead-received-push.ts (`ThreadTurn` no Local suffix)
 * is established convention, NOT drift — see
 * `feedback_subscriber_local_type_mirror_naming_asymmetry.md`.
 */
interface ThreadTurnLocal {
  direction: 'outbound' | 'inbound';
  occurredAt: string;
  subjectLine: string;
  bodyText: string;
}

/**
 * KAN-1037-PR4 — local mirror of brain-service.ts's `BrainLatestInbound`
 * shape. Same field-by-field structure as ContactRepliedEvent.metadata
 * subset; the prompt section in buildEvaluationPrompt renders these
 * fields verbatim.
 *
 * KAN-1058 (Phase B PR III) — extended with `priorTurns: ThreadTurnLocal[]`
 * for the multi-turn rendering surface. Required on the resolved object
 * (Phase B Phase 1 Q2 lock) so the prompt template can read
 * `priorTurns.length === 0` directly without optional-chaining.
 */
interface BrainLatestInboundLocal {
  receivedAt: string;
  senderEmail: string;
  bodyText: string;
  subjectLine: string;
  inReplyToDecisionId: string;
  threadDepth: number;
  priorTurns: ThreadTurnLocal[];
}

/**
 * KAN-1065 (Cluster II PR III) — local mirror of @growth/shared's
 * `BlueprintEnginePhase` shape. Per the established Local-suffix convention
 * documented in feedback_subscriber_local_type_mirror_naming_asymmetry —
 * matches the BrainLatestInboundLocal / ThreadTurnLocal naming on this side.
 */
interface BlueprintEnginePhaseLocal {
  key: 'qualify' | 'problem' | 'proof' | 'closing';
  label: string;
  subObjectives: string[];
  priority: number;
}

/**
 * KAN-1065 (Cluster II PR III) — local mirror of brain-service.ts's
 * `CurrentEnginePhase` return shape. Used by the BrainServiceModule loader
 * typedef + the reply-chain call site that threads it into evaluateDealState.
 */
interface CurrentEnginePhaseSnapshotLocal {
  currentPhase: BlueprintEnginePhaseLocal;
  reason: 'operator_override' | 'derived';
  operatorOverrideRecencyDays?: number;
}

interface BrainServiceModule {
  evaluateDealState: (
    prisma: unknown,
    dealId: string,
    options?: {
      tier?: 'cheap' | 'reasoning';
      recentEngagementLimit?: number;
      triggerContext?: 'inbound' | 'post_stage_advance' | 'post_wait_acknowledgment';
      postStageAdvance?: { fromStageName: string; toStageName: string };
      redis?: unknown;
      openai?: unknown;
      // KAN-1037-PR4 — the load-bearing addition. Renders into the new
      // `## Latest inbound` section of buildEvaluationPrompt so the engine
      // can reason about the contact's verbatim words.
      latestInbound?: BrainLatestInboundLocal;
      // KAN-1065 (Cluster II PR III) — current EnginePhase focus snapshot
      // computed by the subscriber via resolveEnginePhases +
      // computeCurrentEnginePhase. PR IV wires the `## Engine phase focus`
      // prompt section; PR V emits currentEnginePhase + currentEnginePhaseReason
      // on the decision_re_evaluated audit payload.
      currentEnginePhase?: CurrentEnginePhaseSnapshotLocal;
    },
  ) => Promise<{
    dealId: string;
    evaluatedAt: Date;
    nextBestAction: {
      type:
        | 'send_follow_up'
        | 'wait_for_response'
        | 'advance_stage'
        | 'escalate_to_human'
        | 'close_deal_lost'
        | 'no_action';
      targetStageId?: string;
      suggestedChannel?: 'email' | 'sms' | 'meta_messenger';
      suggestedTone?: 'curious' | 'professional' | 'urgent' | 'closing';
      reasoning: string;
    };
    confidence: number;
    modelTier: 'cheap' | 'reasoning';
    llmInputTokens: number;
    llmOutputTokens: number;
  }>;
  // KAN-1052 — pure builder for `BrainLatestInbound`. Both this subscriber
  // (reply chain, post-PR4) and lead-received-push (initial-lead path,
  // KAN-1052) go through this helper. KAN-1058 (Phase B PR III) extends
  // with optional `priorTurns?: ThreadTurnLocal[]` input that defaults
  // to `[]` on the resolved object (Q1+Q2 locks).
  buildLatestInboundContext: (
    input: Omit<BrainLatestInboundLocal, 'priorTurns'> & {
      priorTurns?: ThreadTurnLocal[];
    },
  ) => BrainLatestInboundLocal;
  // KAN-1058 (Phase B PR III) — chronological-by-deal walk of prior email
  // engagements. Fetched before `evaluateDealState` at L398+ and threaded
  // into `buildLatestInboundContext({...priorTurns})`. Fail-safes to `[]`
  // on any throw (matches computeGapState fail-safe posture). See
  // packages/api/src/services/brain-service.ts buildThreadContext docstring
  // for the full contract.
  buildThreadContext: (
    prisma: unknown,
    input: {
      tenantId: string;
      dealId: string;
      excludeEngagementId: string;
    },
  ) => Promise<ThreadTurnLocal[]>;
  // KAN-1065 (Cluster II PR III) — EnginePhase config resolver. Loads
  // Tenant.enginePhasesOverride → Tenant.blueprint?.enginePhases → DEFAULT
  // per Cluster II Phase 1 Lock 3. Fail-safes to DEFAULT on any prisma throw.
  resolveEnginePhases: (
    prisma: unknown,
    tenantId: string,
  ) => Promise<BlueprintEnginePhaseLocal[]>;
  // KAN-1065 (Cluster II PR III) — pure-builder current EnginePhase
  // derivation. Q2 lock: operator detection via source === 'manual' (KAN-1042
  // PR A2 structured enum), NOT pattern-matching setBy strings.
  computeCurrentEnginePhase: (input: {
    gapState: unknown[];
    enginePhases: BlueprintEnginePhaseLocal[];
    contactRecentSetBy?: {
      setBy: string;
      setAt: Date;
      subObjectiveKey: string;
      source: string;
    };
  }) => CurrentEnginePhaseSnapshotLocal;
}

let _brainServiceModule: BrainServiceModule | null = null;
async function loadBrainServiceModule(): Promise<BrainServiceModule> {
  if (_brainServiceModule) return _brainServiceModule;
  // Variable-specifier (non-literal) — bypasses TS6059 cross-rootDir.
  const spec = '../../../../packages/api/src/services/brain-service.js';
  _brainServiceModule = (await import(spec)) as BrainServiceModule;
  return _brainServiceModule;
}

type BrainDecision = Awaited<ReturnType<BrainServiceModule['evaluateDealState']>>;

// ─────────────────────────────────────────────
// Constants — Redis gate TTLs
// ─────────────────────────────────────────────

/**
 * In-flight lock TTL: 30s. Anti-flapping on concurrent inbounds for
 * the same (tenant, contact) pair. Set via `SET key val NX EX 30` —
 * if the key exists, another delivery is mid-processing; drop this
 * one. Released via `DEL` in the handler's `finally` block so a
 * subscriber error can't leave an orphan lock.
 *
 * 30s is conservative: the skeleton handler does no expensive work
 * (just two Prisma writes + Redis ops); the PR4 engine invocation
 * stays under this window with comfortable headroom (Brain Service
 * typical latency ~2-5s per `decision-run-push` observability).
 */
const IN_FLIGHT_TTL_SECONDS = 30;

/**
 * Cooldown TTL: 5 minutes. After successful processing of a reply,
 * subsequent `contact.replied` events for the same (tenant, contact)
 * are skipped for this window — prevents double-evaluation when a
 * second reply arrives within the cooldown.
 *
 * Why shorter than `DEDUP_WINDOW_MINUTES = 30` at
 * `decision-run-push.ts:322`? Replies are high-signal — the operator
 * (or post-PR4 the engine) just decided what to do based on a reply;
 * a second reply within 5 minutes is likely a continuation worth
 * waiting on, but more than 5 minutes apart should re-evaluate fresh.
 */
const COOLDOWN_TTL_SECONDS = 300;

// ─────────────────────────────────────────────
// Hono app
// ─────────────────────────────────────────────

export const contactRepliedPushApp = new Hono();

const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

contactRepliedPushApp.post('/contact-replied', async (c) => {
  // KAN-732: shared helper derives audience from request URL — no
  // CONTACT_REPLIED_AUDIENCE env var. Audience-mismatch class
  // structurally impossible.
  if (!(await verifyPubsubOidc(c))) {
    return c.text('unauthorized', 401);
  }

  let envelope: z.infer<typeof PushEnvelopeSchema>;
  try {
    envelope = PushEnvelopeSchema.parse(await c.req.json());
  } catch (err) {
    console.error(
      `[contact-replied-push] malformed envelope: ${(err as Error)?.message ?? String(err)}`,
    );
    return c.text('ok', 200);
  }

  let event: z.infer<typeof ContactRepliedEventSchema>;
  try {
    const decoded = Buffer.from(envelope.message.data, 'base64').toString('utf8');
    event = ContactRepliedEventSchema.parse(JSON.parse(decoded));
  } catch (err) {
    console.error(
      `[contact-replied-push] malformed contact.replied payload: ${(err as Error)?.message ?? String(err)}`,
    );
    return c.text('ok', 200);
  }

  const redis = getRedisClient();
  // Tenant-isolated by construction — no cross-tenant key collision possible.
  const cooldownKey = `decision-run:cooldown:${event.tenantId}:${event.contactId}`;
  const inFlightKey = `decision-run:in-flight:${event.tenantId}:${event.contactId}`;

  // ─── Cooldown check (high-signal-reply 5-min window) ───────────
  const cooldownActive = await redis.get(cooldownKey);
  if (cooldownActive) {
    void prisma.auditLog
      .create({
        data: {
          tenantId: event.tenantId,
          actor: 'contact_replied_subscriber',
          actionType: 'contact_replied_suppressed_cooldown',
          reasoning: 'cooldown_active',
          payload: {
            eventId: event.eventId,
            contactId: event.contactId,
            cooldownDecisionId: cooldownActive,
            // The decisionId that triggered the cooldown is on the value side;
            // this delivery's decisionId is on `event.decisionId` for trace.
            currentEventDecisionId: event.decisionId,
          },
        },
      })
      .catch((err: unknown) => {
        console.warn(
          `[contact-replied-push] cooldown-audit-failed eventId=${event.eventId} err=${(err as Error)?.message ?? String(err)}`,
        );
      });
    return c.text('ok', 200);
  }

  // ─── In-flight lock (concurrent delivery defense) ──────────────
  // ioredis positional-arg signature: set(key, val, 'EX', seconds, 'NX').
  // EX-token + seconds MUST come before NX per
  // node_modules/ioredis/built/utils/RedisCommander.d.ts:3755 (the only
  // overload that combines TTL + NX-on-create). Returns 'OK' on success,
  // null when NX fails (key already exists).
  const acquired = await redis.set(
    inFlightKey,
    event.eventId,
    'EX',
    IN_FLIGHT_TTL_SECONDS,
    'NX',
  );
  if (acquired !== 'OK') {
    void prisma.auditLog
      .create({
        data: {
          tenantId: event.tenantId,
          actor: 'contact_replied_subscriber',
          actionType: 'contact_replied_suppressed_in_flight',
          reasoning: 'in_flight_lock_held',
          payload: {
            eventId: event.eventId,
            contactId: event.contactId,
          },
        },
      })
      .catch((err: unknown) => {
        console.warn(
          `[contact-replied-push] in-flight-audit-failed eventId=${event.eventId} err=${(err as Error)?.message ?? String(err)}`,
        );
      });
    return c.text('ok', 200);
  }

  try {
    // ── KAN-1037-PR4 — null-dealId short-circuit ──────────────────
    //
    // Edge case: writeSidecarAndCorrelate's correlation succeeded
    // (matchedDecisionId + matchedContactId populated) but the originator
    // contact has NO open Deal at the time of the inbound (Deal closed
    // between the original dispatch and the reply — see
    // writeSidecarAndCorrelate L791-796 docstring). The publisher honestly
    // emits `dealId: null` per the nullable schema; Brain Service's
    // `evaluateDealState` REQUIRES a dealId.
    //
    // Skip-with-audit per the PR3-and-later subscriber observability
    // discipline ("every subscriber outcome writes an audit row"). Cooldown
    // is still set so a no-deal contact replying multiple times rapidly
    // doesn't flood the audit log.
    //
    // Differs from lead-received-push.ts:606's silent-skip precedent —
    // that path's inbound write IS the observable; for contact-replied
    // the audit row is the only observable signal.
    if (event.dealId === null) {
      await prisma.auditLog.create({
        data: {
          tenantId: event.tenantId,
          actor: 'contact_replied_subscriber',
          actionType: 'decision_re_evaluated_skipped_no_deal',
          reasoning: 'no_open_deal_on_originator',
          payload: {
            eventId: event.eventId,
            contactId: event.contactId,
            triggerDecisionId: event.decisionId,
            inboundEngagementId: event.inboundEngagementId,
            replyReceivedAt: event.replyReceivedAt,
          },
        },
      });
      await redis.set(cooldownKey, event.decisionId, 'EX', COOLDOWN_TTL_SECONDS);
      return c.text('ok', 200);
    }

    // ── KAN-1037-PR4 — engine re-evaluation with latestInbound ────
    //
    // Replaces the PR3 skeleton bookmark with the real Brain Service call.
    // First time the engine prompt's `## Latest inbound` section renders
    // body text — the load-bearing PRD §7 quality-risk surface.
    //
    // **Scope: just-evaluate (NOT just-evaluate-AND-dispatch).** Brain's
    // decision is captured in the audit payload but NOT routed through
    // `wirePhase2Consumers`'s downstream chain (stage-transition,
    // message-shaper, send-policy, dispatch). The cognitive surface (does
    // the engine understand the reply?) is observable in isolation; once
    // proven, a follow-up PR wires the dispatch. Splits cognitive-risk
    // from dispatch-risk per the discipline locked in the PR4 spec
    // confirmation — same shape as "ship the schema migration before the
    // code that depends on it."
    //
    // KAN-828 — inject redis + openai so the Knowledge Layer retrieval
    // fires. Same pattern as lead-received-push.ts:1335-1341.
    const {
      evaluateDealState,
      buildLatestInboundContext,
      buildThreadContext,
      // KAN-1065 (Cluster II PR III) — load EnginePhase resolver + focus
      // derivator from the canonical brain-service module.
      resolveEnginePhases,
      computeCurrentEnginePhase,
    } = await loadBrainServiceModule();
    const openai = getOpenAIClient();
    // KAN-1058 (Phase B PR III) — fetch prior conversation turns BEFORE the
    // evaluateDealState call so the result threads into the
    // `## Latest inbound` block's `### Prior conversation context` sub-section.
    // event.dealId is guaranteed non-null by the L360-378 short-circuit above
    // (writeSidecarAndCorrelate's null-dealId path returns 200 with audit +
    // cooldown). buildThreadContext fail-safes to `[]` on any DB error
    // (PR II contract), so a transient query failure gracefully omits the
    // sub-section rather than blocking the engine call.
    const priorTurns = await buildThreadContext(prisma, {
      tenantId: event.tenantId,
      dealId: event.dealId,
      excludeEngagementId: event.inboundEngagementId,
    });
    // KAN-1065 (Cluster II PR III) — compute EnginePhase focus per Phase 1
    // Q1+Q2 locks. Two queries (Q2 lock — engine LLM cost dominates the two
    // single-digit-ms indexed queries). Q1 lock — inline contactRecentSetBy
    // findFirst preserves Cluster I PR III symmetric-inline discipline.
    const enginePhases = await resolveEnginePhases(prisma, event.tenantId);
    const gapStateRows = await prisma.contactSubObjectiveGapState.findMany({
      where: { tenantId: event.tenantId, contactId: event.contactId },
    });
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    const recentManualRow = await prisma.contactSubObjectiveGapState.findFirst({
      where: {
        tenantId: event.tenantId,
        contactId: event.contactId,
        source: 'manual',
        setAt: { gt: new Date(Date.now() - SEVEN_DAYS_MS) },
      },
      orderBy: { setAt: 'desc' },
    });
    const currentEnginePhase = computeCurrentEnginePhase({
      gapState: gapStateRows,
      enginePhases,
      contactRecentSetBy: recentManualRow
        ? {
            setBy: recentManualRow.setBy ?? '',
            setAt: recentManualRow.setAt,
            subObjectiveKey: recentManualRow.subObjectiveKey,
            source: recentManualRow.source,
          }
        : undefined,
    });
    const brainDecision: BrainDecision = await evaluateDealState(prisma, event.dealId, {
      redis,
      openai,
      // Default 'inbound' context is correct here — contact.replied IS
      // an inbound-driven re-eval. Sibling values
      // ('post_stage_advance' / 'post_wait_acknowledgment') are for
      // chained calls that PR4 does not wire.
      triggerContext: 'inbound',
      // KAN-1052 — symmetry pin: the same buildLatestInboundContext helper
      // used by the initial-lead path at lead-received-push.ts:701. Phase B's
      // multi-turn extension touches the helper, not both callers.
      latestInbound: buildLatestInboundContext({
        receivedAt: event.replyReceivedAt,
        senderEmail: event.metadata.senderEmail,
        // bodyText already capped at 2000 chars upstream
        // (ContactRepliedEvent.replyText / normalizeInbound).
        bodyText: event.replyText,
        subjectLine: event.metadata.subjectLine,
        inReplyToDecisionId: event.decisionId,
        threadDepth: event.metadata.threadDepth,
        // KAN-1058 — multi-turn rendering surface.
        priorTurns,
      }),
      // KAN-1065 — thread EnginePhase focus snapshot. PR IV renders the
      // `## Engine phase focus` prompt section; PR V emits the
      // currentEnginePhase + currentEnginePhaseReason audit payload fields.
      currentEnginePhase,
    });

    await prisma.auditLog.create({
      data: {
        tenantId: event.tenantId,
        actor: 'contact_replied_subscriber',
        actionType: 'decision_re_evaluated',
        reasoning: 'brain_eval_complete',
        payload: {
          eventId: event.eventId,
          contactId: event.contactId,
          dealId: event.dealId,
          // Originating Decision (the outbound that this is a reply to).
          triggerDecisionId: event.decisionId,
          // Brain's decision artifacts — surfaces for cognitive-quality
          // empirical assessment per §8 smoke. The full reasoning text is
          // included intentionally; operators inspect it to verify the
          // engine cites reply content (the load-bearing quality signal).
          brainActionType: brainDecision.nextBestAction.type,
          brainConfidence: brainDecision.confidence,
          brainReasoning: brainDecision.nextBestAction.reasoning,
          brainSuggestedChannel: brainDecision.nextBestAction.suggestedChannel ?? null,
          brainSuggestedTone: brainDecision.nextBestAction.suggestedTone ?? null,
          brainModelTier: brainDecision.modelTier,
          llmInputTokens: brainDecision.llmInputTokens,
          llmOutputTokens: brainDecision.llmOutputTokens,
          threadDepth: event.metadata.threadDepth,
          // KAN-1067 (Cluster II PR V) — Tier 1 telemetry. EnginePhase
          // focus snapshot threaded through PR III wiring. Lock 2's
          // derived-from-gap-state contract means the phase key + reason
          // are recoverable at eval time but lossy in PROD without an
          // audit anchor. enginePhasesAvailable is the compact phase-key
          // list (Q4 lock) — full BlueprintEnginePhase config recoverable
          // via Tenant.enginePhasesOverride + Blueprint.enginePhases lookup
          // if a forensic deep-dive needs it.
          currentEnginePhase: currentEnginePhase?.currentPhase.key ?? null,
          currentEnginePhaseReason: currentEnginePhase?.reason ?? null,
          enginePhasesAvailable: enginePhases.map((p) => p.key),
          // Forensic anchors — let operators join back to the originating
          // engagement chain for full trace.
          inboundEngagementId: event.inboundEngagementId,
          outboundEngagementId: event.outboundEngagementId,
          // KAN-1037-PR4.5 — marker that the dispatch chain was kicked off.
          // Fire-and-forget on wirePhase2Consumers below; the boolean reads
          // as "dispatch initiated" not "dispatch completed." Per-consumer
          // observable artifacts (Escalation row, send-policy audit, etc.)
          // are the ground truth for what actually happened downstream.
          dispatchConsumersFired: true,
        },
      },
    });

    // ── KAN-1037-PR4.5 — wire dispatch chain ────────────────────
    //
    // Fire-and-forget per the lead-received-push.ts:607 precedent.
    // Downstream consumer failures (stage-transition error, send-policy
    // defer-write failure, escalation create reject, etc.) must NOT block
    // the cooldown set below or trigger a Pub/Sub retry of the whole
    // contact.replied chain — a retry would re-evaluate Brain (wasteful
    // ~$0.01 of tokens + ~3s of latency) and could race the partial
    // dispatch state we just kicked off. The cognitive audit row above
    // is already committed; downstream observability comes from each
    // consumer's own audit writes.
    //
    // PRECOMPUTED-DECISION PASS-THROUGH (KAN-834 pattern, the load-
    // bearing PR4.5 mechanic): we pass the PR4-evaluated brainDecision
    // through as the 4th arg. wirePhase2Consumers' internal eval at
    // L1335-1341 (lead-received-push.ts) detects the precomputed value
    // and SKIPS its own evaluateDealState call. Without this, the
    // dispatch chain would re-evaluate Brain WITHOUT latestInbound —
    // the reply-aware reasoning that PR4 just demonstrated (engine
    // citing "Q3 timeline / Tuesday afternoon / 30-minute call" at 0.85
    // confidence) would be discarded. PR4's empirical proof would not
    // translate to observable production behavior.
    //
    // `isChainedInvocation: false` — this IS the initial dispatch on
    // this inbound. The KAN-825/835 chains within wirePhase2Consumers
    // self-flag their internal recursive calls.
    void wirePhase2Consumers(
      event.dealId,
      event.eventId,
      false,
      brainDecision as Phase2BrainDecision,
    ).catch((err: unknown) => {
      console.warn(
        `[contact-replied-push] wirePhase2Consumers-error eventId=${event.eventId} err=${(err as Error)?.message ?? String(err)}`,
      );
    });

    // Set 5-min cooldown anchored to this delivery's decisionId so the
    // suppressed-cooldown audit payload above can trace WHICH decision
    // is currently the "freshest evaluation."
    await redis.set(cooldownKey, event.decisionId, 'EX', COOLDOWN_TTL_SECONDS);

    return c.text('ok', 200);
  } catch (err) {
    console.error(
      `[contact-replied-push] handler-error eventId=${event.eventId} err=${(err as Error)?.message ?? String(err)}`,
    );
    // Resend the message — Pub/Sub will retry per the subscription's retry
    // policy (10s/600s exponential, 24h retention per Terraform). Return
    // 500 so the message is nack'd. The in-flight lock is released in the
    // finally block below — when the retry arrives within 30s, it will
    // see the cooldown key (set above only on success), so it falls
    // through to re-acquire the in-flight lock fresh.
    return c.text('internal error', 500);
  } finally {
    // Always release the in-flight lock — even on error — so a retry can
    // re-acquire it. Orphan locks are structurally impossible.
    await redis.del(inFlightKey).catch((err: unknown) => {
      console.warn(
        `[contact-replied-push] in-flight-release-failed eventId=${event.eventId} err=${(err as Error)?.message ?? String(err)}`,
      );
    });
  }
});
