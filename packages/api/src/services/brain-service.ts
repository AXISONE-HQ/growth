/**
 * KAN-794 — Brain Service MVP (Phase 2 epic 1 of 5).
 *
 * Pure module that loads a Deal's current state from the Phase 1 substrate
 * (Deal + Pipeline + Stage + Engagement + DealStageHistory), calls the LLM
 * for next-best-action evaluation, and returns a structured BrainDecision.
 *
 * **No persistence in MVP.** Caller decides what to do with the decision
 * (write to `decisions` table, dispatch action via Communication Shaper,
 * surface in UI, etc.). Phase 2 epics KAN-795/796/797 wire consumers:
 *   - KAN-795 Pipeline Logic — reads BrainDecision to drive Pipeline routing
 *   - KAN-796 Stages Evolution — reads BrainDecision.nextBestAction.targetStageId
 *     for AI-driven Stage advancement
 *   - KAN-797 Communication Shaper — reads suggestedChannel + suggestedTone
 *
 * Determinism: same Deal state + mocked LLM response = same BrainDecision.
 * Tests use this property to assert idempotent shape via the prisma + llm-client
 * mocks.
 *
 * Cost: returns `llmInputTokens` + `llmOutputTokens` raw; does NOT compute or
 * return $USD. Per KAN-745 architecture, llm-client.complete() emits cost
 * asynchronously via the `llm.call` Pub/Sub topic → llm-cost-aggregator
 * partitions per-tenant. Brain Service avoids duplicating MODEL_PRICING
 * (`feedback_model_pricing_refresh_discipline`) — consumers needing $USD
 * either query the rollup or compute via MODEL_PRICING themselves.
 *
 * Module-scoped exports per sibling-service convention (matches
 * lead-normalizer.ts / engagement-service.ts / lead-assignment.ts).
 */
import type {
  PrismaClient,
  Contact,
  Engagement,
  DealStageHistory,
} from '@prisma/client';
import { complete } from './llm-client.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type BrainActionType =
  | 'send_follow_up'
  | 'wait_for_response'
  | 'advance_stage'
  | 'escalate_to_human'
  | 'close_deal_lost'
  | 'no_action';

export type BrainSuggestedChannel = 'email' | 'sms' | 'meta_messenger';
export type BrainSuggestedTone = 'curious' | 'professional' | 'urgent' | 'closing';

export interface BrainNextBestAction {
  type: BrainActionType;
  targetStageId?: string;
  suggestedChannel?: BrainSuggestedChannel;
  suggestedTone?: BrainSuggestedTone;
  reasoning: string;
}

export interface BrainStateSnapshot {
  /** Derived from currentStage.outcomeType (open / terminal_won / terminal_lost). */
  dealStatus: 'open' | 'closed_won' | 'closed_lost';
  currentStageName: string;
  currentStageOutcomeType: 'open' | 'terminal_won' | 'terminal_lost';
  daysInCurrentStage: number;
  /** Count of recent engagements loaded (capped by recentEngagementLimit), NOT total. */
  engagementCount: number;
  lastEngagementType: string | null;
  lastEngagementClass: 'positive' | 'negative' | 'neutral' | null;
  daysSinceLastEngagement: number | null;
  /** Percent of MO entries with completedAt set. null when MO progress is empty. */
  moProgressPercent: number | null;
  pipelineName: string;
  pipelineObjectiveType: string;
}

export interface BrainDecision {
  dealId: string;
  evaluatedAt: Date;
  currentStateSnapshot: BrainStateSnapshot;
  nextBestAction: BrainNextBestAction;
  /** 0-1. Caller decides escalation threshold (analogous to lead-assignment AI fallback). */
  confidence: number;
  modelTier: 'cheap' | 'reasoning';
  /**
   * KAN-745 architecture: llm-client emits cost asynchronously via llm.call
   * topic → llm-cost-aggregator. Brain Service returns raw token counts so
   * consumers can compute cost themselves (via MODEL_PRICING) or join the
   * async rollup. See feedback_model_pricing_refresh_discipline.
   */
  llmInputTokens: number;
  llmOutputTokens: number;
}

export interface EvaluateOptions {
  /** Default 'reasoning' (Sonnet). Caller can downshift to 'cheap' (Haiku) for batch eval. */
  tier?: 'cheap' | 'reasoning';
  /** Default 5. Caps how many recent Engagements feed into the prompt. */
  recentEngagementLimit?: number;
}

