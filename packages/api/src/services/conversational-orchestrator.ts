/**
 * KAN-1184 — Conversational orchestrator service.
 *
 * Single-turn handler for `/campaigns/new` chat builder. Multi-turn dialogue
 * + LLM-scoped dimension extraction + state machine + persistence to
 * CampaignConversationTurn.
 *
 * Doctrinal locks (Phase 1 / Q-ADD ratifications):
 *   - C1: Hybrid LLM tier — Sonnet on ambiguous; Haiku on trivial confirmation
 *   - C2: Deterministic state transitions (nextDimensionToExtract); LLM scoped
 *   - C3: Campaign row created on first turn; turns persisted immediately
 *   - C4: Audience proposal INLINE (orchestrator calls textToSegment/count)
 *   - C5: 3-confidence routing — high=auto, medium=confirm, low=clarification
 *   - C6: Reset reuses Campaign; ConversationState reset; system turn audit
 *   - Q-ADD D Finding E: proposeCampaign function stays as internal helper
 *
 * KAN-689 cohort: consumed via variable-specifier dynamic import from
 * apps/api/src/router.ts.
 */
import type {
  ConversationState,
  DimensionKey,
  DimensionState,
  ChatTurnResult,
} from '@growth/shared';
import { DIMENSION_ORDER, emptyConversationState } from '@growth/shared';

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export interface OrchestratorPrisma {
  campaign: {
    create: (args: {
      data: Record<string, unknown>;
      select: { id: true };
    }) => Promise<{ id: string }>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<unknown>;
    findFirst: (args: {
      where: { id: string; tenantId: string };
      select: Record<string, true>;
    }) => Promise<Record<string, unknown> | null>;
  };
  campaignConversationTurn: {
    create: (args: {
      data: {
        tenantId: string;
        campaignId: string;
        turnType: string;
        content: string;
        proposalSnapshot?: Record<string, unknown>;
      };
    }) => Promise<unknown>;
  };
}

export interface LLMCompleteFn {
  (input: {
    tenantId: string;
    tier: 'reasoning' | 'cheap';
    systemPrompt: string;
    userPrompt: string;
    callerTag: string;
    jsonMode?: boolean;
    maxTokens?: number;
  }): Promise<{
    text: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }>;
}

export interface AudienceCountFn {
  (
    prisma: unknown,
    tenantId: string,
    input: { conditions: unknown },
  ): Promise<{ count: number; isThin: boolean; historicalValueUsd: number }>;
}

export interface OrchestratorParams {
  campaignId?: string;
  tenantId: string;
  message: string;
  state: ConversationState;
}

/**
 * Handle one chat turn. Detects reset intent first; otherwise extracts the
 * next-needed dimension; updates state + persists turns + returns the next
 * AI message + result discriminator.
 */
