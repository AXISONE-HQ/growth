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
  CampaignTargetEntityType,
} from '@growth/shared';
import {
  AudienceConditionsSchema,
  CampaignTargetEntityTypeEnum,
  DIMENSION_ORDER,
  emptyConversationState,
} from '@growth/shared';
import { normalizeEntityTypeExtraction } from './orchestrator/extractEntityType.js';
import {
  VEHICLE_DIMENSION_PROMPT_EXAMPLE,
  normalizeVehicleExtraction,
} from './orchestrator/extractVehicle.js';

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
  // KAN-1230 B1 — multi-dim confirmations emit a campaign.dimension_advanced
  // audit row per confirmed dimension (Memo 53), mirroring the panel-commit
  // audit added in KAN-1224 Phase A.
  auditLog: {
    create: (args: {
      data: {
        tenantId: string;
        actor: string;
        actionType: string;
        payload: Record<string, unknown>;
        reasoning?: string;
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
 * KAN-1224 Phase A — reconcile client-held ConversationState against a
 * polymorphic target the operator committed via TargetEntityPanel.
 *
 * `commitTarget` is a SEPARATE tRPC mutation that writes Campaign.targetEntity*
 * but does NOT touch the client's in-memory ConversationState. So a
 * panel-committed target leaves `entityType`/`product` showing Pending in the
 * state the client passes back, and the LLM re-asks "how many?" (the operator
 * pain KAN-1230 targets). This marks those two dimensions confirmed from DB
 * truth before the orchestrator decides the next dimension; the reconciled
 * state is returned, so the client self-heals via `setState(result.state)`.
 *
 * Pure + minimal: only touches entityType/product, only upgrades (never
 * downgrades a client-confirmed dimension), no-op until a target is committed.
 */
export function reconcileCommittedTargetState(
  state: ConversationState,
  campaign: {
    targetEntityType?: unknown;
    targetEntityIds?: unknown;
    proposedPlan?: unknown;
  } | null,
): ConversationState {
  const entityType =
    typeof campaign?.targetEntityType === 'string'
      ? campaign.targetEntityType
      : null;
  const entityIds = Array.isArray(campaign?.targetEntityIds)
    ? (campaign?.targetEntityIds as unknown[])
    : [];
  // No committed target yet → leave the chat-driven state untouched.
  if (!entityType || entityIds.length === 0) return state;

  const next: ConversationState = { ...state };
  if (state.entityType.kind !== 'confirmed') {
    next.entityType = {
      kind: 'confirmed',
      value: entityType,
    } as DimensionState;
  }
  if (state.product.kind !== 'confirmed') {
    // Vehicle: the descriptor computed at commit time lives in
    // proposedPlan.vehicleTargetDescriptor. Product: the committed IDs are the
    // operator's confirmed selection. Either way the dimension is answered.
    const descriptor =
      entityType === 'vehicle'
        ? extractVehicleTargetDescriptor(campaign?.proposedPlan)
        : null;
    next.product = {
      kind: 'confirmed',
      value: descriptor ?? { committedEntityIds: entityIds },
    } as DimensionState;
  }
  return next;
}

function extractVehicleTargetDescriptor(proposedPlan: unknown): unknown | null {
  if (
    proposedPlan &&
    typeof proposedPlan === 'object' &&
    'vehicleTargetDescriptor' in proposedPlan
  ) {
    return (proposedPlan as { vehicleTargetDescriptor: unknown })
      .vehicleTargetDescriptor;
  }
  return null;
}

// ─────────────────────────────────────────────
// KAN-1230 B1 — multi-dimension extraction
//
// One LLM pass attempts EVERY undetermined dimension from a single (possibly
// compound) operator message. Per-dimension confidence routes each result
// independently (Memo: multi-dim-llm-response-confidence-routing): a low-
// confidence dimension is skipped (stays Pending) while high-confidence ones
// advance — partial extraction ≠ turn failure. entityType is resolved FIRST so
// the polymorphic `product` dimension routes through the correct normalizer
// (vehicle vs product) within the same turn.
// ─────────────────────────────────────────────

/** Numeric LLM confidence → the 3-band scale the per-dim normalizers expect. */
function numericToConfidence(n: number): 'high' | 'medium' | 'low' {
  if (n >= 0.85) return 'high';
  if (n >= 0.6) return 'medium';
  return 'low';
}

/** Dimensions not yet confirmed.
 *
 * KAN-1230 B2.5 / KAN-1232 — audience is a PRODUCT-only dimension. It is left
 * OUT of the multi-dim ask until entityType is confirmed 'product'. This stops
 * the LLM asking "what's your target audience?" on vehicle campaigns (Q3 lock)
 * AND avoids asking it before the entity type is even known (an unknown-type
 * campaign can't meaningfully answer audience). Once entityType resolves to
 * product, audience re-enters the undetermined set on the next turn. */
export function undeterminedDimensions(state: ConversationState): DimensionKey[] {
  const isConfirmedProduct =
    state.entityType.kind === 'confirmed' && state.entityType.value === 'product';
  return DIMENSION_ORDER.filter((d) => {
    if (d === 'audience' && !isConfirmedProduct) return false;
    return state[d].kind !== 'confirmed';
  });
}

export interface MultiDimExtractionEntry {
  extracted: boolean;
  value?: unknown;
  confidence: number;
  reason?: string;
}

export function buildMultiDimExtractionPrompt(
  dims: DimensionKey[],
  state: ConversationState,
  todayUtc: Date,
): string {
  const today = todayUtc.toISOString();
  const isVehicleCampaign =
    state.entityType.kind === 'confirmed' &&
    state.entityType.value === 'vehicle';
  const stateJson = JSON.stringify(state, null, 2);
  const vocabulary = dims.includes('audience') ? `\n\n${AUDIENCE_VOCABULARY}` : '';

  // KAN-1233 — in a multi-dim turn the operator can state BOTH entityType and
  // product in one message ("sell 10 used cars"). At prompt-build time
  // entityType isn't confirmed yet (isVehicleCampaign === false), so the
  // single-dim product contract would tell the LLM to return product as a
  // STRING — contradicting the vehicle descriptor OBJECT it must emit once it
  // classifies entityType=vehicle THIS turn. When entityType is undetermined,
  // present BOTH product shapes and route on the entityType the LLM picks.
  const entityTypeUndetermined = state.entityType.kind !== 'confirmed';

  const perDim = dims
    .map((dim) => {
      const descriptor = describeDimension(dim, isVehicleCampaign);
      const shape =
        dim === 'product' && entityTypeUndetermined
          ? `The shape depends on the entityType you classify for THIS message:

- entityType = "vehicle" → return a JSON OBJECT (vehicle target descriptor):
${VEHICLE_DIMENSION_PROMPT_EXAMPLE}

- entityType = "product" → return a STRING (the catalog product/offering name), e.g. "value": "Growth Platform Pro".

Vehicle signals → use the OBJECT shape: "cars"/"SUVs"/"trucks", year/make/model, VINs, or a condition like "used"/"new"/"cpo". Catalog-product signals → use the STRING shape. If you set entityType=vehicle above, you MUST return product as the descriptor OBJECT, never a string (e.g. "10 used cars" → {"condition":"used","maxCount":10}).`
          : dimensionValueExample(dim, isVehicleCampaign);
      return `### ${dim}\n${descriptor}\n\nValue shape:\n${shape}`;
    })
    .join('\n\n');

  return `${DOCTRINE_PREAMBLE}

Current capture state:
${stateJson}

Today's date (UTC): ${today}${vocabulary}

# KAN-1230 — Multi-dimension extraction

The operator's message may answer SEVERAL dimensions at once (a compound
message like "sell 10 used cars by end of month"). Extract EVERY dimension you
can from this ONE message. Do NOT invent values — only extract what the
operator actually expressed; leave the rest unextracted.

# Dimensions to attempt

${perDim}

# Output envelope (return ONE JSON object)

For EACH dimension above, include a key with this exact shape:

{
  "<dimensionKey>": {
    "extracted": true | false,
    "value": <the dimension's value shape above; omit when extracted=false>,
    "confidence": <number 0..1 — certainty this value is what the operator meant>,
    "reason": "<one short phrase>"
  }
}

# Confidence guidance

- >= 0.85 — unambiguous; the operator clearly stated this
- 0.6 .. 0.85 — plausible but the operator should confirm
- < 0.6 — too vague to act on; set extracted=false

# KAN-1235 — number semantics: GOAL vs TARGET (critical for vehicle campaigns)

A number is the GOAL (objectives.goalTarget) by DEFAULT — it is NOT a cap on how
many vehicles to target. The vehicle target defaults to ALL matching inventory.
ONLY set product.maxCount when the operator is explicitly PICKING a specific
number of vehicles to feature. NEVER emit the same number as both goalTarget AND
maxCount.

- GOAL-context verbs (sell / generate / close / move / achieve) → the number is
  goalTarget ONLY; do NOT set product.maxCount (target = all matching inventory):
  - "sell 50 cars next month" → entityType=vehicle (0.95); product={} (NO maxCount); objectives={goalType:"sales", goalTarget:50, goalDescription:"Sell 50 cars"} (0.9); timeline={windowEnd:"next month"} (0.9).
  - "sell 10 used cars by end of month" → product={condition:"used"} (NO maxCount); objectives={goalType:"sales", goalTarget:10, goalDescription:"Sell 10 used cars"}; timeline={windowEnd:"end of month"}.
  - "Sell 5 Honda CR-Vs" → product={make:"Honda", model:"CR-V"} (NO maxCount); objectives={goalType:"sales", goalTarget:5, goalDescription:"Sell 5 Honda CR-Vs"}.
  - "close 10 deals this quarter" → objectives={goalType:"deals", goalTarget:10}; no maxCount.

- TARGET-context verbs (promote / pick / feature / highlight / "specifically
  these" / "top N") → the number is product.maxCount (explicit inventory pick);
  do NOT turn it into goalTarget:
  - "promote my 5 BMWs" → product={make:"BMW", maxCount:5}; objectives.extracted=false.
  - "pick 10 used cars to feature" → product={condition:"used", maxCount:10}.
  - "specifically these 3 vehicles" → product={maxCount:3}.
  - "sell my top 10 used cars" → product={condition:"used", maxCount:10} ("top N" = pick N, even with the "sell" verb).

- NO number → no maxCount and no goalTarget for that dimension:
  - "sell my used Honda inventory" → product={condition:"used", make:"Honda"}; no maxCount.
  - "promote my SUVs" → product={bodyStyle:"suv"}; no maxCount.

- Catalog products are unaffected: "Sell 50 units of Growth Platform" → entityType=product; objectives={goalType:"units", goalTarget:50}.
- "10 leads by end of month" → objectives={goalType:"leads", goalTarget:10}; timeline={windowEnd:"end of month"}. (goalType "leads"/"sales" accepted; legacy "units"/"deals"/"revenue"/"meetings"/"custom" also valid.)

Relative dates: you may emit timeline as a phrase ("end of month", "next month", "in 30 days", "end of Q3") — the server resolves it against today's date above.

Be honest. A dimension the operator didn't address → extracted: false.`;
}

export function parseMultiDimExtraction(
  text: string,
  dims: DimensionKey[],
): Partial<Record<DimensionKey, MultiDimExtractionEntry>> | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  const out: Partial<Record<DimensionKey, MultiDimExtractionEntry>> = {};
  for (const dim of dims) {
    const entry = rec[dim];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const extracted = e.extracted === true;
    const confidence =
      typeof e.confidence === 'number' ? e.confidence : extracted ? 0.7 : 0;
    out[dim] = {
      extracted,
      value: e.value,
      confidence,
      reason: typeof e.reason === 'string' ? e.reason : undefined,
    };
  }
  return out;
}

function buildMultiDimAck(
  advanced: { dimensionKey: DimensionKey; kind: 'confirmed' | 'proposed' }[],
): string {
  const confirmed = advanced.filter((a) => a.kind === 'confirmed').map((a) => a.dimensionKey);
  const proposed = advanced.filter((a) => a.kind === 'proposed').map((a) => a.dimensionKey);
  const parts: string[] = [];
  if (confirmed.length) parts.push(`Confirmed ${confirmed.join(', ')}`);
  if (proposed.length) parts.push(`proposed ${proposed.join(', ')} (confirm or correct)`);
  return parts.length
    ? `${parts.join('; ')} from your message.`
    : 'Captured your message.';
}

/**
 * Attempt multi-dimension extraction. Returns a ChatTurnResult when at least
 * one dimension advanced, or `null` to fall through to the single-dim path
 * (LLM error / unparseable / nothing extracted / low-token fallback).
 */
async function runMultiDimExtraction(
  prisma: OrchestratorPrisma,
  llm: LLMCompleteFn,
  audienceCount: AudienceCountFn,
  params: OrchestratorParams,
  campaignId: string,
  dims: DimensionKey[],
  todayUtc: Date,
): Promise<ChatTurnResult | null> {
  const systemPrompt = buildMultiDimExtractionPrompt(dims, params.state, todayUtc);
  let llmResponse;
  try {
    llmResponse = await llm({
      tenantId: params.tenantId,
      tier: selectTier(params.message, params.state),
      systemPrompt,
      userPrompt: params.message,
      callerTag: 'orchestrator:multidim',
      jsonMode: true,
      maxTokens: 1536,
    });
  } catch (_err) {
    return null; // fall through to single-dim
  }

  const parsed = parseMultiDimExtraction(llmResponse.text, dims);
  if (!parsed) return null;

  // Process in canonical order so entityType resolves BEFORE product (Risk A).
  const orderedDims = DIMENSION_ORDER.filter((d) => dims.includes(d));
  let workingState = params.state;
  const advanced: { dimensionKey: DimensionKey; kind: 'confirmed' | 'proposed' }[] = [];
  let audienceAnnotation = '';

  // KAN-1235 — goal-vs-target guard. A number defaults to the GOAL
  // (objectives.goalTarget), NOT a cap on the vehicle target. B1 teaches the
  // LLM this; this is defense-in-depth: if the model still echoes the goal
  // number into the vehicle maxCount AND the operator used no explicit
  // target-cardinality phrasing, strip the conflated maxCount.
  const hasTargetCardinalitySignal = /\b(promote|pick|feature|highlight|specifically these|top \d+)\b/i.test(
    params.message,
  );
  const objectivesGoalTarget =
    parsed.objectives?.extracted &&
    parsed.objectives.value &&
    typeof parsed.objectives.value === 'object'
      ? (parsed.objectives.value as { goalTarget?: unknown }).goalTarget
      : undefined;

  for (const dim of orderedDims) {
    const ext = parsed[dim];
    if (!ext || !ext.extracted) continue;
    if (ext.confidence < 0.6) continue; // low → skip (stays Pending)

    const norm = normalizeForDimension(
      {
        kind: 'extracted',
        value: ext.value,
        confidence: numericToConfidence(ext.confidence),
        aiMessage: '',
      },
      dim,
      workingState,
    );
    if (norm.kind === 'clarification') continue; // unmappable shape → skip

    // KAN-1235 B2 — strip a vehicle maxCount that merely echoes the goalTarget.
    if (
      dim === 'product' &&
      !hasTargetCardinalitySignal &&
      norm.value &&
      typeof norm.value === 'object'
    ) {
      const v = norm.value as Record<string, unknown>;
      if (
        typeof v.maxCount === 'number' &&
        typeof objectivesGoalTarget === 'number' &&
        v.maxCount === objectivesGoalTarget
      ) {
        const { maxCount: _conflated, ...rest } = v;
        (norm as { value: unknown }).value = rest;
      }
    }

    const targetKind: 'confirmed' | 'proposed' =
      ext.confidence >= 0.85 ? 'confirmed' : 'proposed';
    workingState = {
      ...workingState,
      [dim]:
        targetKind === 'confirmed'
          ? ({ kind: 'confirmed', value: norm.value } as DimensionState)
          : ({
              kind: 'proposed',
              value: norm.value,
              confidence: numericToConfidence(ext.confidence),
            } as DimensionState),
    };
    advanced.push({ dimensionKey: dim, kind: targetKind });

    // Inline audience count annotation (Q-ADD C4 parity with single-dim path).
    if (dim === 'audience' && norm.value) {
      try {
        const r = await audienceCount(prisma, params.tenantId, {
          conditions: norm.value,
        });
        audienceAnnotation = ` ${r.count.toLocaleString()} contacts match.`;
      } catch (_e) {
        /* count unavailable — proceed */
      }
    }

    const entityTypeForPersist: CampaignTargetEntityType | null =
      workingState.entityType.kind === 'confirmed'
        ? (workingState.entityType.value as CampaignTargetEntityType)
        : null;
    await persistDimensionToCampaign(
      prisma,
      campaignId,
      params.tenantId,
      dim,
      norm.value,
      entityTypeForPersist,
      todayUtc,
    );

    // Memo 53 — emit one campaign.dimension_advanced per CONFIRMED dim so the
    // KAN-1230 avg_turns_to_commit metric can attribute confirmations to a
    // multi-dim chat turn (mirrors KAN-1224 panel_commit audit).
    if (targetKind === 'confirmed') {
      await prisma.auditLog.create({
        data: {
          tenantId: params.tenantId,
          actor: 'system',
          actionType: 'campaign.dimension_advanced',
          payload: {
            campaignId,
            dimension: dim,
            action: 'confirm',
            via: 'chat_multidim',
          },
          reasoning: `Dimension ${dim} confirmed via multi-dimension chat extraction`,
        },
      });
    }
  }

  if (advanced.length === 0) return null; // nothing usable → single-dim fallback

  // KAN-1235 B3 — non-blocking refinement invitation. When a vehicle target was
  // advanced this turn with a BROAD descriptor (no make/model, no maxCount → it
  // will target all matching inventory), invite the operator to narrow by
  // make/model. Doctrine #1 / Memo 19/42 — offered, never required (the operator
  // can just confirm via the panel). Skipped when the descriptor is already
  // make/model-specific (would be noise).
  let refinement = '';
  const productAdvanced = advanced.some((a) => a.dimensionKey === 'product');
  const isVehicleTarget =
    workingState.entityType.kind === 'confirmed' &&
    workingState.entityType.value === 'vehicle';
  if (productAdvanced && isVehicleTarget && workingState.product.kind !== 'empty') {
    const d = workingState.product.value as Record<string, unknown> | null;
    const broad =
      d != null &&
      typeof d === 'object' &&
      !d.make &&
      !d.model &&
      d.maxCount == null;
    if (broad) {
      refinement =
        " I'll target all matching vehicles — any specific makes or models you want to focus on? (Or just confirm via the panel to proceed with all.)";
    }
  }

  const aiMessage = `${buildMultiDimAck(advanced)}${audienceAnnotation}${refinement}`;
  await prisma.campaignConversationTurn.create({
    data: {
      tenantId: params.tenantId,
      campaignId,
      turnType: 'ai',
      content: aiMessage,
      proposalSnapshot: { multiDim: advanced },
    },
  });

  if (allRequiredConfirmed(workingState)) {
    return { kind: 'all_dimensions_confirmed', aiMessage, state: workingState, campaignId };
  }
  return {
    kind: 'dimensions_extracted',
    aiMessage,
    state: workingState,
    campaignId,
    advanced,
  };
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
        content: 'Conversation reset — all dimensions cleared.',
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

  // KAN-1224 Phase A — reconcile the client-held state against a polymorphic
  // target the operator committed via TargetEntityPanel (a separate mutation
  // that never touched this in-memory state). DB truth marks entityType +
  // product confirmed BEFORE we pick the next dimension, so the LLM stops
  // re-asking "how many?". We reassign params.state once here so the whole
  // downstream turn (extraction + all returns) threads the reconciled value
  // and the client self-heals via setState(result.state). No-op until a target
  // is committed; only upgrades, never downgrades a client-confirmed dimension.
  const committedTarget = await prisma.campaign.findFirst({
    where: { id: campaignId, tenantId: params.tenantId },
    select: { targetEntityType: true, targetEntityIds: true, proposedPlan: true },
  });
  params.state = reconcileCommittedTargetState(params.state, committedTarget);

  // C2 — Deterministic transition: which dimension to extract next
  const targetDim = nextDimensionToExtract(params.state);

  if (targetDim === null) {
    // All required dimensions confirmed; orchestrator hands off to Action
    // Plan generator (KAN-1185). KAN-1219 Slice G3 — "required" varies by
    // entityType per Q3 lock (vehicle campaigns skip audience).
    const aiMessage =
      'All required dimensions confirmed. Ready to generate your Action Plan.';
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
    const allConfirmed = allRequiredConfirmed(confirmedState);
    const ackMessage = allConfirmed
      ? 'All required dimensions confirmed. Ready to generate your Action Plan.'
      : buildConfirmationAck(targetDim, confirmedState);
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

  // KAN-1230 B1 — multi-dimension extraction. When ≥2 dimensions remain
  // undetermined, attempt them all in ONE LLM pass (compound-message handling).
  // Returns when ≥1 dimension advanced; otherwise falls through to the single-
  // dim path below (LLM error / unparseable / nothing extracted). Skipped when
  // only the final dimension remains, and AFTER the operator-confirmation early-
  // exit above — so that path and the low-token single-dim path stay intact
  // (Risk B: multi-dim is additive, not a replacement).
  const undetermined = undeterminedDimensions(params.state);
  if (undetermined.length >= 2) {
    const multiResult = await runMultiDimExtraction(
      prisma,
      llm,
      audienceCount,
      params,
      campaignId,
      undetermined,
      todayUtc,
    );
    if (multiResult) return multiResult;
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

  const rawExtraction = parseDimensionExtraction(llmResponse.text, targetDim);

  // KAN-1219 Slice G3 — Per-dimension normalizer routing. entityType uses the
  // CampaignTargetEntityTypeEnum classifier; the 'product' dimension branches
  // on confirmed entityType (vehicle → VehicleDimensionValueSchema; product →
  // raw passthrough). Other dimensions pass through unchanged. Each
  // normalizer returns either an extracted shape with confidence + canonical
  // value OR a clarification fallback when the LLM emitted an unmappable
  // shape (Memo 19/42 affordance-honesty — ask rather than invent).
  const extraction = normalizeForDimension(
    rawExtraction,
    targetDim,
    params.state,
  );

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

  // Persist updated state to Campaign row for chat-history resume.
  // KAN-1219 Slice G3 — pass the post-update entityType so the persistence
  // layer can branch the polymorphic 'product' dimension (vehicle mode
  // captures the descriptive intent in proposedPlan, NOT in goalProductId;
  // actual targetEntityIds population happens at the TargetEntityPanel
  // confirm step in BuilderChatThread per Q5 lock).
  const postUpdateEntityType: CampaignTargetEntityType | null =
    updatedState.entityType.kind === 'confirmed'
      ? (updatedState.entityType.value as CampaignTargetEntityType)
      : null;
  await persistDimensionToCampaign(
    prisma,
    campaignId,
    params.tenantId,
    targetDim,
    extraction.value,
    postUpdateEntityType,
    todayUtc,
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

  // KAN-1201 L5 — If this confirmation closed the required-dimension set,
  // return all_dimensions_confirmed directly (without waiting for the
  // operator to send another turn). Mirrors the entry-time check at line
  // ~147 but fires on the exit path. KAN-1219 Slice G3 — "required" varies
  // by entityType per Q3 lock (vehicle campaigns skip audience).
  if (shouldConfirm && allRequiredConfirmed(updatedState)) {
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
 * First-Empty-wins per canonical order. Returns null when all required
 * dimensions are confirmed (orchestrator hands off to Action Plan generator).
 *
 * # KAN-1219 Slice G3 — Q3 lock: vehicle campaigns skip 'audience'
 *
 * When entityType has confirmed to 'vehicle', the 'audience' dimension is
 * gated out of the iteration. Q3 doctrine: vehicle campaigns target a fixed
 * VIN set + dealer-distance / lifecycle-stage filtering happens at send time
 * via Q5 skip-removed-at-send semantics, NOT via an audience tree. Product
 * campaigns continue to require an explicit audience.
 */
export function nextDimensionToExtract(
  state: ConversationState,
): DimensionKey | null {
  const isVehicleCampaign =
    state.entityType.kind === 'confirmed' &&
    state.entityType.value === 'vehicle';
  for (const dim of DIMENSION_ORDER) {
    if (dim === 'audience' && isVehicleCampaign) continue;
    if (state[dim].kind !== 'confirmed') return dim;
  }
  return null;
}

/**
 * KAN-1219 Slice G3 — Q3 lock: which dimensions are REQUIRED for this state
 * to be considered fully-confirmed. Vehicle campaigns are complete with
 * entityType + product + objectives + timeline; product campaigns require
 * audience too. Mirrors the same gating logic as `nextDimensionToExtract`
 * so the all-confirmed check stays consistent.
 */
function requiredDimensionsForState(state: ConversationState): DimensionKey[] {
  const isVehicleCampaign =
    state.entityType.kind === 'confirmed' &&
    state.entityType.value === 'vehicle';
  return DIMENSION_ORDER.filter(
    (d) => !(d === 'audience' && isVehicleCampaign),
  );
}

function allRequiredConfirmed(state: ConversationState): boolean {
  return requiredDimensionsForState(state).every(
    (d) => state[d].kind === 'confirmed',
  );
}

/**
 * KAN-1219 Slice G3 — Per-dimension normalization router.
 *
 * Routes the canonical LLM extraction envelope into the matching
 * per-dimension normalizer. entityType uses the polymorphic discriminator
 * classifier; product dimension branches on the operator's confirmed
 * entityType (vehicle → VehicleDimensionValueSchema). Other dimensions
 * pass through unchanged (the persist-side normalizers handle field-name
 * drift for those — see persistDimensionToCampaign).
 *
 * Returns a clarification fallback when the normalizer rejects the LLM's
 * shape so the operator sees an honest question rather than a silently-
 * dropped value (Memo 19/42 affordance-honesty).
 */
function normalizeForDimension(
  rawExtraction:
    | { kind: 'extracted'; value: unknown; confidence: 'high' | 'medium' | 'low'; aiMessage: string }
    | { kind: 'clarification'; aiMessage: string },
  targetDim: DimensionKey,
  state: ConversationState,
):
  | { kind: 'extracted'; value: unknown; confidence: 'high' | 'medium' | 'low'; aiMessage: string }
  | { kind: 'clarification'; aiMessage: string } {
  if (rawExtraction.kind === 'clarification') return rawExtraction;

  if (targetDim === 'entityType') {
    const normalized = normalizeEntityTypeExtraction(rawExtraction);
    if (normalized.kind === 'clarification') return normalized;
    return {
      kind: 'extracted',
      value: normalized.entityType,
      confidence: normalized.confidence,
      aiMessage: rawExtraction.aiMessage,
    };
  }

  if (targetDim === 'product') {
    const isVehicleCampaign =
      state.entityType.kind === 'confirmed' &&
      state.entityType.value === 'vehicle';
    if (isVehicleCampaign) {
      const normalized = normalizeVehicleExtraction(rawExtraction);
      if (normalized.kind === 'clarification') return normalized;
      return {
        kind: 'extracted',
        value: normalized.value,
        confidence: normalized.confidence,
        aiMessage: rawExtraction.aiMessage,
      };
    }
  }

  return rawExtraction;
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
function buildConfirmationAck(
  dim: DimensionKey,
  state: ConversationState,
): string {
  const isVehicleCampaign =
    state.entityType.kind === 'confirmed' &&
    state.entityType.value === 'vehicle';
  switch (dim) {
    case 'entityType':
      return isVehicleCampaign
        ? "Got it — vehicle campaign. Next: which vehicles (year/make/model, body style, specific VINs)?"
        : "Got it — product campaign. Next: which product or offering is this Campaign about?";
    case 'product':
      return isVehicleCampaign
        ? "Vehicle target confirmed. Next, let's nail down your objective: revenue / units / deals / meetings and a target number."
        : "Got it — Product confirmed. Next, let's nail down your objective: what specific outcome (revenue / units / deals / meetings) and target number do you want to hit?";
    case 'objectives':
      return "Objective confirmed. Next: what's the timeline — when does this Campaign start and end?";
    case 'timeline':
      // Q3 lock — vehicle campaigns complete after timeline (no audience step).
      return isVehicleCampaign
        ? 'Timeline confirmed. All required dimensions in place — ready to generate your Action Plan.'
        : 'Timeline confirmed. Last dimension: the audience — who are we sending this to?';
    case 'audience':
      return 'Audience confirmed. All required dimensions in place — ready to generate your Action Plan.';
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

  const isVehicleCampaign =
    state.entityType.kind === 'confirmed' &&
    state.entityType.value === 'vehicle';

  const dimensionDescriptor = describeDimension(dim, isVehicleCampaign);
  const vocabulary = dim === 'audience' ? `\n\n${AUDIENCE_VOCABULARY}` : '';
  // KAN-1203 — concrete JSON examples are the primary defense against
  // LLM-output / persist-schema field-name drift. Replaces the prior vague
  // "<dimension-specific shape>" placeholder.
  // KAN-1219 Slice G3 — the 'product' dimension is polymorphic; when the
  // operator has confirmed entityType='vehicle' the shape contract switches
  // to VEHICLE_DIMENSION_PROMPT_EXAMPLE.
  const valueShapeContract = dimensionValueExample(dim, isVehicleCampaign);

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

function describeDimension(dim: DimensionKey, isVehicleCampaign: boolean): string {
  switch (dim) {
    case 'entityType':
      // KAN-1219 Slice G1 — operator clarification: are we campaigning to
      // sell a Product (Stripe/inventory) OR to move a Vehicle from the
      // dealer lot (KAN-1211 inventory)? Memo 19/42 affordance-honesty —
      // the operator should see this explicit branch, not have it inferred.
      return 'Whether this campaign targets a Product (catalog item) or a Vehicle (dealer inventory).';
    case 'product':
      // KAN-1219 Slice G3 — polymorphic 'product' dimension. Vehicle-mode
      // captures the operator's descriptive vehicle intent (year/make/model/
      // bodyStyle + optional VIN hints).
      return isVehicleCampaign
        ? "Which vehicles this Campaign targets (year/make/model/bodyStyle/condition/price/VIN hints). Capture the operator's descriptive intent — actual VIN resolution against live inventory happens at confirm time."
        : 'Which product / offering this Campaign is about (free text or product ID).';
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
function dimensionValueExample(dim: DimensionKey, isVehicleCampaign: boolean): string {
  // KAN-1219 Slice G3 — when the operator confirmed entityType='vehicle',
  // the 'product' dimension prompt uses the vehicle shape contract instead
  // of the catalog-product one. Routes to the shared
  // VEHICLE_DIMENSION_PROMPT_EXAMPLE constant in extractVehicle.ts.
  if (dim === 'product' && isVehicleCampaign) {
    return VEHICLE_DIMENSION_PROMPT_EXAMPLE;
  }
  switch (dim) {
    case 'entityType':
      // KAN-1219 Slice G1 — classify operator utterance as 'product' or
      // 'vehicle'. Strong "vehicle" signals: VIN, year/make/model phrasing,
      // "SUV"/"truck"/etc. body styles, dealer-lot phrasing. Strong
      // "product" signals: SKU, price-list reference, catalog item name.
      // Ambiguous → low confidence + clarification per the routing rules.
      return `Return value as a STRING — either "product" or "vehicle". Examples:
  "value": "vehicle"   // operator said "campaign for the 4 SUVs we just took on trade"
  "value": "product"   // operator said "promote Growth Platform Pro to existing customers"

If the operator's intent is unclear (no entity-shape signal), return
kind=clarification and ask explicitly: "Is this campaign about a product
in your catalog, or a vehicle from your dealer inventory?"`;
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

# Canonical leaf shapes (use EXACTLY these)

  { "field": "lifecycleStage", "op": "in", "values": [<"lead"|"mql"|"sql"|"customer"|"lost">, ...] }
  { "field": "segment",        "op": "in", "values": [<string>, ...] }
  { "field": "source",         "op": "in", "values": [<"email_inbox"|"web_form"|"meta_ad"|...>, ...] }
  { "field": "country",        "op": "in", "values": [<"CA"|"US"|...>, ...] }   // ISO-3166-1 alpha-2
  { "field": "region",         "op": "in", "values": [<string>, ...] }          // state/province free-text
  { "field": "city",           "op": "in", "values": [<string>, ...] }
  { "field": "createdAt",      "op": "between", "fromUtc": "<ISO>", "toUtcExclusive": "<ISO>" }
  { "field": "orders.placedAt", "op": "between", "fromUtc": "<ISO>", "toUtcExclusive": "<ISO>" }
  { "field": "orders.refundedAt", "op": "between", "fromUtc": "<ISO>", "toUtcExclusive": "<ISO>" }
  { "field": "orders.cancelledAt", "op": "between", "fromUtc": "<ISO>", "toUtcExclusive": "<ISO>" }
  { "field": "orders.exists",  "op": "eq", "value": <true|false> }
  { "field": "deal.value.gte", "op": "gte", "value": <number-usd> }
  { "field": "deal.value.lte", "op": "lte", "value": <number-usd> }
  { "field": "deal.value.between", "op": "between", "minUsd": <number>, "maxUsdExclusive": <number> }

# IMPORTANT (KAN-1204 lessons)

- Date filters MUST use \`op: "between"\` with \`fromUtc\` + \`toUtcExclusive\` (NOT \`lte\`/\`gte\` with a single \`value\`)
- lifecycleStage MUST use ONLY the 5 canonical values (lead/mql/sql/customer/lost) — "contact" or "prospect" are invalid
- country MUST be uppercase 2-letter ISO codes (NOT "Canada" or "United States")

Example for "leads from Quebec who bought in last 30 days":
  "value": {
    "allOf": [
      { "field": "lifecycleStage", "op": "in", "values": ["lead"] },
      { "field": "region", "op": "in", "values": ["QC"] },
      { "field": "orders.placedAt", "op": "between",
        "fromUtc": "2026-05-17T00:00:00.000Z",
        "toUtcExclusive": "2026-06-16T00:00:00.000Z" }
    ]
  }

Trees compose with \`allOf\` and \`anyOf\`:
  "value": { "anyOf": [<tree1>, <tree2>] }`;
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

// ─────────────────────────────────────────────
// KAN-1204 — Audience tree normalizer
//
// Walks the recursive AudienceConditions tree (allOf/anyOf/leaf) and
// rewrites each leaf into a canonical shape that AudienceConditionsSchema.parse
// accepts. Handles three classes of LLM divergence empirically observed
// in Fred's PROD session:
//
//   1. Date filters emitted as single-value comparisons
//      ({field: 'orders.placedAt', op: 'lte', value: ISO})
//      → canonical between with sentinel bounds
//      ({field: 'orders.placedAt', op: 'between', fromUtc: EPOCH_ISO,
//        toUtcExclusive: ISO})
//
//   2. Invalid enum values in lifecycleStage/source filters
//      ({values: ['customer', 'contact']} — 'contact' isn't a valid stage)
//      → filter values to canonical enum members; drop leaf entirely if
//      all values become invalid
//
//   3. Country values not in ISO-3166-1 alpha-2 shape
//      ({values: ['Canada']}) → uppercase 2-char attempt; drop if can't coerce
//
// Returns ok with the normalized tree OR err with the reason for surfacing
// in the persist-drift log. Caller writes data.audienceConditions only on ok.
// ─────────────────────────────────────────────

/** ISO sentinel bounds for converting single-sided date comparisons into
 *  canonical between intervals. Distant past + distant future so the
 *  resulting [from, toExclusive) covers everything operator likely meant. */
const EPOCH_ISO = '1970-01-01T00:00:00.000Z';
const FAR_FUTURE_ISO = '2099-12-31T23:59:59.999Z';

/** Canonical LifecycleStage enum values (mirrored from packages/shared
 *  enums.ts to avoid a circular shared-import for runtime data). Drift
 *  between this list and `LifecycleStageEnum` is caught by the integration
 *  test scenarios. */
const CANONICAL_LIFECYCLE_STAGES = new Set([
  'lead',
  'mql',
  'sql',
  'customer',
  'lost',
]);

const CANONICAL_CONTACT_SOURCES = new Set([
  'email_inbox',
  'web_form',
  'meta_ad',
  'manual',
  'csv_import',
  'api',
  'hubspot',
  'stripe',
  'shopify',
  'other',
]);

/** Date-leaf field names that the canonical schema constrains to
 *  `op: 'between'` with `fromUtc` + `toUtcExclusive`. The LLM frequently
 *  emits single-value `op: 'lte'` / `op: 'gte'` for these; normalizer
 *  converts to the canonical between shape with sentinel bounds. */
const DATE_LEAF_FIELDS = new Set([
  'createdAt',
  'orders.placedAt',
  'orders.refundedAt',
  'orders.cancelledAt',
]);

function isIsoDateString(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime());
}

function normalizeAudienceLeaf(leaf: Record<string, unknown>): Record<string, unknown> | null {
  const field = leaf.field;
  if (typeof field !== 'string') return null;

  // Date leaves: coerce lte/gte/eq with ISO `value` into canonical between.
  if (DATE_LEAF_FIELDS.has(field)) {
    if (leaf.op === 'between' && typeof leaf.fromUtc === 'string' && typeof leaf.toUtcExclusive === 'string') {
      return { field, op: 'between', fromUtc: leaf.fromUtc, toUtcExclusive: leaf.toUtcExclusive };
    }
    // lte: between [EPOCH, value)
    if (leaf.op === 'lte' && isIsoDateString(leaf.value)) {
      return { field, op: 'between', fromUtc: EPOCH_ISO, toUtcExclusive: leaf.value as string };
    }
    // gte: between [value, FAR_FUTURE)
    if (leaf.op === 'gte' && isIsoDateString(leaf.value)) {
      return { field, op: 'between', fromUtc: leaf.value as string, toUtcExclusive: FAR_FUTURE_ISO };
    }
    // Common LLM variant: `fromUtc` + `to` (without 'Exclusive' suffix)
    if (leaf.op === 'between' && typeof leaf.fromUtc === 'string' && typeof leaf.to === 'string') {
      return { field, op: 'between', fromUtc: leaf.fromUtc, toUtcExclusive: leaf.to };
    }
    return null;
  }

  // lifecycleStage: filter values to canonical enum members.
  if (field === 'lifecycleStage' && leaf.op === 'in' && Array.isArray(leaf.values)) {
    const filtered = (leaf.values as unknown[]).filter(
      (v): v is string => typeof v === 'string' && CANONICAL_LIFECYCLE_STAGES.has(v),
    );
    if (filtered.length === 0) return null;
    return { field: 'lifecycleStage', op: 'in', values: filtered };
  }

  // source: filter values to canonical enum members.
  if (field === 'source' && leaf.op === 'in' && Array.isArray(leaf.values)) {
    const filtered = (leaf.values as unknown[]).filter(
      (v): v is string => typeof v === 'string' && CANONICAL_CONTACT_SOURCES.has(v),
    );
    if (filtered.length === 0) return null;
    return { field: 'source', op: 'in', values: filtered };
  }

  // country: 2-char ISO uppercase. LLM may emit "Canada"; we can't safely
  // coerce country names → ISO without a lookup table, so reject non-shape
  // values + log for follow-up.
  if (field === 'country' && leaf.op === 'in' && Array.isArray(leaf.values)) {
    const filtered = (leaf.values as unknown[]).filter(
      (v): v is string => typeof v === 'string' && /^[A-Z]{2}$/.test(v),
    );
    if (filtered.length === 0) return null;
    return { field: 'country', op: 'in', values: filtered };
  }

  // segment, region, city: free-text array; pass through with string filter.
  if (
    (field === 'segment' || field === 'region' || field === 'city') &&
    leaf.op === 'in' &&
    Array.isArray(leaf.values)
  ) {
    const filtered = (leaf.values as unknown[]).filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    if (filtered.length === 0) return null;
    return { field, op: 'in', values: filtered };
  }

  // orders.exists: boolean comparison.
  if (field === 'orders.exists' && leaf.op === 'eq' && typeof leaf.value === 'boolean') {
    return { field: 'orders.exists', op: 'eq', value: leaf.value };
  }

  // deal.value.{gte,lte,between}: numeric comparison.
  if (field === 'deal.value.gte' && leaf.op === 'gte' && typeof leaf.value === 'number' && leaf.value >= 0) {
    return { field: 'deal.value.gte', op: 'gte', value: leaf.value };
  }
  if (field === 'deal.value.lte' && leaf.op === 'lte' && typeof leaf.value === 'number' && leaf.value >= 0) {
    return { field: 'deal.value.lte', op: 'lte', value: leaf.value };
  }
  if (field === 'deal.value.between' && leaf.op === 'between' && typeof leaf.minUsd === 'number' && typeof leaf.maxUsdExclusive === 'number') {
    return { field: 'deal.value.between', op: 'between', minUsd: leaf.minUsd, maxUsdExclusive: leaf.maxUsdExclusive };
  }

  // Unmappable shape: drop with warn-via-null-return.
  return null;
}

function normalizeAudienceNode(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as Record<string, unknown>;

  // Recursive: allOf/anyOf
  if (Array.isArray(n.allOf)) {
    const children = (n.allOf as unknown[])
      .map((c) => normalizeAudienceNode(c))
      .filter((c): c is Record<string, unknown> => c !== null);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]; // unwrap single-child allOf
    return { allOf: children };
  }
  if (Array.isArray(n.anyOf)) {
    const children = (n.anyOf as unknown[])
      .map((c) => normalizeAudienceNode(c))
      .filter((c): c is Record<string, unknown> => c !== null);
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]; // unwrap single-child anyOf
    return { anyOf: children };
  }

  // Leaf
  if (typeof n.field === 'string') {
    return normalizeAudienceLeaf(n);
  }

  return null;
}

/** Top-level audience normalizer. Walks tree, normalizes each leaf, and
 *  validates the result against AudienceConditionsSchema.parse before
 *  returning. Returns discriminated result for caller introspection. */
function normalizeAudienceTree(
  value: unknown,
): { kind: 'ok'; tree: unknown } | { kind: 'err'; reason: string } {
  const normalized = normalizeAudienceNode(value);
  if (!normalized) {
    return { kind: 'err', reason: 'all-leaves-unmappable' };
  }
  // Validate via the canonical Zod schema before persisting. Imported lazily
  // via @growth/shared the same way other types are.
  try {
    // The schema is already imported at the top of this file via @growth/shared
    // (AudienceConditionsSchema). We call .parse to throw on invalid shape.
    AudienceConditionsSchema.parse(normalized);
    return { kind: 'ok', tree: normalized };
  } catch (err) {
    return { kind: 'err', reason: `schema-parse-failed: ${(err as Error).message.slice(0, 120)}` };
  }
}

/**
 * KAN-1230 B2.2 — resolve a relative timeline phrase to a concrete UTC Date,
 * relative to `today`. Returns null when the phrase isn't a recognized
 * relative pattern (caller then falls back to `new Date()` ISO parsing).
 *
 * UTC-only — tenant timezone isn't plumbed yet (documented default). End-of-
 * period phrases resolve to the last instant (23:59:59.999) of the period.
 */
export function resolveRelativeDate(raw: string, today: Date): Date | null {
  const s = raw.toLowerCase().trim();
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const endOfDay = (dt: Date) =>
    new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), 23, 59, 59, 999));

  // "end of month" / "end of this month" → last day of current month
  if (/\bend of (this )?month\b/.test(s)) {
    return new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999)); // day 0 of next month
  }
  // "end of Q[1-4]" / "end of quarter" → last day of the named (or current) quarter
  const qMatch = s.match(/\bend of q([1-4])\b/);
  if (qMatch || /\bend of (the )?(current )?quarter\b/.test(s)) {
    const q = qMatch ? Number(qMatch[1]) : Math.floor(m / 3) + 1;
    const lastMonthOfQ = q * 3 - 1; // Q1→2(Mar) Q2→5(Jun) Q3→8(Sep) Q4→11(Dec)
    return new Date(Date.UTC(y, lastMonthOfQ + 1, 0, 23, 59, 59, 999));
  }
  // "next quarter" → first day of the next calendar quarter
  if (/\bnext quarter\b/.test(s)) {
    const nextQStartMonth = (Math.floor(m / 3) + 1) * 3; // may roll into next year
    return new Date(Date.UTC(y, nextQStartMonth, 1, 0, 0, 0, 0));
  }
  // "in N days" / "N days" → today + N days (end of that day)
  const nDays = s.match(/\bin (\d{1,4}) days?\b/) ?? s.match(/^(\d{1,4}) days?$/);
  if (nDays) {
    const d = new Date(today.getTime());
    d.setUTCDate(d.getUTCDate() + Number(nDays[1]));
    return endOfDay(d);
  }
  // "next week" → +7 days
  if (/\bnext week\b/.test(s)) {
    const d = new Date(today.getTime());
    d.setUTCDate(d.getUTCDate() + 7);
    return endOfDay(d);
  }
  // "end of week" / "by friday" etc. → upcoming weekday (default Sunday)
  const byDay = s.match(/\bby (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (byDay || /\bend of (this )?week\b/.test(s)) {
    const targetDow = byDay
      ? ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(byDay[1])
      : 0; // end of week → Sunday
    const d = new Date(today.getTime());
    const delta = (targetDow - d.getUTCDay() + 7) % 7 || 7; // strictly upcoming
    d.setUTCDate(d.getUTCDate() + delta);
    return endOfDay(d);
  }
  return null;
}

/** Normalize the LLM's timeline-dimension value to {windowStart, windowEnd}
 *  as Date objects. Pre-KAN-1203 accepted only ISO strings via `new Date()`
 *  (which silently returns Invalid Date on bad input); KAN-1203 surfaces
 *  Invalid Date as a normalization failure so the field stays NULL rather
 *  than corrupting the column. KAN-1230 B2.2 — resolves relative phrases
 *  ("end of month", "in 30 days", "end of Q3") against `today` before the ISO
 *  fallback; windowStart defaults to `today` when only an end is given. */
function normalizeTimeline(
  value: unknown,
  today: Date = new Date(),
): Partial<{ windowStart: Date; windowEnd: Date }> {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  const result: Partial<{ windowStart: Date; windowEnd: Date }> = {};

  const parseOne = (rawStr: string): Date | undefined => {
    const relative = resolveRelativeDate(rawStr, today);
    if (relative) return relative;
    const d = new Date(rawStr);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };

  const startRaw = pickString(v, ['windowStart', 'start', 'startDate', 'from', 'beginAt']);
  if (startRaw) {
    const d = parseOne(startRaw);
    if (d) result.windowStart = d;
  }

  const endRaw = pickString(v, ['windowEnd', 'end', 'endDate', 'to', 'finishAt']);
  if (endRaw) {
    const d = parseOne(endRaw);
    if (d) result.windowEnd = d;
  }

  // KAN-1230 B2.2 — a relative end with no start defaults the window open from
  // today ("by end of month" → window is now → end of month).
  if (result.windowEnd && !result.windowStart) {
    result.windowStart = today;
  }

  return result;
}

async function persistDimensionToCampaign(
  prisma: OrchestratorPrisma,
  campaignId: string,
  _tenantId: string,
  dim: DimensionKey,
  value: unknown,
  entityType: CampaignTargetEntityType | null,
  // KAN-1230 B2.2 — reference date for relative-timeline resolution. Defaults
  // to now; callers pass the turn's todayUtc for deterministic resolution.
  today: Date = new Date(),
): Promise<void> {
  const data: Record<string, unknown> = {};
  switch (dim) {
    case 'entityType': {
      // KAN-1219 Slice G3 — write the polymorphic discriminator to the
      // canonical `target_entity_type` column the moment the operator
      // confirms it. targetEntityIds is populated later at the
      // TargetEntityPanel confirm step (per Q5 lock — specific VINs
      // selected from live inventory, lazy-loaded at confirm time).
      const parsed = CampaignTargetEntityTypeEnum.safeParse(value);
      if (parsed.success) {
        data.targetEntityType = parsed.data;
      } else {
        console.warn(
          `[orchestrator] entityType-persist-drift campaignId=${campaignId} valueShape=${describeValueShape(value)}`,
        );
      }
      break;
    }
    case 'product': {
      // KAN-1219 Slice G3 — polymorphic branch. Vehicle campaigns capture
      // the operator's descriptive intent (year/make/model/VIN hints) in
      // proposedPlan.vehicleTargetDescriptor; actual targetEntityIds get
      // populated at the TargetEntityPanel confirm step. Product campaigns
      // keep the existing goalProductId behavior for the 1-sprint
      // deprecation window per Q4 lock.
      if (entityType === 'vehicle') {
        if (value && typeof value === 'object') {
          data.proposedPlan = { vehicleTargetDescriptor: value };
        } else {
          console.warn(
            `[orchestrator] vehicle-persist-drift campaignId=${campaignId} valueShape=${describeValueShape(value)}`,
          );
        }
        break;
      }
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
      const normalized = normalizeTimeline(value, today);
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
    case 'audience': {
      // KAN-1204 — Audience normalizer. Pre-KAN-1204 was passthrough; the
      // LLM emitted creative shapes that failed AudienceConditionsSchema.parse
      // downstream at the generator's validation gate (Fred's smoke saw
      // amber banner "Campaign audienceConditions failed schema validation").
      //
      // Worse: the KAN-1203 prompt example for audience contained a
      // NON-canonical shape (`{field: 'orders.placedAt', op: 'gte', ...}` —
      // only `op: 'between'` is canonical for date leaves). The LLM
      // faithfully followed the wrong example. Both layers fixed: prompt
      // example corrected below + normalizer wired here.
      //
      // The normalizer walks the recursive (allOf/anyOf/leaf) tree, fixes
      // common LLM divergences at each leaf, drops unmappable leaves, and
      // validates the final shape via AudienceConditionsSchema.parse before
      // persisting. If parse fails, no write happens (Campaign.audienceConditions
      // stays as {} from createDraftCampaign and the generator surfaces
      // insufficient_dimensions honestly to the operator).
      const normalized = normalizeAudienceTree(value);
      if (normalized.kind === 'ok') {
        data.audienceConditions = normalized.tree;
      } else {
        console.warn(
          `[orchestrator] audience-persist-drift campaignId=${campaignId} reason=${normalized.reason} valueShape=${describeValueShape(value)}`,
        );
      }
      break;
    }
  }
  if (Object.keys(data).length > 0) {
    await prisma.campaign.update({ where: { id: campaignId }, data });
  }
}
