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
  // KAN-1219 Slice G3 (Q1 lock activated) — entityType is the polymorphic
  // discriminator and the FIRST extracted dimension. Operator answers
  // "campaign for a product or a vehicle?" before any product/vehicle
  // resolution branches off. Memo 19/42 affordance-honesty — the entity
  // decision is the first explicit step.
  'entityType',
  'product',
  'objectives',
  'timeline',
  'audience',
]);
export type DimensionKey = z.infer<typeof DimensionKeyEnum>;

/**
 * KAN-1219 Slice G3 — Type alias for currently-active extraction dims.
 *
 * Retained for downstream callers that emerged during the G1 dark-substrate
 * phase (e.g. `apps/web/src/app/campaigns/new/_components/DimensionSidebar.tsx`
 * Record<ActiveDimensionKey, string> label map). G3 promotes entityType to
 * full DimensionKey membership; this alias remains a safe escape hatch for
 * future dimensions that need staged activation.
 */
export type ActiveDimensionKey = Exclude<DimensionKey, 'entityType'>;

/**
 * Canonical extraction order. First-Empty-wins in `nextDimensionToExtract`.
 *
 * # KAN-1219 Slice G3 — entityType promoted to position 0 (Q1 lock)
 *
 * G1 staged entityType in the enum + optional state slot. G2 shipped the
 * UI confirmation surface DARK. G3 activates: entityType is now position 0
 * in extraction order, required in ConversationStateSchema, and gating
 * downstream extraction branching (product vs vehicle resolution; audience
 * gated per Q3 — vehicles skip audience). All in-tree consumers updated in
 * lockstep — Memo 56 anchor #13 substrate-staging-for-future-activation
 * 3rd anchor (composes-across-slices refinement formalizes).
 */
export const DIMENSION_ORDER: DimensionKey[] = [
  'entityType',
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
  // KAN-1219 Slice G3 — `entityType` carries CampaignTargetEntityType
  // ('product' | 'vehicle') once confirmed. REQUIRED + first in
  // DIMENSION_ORDER per Q1 lock. Gates downstream product/vehicle
  // resolution + (Q3) audience skip for vehicles.
  entityType: DimensionStateSchema,
  product: DimensionStateSchema,
  objectives: DimensionStateSchema,
  timeline: DimensionStateSchema,
  audience: DimensionStateSchema,
});
export type ConversationState = z.infer<typeof ConversationStateSchema>;

/** Empty initial state — 5 dimensions unconfirmed (Slice G3 activation). */
export function emptyConversationState(): ConversationState {
  return {
    entityType: { kind: 'empty' },
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