export async function handleChatTurn(
  prisma: OrchestratorPrisma,
  llm: LLMCompleteFn,
  audienceCount: AudienceCountFn,
  params: OrchestratorParams,
  todayUtc: Date = new Date(),
): Promise<ChatTurnResult> {
  // C3 — Campaign row created on first turn if not provided
  const campaignId =
    params.campaignId ??
    (await createDraftCampaign(prisma, params.tenantId)).id;

  // Persist operator turn first (audit-faithful)
  await prisma.campaignConversationTurn.create({
    data: {
      tenantId: params.tenantId,
      campaignId,
      turnType: 'operator',
      content: params.message,
    },
  });

  // C6 — Reset intent detection
  if (isResetIntent(params.message)) {
    const resetState = emptyConversationState();
    await prisma.campaignConversationTurn.create({
      data: {
        tenantId: params.tenantId,
        campaignId,
        turnType: 'system',
        content: 'Conversation reset — all 4 dimensions cleared.',
      },
    });
    const aiMessage =
      'Starting over from scratch on this campaign. All earlier confirmations cleared. What do you want to accomplish?';
    await prisma.campaignConversationTurn.create({
      data: {
        tenantId: params.tenantId,
        campaignId,
        turnType: 'ai',
        content: aiMessage,
      },
    });
    return { kind: 'reset', aiMessage, state: resetState, campaignId };
  }

  // C2 — Deterministic transition: which dimension to extract next
  const targetDim = nextDimensionToExtract(params.state);

  if (targetDim === null) {
    // All 4 dimensions confirmed; orchestrator hands off to Action Plan
    // generator (KAN-1185).
    const aiMessage =
      'All 4 dimensions confirmed. Ready to generate your Action Plan.';
    await prisma.campaignConversationTurn.create({
      data: {
        tenantId: params.tenantId,
        campaignId,
        turnType: 'ai',
        content: aiMessage,
      },
    });
    return {
      kind: 'all_dimensions_confirmed',
      aiMessage,
      state: params.state,
      campaignId,
    };
  }

  // KAN-1201 L1 — Operator confirmation intent early-exit.
  // If the current targetDim is already 'proposed' AND the operator's
  // message is a bare confirmation, upgrade to 'confirmed' and skip the
  // LLM call entirely. The substrate HAD the confirmation regex in
  // selectTier() (line ~297) but only used it for tier routing — per
  // memo `detected_signals_drive_substrate_not_just_orchestration`,
  // detected signals should drive state transitions FIRST, then inform
  // orchestration decisions downstream.
  const currentDimState = params.state[targetDim];
  if (
    currentDimState.kind === 'proposed' &&
    isOperatorConfirmation(params.message)
  ) {
    const priorValue = currentDimState.value;
    const confirmedState: ConversationState = {
      ...params.state,
      [targetDim]: { kind: 'confirmed', value: priorValue } as DimensionState,
    };
    const allConfirmed = DIMENSION_ORDER.every(
      (d) => confirmedState[d].kind === 'confirmed',
    );
    const ackMessage = allConfirmed
      ? 'All 4 dimensions confirmed. Ready to generate your Action Plan.'
      : buildConfirmationAck(targetDim);
    await prisma.campaignConversationTurn.create({
      data: {
        tenantId: params.tenantId,
        campaignId,
        turnType: 'ai',
        content: ackMessage,
        proposalSnapshot: {
          dimensionKey: targetDim,
          kind: 'confirmed',
          value: priorValue,
        },
      },
    });
    // KAN-1201 L5 — All-confirmed early return (don't wait for next turn).
    if (allConfirmed) {
      return {
        kind: 'all_dimensions_confirmed',
        aiMessage: ackMessage,
        state: confirmedState,
        campaignId,
      };
    }
    return {
      kind: 'dimension_confirmed',
      aiMessage: ackMessage,
      state: confirmedState,
      campaignId,
      dimensionKey: targetDim,
    };
  }

  // Build extraction prompt for the target dimension
  const systemPrompt = buildExtractionPrompt(
    targetDim,
    params.state,
    todayUtc,
  );

  // C1 — Hybrid tier selection
  const tier = selectTier(params.message, params.state);

  let llmResponse;
  try {
    llmResponse = await llm({
      tenantId: params.tenantId,
      tier,
      systemPrompt,
      userPrompt: params.message,
      callerTag: `orchestrator:${targetDim}`,
      jsonMode: true,
      maxTokens: 1024,
    });
  } catch (_err) {
    const aiMessage =
      "Couldn't reach the analyzer right now. Try again in a moment.";
    await prisma.campaignConversationTurn.create({
      data: {
        tenantId: params.tenantId,
        campaignId,
        turnType: 'ai',
        content: aiMessage,
      },
    });
    return { kind: 'analyzer_unavailable', aiMessage, campaignId };
  }

  const extraction = parseDimensionExtraction(llmResponse.text, targetDim);

  // C5 — 3-confidence routing
  if (extraction.kind === 'clarification') {
    await prisma.campaignConversationTurn.create({
      data: {
        tenantId: params.tenantId,
        campaignId,
        turnType: 'ai',
        content: extraction.aiMessage,
      },
    });
    return {
      kind: 'clarification',
      aiMessage: extraction.aiMessage,
      state: params.state,
      campaignId,
    };
  }

  // For audience dimension, inline-compose count (Q-ADD C4 lock)
  let audienceCountAnnotation = '';
  if (targetDim === 'audience' && extraction.value) {
    try {
      const audienceResult = await audienceCount(prisma, params.tenantId, {
        conditions: extraction.value,
      });
      audienceCountAnnotation = ` ${audienceResult.count.toLocaleString()} contacts match.`;
    } catch (_err) {
      // Count unavailable — proceed without annotation
    }
  }

  // KAN-1201 L2/L3/L4 — Confidence-routed transitions per Q-ADD C5 doctrine.
  //   L2 (HIGH + empty)    → auto-confirm  (Q-ADD C5 'high → auto-transition')
  //   L3 (HIGH + proposed) → auto-confirm  (V2 doctrine extended: operator
  //                          continued past a proposal without correcting =
  //                          implicit confirmation)
  //   L4 (MEDIUM)          → propose        (Q-ADD C5 'medium → operator-
  //                          confirmation'; operator must explicitly confirm
  //                          via the L1 early-exit on a subsequent turn)
  //
  // Pre-KAN-1201, this block hardcoded `kind: 'proposed'` for ALL confidence
  // levels. The docstring at lines 12-19 described all 3 confidence-routing
  // behaviors but only the LOW path (→ clarification, already returned above
  // in the extraction.kind === 'clarification' branch) was wired. The HIGH
  // and MEDIUM transitions existed in the docstring only. See memo
  // `documented_doctrine_ne_implemented_doctrine`.
  const priorKindAtTarget = params.state[targetDim].kind;
  const shouldConfirm =
    extraction.confidence === 'high' &&
    (priorKindAtTarget === 'empty' || priorKindAtTarget === 'proposed');

  const updatedState: ConversationState = {
    ...params.state,
    [targetDim]: shouldConfirm
      ? ({ kind: 'confirmed', value: extraction.value } as DimensionState)
      : ({
          kind: 'proposed',
          value: extraction.value,
          confidence: extraction.confidence,
        } as DimensionState),
  };

  // Persist updated state to Campaign row for chat-history resume
  await persistDimensionToCampaign(
    prisma,
    campaignId,
    params.tenantId,
    targetDim,
    extraction.value,
  );

  const aiMessage = `${extraction.aiMessage}${audienceCountAnnotation}`;
  await prisma.campaignConversationTurn.create({
    data: {
      tenantId: params.tenantId,
      campaignId,
      turnType: 'ai',
      content: aiMessage,
      proposalSnapshot: {
        dimensionKey: targetDim,
        kind: shouldConfirm ? 'confirmed' : 'proposed',
        value: extraction.value,
      },
    },
  });

  // KAN-1201 L5 — If this confirmation closed the 4-dimension set, return
  // all_dimensions_confirmed directly (without waiting for the operator to
  // send another turn). Mirrors the entry-time check at line ~147 but fires
  // on the exit path.
  if (
    shouldConfirm &&
    DIMENSION_ORDER.every((d) => updatedState[d].kind === 'confirmed')
  ) {
    return {
      kind: 'all_dimensions_confirmed',
      aiMessage,
      state: updatedState,
      campaignId,
    };
  }

  return shouldConfirm
    ? {
        kind: 'dimension_confirmed',
        aiMessage,
        state: updatedState,
        campaignId,
        dimensionKey: targetDim,
      }
    : {
        kind: 'dimension_proposed',
        aiMessage,
        state: updatedState,
        campaignId,
        dimensionKey: targetDim,
      };
}

