/**
 * KAN-1184 — Conversational orchestrator types (Campaign Module Reset).
 *
 * Multi-turn dialogue state for the `/campaigns/new` chat builder.
 * Orchestrator extracts 4 dimensions in canonical order:
 *   Product → Objectives → Timeline → Audience
 * Each dimension transitions Empty → Proposed → Confirmed.
 *
 * State transitions are deterministic (Q-ADD C2 lock): orchestrator
 * computes `nextDimensionToExtract(state)` (first Empty dimension wins);
 * LLM is scoped to per-dimension extraction.
 *
 * Three confidence levels on Proposed (Q-ADD C5 lock):
 *   - high   → auto-transition; next turn proceeds to next dimension
 *   - medium → explicit operator confirmation prompt before transition
 *   - low    → orchestrator returns 'clarification' turn; no state change
 *
 * Honest counsel doctrine: LLM never fabricates dimensions. Low confidence
 * triggers clarification, not invented values.
 */
import { z } from 'zod';

// ─────────────────────────────────────────────
// Dimensions
// ─────────────────────────────────────────────

export const DimensionKeyEnum = z.enum([
  'product',
  'objectives',
  'timeline',
  'audience',
]);
export type DimensionKey = z.infer<typeof DimensionKeyEnum>;

/** Canonical extraction order. First-Empty-wins in `nextDimensionToExtract`. */
export const DIMENSION_ORDER: DimensionKey[] = [
  'product',
  'objectives',
  'timeline',
  'audience',
];

// ─────────────────────────────────────────────
// DimensionState — discriminated union over `kind`
// ─────────────────────────────────────────────

export const DimensionStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty') }),
  z.object({
    kind: z.literal('proposed'),
    value: z.unknown(),
    confidence: z.enum(['high', 'medium', 'low']),
  }),
  z.object({
    kind: z.literal('confirmed'),
    value: z.unknown(),
  }),
]);
export type DimensionState = z.infer<typeof DimensionStateSchema>;

// ─────────────────────────────────────────────
// ConversationState — 4-dimension capture state
// ─────────────────────────────────────────────

export const ConversationStateSchema = z.object({
  product: DimensionStateSchema,
  objectives: DimensionStateSchema,
  timeline: DimensionStateSchema,
  audience: DimensionStateSchema,
});
export type ConversationState = z.infer<typeof ConversationStateSchema>;

/** Empty initial state — all 4 dimensions unconfirmed. */
export function emptyConversationState(): ConversationState {
  return {
    product: { kind: 'empty' },
    objectives: { kind: 'empty' },
    timeline: { kind: 'empty' },
    audience: { kind: 'empty' },
  };
}

// ─────────────────────────────────────────────
// ConversationTurn — chat turn shape
// ─────────────────────────────────────────────

export const TurnTypeEnum = z.enum(['operator', 'ai', 'system']);
export type TurnType = z.infer<typeof TurnTypeEnum>;

export interface ConversationTurn {
  turnType: TurnType;
  content: string;
  dimensionsExtracted?: Partial<ConversationState>;
  createdAt: string;
}

/**
 * KAN-1189 Z1 lock — Replay persisted turns into a ConversationState.
 *
 * Pure logic, zero IO. Consumed by:
 *   - apps/web useCampaignBuilder hook on /campaigns/new?campaignId= restoration
 *   - future server-side admin/debugging tools (TBD)
 *
 * Walks turns chronologically and accumulates dimensions. Honors the
 * KAN-1187 X3 reset-turn doctrine: when a turn carries
 * `dimensionsExtracted = emptyConversationState()` (the reset marker), the
 * accumulator restarts. Subsequent confirmations layer on top of the empty
 * baseline, exactly as the live orchestrator would have driven them.
 *
 * Turns are expected in `createdAt ASC` order (same as the DB index). The
 * function preserves this assumption — it does not sort defensively, since
 * silently re-ordering a corrupted history would mask a bug.
 */
export function replayConversationState(
  turns: readonly ConversationTurn[],
): ConversationState {
  let state = emptyConversationState();
  for (const turn of turns) {
    if (!turn.dimensionsExtracted) continue;
    // Reset turns carry a fully-empty dimensionsExtracted snapshot. Detect
    // by checking all 4 keys are `kind: 'empty'` — the orchestrator emits
    // this exact shape on KAN-1184 Q-ADD C6 reset triggers.
    const allEmpty = DIMENSION_ORDER.every(
      (k) => turn.dimensionsExtracted?.[k]?.kind === 'empty',
    );
    if (allEmpty) {
      state = emptyConversationState();
      continue;
    }
    state = {
      ...state,
      ...(turn.dimensionsExtracted as Partial<ConversationState>),
    };
  }
  return state;
}

// ─────────────────────────────────────────────
// ChatTurnResult — discriminated result from campaigns.chat
// ─────────────────────────────────────────────

export type ChatTurnResult =
  | {
      kind: 'clarification';
      aiMessage: string;
      state: ConversationState;
      campaignId: string;
    }
  | {
      kind: 'dimension_proposed';
      aiMessage: string;
      state: ConversationState;
      campaignId: string;
      dimensionKey: DimensionKey;
    }
  | {
      kind: 'dimension_confirmed';
      aiMessage: string;
      state: ConversationState;
      campaignId: string;
      dimensionKey: DimensionKey;
    }
  | {
      kind: 'all_dimensions_confirmed';
      aiMessage: string;
      state: ConversationState;
      campaignId: string;
    }
  | {
      kind: 'reset';
      aiMessage: string;
      state: ConversationState;
      campaignId: string;
    }
  | {
      kind: 'analyzer_unavailable';
      aiMessage: string;
      campaignId: string;
    };
