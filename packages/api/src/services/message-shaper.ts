/**
 * KAN-797a — Message Shaper (Phase 2 epic 4 of 5, sub-cohort a).
 *
 * message-shaper.ts: composes outbound messages for the NEW Brain-driven action flow.
 * Multi-channel (email/sms/meta_messenger), Sonnet-tier, anti-repetition, pure-return.
 *
 * SIBLING but DISTINCT from message-composer.ts (~/services/message-composer.ts), which
 * serves the LEGACY action.decided event flow (KAN-660/661/698/703): single-channel email,
 * Haiku-tier, RAG-injected, returns+publishes. message-composer is the canonical live send
 * path today; message-shaper is forward-investment for the Brain-driven Phase 2 architecture.
 *
 * Convergence question (extend composer with Brain support OR retire composer in favor of
 * shaper) is deferred — Phase 5+ cleanup decision pending.
 *
 * Pure module — does NOT dispatch, does NOT persist Action row. Caller (KAN-815 sub-cohort
 * b) wraps with Send Policy (KAN-798) + channel API call + Action row write.
 *
 * Decision flow:
 *   1. Get Brain decision (use options.brainDecision if provided to avoid double-eval, else
 *      call evaluateDealState).
 *   2. If Brain returns anything other than send_follow_up → no_shape (no LLM compose).
 *   3. Load Deal + Contact + recent outbound Engagements (anti-repetition context).
 *   4. Resolve channel: forceChannel override > Brain suggestion > "email" default.
 *   5. Resolve tone: Brain suggestion > "professional" default.
 *   6. Build prompt with anti-repetition context.
 *   7. Call LLM (Sonnet by default — message quality matters for first impressions).
 *   8. Parse + validate (strict reject — see VALID_TONES allowlist + channel-aware checks
 *      below).
 *   9. Return ShapedMessage.
 *
 * Channel selection MVP: Brain's suggestedChannel is the only signal. Real channel-preference
 * learning (best channel per Contact based on engagement history) is folded into KAN-805
 * Shared Learning Layer scope (per Phase 2 deferral 2026-05-03).
 *
 * Anti-repetition MVP: load last K outbound engagements, pass their subject + body summary
 * to the LLM as "DON'T repeat these" context. Phase 4+ can replace heuristic with
 * embedding-similarity check via brain-embeddings.
 *
 * Cost-tracking alignment with KAN-745 + KAN-794 + KAN-795 + KAN-796a: returns
 * llmInputTokens + llmOutputTokens (NOT llmCostUsd). Same async-cost-via-llm.call posture.
 */
import type { PrismaClient } from '@prisma/client';
import { complete } from './llm-client.js';
import { evaluateDealState, type BrainDecision } from './brain-service.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type ShapedMessageChannel = 'email' | 'sms' | 'meta_messenger';
export type ShapedMessageTone = 'curious' | 'professional' | 'urgent' | 'closing';

export interface ShapedMessage {
  dealId: string;
  shapedAt: Date;
  channel: ShapedMessageChannel;
  /** Email-only. Required when channel='email'; absent for sms/meta_messenger. */
  subject?: string;
  body: string;
  tone: ShapedMessageTone;
  /** 1-2 sentence explanation of why this message — observability + audit anchor. */
  rationale: string;
  /** How many past outbound engagements were considered for anti-repetition. */
  antiRepetitionContextCount: number;
  modelTier: 'cheap' | 'reasoning';
  /**
   * KAN-745 architecture: llm-client emits cost asynchronously via llm.call topic →
   * llm-cost-aggregator. Returns raw token counts so consumers can compute cost themselves
   * (via MODEL_PRICING) or join the async rollup. See feedback_model_pricing_refresh_discipline.
   */
  llmInputTokens: number;
  llmOutputTokens: number;
}

export type ShapeMessageResult =
  | { type: 'shaped'; message: ShapedMessage; brainDecision: BrainDecision }
  | { type: 'no_shape'; dealId: string; reason: string; brainDecision?: BrainDecision };