// ─────────────────────────────────────────────
// State machine helpers (pure functions; unit-testable without LLM mocks)
// ─────────────────────────────────────────────

/**
 * First-Empty-wins per canonical order. Returns null when all 4 dimensions
 * are confirmed (orchestrator hands off to Action Plan generator).
 */
export function nextDimensionToExtract(
  state: ConversationState,
): DimensionKey | null {
  for (const dim of DIMENSION_ORDER) {
    if (state[dim].kind !== 'confirmed') return dim;
  }
  return null;
}

/**
 * Q-ADD C1 — Hybrid tier selection heuristic.
 *   - Trivial confirmation ("yes" / "ok") → cheap
 *   - Long messages, operator questions, multiple proposed dimensions → reasoning
 *   - Default → reasoning (quality over cost)
 */
export function selectTier(
  message: string,
  state: ConversationState,
): 'reasoning' | 'cheap' {
  if (message.length > 50) return 'reasoning';
  if (countProposed(state) > 1) return 'reasoning';
  if (message.includes('?')) return 'reasoning';
  if (/^(yes|no|ok|sure|confirm|yep|nope)\b/i.test(message.trim())) {
    return 'cheap';
  }
  return 'reasoning';
}

function countProposed(state: ConversationState): number {
  return DIMENSION_ORDER.filter((d) => state[d].kind === 'proposed').length;
}