export class BrainServiceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrainServiceNotFoundError';
  }
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Evaluate a single Deal's state and return a next-best-action recommendation.
 *
 * Pure function — no persistence. Caller holds the decision-write authority.
 *
 * Throws BrainServiceNotFoundError when dealId doesn't exist.
 *
 * Graceful degradation: LLM call failure / malformed JSON / wrong-shape JSON
 * all return type='no_action' + confidence=0 + zero tokens (the latter
 * because no successful LLM call was made — consumers can detect "no_action
 * + confidence=0" as "Brain failed gracefully, decide your retry policy").
 */
export async function evaluateDealState(
  prisma: PrismaClient,
  dealId: string,
  options: EvaluateOptions = {},
): Promise<BrainDecision> {
  const tier = options.tier ?? 'reasoning';
  const recentEngagementLimit = options.recentEngagementLimit ?? 5;
  const evaluatedAt = new Date();

  // 1. Load Deal + relations needed for snapshot + prompt.
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      contact: true,
      pipeline: true,
      currentStage: true,
      engagements: {
        orderBy: { occurredAt: 'desc' },
        take: recentEngagementLimit,
      },
      stageHistory: {
        orderBy: { transitionedAt: 'desc' },
        take: 10,
      },
    },
  });

  if (!deal) {
    throw new BrainServiceNotFoundError(`Deal not found: ${dealId}`);
  }

  // 2. Compute snapshot.
  const snapshot = buildStateSnapshot(deal, evaluatedAt);

  // 3. Short-circuit on terminal Stages — no LLM call needed.
  if (snapshot.dealStatus === 'closed_won' || snapshot.dealStatus === 'closed_lost') {
    return {
      dealId,
      evaluatedAt,
      currentStateSnapshot: snapshot,
      nextBestAction: {
        type: 'no_action',
        reasoning: `Deal is in terminal stage (${snapshot.currentStageName}); no further action needed.`,
      },
      confidence: 1.0,
      modelTier: tier,
      llmInputTokens: 0,
      llmOutputTokens: 0,
    };
  }

  // 4. Build prompt.
  const userPrompt = buildEvaluationPrompt({
    snapshot,
    contact: deal.contact,
    recentEngagements: deal.engagements,
    recentTransitions: deal.stageHistory,
  });

  // 5. Call LLM. tenantId derived from the loaded Deal (KAN-745 per-tenant
  //    cost partition requirement).
  let llmText: string;
  let llmInputTokens = 0;
  let llmOutputTokens = 0;
  try {
    const response = await complete({
      tenantId: deal.tenantId,
      tier,
      systemPrompt: BRAIN_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 800,
      callerTag: 'brain-service:evaluate-deal-state',
    });
    llmText = response.text;
    llmInputTokens = response.inputTokens;
    llmOutputTokens = response.outputTokens;
  } catch (err) {
    console.warn(
      `[brain-service] llm-call-failed dealId=${dealId} err=${(err as Error)?.message ?? String(err)}`,
    );
    return gracefulFallback(dealId, evaluatedAt, snapshot, tier, 'LLM call failed');
  }

  // 6. Parse + validate response.
  const parsed = parseLlmResponse(llmText);
  if (!parsed.ok) {
    console.warn(
      `[brain-service] parse-failed dealId=${dealId} reason=${parsed.error} preview=${llmText.slice(0, 200)}`,
    );
    return gracefulFallback(dealId, evaluatedAt, snapshot, tier, parsed.error);
  }

  return {
    dealId,
    evaluatedAt,
    currentStateSnapshot: snapshot,
    nextBestAction: parsed.value.nextBestAction,
    confidence: parsed.value.confidence,
    modelTier: tier,
    llmInputTokens,
    llmOutputTokens,
  };
}

// ─────────────────────────────────────────────
// State snapshot computation (pure, exported for test introspection)
// ─────────────────────────────────────────────

interface DealWithRelations {
  id: string;
  tenantId: string;
  enteredStageAt: Date;
  microObjectiveProgress: unknown;
  contact: Contact;
  pipeline: { name: string; objectiveType: string };
  currentStage: { name: string; outcomeType: 'open' | 'terminal_won' | 'terminal_lost' };
  engagements: Engagement[];
  stageHistory: DealStageHistory[];
}