export interface ShapeMessageOptions {
  /** Default tier: 'reasoning' (Sonnet) — message quality matters for first impressions. */
  tier?: 'cheap' | 'reasoning';
  /** Optional pre-computed Brain decision. When provided, shapeMessage skips its own
   *  evaluateDealState call (avoids double Brain eval when caller already has the decision —
   *  e.g., a future orchestrator that calls Brain once and routes the result to multiple
   *  consumers). */
  brainDecision?: BrainDecision;
  /** Default 5. Caps how many recent outbound Engagements feed into the anti-repetition prompt. */
  recentOutboundLimit?: number;
  /** Override Brain's suggestedChannel (for testing or operator manual override). */
  forceChannel?: ShapedMessageChannel;
}

export class MessageShaperDealNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageShaperDealNotFoundError';
  }
}

const SMS_BODY_MAX_CHARS = 160;
const VALID_TONES: ReadonlySet<ShapedMessageTone> = new Set<ShapedMessageTone>([
  'curious',
  'professional',
  'urgent',
  'closing',
]);
const VALID_CHANNELS: ReadonlySet<ShapedMessageChannel> = new Set<ShapedMessageChannel>([
  'email',
  'sms',
  'meta_messenger',
]);

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Shape (compose) the next outbound message for a Deal based on Brain Service decision.
 *
 * Throws MessageShaperDealNotFoundError when dealId doesn't exist (or BrainServiceNotFoundError
 * if the Brain Service load fails — propagated upward).
 *
 * Graceful no_shape on non-send_follow_up Brain decisions OR LLM call failure OR parse failure
 * (including strict-reject edge cases like email-without-subject and SMS-too-long).
 */