/**
 * Q-ADD C6 — Reset intent detection. Conservative; requires near-exact match
 * to avoid accidental triggers from ambiguous phrasing ("let me think again"
 * should NOT trigger reset).
 */
export function isResetIntent(message: string): boolean {
  const trimmed = message.trim().toLowerCase();
  return (
    /^(start over|reset|let me try again|from the beginning|restart)\b/.test(
      trimmed,
    )
  );
}

/**
 * KAN-1201 L1 — Operator confirmation intent detection.
 *
 * Conservative pattern; requires confirmation token at message START + word
 * boundary so partial words and embedded confirmations ("we still need to
 * confirm the audience") don't false-positive. Exported so the multi-turn
 * integration test asserts this gate directly + so the apps/web client can
 * locally short-circuit the API call in a future UX enhancement if useful.
 *
 * The substrate already had a similar regex in `selectTier` (above) but only
 * used it to pick LLM tier. Per memo
 * `detected_signals_drive_substrate_not_just_orchestration`, the same signal
 * must drive STATE TRANSITIONS first; orchestration decisions are downstream.
 * Pre-KAN-1201, an operator typing "confirmed" routed to cheap-tier LLM and
 * the LLM re-proposed the SAME dimension — state never advanced because the
 * confirmation signal never reached the state machine.
 */
export function isOperatorConfirmation(message: string): boolean {
  const trimmed = message.trim();
  return /^(yes|yeah|yep|confirm(ed)?|ok(ay)?|sure|correct|right|sounds good|all good|that's right|✓)\b/i.test(
    trimmed,
  );
}

/**
 * KAN-1201 — Operator-facing acknowledgement when a dimension auto-confirms
 * via L1 early-exit. Names the dimension that just confirmed + cues the
 * operator on the NEXT dimension. Honest counsel: the ack message describes
 * exactly the state transition the orchestrator just performed (Defect 3
 * fix — pre-KAN-1201 the LLM's prose said "next, let's nail down your
 * objective" but state never advanced, violating the doctrine preamble).
 */
function buildConfirmationAck(dim: DimensionKey): string {
  switch (dim) {
    case 'product':
      return "Got it — Product confirmed. Next, let's nail down your objective: what specific outcome (revenue / units / deals / meetings) and target number do you want to hit?";
    case 'objectives':
      return "Objective confirmed. Next: what's the timeline — when does this Campaign start and end?";
    case 'timeline':
      return 'Timeline confirmed. Last dimension: the audience — who are we sending this to?';
    case 'audience':
      return 'Audience confirmed. All 4 dimensions are in place — ready to generate your Action Plan.';
  }
}

// ─────────────────────────────────────────────
// Prompt building — per Step 3 lock
// ─────────────────────────────────────────────

const DOCTRINE_PREAMBLE =
  'You are growth, the AI that proposes operator-honest Campaign plans. ' +
  'Doctrine: no euphemism, no fabrication, concrete numbers when relevant, ' +
  'honest counsel over false confidence. When uncertain, ask. Never invent.';

const AUDIENCE_VOCABULARY =
  'Audience filter dimensions (the only valid leaves): ' +
  'lifecycleStage / segment / source / country / region / city / ' +
  'createdAt / orders.placedAt / orders.exists / orders.refundedAt / ' +
  'orders.cancelledAt / deal.value.{gte,lte,between}. ' +
  'Lead-created-at is derived via allOf(lifecycleStage=lead, createdAt).';

