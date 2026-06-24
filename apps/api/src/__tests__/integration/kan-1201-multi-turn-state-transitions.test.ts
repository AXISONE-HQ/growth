/**
 * KAN-1201 — Multi-turn state-transition regression lock (REAL Prisma).
 *
 * Closes the second testing-substrate gap that KAN-1184 shipped through. The
 * existing unit tests at `packages/api/src/services/__tests__/
 * conversational-orchestrator.test.ts` inject `ConversationState` directly
 * into each call — no test ever runs `handleChatTurn` for 2+ consecutive
 * turns with the state returned from turn N flowing into turn N+1. So the
 * state-machine bug surfaced as three concrete defects in Fred's PROD smoke
 * (proposed→confirmed transition never fires / dimensions don't persist
 * across turns / AI says "moving on" but state doesn't).
 *
 * This fixture exercises the orchestrator multi-turn against a real Postgres
 * transaction (rolled back). Each scenario asserts:
 *   - state from turn N is correctly carried into turn N+1
 *   - the right `kind` of `ChatTurnResult` is returned at each step
 *   - persistent rows (Campaign + CampaignConversationTurn) match the
 *     state machine's documented behavior, not just the docstring intent
 *
 * Substrate posture per banked memos:
 *
 *   - `documented_doctrine_ne_implemented_doctrine` — Q-ADD C5 docstring
 *     described 3 confidence-routing behaviors (high/medium/low); only
 *     `low → clarification` was wired pre-KAN-1201. Scenarios 2–4 assert
 *     each of the missing transitions is now backed by an actual code path.
 *
 *   - `detected_signals_drive_substrate_not_just_orchestration` — the
 *     orchestrator detected operator confirmation patterns in `selectTier`
 *     but only used the signal for LLM-tier routing. Scenario 1 asserts
 *     the L1 early-exit lets the same signal drive state transitions FIRST,
 *     skipping the LLM entirely when the operator types a bare confirmation.
 *
 *   - `operator_experience_verification` — the test suite passing is NOT
 *     equivalent to the operator being able to use the feature. KAN-1200 +
 *     KAN-1201 are both KAN-1184 latent bugs that shipped through 7 PRs of
 *     substitute-gate-clean CI. This fixture is the empirical anchor for
 *     KAN-1192's expanded scope: end-to-end multi-turn operator scenarios
 *     in CI, not just isolated transactional substrate paths.
 *
 * Import posture (KAN-689 variable-specifier): orchestrator lives in
 * packages/api/src outside apps/api's rootDir. Imported via variable-
 * specifier `await import(spec)` so apps/api tsc rootDir scope (TS6059)
 * doesn't drag the orchestrator module in at compile time.
 *
 * LLM is mocked at the function-pointer level (NOT vi.mock the module). Each
 * scenario supplies a deterministic LLM response so the test asserts
 * orchestrator state-machine semantics, not LLM behavior. Real Prisma writes
 * exercise the persistence path — closes the KAN-1184 gap where unit tests
 * injected a campaignId and never invoked the Prisma write path.
 */
import { describe, expect, it } from 'vitest';
import type {
  ChatTurnResult,
  ConversationState,
  DimensionKey,
} from '@growth/shared';
import { emptyConversationState } from '@growth/shared';
import { createTenant, withRollback } from './setup.js';

const orchestratorSpec =
  '../../../../../packages/api/src/services/conversational-orchestrator.js';

interface OrchestratorModule {
  handleChatTurn: (
    prisma: unknown,
    llm: unknown,
    audienceCount: unknown,
    params: {
      campaignId?: string;
      tenantId: string;
      message: string;
      state: ConversationState;
    },
    todayUtc?: Date,
  ) => Promise<ChatTurnResult>;
  isOperatorConfirmation: (message: string) => boolean;
}

/** Build a deterministic LLM function. Each call returns the next queued
 *  response; throws when the queue is exhausted (a scenario asking for more
 *  LLM calls than scripted means the orchestrator's behavior diverged from
 *  the test's expectation — which is the actual signal we want). */
function llmQueue(responses: Array<Record<string, unknown>>) {
  let i = 0;
  return async () => {
    if (i >= responses.length) {
      throw new Error(
        `LLM queue exhausted at call ${i + 1}; scenario only scripted ${responses.length} responses`,
      );
    }
    const next = responses[i++];
    return {
      text: JSON.stringify(next),
      model: 'mock-llm',
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 10,
    };
  };
}