export async function shapeMessage(
  prisma: PrismaClient,
  dealId: string,
  options: ShapeMessageOptions = {},
): Promise<ShapeMessageResult> {
  const tier = options.tier ?? 'reasoning';
  const recentOutboundLimit = options.recentOutboundLimit ?? 5;
  const shapedAt = new Date();

  // 1. Brain decision (re-eval if not provided).
  const brainDecision =
    options.brainDecision ?? (await evaluateDealState(prisma, dealId, { tier }));

  // 2. Short-circuit if Brain doesn't recommend send_follow_up.
  if (brainDecision.nextBestAction.type !== 'send_follow_up') {
    return {
      type: 'no_shape',
      dealId,
      reason: `Brain decision type=${brainDecision.nextBestAction.type} does not require message shaping`,
      brainDecision,
    };
  }

  // 3. Load Deal + Contact + recent outbound engagements.
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      contact: true,
      pipeline: { select: { name: true, objectiveType: true, objectiveDescription: true } },
      currentStage: { select: { name: true, outcomeType: true } },
      engagements: {
        where: {
          OR: [
            { engagementType: { startsWith: 'email_send' } },
            { engagementType: { startsWith: 'sms_send' } },
            { engagementType: { startsWith: 'meta_messenger_send' } },
          ],
        },
        orderBy: { occurredAt: 'desc' },
        take: recentOutboundLimit,
      },
    },
  });
  if (!deal) {
    throw new MessageShaperDealNotFoundError(`Deal not found: ${dealId}`);
  }

  // KAN-839 — load most recent inbound Engagement for this Deal so the
  // Shaper prompt can render the customer's verbatim words. Single row
  // (the most recent); load is universal across all dispatch paths
  // (initial inbound, KAN-825 chain, KAN-835 chain, KAN-814 cron
  // re-dispatch) because the Engagement IS the source-of-truth — the
  // in-memory `event` payload is not in scope for cron-deferred sends.
  // Producer (lead-received-push) writes metadata.{subject, bodyPreview}
  // capped at 2000 chars; this consumer reads them as-is.
  const recentInbound = await prisma.engagement.findFirst({
    where: {
      dealId,
      OR: [
        { engagementType: { startsWith: 'email_received' } },
        { engagementType: { startsWith: 'sms_received' } },
        { engagementType: { startsWith: 'meta_messenger_received' } },
      ],
    },
    orderBy: { occurredAt: 'desc' },
    select: { occurredAt: true, metadata: true },
  });

  // 4. Resolve channel: forceChannel override > Brain suggestion > 'email' default.
  const suggestedChannel = brainDecision.nextBestAction.suggestedChannel;
  const channel: ShapedMessageChannel =
    options.forceChannel ??
    (suggestedChannel && VALID_CHANNELS.has(suggestedChannel as ShapedMessageChannel)
      ? (suggestedChannel as ShapedMessageChannel)
      : 'email');

  // 5. Resolve tone: Brain suggestion > 'professional' default.
  const suggestedTone = brainDecision.nextBestAction.suggestedTone;
  const tone: ShapedMessageTone =
    suggestedTone && VALID_TONES.has(suggestedTone as ShapedMessageTone)
      ? (suggestedTone as ShapedMessageTone)
      : 'professional';

  // 6. Build prompt.
  const userPrompt = buildShapePrompt({
    contact: deal.contact,
    pipeline: deal.pipeline,
    currentStage: deal.currentStage,
    brainReasoning: brainDecision.nextBestAction.reasoning,
    channel,
    tone,
    recentOutbound: deal.engagements,
    recentInbound: recentInbound
      ? { occurredAt: recentInbound.occurredAt, metadata: recentInbound.metadata }
      : null,
  });

  // KAN-817 — gated smoke log. Enables capturing the rendered Shaper user
  // prompt during a 3-turn smoke so we can eyeball that the new
  // `metadata.subject` + `metadata.bodyPreview` fields actually flow into
  // the prompt's "Recent outbound to avoid repeating" section. Off by
  // default — flip on with `KAN_817_SMOKE_LOG=true` only for the smoke,
  // then unset (or remove this block once KAN-797a content visibility is
  // proven end-to-end).
  if (process.env.KAN_817_SMOKE_LOG === 'true') {
    console.log(
      `[message-shaper] kan-817-smoke-prompt dealId=${dealId} channel=${channel} tone=${tone} antiRepetitionContextCount=${deal.engagements.length}\n--- BEGIN USER PROMPT ---\n${userPrompt}\n--- END USER PROMPT ---`,
    );
  }

  // 7. Call LLM. tenantId derived from Deal (KAN-745 per-tenant cost partition).
  let llmText: string;
  let llmInputTokens = 0;
  let llmOutputTokens = 0;
  try {
    const response = await complete({
      tenantId: deal.tenantId,
      tier,
      systemPrompt: SHAPE_SYSTEM_PROMPT,
      userPrompt,
      // SMS is short (160-char cap); email gets headroom for richer bodies.
      maxTokens: channel === 'sms' ? 200 : 600,
      callerTag: `message-shaper:shape-${channel}`,
    });
    llmText = response.text;
    llmInputTokens = response.inputTokens;
    llmOutputTokens = response.outputTokens;
  } catch (err) {
    console.warn(
      `[message-shaper] llm-call-failed dealId=${dealId} channel=${channel} err=${(err as Error)?.message ?? String(err)}`,
    );
    return gracefulNoShape(dealId, brainDecision, 'LLM call failed');
  }

  // 8. Parse + validate (strict reject per channel rules).
  const parsed = parseShapeResponse(llmText, channel);
  if (!parsed.ok) {
    console.warn(
      `[message-shaper] parse-failed dealId=${dealId} channel=${channel} reason=${parsed.error} preview=${llmText.slice(0, 200)}`,
    );
    return gracefulNoShape(dealId, brainDecision, `LLM response invalid: ${parsed.error}`);
  }

  return {
    type: 'shaped',
    message: {
      dealId,
      shapedAt,
      channel,
      ...(parsed.value.subject ? { subject: parsed.value.subject } : {}),
      body: parsed.value.body,
      tone,
      rationale: parsed.value.rationale,
      antiRepetitionContextCount: deal.engagements.length,
      modelTier: tier,
      llmInputTokens,
      llmOutputTokens,
    },
    brainDecision,
  };
}

// ─────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────