export function buildExtractionPrompt(
  dim: DimensionKey,
  state: ConversationState,
  todayUtc: Date,
): string {
  const today = todayUtc.toISOString();
  const stateJson = JSON.stringify(state, null, 2);

  const dimensionDescriptor = describeDimension(dim);
  const vocabulary = dim === 'audience' ? `\n\n${AUDIENCE_VOCABULARY}` : '';
  // KAN-1203 — concrete JSON examples are the primary defense against
  // LLM-output / persist-schema field-name drift. Replaces the prior vague
  // "<dimension-specific shape>" placeholder.
  const valueShapeContract = dimensionValueExample(dim);

  return `${DOCTRINE_PREAMBLE}

Current 4-dimension capture state:
${stateJson}

Target dimension to extract: ${dim} — ${dimensionDescriptor}

Today's date (UTC): ${today}${vocabulary}

# Output envelope (return ONE JSON object)

{
  "kind": "extracted" | "clarification",
  "value"?: <see "value shape contract" below; only when kind=extracted>,
  "confidence": "high" | "medium" | "low",
  "aiMessage": "<operator-facing message — what you extracted, what you'd like to confirm, or what you need clarified>"
}

# Value shape contract (KAN-1203 — STRICT)

${valueShapeContract}

# Confidence routing

- "high" — extraction unambiguous + operator can implicitly confirm by continuing
- "medium" — extraction plausible but operator should explicitly confirm
- "low" — return kind=clarification + specific question; do NOT extract

Be honest. When the operator's message doesn't clearly answer the dimension, return clarification.`;
}

function describeDimension(dim: DimensionKey): string {
  switch (dim) {
    case 'product':
      return 'Which product / offering this Campaign is about (free text or product ID).';
    case 'objectives':
      return 'Numeric outcome target + outcome type (revenue / units / deals / meetings / custom) + goal description.';
    case 'timeline':
      return 'Campaign window — windowStart + windowEnd (ISO 8601 UTC).';
    case 'audience':
      return 'AudienceConditions tree using the leaf vocabulary above. Surface the audience count if you compute one.';
  }
}

/**
 * KAN-1203 — Concrete JSON shape example per dimension. Pre-KAN-1203 the
 * extraction prompt used vague "<dimension-specific shape>" placeholder
 * text; the LLM emitted shapes that diverged from Campaign-column field
 * names (`numericTarget` vs `goalTarget`, `outcomeType` vs `goalType`)
 * and the orchestrator's permissive-on-fail persist code silently dropped
 * everything. The normalizer in persistDimensionToCampaign is now generous
 * enough to translate the natural-language variants — but the prompt
 * tightening here is the primary path: LLMs follow concrete examples
 * MUCH more reliably than prose schemas.
 *
 * Doctrine: documented examples are the canonical contract; the normalizer
 * is defense-in-depth. Both layers together close the dual-state-drift
 * anti-pattern (in-memory state vs persisted state).
 */
function dimensionValueExample(dim: DimensionKey): string {
  switch (dim) {
    case 'product':
      return `Return value as a STRING containing the product/offering name. Example:
  "value": "Growth Platform Pro"

If the operator mentions a specific product, use that name verbatim.
Do NOT wrap in an object; return the raw string.`;
    case 'objectives':
      return `Return value as a JSON OBJECT with EXACTLY these field names:
  {
    "goalType": "revenue" | "units" | "deals" | "meetings" | "custom",
    "goalTarget": <number>,
    "goalDescription": "<one-sentence operator-facing summary>"
  }

The goalType MUST be one of the 5 enum values listed above. If the operator's
intent doesn't fit revenue/units/deals/meetings, use "custom".

Example for "I want to sell 50 subscriptions of Growth Platform":
  "value": {
    "goalType": "custom",
    "goalTarget": 50,
    "goalDescription": "Sell 50 subscriptions of Growth Platform"
  }`;
    case 'timeline':
      return `Return value as a JSON OBJECT with EXACTLY these field names:
  {
    "windowStart": "<ISO 8601 UTC timestamp>",
    "windowEnd": "<ISO 8601 UTC timestamp>"
  }

Both fields are required. Example for "campaign runs July 2026":
  "value": {
    "windowStart": "2026-07-01T00:00:00.000Z",
    "windowEnd": "2026-07-31T23:59:59.999Z"
  }`;
    case 'audience':
      return `Return value as an AudienceConditions tree per the leaf vocabulary above.
Example for "leads from Quebec who bought in last 30 days":
  "value": {
    "allOf": [
      { "field": "lifecycleStage", "op": "in", "values": ["lead"] },
      { "field": "region", "op": "in", "values": ["QC"] },
      { "field": "orders.placedAt", "op": "gte", "value": "<ISO timestamp 30d ago>" }
    ]
  }`;
  }
}