export function buildStateSnapshot(
  deal: DealWithRelations,
  evaluatedAt: Date,
): BrainStateSnapshot {
  const lastEngagement = deal.engagements[0] ?? null;
  const daysInCurrentStage = Math.floor(
    (evaluatedAt.getTime() - deal.enteredStageAt.getTime()) / (1000 * 60 * 60 * 24),
  );
  const daysSinceLastEngagement = lastEngagement
    ? Math.floor(
        (evaluatedAt.getTime() - lastEngagement.occurredAt.getTime()) / (1000 * 60 * 60 * 24),
      )
    : null;

  const dealStatus =
    deal.currentStage.outcomeType === 'terminal_won'
      ? 'closed_won'
      : deal.currentStage.outcomeType === 'terminal_lost'
        ? 'closed_lost'
        : 'open';

  return {
    dealStatus,
    currentStageName: deal.currentStage.name,
    currentStageOutcomeType: deal.currentStage.outcomeType,
    daysInCurrentStage,
    engagementCount: deal.engagements.length,
    lastEngagementType: lastEngagement?.engagementType ?? null,
    lastEngagementClass: lastEngagement
      ? (lastEngagement.signalClass as BrainStateSnapshot['lastEngagementClass'])
      : null,
    daysSinceLastEngagement,
    moProgressPercent: computeMoProgressPercent(deal.microObjectiveProgress),
    pipelineName: deal.pipeline.name,
    pipelineObjectiveType: deal.pipeline.objectiveType,
  };
}

export function computeMoProgressPercent(progress: unknown): number | null {
  if (
    !progress ||
    typeof progress !== 'object' ||
    Array.isArray(progress) ||
    Object.keys(progress as Record<string, unknown>).length === 0
  ) {
    return null;
  }
  const entries = Object.values(progress as Record<string, unknown>);
  const total = entries.length;
  const completed = entries.filter(
    (p) =>
      p != null &&
      typeof p === 'object' &&
      typeof (p as { completedAt?: unknown }).completedAt === 'string' &&
      ((p as { completedAt?: unknown }).completedAt as string).length > 0,
  ).length;
  return Math.round((completed / total) * 100);
}

// ─────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────

const BRAIN_SYSTEM_PROMPT = `You are an AI sales assistant helping a sales team decide the best next action for a Deal.

Given the current state of a Deal — its Stage, recent engagement history, Pipeline objective, and time-in-stage — recommend ONE next action from this set:

- send_follow_up: send a new outbound message (specify channel + tone)
- wait_for_response: contact recently engaged; give them time
- advance_stage: move Deal to next Stage in Pipeline
- escalate_to_human: confidence too low or situation requires human judgment
- close_deal_lost: stalled too long; give up
- no_action: explicit no-op

Respond ONLY with valid JSON in this exact shape:
{
  "nextBestAction": {
    "type": "<one of the action types>",
    "reasoning": "<1-2 sentence explanation>",
    "suggestedChannel": "<email|sms|meta_messenger or null>",
    "suggestedTone": "<curious|professional|urgent|closing or null>",
    "targetStageId": "<stage id or null>"
  },
  "confidence": <0.0-1.0>
}

Be conservative: if unsure, recommend escalate_to_human or wait_for_response with low confidence.`;

function buildEvaluationPrompt(input: {
  snapshot: BrainStateSnapshot;
  contact: Contact;
  recentEngagements: Engagement[];
  recentTransitions: DealStageHistory[];
}): string {
  const { snapshot, contact, recentEngagements, recentTransitions } = input;

  const contactName =
    [contact.firstName, contact.lastName].filter((p) => !!p && p.trim().length > 0).join(' ') ||
    contact.email ||
    '(unknown contact)';
  const company = contact.company ?? '(unknown company)';

  const engagementsBlock =
    recentEngagements.length === 0
      ? '(no recent engagements)'
      : recentEngagements
          .map(
            (e, i) =>
              `${i + 1}. ${e.occurredAt.toISOString()} — ${e.engagementType} (${e.signalClass})${e.channel ? ` via ${e.channel}` : ''}`,
          )
          .join('\n');

  const transitionsBlock =
    recentTransitions.length === 0
      ? '(no recent stage transitions)'
      : recentTransitions
          .slice(0, 3)
          .map(
            (t, i) =>
              `${i + 1}. ${t.transitionedAt.toISOString()} — ${t.fromStageId ?? 'initial'} → ${t.toStageId} (triggered by ${t.triggeredBy})`,
          )
          .join('\n');

  return `## Deal context
Pipeline: ${snapshot.pipelineName} (objective: ${snapshot.pipelineObjectiveType})
Contact: ${contactName} @ ${company}

## Current Stage
Name: ${snapshot.currentStageName}
Outcome type: ${snapshot.currentStageOutcomeType}
Days in stage: ${snapshot.daysInCurrentStage}
Micro-objective progress: ${snapshot.moProgressPercent ?? '(none tracked)'}${snapshot.moProgressPercent != null ? '%' : ''}

## Recent engagement (last ${snapshot.engagementCount}, capped)
${engagementsBlock}
Last engagement signal: ${snapshot.lastEngagementClass ?? '(none)'}
Days since last engagement: ${snapshot.daysSinceLastEngagement ?? '(no engagements)'}

## Recent stage transitions (last 3)
${transitionsBlock}

## Decision required
Pick the best next action. Respond ONLY with the JSON shape specified in the system prompt.`;
}

