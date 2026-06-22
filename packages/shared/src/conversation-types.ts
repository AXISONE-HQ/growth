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
  // KAN-1219 Slice G1 (Q1 lock) — entityType is the new polymorphic
  // discriminator dimension. The substrate ships the enum value here; the
  // orchestrator state-machine activation (DIMENSION_ORDER reshuffle +
  // 5-dimension extraction wiring) lands in Slice G3. Keeping the value in
  // the enum but absent from DIMENSION_ORDER (below) preserves the existing
  // 4-dimension extraction flow until G3 explicitly opts in. Memo 19/42
  // affordance-honesty — operator will see the entity decision as the
  // first explicit step once G3 promotes entityType to position 0.
  'entityType',
  'product',
  'objectives',
  'timeline',
  'audience',
]);
export type DimensionKey = z.infer<typeof DimensionKeyEnum>;

/**
 * KAN-1219 Slice G1 — Narrower type for currently-active extraction dims.
 *
 * `DimensionKey` includes 'entityType' (substrate ships it) but the
 * extraction order array + iteration sites only currently cover the 4
 * legacy dimensions. G3 will promote 'entityType' to a member of this
 * subset once the state machine + tests are wired in lockstep.
 */
export type ActiveDimensionKey = Exclude<DimensionKey, 'entityType'>;

/**
 * Canonical extraction order. First-Empty-wins in `nextDimensionToExtract`.
 *
 * # KAN-1219 Slice G1 — entityType intentionally OMITTED here
 *
 * The substrate ships entityType in the enum + state schema (optional)
 * without inserting it into DIMENSION_ORDER yet. G3 will replace this array
 * with `['entityType', 'product', 'objectives', 'timeline', 'audience']`
 * once the orchestrator state machine + tests have been updated in
 * lockstep. Pattern mirrors KAN-1184 Q-ADD C2 "deterministic state
 * transitions" — order changes are a state-machine concern, not substrate.
 */
export const DIMENSION_ORDER: ActiveDimensionKey[] = [
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
  // KAN-1219 Slice G1 — `entityType` carries CampaignTargetEntityType
  // ('product' | 'vehicle') once confirmed. Drives the downstream product
  // vs vehicle resolution flow. OPTIONAL in this substrate ship so the
  // existing 4-dimension orchestrator flow remains intact; G3 will mark it
  // required + insert into DIMENSION_ORDER position 0 (Memo 19/42
  // affordance-honesty — operator sees the entity branch as the first
  // explicit step once G3 lands).
  entityType: DimensionStateSchema.optional(),
  product: DimensionStateSchema,
  objectives: DimensionStateSchema,
  timeline: DimensionStateSchema,
  audience: DimensionStateSchema,
});
export type ConversationState = z.infer<typeof ConversationStateSchema>;

/** Empty initial state — 4 dimensions unconfirmed (G1 backward-compat). */
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