/**
 * KAN-1230 B1 — when ≥2 dimensions are undetermined the orchestrator routes
 * to the multi-dim extraction path. `md()` wraps a single dimension's value in
 * the multi-dim response envelope (confidence ≥0.85 → confirm, 0.6–0.85 →
 * propose). L1 operator-confirmation and reset still fire BEFORE multi-dim, so
 * those scenarios are unchanged.
 */
function md(
  dim: string,
  value: unknown,
  confidence = 0.9,
): Record<string, unknown> {
  return { [dim]: { extracted: true, value, confidence, reason: 'test' } };
}

const STUB_AUDIENCE_COUNT = async () => ({
  count: 0,
  isThin: false,
  historicalValueUsd: 0,
});

const TODAY = new Date('2026-06-16T00:00:00.000Z');

/**
 * KAN-1219 Slice G3 activation cost — entityType promoted to FIRST position
 * in DIMENSION_ORDER per Q1 lock. KAN-1201 scenarios target product /
 * objectives / timeline / audience transitions, so each fixture seeds
 * entityType='product' as confirmed up-front (the orchestrator would
 * otherwise route to entityType extraction before reaching product).
 *
 * This is the activation-slice-fixture-update pattern: cost deferred from
 * G1/G2 DARK substrate now folded into G3 activation slice. See banked
 * memo (1st anchor of pattern).
 */
function productCampaignSeed(): ConversationState {
  return {
    ...emptyConversationState(),
    entityType: { kind: 'confirmed', value: 'product' },
  };
}

// ─────────────────────────────────────────────
// Scenario 1 — Defect 1 fix: bare confirmation upgrades proposed → confirmed.
//
// Pre-KAN-1201: orchestrator hardcoded `kind:'proposed'`; operator typing
// "confirmed" 5+ times in Fred's session never advanced state.
// Post-KAN-1201: L1 early-exit detects the confirmation signal + upgrades.
// ─────────────────────────────────────────────

describe('KAN-1201 L1 — bare confirmation upgrades proposed → confirmed (skips LLM)', () => {
  it('upgrades `product` from proposed → confirmed without invoking LLM', async () => {
    const { handleChatTurn } = (await import(
      orchestratorSpec
    )) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      // Prior turn left product in 'proposed' state (KAN-1219 G3 — entityType
      // seeded as confirmed=product so the orchestrator targets the product
      // dimension on this turn).
      const stateWithProposed: ConversationState = {
        ...productCampaignSeed(),
        product: { kind: 'proposed', value: 'Growth Platform', confidence: 'medium' },
      };
      // LLM queue is EMPTY — scenario asserts the LLM is NOT called when the
      // operator confirms a proposed dim. If the L1 early-exit regresses,
      // the call falls through to the LLM and queue-exhausted throws.
      const llm = llmQueue([]);

      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        {
          tenantId: tenant.id,
          message: 'yes, confirmed',
          state: stateWithProposed,
        },
        TODAY,
      );

      expect(result.kind).toBe('dimension_confirmed');
      if (result.kind === 'dimension_confirmed') {
        expect(result.dimensionKey).toBe('product');
        expect(result.state.product.kind).toBe('confirmed');
        if (result.state.product.kind === 'confirmed') {
          expect(result.state.product.value).toBe('Growth Platform');
        }
      }
    });
  });

  it('does NOT confirm when no dim is proposed (clarification fallback)', async () => {
    const { handleChatTurn } = (await import(
      orchestratorSpec
    )) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      // Empty state — operator typing "yes" is meaningless. L1 does NOT fire
      // (no proposed dim). KAN-1230 B1: multi-dim runs first but extracts
      // nothing from "yes" (response 1 = empty envelope → no dim advances →
      // falls through), then the single-dim entityType path returns the
      // clarification (response 2).
      const llm = llmQueue([
        {},
        {
          kind: 'clarification',
          aiMessage: 'Is this campaign about a product in your catalog, or a vehicle from your dealer inventory?',
        },
      ]);

      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        { tenantId: tenant.id, message: 'yes', state: emptyConversationState() },
        TODAY,
      );

      // Multi-dim found nothing → single-dim fallback → clarification.
      expect(result.kind).toBe('clarification');
    });
  });
});

// ─────────────────────────────────────────────
// Scenario 2 — Defect 1 fix: HIGH + empty → confirmed auto-transition (L2).
//
// Q-ADD C5 doctrine: "high → auto-transition; next turn proceeds to next
// dimension". Pre-KAN-1201 was a comment block, not a code path.
// ─────────────────────────────────────────────