// ─────────────────────────────────────────────
// Response parsing (defensive — LLMs can return partial/wrong shapes)
// ─────────────────────────────────────────────

const VALID_ACTION_TYPES: ReadonlySet<BrainActionType> = new Set<BrainActionType>([
  'send_follow_up',
  'wait_for_response',
  'advance_stage',
  'escalate_to_human',
  'close_deal_lost',
  'no_action',
]);
const VALID_CHANNELS: ReadonlySet<BrainSuggestedChannel> = new Set<BrainSuggestedChannel>([
  'email',
  'sms',
  'meta_messenger',
]);
const VALID_TONES: ReadonlySet<BrainSuggestedTone> = new Set<BrainSuggestedTone>([
  'curious',
  'professional',
  'urgent',
  'closing',
]);

type ParsedLlmResponse =
  | { ok: true; value: { nextBestAction: BrainNextBestAction; confidence: number } }
  | { ok: false; error: string };

export function parseLlmResponse(text: string): ParsedLlmResponse {
  let cleaned = text.trim();
  // Strip optional ```json fences.
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
  const action = root.nextBestAction;
  const confidence = root.confidence;

  if (typeof confidence !== 'number' || !isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, error: 'confidence not a number in [0,1]' };
  }
  if (!action || typeof action !== 'object') {
    return { ok: false, error: 'nextBestAction missing' };
  }
  const a = action as Record<string, unknown>;
  if (typeof a.type !== 'string' || !VALID_ACTION_TYPES.has(a.type as BrainActionType)) {
    return { ok: false, error: `invalid action type: ${String(a.type)}` };
  }
  if (typeof a.reasoning !== 'string' || a.reasoning.trim().length === 0) {
    return { ok: false, error: 'reasoning missing or empty' };
  }

  const nextBestAction: BrainNextBestAction = {
    type: a.type as BrainActionType,
    reasoning: a.reasoning,
  };
  if (
    typeof a.suggestedChannel === 'string' &&
    VALID_CHANNELS.has(a.suggestedChannel as BrainSuggestedChannel)
  ) {
    nextBestAction.suggestedChannel = a.suggestedChannel as BrainSuggestedChannel;
  }
  if (
    typeof a.suggestedTone === 'string' &&
    VALID_TONES.has(a.suggestedTone as BrainSuggestedTone)
  ) {
    nextBestAction.suggestedTone = a.suggestedTone as BrainSuggestedTone;
  }
  if (typeof a.targetStageId === 'string' && a.targetStageId.trim().length > 0) {
    nextBestAction.targetStageId = a.targetStageId;
  }

  return { ok: true, value: { nextBestAction, confidence } };
}

// ─────────────────────────────────────────────
// Graceful fallback
// ─────────────────────────────────────────────

function gracefulFallback(
  dealId: string,
  evaluatedAt: Date,
  snapshot: BrainStateSnapshot,
  tier: 'cheap' | 'reasoning',
  reason: string,
): BrainDecision {
  return {
    dealId,
    evaluatedAt,
    currentStateSnapshot: snapshot,
    nextBestAction: {
      type: 'no_action',
      reasoning: `Brain Service fallback: ${reason}. Caller should retry or escalate.`,
    },
    confidence: 0.0,
    modelTier: tier,
    // Zero tokens: no successful LLM call was made (or the response was
    // unparseable, in which case the caller treats this as "no decision yet").
    llmInputTokens: 0,
    llmOutputTokens: 0,
  };
}