const SHAPE_SYSTEM_PROMPT = `You are an AI sales assistant composing the next outbound message for a sales Deal.

Given the Contact's profile, current Deal state, the Pipeline's objective, the suggested tone, and a list of recent outbound messages already sent (which you must NOT repeat), compose ONE outbound message.

Channel-specific rules:
- email: include both subject and body. Subject is REQUIRED.
- sms: body only (no subject). Body MUST be ≤ 160 characters.
- meta_messenger: body only (no subject). Conversational, < 500 chars.

General rules:
- Match the suggested tone exactly (curious / professional / urgent / closing).
- Don't repeat themes/openings/closings used in the recent outbound list.
- Reference the Contact by name if known.
- Be specific to the Deal's Pipeline objective (e.g., "warm_up_lead" → discovery questions; "send_quote" → next step toward proposal).
- Don't make up facts about the Contact or company.

Respond ONLY with valid JSON in this exact shape:
{
  "subject": "<email subject — REQUIRED for email channel, omit/null for sms/meta_messenger>",
  "body": "<message body>",
  "rationale": "<1-2 sentence explanation of why this message>"
}`;

interface PromptContact {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
}

interface PromptPipeline {
  name: string;
  objectiveType: string;
  objectiveDescription: string | null;
}

interface PromptStage {
  name: string;
  outcomeType: string;
}

interface PromptOutbound {
  occurredAt: Date;
  engagementType: string;
  channel: string | null;
  metadata: unknown;
}

// KAN-839 — most recent inbound from the contact, surfaced into the Shaper
// prompt so outbound replies are responsive to the customer's literal words
// rather than templating against Brain's strategic intent alone.
interface PromptInbound {
  occurredAt: Date;
  metadata: unknown;
}

// KAN-839 — render cap for the inbound body inside the prompt. Matches the
// producer-side cap at lead-received-push.ts (DB stores ≤ 2000 chars).
// Single source of truth: the persisted value IS the render value.
const INBOUND_BODY_RENDER_MAX_CHARS = 2000;

export function buildShapePrompt(input: {
  contact: PromptContact;
  pipeline: PromptPipeline;
  currentStage: PromptStage;
  brainReasoning: string;
  channel: ShapedMessageChannel;
  tone: ShapedMessageTone;
  recentOutbound: PromptOutbound[];
  recentInbound: PromptInbound | null;
}): string {
  const { contact, pipeline, currentStage, brainReasoning, channel, tone, recentOutbound, recentInbound } = input;

  const contactName =
    [contact.firstName, contact.lastName].filter((p) => !!p && p.trim().length > 0).join(' ') ||
    contact.email ||
    '(unknown contact)';
  const company = contact.company ?? '(unknown company)';

  const recentOutboundBlock =
    recentOutbound.length === 0
      ? '(none — this is the first outbound for this Deal)'
      : recentOutbound
          .map((e, i) => {
            const meta = (e.metadata ?? {}) as Record<string, unknown>;
            const subject = typeof meta.subject === 'string' ? meta.subject : '(no subject)';
            const bodyPreview =
              typeof meta.bodyPreview === 'string'
                ? meta.bodyPreview.slice(0, 120)
                : typeof meta.body === 'string'
                  ? (meta.body as string).slice(0, 120)
                  : '(no body preview)';
            return `${i + 1}. ${e.occurredAt.toISOString()} ${e.engagementType}${e.channel ? ` (${e.channel})` : ''}\n   subject: ${subject}\n   body: ${bodyPreview}`;
          })
          .join('\n');

  // KAN-839 — render the most recent inbound from the contact. Three states:
  //   1. No inbound row at all → first-outbound-on-Deal posture; the AI
  //      isn't responding to anything specific.
  //   2. Subject-only (body absent or empty after trim) → e.g., reply with
  //      empty body but a subject line. Render the subject so the AI sees
  //      the topic even without prose.
  //   3. Subject + body → the canonical case. Verbatim text is what makes
  //      KAN-839 work end-to-end.
  let recentInboundBlock: string;
  if (!recentInbound) {
    recentInboundBlock = '(no inbound from this contact yet)';
  } else {
    const meta = (recentInbound.metadata ?? {}) as Record<string, unknown>;
    const subject = typeof meta.subject === 'string' ? meta.subject : null;
    const bodyRaw = typeof meta.bodyPreview === 'string' ? meta.bodyPreview : null;
    const body = bodyRaw && bodyRaw.trim().length > 0
      ? bodyRaw.slice(0, INBOUND_BODY_RENDER_MAX_CHARS)
      : null;
    if (body) {
      recentInboundBlock = `Subject: ${subject ?? '(no subject)'}\n\n${body}`;
    } else {
      recentInboundBlock = `(subject only — body empty)\nSubject: ${subject ?? '(no subject)'}`;
    }
  }

  return `## Contact
${contactName} @ ${company}

## Deal context
Pipeline: ${pipeline.name} (objective: ${pipeline.objectiveType}${pipeline.objectiveDescription ? ` — ${pipeline.objectiveDescription}` : ''})
Current Stage: ${currentStage.name} (${currentStage.outcomeType})

## Brain-suggested intent
${brainReasoning}

## Recent inbound from contact
${recentInboundBlock}

## Channel + tone
Channel: ${channel}
Tone: ${tone}

## Recent outbound to avoid repeating
${recentOutboundBlock}

## Output
Compose the next outbound message. Respond ONLY with the JSON shape from the system prompt.`;
}

