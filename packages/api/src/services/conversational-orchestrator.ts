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

  const proposedState: ConversationState = {
    ...params.state,
    [targetDim]: {
      kind: 'proposed',
      value: extraction.value,
      confidence: extraction.confidence,
    } as DimensionState,
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
      proposalSnapshot: { dimensionKey: targetDim, value: extraction.value },
    },
  });

  return {
    kind: 'dimension_proposed',
    aiMessage,
    state: proposedState,
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

  return `${DOCTRINE_PREAMBLE}

Current 4-dimension capture state:
${stateJson}

Target dimension to extract: ${dim} — ${dimensionDescriptor}

Today's date (UTC): ${today}${vocabulary}

# Output schema (return ONE JSON object)

{
  "kind": "extracted" | "clarification",
  "value"?: <dimension-specific shape; only when kind=extracted>,
  "confidence": "high" | "medium" | "low",
  "aiMessage": "<operator-facing message — what you extracted, what you'd like to confirm, or what you need clarified>"
}

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

async function persistDimensionToCampaign(
  prisma: OrchestratorPrisma,
  campaignId: string,
  _tenantId: string,
  dim: DimensionKey,
  value: unknown,
): Promise<void> {
  const data: Record<string, unknown> = {};
  switch (dim) {
    case 'product':
      if (typeof value === 'string') data.goalProductId = value;
      break;
    case 'objectives':
      if (value && typeof value === 'object') {
        const v = value as {
          goalType?: unknown;
          goalTarget?: unknown;
          goalDescription?: unknown;
        };
        if (typeof v.goalType === 'string') data.goalType = v.goalType;
        if (typeof v.goalTarget === 'number') data.goalTarget = v.goalTarget;
        if (typeof v.goalDescription === 'string') {
          data.goalDescription = v.goalDescription;
        }
      }
      break;
    case 'timeline':
      if (value && typeof value === 'object') {
        const v = value as { windowStart?: unknown; windowEnd?: unknown };
        if (typeof v.windowStart === 'string') {
          data.windowStart = new Date(v.windowStart);
        }
        if (typeof v.windowEnd === 'string') {
          data.windowEnd = new Date(v.windowEnd);
        }
      }
      break;
    case 'audience':
      data.audienceConditions = value;
      break;
  }
  if (Object.keys(data).length > 0) {
    await prisma.campaign.update({ where: { id: campaignId }, data });
  }
}