// ─────────────────────────────────────────────
// LLM output parsing
// ─────────────────────────────────────────────

type ExtractionResult =
  | { kind: 'extracted'; value: unknown; confidence: 'high' | 'medium' | 'low'; aiMessage: string }
  | { kind: 'clarification'; aiMessage: string };

export function parseDimensionExtraction(
  llmOutput: string,
  _targetDim: DimensionKey,
): ExtractionResult {
  let parsed: { kind?: unknown; value?: unknown; confidence?: unknown; aiMessage?: unknown };
  try {
    // LLM sometimes wraps JSON in markdown fences
    const cleaned = llmOutput.replace(/```json\n?|\n?```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    // Malformed JSON → graceful degradation to clarification
    return {
      kind: 'clarification',
      aiMessage:
        "I didn't quite catch that. Could you rephrase what you'd like to focus on?",
    };
  }

  if (parsed.kind === 'clarification') {
    return {
      kind: 'clarification',
      aiMessage:
        typeof parsed.aiMessage === 'string'
          ? parsed.aiMessage
          : 'Could you tell me more?',
    };
  }

  if (parsed.kind === 'extracted') {
    const confidence = parsed.confidence;
    if (
      confidence !== 'high' &&
      confidence !== 'medium' &&
      confidence !== 'low'
    ) {
      return {
        kind: 'clarification',
        aiMessage:
          "I wasn't sure how confident to be on that — could you clarify?",
      };
    }
    // Low confidence routes to clarification per Q-ADD C5
    if (confidence === 'low') {
      return {
        kind: 'clarification',
        aiMessage:
          typeof parsed.aiMessage === 'string'
            ? parsed.aiMessage
            : 'Could you tell me more about that?',
      };
    }
    return {
      kind: 'extracted',
      value: parsed.value,
      confidence,
      aiMessage:
        typeof parsed.aiMessage === 'string'
          ? parsed.aiMessage
          : 'Got it.',
    };
  }

  // Unknown kind → clarification fallback
  return {
    kind: 'clarification',
    aiMessage: 'Could you say a bit more about that?',
  };
}

// ─────────────────────────────────────────────
// Persistence helpers
// ─────────────────────────────────────────────

// KAN-1200 — Exported so the KAN-1200 integration test can exercise this
// path against REAL Prisma (closes the loader-vs-canonical test divergence
// that let KAN-1184 ship with a zero-UUID FK-violating placeholder; unit
// tests injected campaignId and never invoked this function).
export async function createDraftCampaign(
  prisma: OrchestratorPrisma,
  tenantId: string,
): Promise<{ id: string }> {
  // KAN-1200 — Mint a draft Campaign WITHOUT an objectiveId. The earlier
  // KAN-1184 implementation hardcoded a zero-UUID placeholder which violated
  // campaigns_objective_id_fkey on every first chat turn; the test substrate
  // injected a campaignId and never exercised this code path against real
  // Prisma, so the FK violation only surfaced when Fred ran the first
  // end-to-end UI smoke in PROD after KAN-1190 deployed.
  //
  // The fix is doctrinally clean: KAN-1167 shifted goal semantics from
  // Objective-owned to Campaign-owned (goalType / goalTarget / goalProductId
  // / goalDescription live on the Campaign row), and KAN-1190 V3 already
  // established the nullable-objective pattern for Pipeline.objectiveId on
  // Action Plan commits. Campaign.objectiveId is now nullable too (see
  // schema.prisma KAN-1200 doctrine comment + the matching migration). The
  // operator MAY bind an Objective later via the dimensions UI; commit-time
  // resolution stays available via the regular Campaign.update path.
  return prisma.campaign.create({
    data: {
      tenantId,
      name: 'Draft Campaign',
      audienceConditions: {},
      status: 'draft',
    },
    select: { id: true },
  });
}

// ─────────────────────────────────────────────
// KAN-1203 — LLM-output → Campaign-schema normalizers (per-dimension)
//
// Pre-KAN-1203 `persistDimensionToCampaign` strict-checked for Campaign-schema
// field names exactly (`goalType` / `goalTarget` / `goalDescription`); when the
// LLM emitted natural-language-flavored names (`outcomeType` / `numericTarget`
// / `description`) the conditional silently dropped them and the Campaign row
// stayed NULL — even though the in-memory ConversationState showed the
// dimension confirmed with valid data. Operator clicked Generate, generator
// returned `insufficient_dimensions` because the row was empty.
//
// This is the "dual-state-source-of-truth-drift anti-pattern": ConversationState
// (in-memory) diverged from Campaign row (persistence) because the persist
// coercion was permissive-on-fail (silent drop) rather than strict-on-fail
// (Zod reject + clarification). The fix accepts BOTH the canonical schema
// names AND common LLM-natural variants, normalizes to canonical, and emits
// a structured console.warn when normalization fails so future drift is
// surfaced rather than swallowed.
//
// Same class as KAN-1200 (FK violation hidden by test substrate) + KAN-1201
// (state machine never advanced past docstring). Operator-experience
// verification gap (see `operator_experience_verification` memo).
//
// LLM prompt at `buildExtractionPrompt` ALSO tightened with concrete JSON
// shape examples per dimension — the LLM follows examples better than prose
// schemas; the normalizer below is the runtime defense in depth.
// ─────────────────────────────────────────────

/** Compact description of a value's shape for drift logging — surfaces
 *  enough structure for forensic debugging without dumping the whole
 *  payload (which may be operator-sensitive). */
function describeValueShape(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return `${typeof value}`;
  if (Array.isArray(value)) return `array[${value.length}]`;
  const keys = Object.keys(value as Record<string, unknown>).slice(0, 8).join(',');
  return `object{${keys}}`;
}

/** Pick the first string value at any of the given keys; returns undefined
 *  if none match. Centralizes the multi-key-name lookup so each dimension
 *  normalizer reads as a flat list of expected names. */
function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return undefined;
}