// ─────────────────────────────────────────────
// Response parsing — strict-reject discipline
// ─────────────────────────────────────────────

// Strict-reject discipline (sibling to KAN-794 VALID_ACTION_TYPES allowlist):
// - Email channel: subject is REQUIRED. Resend connector enforces this; we fail-fast here
//   to surface the malformed-LLM-output as gracefulNoShape rather than letting it
//   propagate to dispatch.
// - SMS channel: body must be ≤ 160 chars. Truncating mid-message would change intent and
//   risk landing a half-sentence at the carrier. KAN-798 Send Policy can decide whether to
//   re-prompt the LLM or escalate when it sees a no_shape result.

type ParsedShapeResponse =
  | { ok: true; value: { subject?: string; body: string; rationale: string } }
  | { ok: false; error: string };

export function parseShapeResponse(
  text: string,
  channel: ShapedMessageChannel,
): ParsedShapeResponse {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${(err as Error).message}` };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Response is not an object' };
  }
  const root = parsed as Record<string, unknown>;

  const body = root.body;
  const rationale = root.rationale;
  const subjectRaw = root.subject;

  if (typeof body !== 'string' || body.trim().length === 0) {
    return { ok: false, error: 'body missing or empty' };
  }
  if (typeof rationale !== 'string' || rationale.trim().length === 0) {
    return { ok: false, error: 'rationale missing or empty' };
  }

  // Channel-specific strict-reject rules.
  if (channel === 'email') {
    if (typeof subjectRaw !== 'string' || subjectRaw.trim().length === 0) {
      return { ok: false, error: 'email missing required subject' };
    }
    return {
      ok: true,
      value: { subject: subjectRaw.trim(), body: body.trim(), rationale: rationale.trim() },
    };
  }

  if (channel === 'sms') {
    const trimmedBody = body.trim();
    if (trimmedBody.length > SMS_BODY_MAX_CHARS) {
      return {
        ok: false,
        error: `SMS body exceeds ${SMS_BODY_MAX_CHARS} chars (got ${trimmedBody.length})`,
      };
    }
    return { ok: true, value: { body: trimmedBody, rationale: rationale.trim() } };
  }

  // meta_messenger (no subject required, no length cap beyond LLM maxTokens).
  return { ok: true, value: { body: body.trim(), rationale: rationale.trim() } };
}

// ─────────────────────────────────────────────
// Graceful fallback
// ─────────────────────────────────────────────

function gracefulNoShape(
  dealId: string,
  brainDecision: BrainDecision,
  reason: string,
): ShapeMessageResult {
  return {
    type: 'no_shape',
    dealId,
    reason: `Message Shaper fallback: ${reason}. Caller should retry, escalate, or surface for human composition.`,
    brainDecision,
  };
}