describe('KAN-1201 L2 — HIGH confidence on empty dim → auto-confirm', () => {
  it('auto-confirms product on first turn when LLM returns confidence=high', async () => {
    const { handleChatTurn } = (await import(
      orchestratorSpec
    )) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const llm = llmQueue([md('product', 'Growth Platform Essential')]);

      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        {
          tenantId: tenant.id,
          message: 'we sell Growth Platform Essential tier',
          state: productCampaignSeed(),
        },
        TODAY,
      );

      // KAN-1230 B1 — HIGH confidence (≥0.85) auto-confirms via the multi-dim path.
      expect(result.kind).toBe('dimensions_extracted');
      if (result.kind === 'dimensions_extracted') {
        expect(result.state.product.kind).toBe('confirmed');
        expect(result.advanced).toContainEqual({ dimensionKey: 'product', kind: 'confirmed' });
      }
    });
  });
});

// ─────────────────────────────────────────────
// Scenario 3 — Defect 1 fix: HIGH + proposed → confirmed (L3 implicit confirmation).
//
// V2 doctrine extended: operator continued past a proposal without correcting
// = implicit confirmation. If the operator rephrases the proposal in their
// own words and the LLM extracts with confidence=high, that counts as
// confirmation.
// ─────────────────────────────────────────────

describe('KAN-1201 L3 — HIGH confidence on proposed dim → implicit confirmation', () => {
  it('upgrades proposed → confirmed when operator continues with refined detail', async () => {
    const { handleChatTurn } = (await import(
      orchestratorSpec
    )) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const stateWithProposed: ConversationState = {
        ...productCampaignSeed(),
        product: { kind: 'proposed', value: 'Growth Platform', confidence: 'medium' },
      };
      const llm = llmQueue([md('product', 'Growth Platform Pro tier')]);

      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        {
          tenantId: tenant.id,
          message: 'specifically the Pro tier',
          state: stateWithProposed,
        },
        TODAY,
      );

      // HIGH confidence upgrades the proposed dim → confirmed (multi-dim path).
      expect(result.kind).toBe('dimensions_extracted');
      if (result.kind === 'dimensions_extracted') {
        expect(result.state.product.kind).toBe('confirmed');
      }
    });
  });
});

// ─────────────────────────────────────────────
// Scenario 4 — L4 preserved: MEDIUM → proposed (operator must explicitly confirm).
//
// Q-ADD C5 doctrine: "medium → explicit operator confirmation prompt before
// transition". This is the CURRENT (pre-KAN-1201) behavior; preserving it
// ensures the surgical fix didn't accidentally over-rotate to auto-confirm.
// ─────────────────────────────────────────────

describe('KAN-1201 L4 — MEDIUM confidence → propose (no auto-confirm)', () => {
  it('keeps dim in proposed state when LLM returns confidence=medium', async () => {
    const { handleChatTurn } = (await import(
      orchestratorSpec
    )) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      // MEDIUM confidence (0.6–0.85) → propose, not auto-confirm.
      const llm = llmQueue([md('product', 'Some product', 0.7)]);

      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        {
          tenantId: tenant.id,
          message: 'the main thing we sell',
          state: productCampaignSeed(),
        },
        TODAY,
      );

      expect(result.kind).toBe('dimensions_extracted');
      if (result.kind === 'dimensions_extracted') {
        expect(result.state.product.kind).toBe('proposed');
        expect(result.advanced).toContainEqual({ dimensionKey: 'product', kind: 'proposed' });
      }
    });
  });
});

// ─────────────────────────────────────────────
// Scenario 5 — Multi-turn chain: 4 confirmations in sequence reach
// all_dimensions_confirmed (L5 early return).
//
// This is the scenario Fred's PROD session couldn't complete. Pre-KAN-1201
// the loop never broke because no dim ever reached 'confirmed'.
// ─────────────────────────────────────────────