function pickNumber(obj: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Canonical goalType enum from KAN-1167 schema. LLM may emit any of these
 *  values OR plural variants ("customers" / "units" with -s); we coerce to
 *  the canonical singular enum value. Unknown values fall back to 'custom'
 *  (which is the legitimate catch-all per `parseGoalShape`'s switch). */
const GOAL_TYPE_NORMALIZERS: Record<string, 'revenue' | 'units' | 'deals' | 'meetings' | 'custom'> = {
  revenue: 'revenue',
  revenues: 'revenue',
  unit: 'units',
  units: 'units',
  deal: 'deals',
  deals: 'deals',
  meeting: 'meetings',
  meetings: 'meetings',
  custom: 'custom',
  // KAN-1203 — pluralized natural-language variants from Fred's session
  customer: 'custom',
  customers: 'custom',
  subscription: 'custom',
  subscriptions: 'custom',
  sale: 'custom',
  sales: 'custom',
};

function normalizeGoalType(raw: string): 'revenue' | 'units' | 'deals' | 'meetings' | 'custom' {
  return GOAL_TYPE_NORMALIZERS[raw.trim().toLowerCase()] ?? 'custom';
}

/** Normalize the LLM's product-dimension value into a single goalProductId
 *  string. Accepts: a raw string (canonical) OR an object with one of several
 *  natural-language field names (LLM-flavored). */
function normalizeProduct(value: unknown): { goalProductId: string } | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return { goalProductId: value.trim() };
  }
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const productId = pickString(v, ['goalProductId', 'productId', 'name', 'productName', 'product', 'value', 'id']);
    if (productId) return { goalProductId: productId };
  }
  return null;
}

/** Normalize the LLM's objectives-dimension value. Accepts both canonical
 *  ({goalType, goalTarget, goalDescription}) AND Fred-confirmed LLM-natural
 *  ({outcomeType, numericTarget, description}). Returns partial if some
 *  fields are missing — the caller writes whichever fields normalized
 *  successfully (matches pre-KAN-1203 partial-write semantics for
 *  doctrine-preserving compatibility). */
function normalizeObjectives(value: unknown): Partial<{
  goalType: string;
  goalTarget: number;
  goalDescription: string;
}> {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  const result: Partial<{ goalType: string; goalTarget: number; goalDescription: string }> = {};

  const rawType = pickString(v, ['goalType', 'outcomeType', 'type', 'metric', 'kpi']);
  if (rawType) result.goalType = normalizeGoalType(rawType);

  const target = pickNumber(v, ['goalTarget', 'numericTarget', 'target', 'count', 'quantity', 'amount']);
  if (target != null) result.goalTarget = target;

  const description = pickString(v, ['goalDescription', 'description', 'goal', 'objective', 'summary']);
  if (description) result.goalDescription = description;

  return result;
}

/** Normalize the LLM's timeline-dimension value to {windowStart, windowEnd}
 *  as Date objects. Pre-KAN-1203 accepted only ISO strings via `new Date()`
 *  (which silently returns Invalid Date on bad input); KAN-1203 surfaces
 *  Invalid Date as a normalization failure so the field stays NULL rather
 *  than corrupting the column. */
function normalizeTimeline(value: unknown): Partial<{ windowStart: Date; windowEnd: Date }> {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  const result: Partial<{ windowStart: Date; windowEnd: Date }> = {};

  const startRaw = pickString(v, ['windowStart', 'start', 'startDate', 'from', 'beginAt']);
  if (startRaw) {
    const d = new Date(startRaw);
    if (!Number.isNaN(d.getTime())) result.windowStart = d;
  }

  const endRaw = pickString(v, ['windowEnd', 'end', 'endDate', 'to', 'finishAt']);
  if (endRaw) {
    const d = new Date(endRaw);
    if (!Number.isNaN(d.getTime())) result.windowEnd = d;
  }

  return result;
}

async function persistDimensionToCampaign(
  prisma: OrchestratorPrisma,
  campaignId: string,
  _tenantId: string,
  dim: DimensionKey,
  value: unknown,
): Promise<void> {
  const data: Record<string, unknown> = {};
  switch (dim) {
    case 'product': {
      const normalized = normalizeProduct(value);
      if (normalized) {
        data.goalProductId = normalized.goalProductId;
      } else {
        // KAN-1203 — surface drift so future PROD sessions don't need
        // DevTools to diagnose. Operator-experience verification gap.
        console.warn(
          `[orchestrator] product-persist-drift campaignId=${campaignId} valueShape=${describeValueShape(value)}`,
        );
      }
      break;
    }
    case 'objectives': {
      const normalized = normalizeObjectives(value);
      if (normalized.goalType) data.goalType = normalized.goalType;
      if (normalized.goalTarget != null) data.goalTarget = normalized.goalTarget;
      if (normalized.goalDescription) data.goalDescription = normalized.goalDescription;
      const dropped: string[] = [];
      if (!normalized.goalType) dropped.push('goalType');
      if (normalized.goalTarget == null) dropped.push('goalTarget');
      if (!normalized.goalDescription) dropped.push('goalDescription');
      if (dropped.length > 0) {
        console.warn(
          `[orchestrator] objectives-persist-drift campaignId=${campaignId} dropped=${dropped.join(',')} valueShape=${describeValueShape(value)}`,
        );
      }
      break;
    }
    case 'timeline': {
      const normalized = normalizeTimeline(value);
      if (normalized.windowStart) data.windowStart = normalized.windowStart;
      if (normalized.windowEnd) data.windowEnd = normalized.windowEnd;
      const dropped: string[] = [];
      if (!normalized.windowStart) dropped.push('windowStart');
      if (!normalized.windowEnd) dropped.push('windowEnd');
      if (dropped.length > 0) {
        console.warn(
          `[orchestrator] timeline-persist-drift campaignId=${campaignId} dropped=${dropped.join(',')} valueShape=${describeValueShape(value)}`,
        );
      }
      break;
    }
    case 'audience':
      // KAN-1203 — audience passes through to Campaign.audienceConditions
      // JSON column; downstream validation (generator/refiner) runs
      // AudienceConditionsSchema.parse separately. Logging drift here would
      // false-positive on schema-valid-but-non-trivial trees.
      data.audienceConditions = value;
      break;
  }
  if (Object.keys(data).length > 0) {
    await prisma.campaign.update({ where: { id: campaignId }, data });
  }
}