describe('KAN-1201 L5 — full 4-dimension confirmation chain', () => {
  it('drives 4 dimensions to confirmed via consecutive HIGH-confidence extractions', async () => {
    const { handleChatTurn } = (await import(
      orchestratorSpec
    )) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      // KAN-1230 B1 — turns 1–3 advance one dim each via the multi-dim path
      // (≥2 dims undetermined); turn 4 has only audience left → single-dim path.
      const llm = llmQueue([
        // Turn 1 — product (multi-dim)
        md('product', 'Growth Platform'),
        // Turn 2 — objectives (multi-dim)
        md('objectives', { goalType: 'units', goalTarget: 50, goalDescription: '50 subscriptions' }),
        // Turn 3 — timeline (multi-dim)
        md('timeline', { windowStart: '2026-06-16T00:00:00.000Z', windowEnd: '2026-07-31T23:59:59.999Z' }),
        // Turn 4 — audience (last dim → single-dim shape)
        {
          kind: 'extracted',
          value: { field: 'lifecycleStage', op: 'in', values: ['lead'] },
          confidence: 'high',
          aiMessage: 'Got leads as the audience.',
        },
      ]);

      // KAN-1219 G3 — scenario chains 4 dimensions on top of entityType
      // already confirmed (product campaign). G3 added entityType as the
      // FIRST dimension per Q1 lock; this scenario stays focused on the
      // existing product→objectives→timeline→audience chain because the
      // dedicated 5-dim end-to-end coverage lives in the polymorphic
      // integration test added below.
      let state: ConversationState = productCampaignSeed();
      let campaignId: string | undefined;

      const dimensions: DimensionKey[] = [
        'product',
        'objectives',
        'timeline',
        'audience',
      ];
      const messages = [
        'Growth Platform',
        '50 subscriptions',
        'June through July',
        'all our leads',
      ];

      for (let t = 0; t < 4; t++) {
        const result = await handleChatTurn(
          prisma,
          llm,
          STUB_AUDIENCE_COUNT,
          {
            campaignId,
            tenantId: tenant.id,
            message: messages[t],
            state,
          },
          TODAY,
        );

        if (t < 3) {
          // multi-dim path advances dimensions[t] (confirmed) this turn
          expect(result.kind).toBe('dimensions_extracted');
          if (result.kind === 'dimensions_extracted') {
            expect(result.advanced).toContainEqual({ dimensionKey: dimensions[t], kind: 'confirmed' });
            state = result.state;
            campaignId = result.campaignId;
          }
        } else {
          // Turn 4 — only audience left → single-dim path closes the 4-set (L5)
          expect(result.kind).toBe('all_dimensions_confirmed');
          if (result.kind === 'all_dimensions_confirmed') {
            state = result.state;
            for (const d of dimensions) {
              expect(state[d].kind).toBe('confirmed');
            }
          }
        }
      }

      // Verify the Campaign row persisted state transitions correctly.
      // Pre-KAN-1201 this would NEVER reach all-confirmed (loop forever on
      // product). Reaching all-confirmed proves the state machine advances.
      const row = await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId! },
        select: {
          status: true,
          goalProductId: true,
          goalType: true,
          goalTarget: true,
          windowStart: true,
          windowEnd: true,
          audienceConditions: true,
        },
      });
      expect(row.status).toBe('draft');
      expect(row.goalProductId).toBe('Growth Platform');
      expect(row.goalType).toBe('units');
      expect(row.goalTarget).toBe(50);
      expect(row.windowStart).not.toBeNull();
      expect(row.windowEnd).not.toBeNull();
      expect(row.audienceConditions).toEqual({
        field: 'lifecycleStage',
        op: 'in',
        values: ['lead'],
      });
    });
  });
});

// ─────────────────────────────────────────────
// Scenario 6 — Reset mid-conversation preserves turns history + resets state.
//
// X3 reset-turn observability lock from KAN-1187. Confirms the reset path
// still works post-KAN-1201 state-machine changes.
// ─────────────────────────────────────────────

describe('KAN-1201 — reset mid-conversation preserves history', () => {
  it('routes reset intent to reset result kind + leaves operator turn in history', async () => {
    const { handleChatTurn } = (await import(
      orchestratorSpec
    )) as OrchestratorModule;
    await withRollback(async (prisma) => {
      const tenant = await createTenant(prisma);
      const stateWithProposed: ConversationState = {
        ...productCampaignSeed(),
        product: { kind: 'proposed', value: 'Stale Product', confidence: 'medium' },
      };
      const llm = llmQueue([]); // LLM not called on reset

      const result = await handleChatTurn(
        prisma,
        llm,
        STUB_AUDIENCE_COUNT,
        {
          tenantId: tenant.id,
          message: 'start over',
          state: stateWithProposed,
        },
        TODAY,
      );

      expect(result.kind).toBe('reset');
      if (result.kind === 'reset') {
        // KAN-1219 G3 — entityType is also reset to empty (5-dim shape).
        expect(result.state.entityType.kind).toBe('empty');
        expect(result.state.product.kind).toBe('empty');
      }

      // Verify operator + system + AI turns persisted (turn history preserved
      // per X3 lock; only ConversationState resets).
      const turns = await prisma.campaignConversationTurn.findMany({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: 'asc' },
        select: { turnType: true, content: true },
      });
      expect(turns.length).toBeGreaterThanOrEqual(3);
      expect(turns.some((t) => t.turnType === 'operator')).toBe(true);
      expect(turns.some((t) => t.turnType === 'system')).toBe(true);
      expect(turns.some((t) => t.turnType === 'ai')).toBe(true);
    });
  });
});
