/**
 * KAN-796a — Stage Transition Engine tests (Phase 2 epic 3 of 5, sub-cohort a).
 *
 * 19 vitest cases covering: NotFound, terminal short-circuit, all 6
 * BrainActionType branches, advance_stage with valid/missing/invalid
 * targetStageId, close_deal_lost with/without terminal_lost Stage,
 * confidence threshold default + override, tier override, triggeredBy
 * default ('agent') + override, tx atomicity, advance_stage to terminal_won
 * edge case.
 *
 * brain-service mocked via vi.mock per sibling convention. Prisma mocked via
 * hand-rolled vi.fn() per sibling convention.
 *
 * NOTE: tests verify Deal.update writes currentStageId + enteredStageAt only
 * (NO closedAt — dropped in KAN-791 pivot; closure signaled by
 * currentStage.outcomeType + DealStageHistory.transitionedAt).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const evaluateDealStateMock = vi.fn();
vi.mock('../brain-service.js', () => ({
  evaluateDealState: (...args: unknown[]) => evaluateDealStateMock(...args),
}));

import {
  evaluateStageTransition,
  resolveAdvanceTargetStage,
  StageTransitionDealNotFoundError,
} from '../stage-transition-engine.js';

const DEAL_A = 'deal_a';
const PIPELINE_A = 'pipeline_a';
const STAGE_NEW = 'stage_new';
const STAGE_QUALIFIED = 'stage_qualified';
const STAGE_QUOTE_SENT = 'stage_quote_sent';
const STAGE_WON = 'stage_won';
const STAGE_LOST = 'stage_lost';

interface StageFixture {
  id: string;
  name: string;
  order: number;
  outcomeType: 'open' | 'terminal_won' | 'terminal_lost';
}

const DEFAULT_PIPELINE_STAGES: StageFixture[] = [
  { id: STAGE_NEW, name: 'New', order: 0, outcomeType: 'open' },
  { id: STAGE_QUALIFIED, name: 'Qualified', order: 1, outcomeType: 'open' },
  { id: STAGE_QUOTE_SENT, name: 'Quote Sent', order: 2, outcomeType: 'open' },
  { id: STAGE_WON, name: 'Closed Won', order: 3, outcomeType: 'terminal_won' },
  { id: STAGE_LOST, name: 'Closed Lost', order: 4, outcomeType: 'terminal_lost' },
];

interface DealFixtureOpts {
  currentStageId?: string;
  pipelineStages?: StageFixture[];
}

function buildDealFixture(opts: DealFixtureOpts = {}) {
  const stages = opts.pipelineStages ?? DEFAULT_PIPELINE_STAGES;
  const currentStageId = opts.currentStageId ?? STAGE_NEW;
  const currentStage = stages.find((s) => s.id === currentStageId);
  if (!currentStage) throw new Error(`Test fixture: currentStageId ${currentStageId} not in stages`);
  return {
    id: DEAL_A,
    tenantId: 'tenant_a',
    // KAN-963 (slice 2a PR B) — needed for the CustomerLifecycleEvent
    // writer hook on terminal_won.
    contactId: 'contact_a',
    pipelineId: PIPELINE_A,
    currentStageId,
    currentStage,
    pipeline: { id: PIPELINE_A, stages },
  };
}

function buildBrainDecision(overrides: {
  type:
    | 'send_follow_up'
    | 'wait_for_response'
    | 'advance_stage'
    | 'escalate_to_human'
    | 'close_deal_lost'
    | 'no_action';
  confidence?: number;
  targetStageId?: string;
  reasoning?: string;
}) {
  return {
    dealId: DEAL_A,
    evaluatedAt: new Date(),
    currentStateSnapshot: {
      dealStatus: 'open',
      currentStageName: 'New',
      currentStageOutcomeType: 'open',
      daysInCurrentStage: 5,
      engagementCount: 1,
      lastEngagementType: 'email_received',
      lastEngagementClass: 'positive',
      daysSinceLastEngagement: 1,
      moProgressPercent: null,
      pipelineName: 'Default Sales Pipeline',
      pipelineObjectiveType: 'warm_up_lead',
    },
    nextBestAction: {
      type: overrides.type,
      reasoning: overrides.reasoning ?? 'Test decision.',
      ...(overrides.targetStageId && { targetStageId: overrides.targetStageId }),
    },
    confidence: overrides.confidence ?? 0.8,
    modelTier: 'reasoning' as const,
    llmInputTokens: 400,
    llmOutputTokens: 100,
  };
}

interface PrismaMockOpts {
  deal: unknown | null;
}

function makePrismaMock(opts: PrismaMockOpts) {
  const findUniqueDeal = vi.fn(async () => opts.deal);
  const updateDeal = vi.fn(async (args: any) => ({ id: DEAL_A, ...args.data }));
  const createHistory = vi.fn(async () => ({ id: 'dsh_created' }));
  // KAN-963 (slice 2a PR B) — CustomerLifecycleEvent writer hook is
  // POST-COMMIT (decoupled from the stage-transition transaction per
  // Fred's review gate). So these fakes live on `prisma`, NOT inside
  // the $transaction tx. Failures here cannot roll back the stage
  // advance — verified by the test that throws from upsertCustomer
  // and asserts the transition still happened.
  const upsertCustomer = vi.fn(async (args: any) => ({
    id: 'cust_test',
    contactId: args.where.contactId,
    status: args.create?.status ?? args.update?.status ?? 'active',
  }));
  const createLifecycleEvent = vi.fn(async (args: any) => ({
    id: 'cle_test',
    ...args.data,
  }));

  const transaction = vi.fn(async (cb: (tx: any) => Promise<unknown>) => {
    const tx = {
      deal: { update: updateDeal },
      dealStageHistory: { create: createHistory },
    };
    return cb(tx);
  });

  const prisma = {
    deal: { findUnique: findUniqueDeal },
    customer: { upsert: upsertCustomer },
    customerLifecycleEvent: { create: createLifecycleEvent },
    $transaction: transaction,
  } as unknown as PrismaClient;

  return {
    prisma,
    mocks: {
      findUniqueDeal,
      updateDeal,
      createHistory,
      transaction,
      upsertCustomer,
      createLifecycleEvent,
    },
  };
}

beforeEach(() => {
  evaluateDealStateMock.mockReset();
});

// ─────────────────────────────────────────────
// 1. Throws when dealId doesn't exist
// ─────────────────────────────────────────────

describe('evaluateStageTransition — NotFound', () => {
  it('throws StageTransitionDealNotFoundError when dealId does not exist', async () => {
    const { prisma } = makePrismaMock({ deal: null });
    await expect(evaluateStageTransition(prisma, 'missing-deal-id')).rejects.toThrow(
      StageTransitionDealNotFoundError,
    );
    expect(evaluateDealStateMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 2. Already-terminal Deal → skipped, no Brain call
// ─────────────────────────────────────────────

describe('evaluateStageTransition — terminal short-circuit', () => {
  it('Deal already in terminal_won → skipped (already_terminal), no Brain call', async () => {
    const { prisma, mocks } = makePrismaMock({ deal: buildDealFixture({ currentStageId: STAGE_WON }) });
    const result = await evaluateStageTransition(prisma, DEAL_A);
    expect(result.type).toBe('skipped');
    expect(result.reason).toBe('already_terminal');
    expect(evaluateDealStateMock).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('Deal already in terminal_lost → skipped (already_terminal), no Brain call', async () => {
    const { prisma } = makePrismaMock({ deal: buildDealFixture({ currentStageId: STAGE_LOST }) });
    const result = await evaluateStageTransition(prisma, DEAL_A);
    expect(result.type).toBe('skipped');
    expect(result.reason).toBe('already_terminal');
    expect(evaluateDealStateMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 3-6. Brain returns non-transition action types → no_transition
// ─────────────────────────────────────────────

describe('evaluateStageTransition — non-transition Brain actions', () => {
  it.each([
    ['send_follow_up'],
    ['wait_for_response'],
    ['escalate_to_human'],
    ['no_action'],
  ] as const)('Brain returns %s → no_transition (no tx, no DB writes)', async (actionType) => {
    const { prisma, mocks } = makePrismaMock({ deal: buildDealFixture() });
    evaluateDealStateMock.mockResolvedValueOnce(buildBrainDecision({ type: actionType, confidence: 0.9 }));

    const result = await evaluateStageTransition(prisma, DEAL_A);

    expect(result.type).toBe('no_transition');
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.updateDeal).not.toHaveBeenCalled();
    expect(mocks.createHistory).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 7. advance_stage with valid targetStageId → transitioned
// ─────────────────────────────────────────────

describe('evaluateStageTransition — advance_stage with valid targetStageId', () => {
  it('writes Deal.update + DealStageHistory.create with targetStageId from Brain', async () => {
    const { prisma, mocks } = makePrismaMock({ deal: buildDealFixture({ currentStageId: STAGE_NEW }) });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'advance_stage', targetStageId: STAGE_QUOTE_SENT, confidence: 0.85 }),
    );

    const result = await evaluateStageTransition(prisma, DEAL_A);

    expect(result.type).toBe('transitioned');
    expect((result as { fromStageId: string }).fromStageId).toBe(STAGE_NEW);
    expect((result as { toStageId: string }).toStageId).toBe(STAGE_QUOTE_SENT);
    expect((result as { transitionRowId: string }).transitionRowId).toBe('dsh_created');

    // Deal update — currentStageId + enteredStageAt only (NO closedAt — KAN-791 dropped it).
    expect(mocks.updateDeal).toHaveBeenCalledOnce();
    const updateArgs = mocks.updateDeal.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(updateArgs.data.currentStageId).toBe(STAGE_QUOTE_SENT);
    expect(updateArgs.data.enteredStageAt).toBeInstanceOf(Date);
    expect('closedAt' in updateArgs.data).toBe(false);

    // History row written.
    expect(mocks.createHistory).toHaveBeenCalledOnce();
    const histArgs = mocks.createHistory.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(histArgs.data.fromStageId).toBe(STAGE_NEW);
    expect(histArgs.data.toStageId).toBe(STAGE_QUOTE_SENT);
  });
});

// ─────────────────────────────────────────────
// 8. advance_stage with NO targetStageId → next-by-order fallback
// ─────────────────────────────────────────────

describe('evaluateStageTransition — advance_stage default-by-order', () => {
  it('Brain omits targetStageId → falls back to next non-terminal Stage by order', async () => {
    const { prisma, mocks } = makePrismaMock({ deal: buildDealFixture({ currentStageId: STAGE_NEW }) });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'advance_stage', confidence: 0.8 }),
    );

    const result = await evaluateStageTransition(prisma, DEAL_A);

    expect(result.type).toBe('transitioned');
    // STAGE_NEW=0; next open is STAGE_QUALIFIED=1.
    expect((result as { toStageId: string }).toStageId).toBe(STAGE_QUALIFIED);
    expect(mocks.updateDeal).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────
// 9. advance_stage with INVALID targetStageId → next-by-order fallback
// ─────────────────────────────────────────────

describe('evaluateStageTransition — advance_stage invalid target fallback', () => {
  it('Brain provides targetStageId not in Pipeline → falls back to next-by-order', async () => {
    const { prisma } = makePrismaMock({ deal: buildDealFixture({ currentStageId: STAGE_NEW }) });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'advance_stage', targetStageId: 'nonexistent_stage', confidence: 0.8 }),
    );

    const result = await evaluateStageTransition(prisma, DEAL_A);

    expect(result.type).toBe('transitioned');
    expect((result as { toStageId: string }).toStageId).toBe(STAGE_QUALIFIED);
  });

  it('Brain provides targetStageId at EARLIER order, fallback finds no open Stage past current → skipped', async () => {
    // currentStage=QUOTE_SENT (order=2), explicit target=NEW (order=0, earlier — invalid).
    // Fallback: next open Stage with order > 2. Only WON (terminal_won) + LOST (terminal_lost)
    // remain past QUOTE_SENT — neither is open. → fallback returns null → skipped.
    const { prisma, mocks } = makePrismaMock({ deal: buildDealFixture({ currentStageId: STAGE_QUOTE_SENT }) });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'advance_stage', targetStageId: STAGE_NEW, confidence: 0.8 }),
    );

    const result = await evaluateStageTransition(prisma, DEAL_A);

    expect(result.type).toBe('skipped');
    expect(result.reason).toBe('no_target_resolved');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 10. advance_stage but no next non-terminal Stage → skipped
// ─────────────────────────────────────────────

describe('evaluateStageTransition — advance_stage no candidate', () => {
  it('Deal at last open Stage + Brain advance_stage → skipped (no_target_resolved)', async () => {
    const { prisma, mocks } = makePrismaMock({ deal: buildDealFixture({ currentStageId: STAGE_QUOTE_SENT }) });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'advance_stage', confidence: 0.8 }),
    );

    const result = await evaluateStageTransition(prisma, DEAL_A);

    expect(result.type).toBe('skipped');
    expect(result.reason).toBe('no_target_resolved');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 11. close_deal_lost → finds terminal_lost → transitioned (NO closedAt write)
// ─────────────────────────────────────────────

describe('evaluateStageTransition — close_deal_lost', () => {
  it('Brain returns close_deal_lost → finds Pipeline terminal_lost Stage → transition written (NO closedAt — KAN-791)', async () => {
    const { prisma, mocks } = makePrismaMock({ deal: buildDealFixture({ currentStageId: STAGE_NEW }) });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'close_deal_lost', confidence: 0.75 }),
    );

    const result = await evaluateStageTransition(prisma, DEAL_A);

    expect(result.type).toBe('transitioned');
    expect((result as { toStageId: string }).toStageId).toBe(STAGE_LOST);

    // Verify the Deal.update wrote currentStageId + enteredStageAt only (NO closedAt).
    const updateArgs = mocks.updateDeal.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(updateArgs.data.currentStageId).toBe(STAGE_LOST);
    expect(updateArgs.data.enteredStageAt).toBeInstanceOf(Date);
    expect('closedAt' in updateArgs.data).toBe(false);

    // DealStageHistory row captures the transition INTO the terminal Stage.
    // (Closure timestamp queryable via this row's transitionedAt.)
    const histArgs = mocks.createHistory.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(histArgs.data.toStageId).toBe(STAGE_LOST);
    expect((histArgs.data.metadata as Record<string, unknown>).targetStageOutcomeType).toBe('terminal_lost');
  });
});

// ─────────────────────────────────────────────
// 12. close_deal_lost but Pipeline has no terminal_lost Stage → skipped + warn
// ─────────────────────────────────────────────

describe('evaluateStageTransition — close_deal_lost missing terminal Stage', () => {
  it('Pipeline has no terminal_lost Stage → skipped (no_terminal_lost_stage_in_pipeline) + warn logged', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stagesNoLost: StageFixture[] = [
      { id: STAGE_NEW, name: 'New', order: 0, outcomeType: 'open' },
      { id: STAGE_QUALIFIED, name: 'Qualified', order: 1, outcomeType: 'open' },
      { id: STAGE_WON, name: 'Closed Won', order: 2, outcomeType: 'terminal_won' },
      // No terminal_lost.
    ];
    const { prisma, mocks } = makePrismaMock({
      deal: buildDealFixture({ currentStageId: STAGE_NEW, pipelineStages: stagesNoLost }),
    });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'close_deal_lost', confidence: 0.8 }),
    );

    const result = await evaluateStageTransition(prisma, DEAL_A);

    expect(result.type).toBe('skipped');
    expect(result.reason).toBe('no_terminal_lost_stage_in_pipeline');
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0] as string).toContain('no_terminal_lost_stage_in_pipeline');
    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────
// 13. Brain confidence < default threshold (0.5) → no_transition
// ─────────────────────────────────────────────

describe('evaluateStageTransition — confidence threshold (default 0.5)', () => {
  it('Brain confidence below default 0.5 → no_transition, no DB writes', async () => {
    const { prisma, mocks } = makePrismaMock({ deal: buildDealFixture() });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'advance_stage', targetStageId: STAGE_QUALIFIED, confidence: 0.3 }),
    );

    const result = await evaluateStageTransition(prisma, DEAL_A);

    expect(result.type).toBe('no_transition');
    expect(result.reason).toContain('below threshold');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 14. Custom threshold via options → no_transition
// ─────────────────────────────────────────────

describe('evaluateStageTransition — custom confidence threshold', () => {
  it('minConfidenceForTransition=0.9 + Brain confidence=0.7 → no_transition', async () => {
    const { prisma, mocks } = makePrismaMock({ deal: buildDealFixture() });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'advance_stage', targetStageId: STAGE_QUALIFIED, confidence: 0.7 }),
    );

    const result = await evaluateStageTransition(prisma, DEAL_A, { minConfidenceForTransition: 0.9 });

    expect(result.type).toBe('no_transition');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 15. Tier override propagates to Brain Service
// ─────────────────────────────────────────────

describe('evaluateStageTransition — tier propagation', () => {
  it('explicit tier="cheap" forwarded to evaluateDealState', async () => {
    const { prisma } = makePrismaMock({ deal: buildDealFixture() });
    evaluateDealStateMock.mockResolvedValueOnce(buildBrainDecision({ type: 'no_action', confidence: 0.9 }));

    await evaluateStageTransition(prisma, DEAL_A, { tier: 'cheap' });

    const callArgs = evaluateDealStateMock.mock.calls[0]!;
    // (prisma, dealId, options) — options.tier is the 3rd arg's tier field.
    expect((callArgs[2] as { tier: string }).tier).toBe('cheap');
  });

  it('default tier (omitted) leaves Brain Service to apply its own default ("reasoning")', async () => {
    const { prisma } = makePrismaMock({ deal: buildDealFixture() });
    evaluateDealStateMock.mockResolvedValueOnce(buildBrainDecision({ type: 'no_action', confidence: 0.9 }));

    await evaluateStageTransition(prisma, DEAL_A);

    const callArgs = evaluateDealStateMock.mock.calls[0]!;
    // tier may be undefined here; Brain Service applies its own default.
    expect((callArgs[2] as { tier?: string }).tier).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// 16. triggeredBy override propagates to DealStageHistory
// ─────────────────────────────────────────────

describe('evaluateStageTransition — triggeredBy override', () => {
  it('options.triggeredBy="system" lands in DealStageHistory.triggeredBy', async () => {
    const { prisma, mocks } = makePrismaMock({ deal: buildDealFixture({ currentStageId: STAGE_NEW }) });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'advance_stage', targetStageId: STAGE_QUALIFIED, confidence: 0.8 }),
    );

    await evaluateStageTransition(prisma, DEAL_A, { triggeredBy: 'system' });

    const histArgs = mocks.createHistory.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(histArgs.data.triggeredBy).toBe('system');
  });
});

// ─────────────────────────────────────────────
// 17. Atomicity — Deal.update + DealStageHistory.create inside same tx
// ─────────────────────────────────────────────

describe('evaluateStageTransition — transaction atomicity', () => {
  it('Deal.update + DealStageHistory.create both invoked inside the $transaction callback', async () => {
    const { prisma, mocks } = makePrismaMock({ deal: buildDealFixture({ currentStageId: STAGE_NEW }) });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'advance_stage', targetStageId: STAGE_QUALIFIED, confidence: 0.8 }),
    );

    await evaluateStageTransition(prisma, DEAL_A);

    expect(mocks.transaction).toHaveBeenCalledOnce();
    // Both writes happened (the tx callback body called updateDeal + createHistory).
    expect(mocks.updateDeal).toHaveBeenCalledOnce();
    expect(mocks.createHistory).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────
// 18. advance_stage to terminal_won (Brain explicitly targets won-Stage)
// ─────────────────────────────────────────────

describe('evaluateStageTransition — advance_stage to terminal_won (edge)', () => {
  it('Brain advance_stage with targetStageId=terminal_won Stage → transition lands on won Stage (NO closedAt write — KAN-791)', async () => {
    const { prisma, mocks } = makePrismaMock({ deal: buildDealFixture({ currentStageId: STAGE_QUOTE_SENT }) });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'advance_stage', targetStageId: STAGE_WON, confidence: 0.95 }),
    );

    const result = await evaluateStageTransition(prisma, DEAL_A);

    expect(result.type).toBe('transitioned');
    expect((result as { toStageId: string }).toStageId).toBe(STAGE_WON);

    const updateArgs = mocks.updateDeal.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(updateArgs.data.currentStageId).toBe(STAGE_WON);
    expect('closedAt' in updateArgs.data).toBe(false);

    const histArgs = mocks.createHistory.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(histArgs.data.toStageId).toBe(STAGE_WON);
    expect((histArgs.data.metadata as Record<string, unknown>).targetStageOutcomeType).toBe('terminal_won');
  });

  // KAN-963 (slice 2a PR B) — lifecycle hook decoupling.
  // The CustomerLifecycleEvent writer runs POST-COMMIT, fire-and-forget.
  // A failure inside customer.upsert or customerLifecycleEvent.create
  // MUST NOT roll back the Deal stage transition (the audit layer is
  // non-load-bearing; deal-won is the truth-of-record).
  it('KAN-963: customer.upsert FAILURE post-commit does NOT roll back the terminal_won stage transition', async () => {
    const { prisma, mocks } = makePrismaMock({
      deal: buildDealFixture({ currentStageId: STAGE_QUOTE_SENT }),
    });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'advance_stage', targetStageId: STAGE_WON, confidence: 0.95 }),
    );
    // Force the lifecycle write to throw — simulates FK violation, transient
    // DB issue, or any other failure on the audit side. Stage transition
    // must still complete successfully.
    mocks.upsertCustomer.mockRejectedValueOnce(new Error('simulated customer-upsert failure'));

    const result = await evaluateStageTransition(prisma, DEAL_A);

    // Stage advance committed — the truth-of-record event
    expect(result.type).toBe('transitioned');
    expect((result as { toStageId: string }).toStageId).toBe(STAGE_WON);
    expect(mocks.updateDeal).toHaveBeenCalledTimes(1);
    expect(mocks.createHistory).toHaveBeenCalledTimes(1);

    // Audit write was attempted but failed; lifecycle event never wrote.
    // The void/fire-and-forget call may still be in flight after the
    // synchronous return; wait a microtask for it to settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.upsertCustomer).toHaveBeenCalledTimes(1);
    expect(mocks.createLifecycleEvent).not.toHaveBeenCalled();
  });

  it('KAN-963: customerLifecycleEvent.create FAILURE post-commit also does NOT roll back', async () => {
    const { prisma, mocks } = makePrismaMock({
      deal: buildDealFixture({ currentStageId: STAGE_QUOTE_SENT }),
    });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'advance_stage', targetStageId: STAGE_WON, confidence: 0.95 }),
    );
    // Customer upsert succeeds; event create fails. Stage advance must
    // still be committed (Customer row stays — that's the canonical state;
    // only the audit trail is incomplete).
    mocks.createLifecycleEvent.mockRejectedValueOnce(new Error('simulated event-create failure'));

    const result = await evaluateStageTransition(prisma, DEAL_A);
    expect(result.type).toBe('transitioned');
    expect((result as { toStageId: string }).toStageId).toBe(STAGE_WON);

    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.upsertCustomer).toHaveBeenCalledTimes(1);
    expect(mocks.createLifecycleEvent).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────
// 19. triggeredBy default = 'agent' when not provided
// ─────────────────────────────────────────────

describe('evaluateStageTransition — triggeredBy default', () => {
  it('triggeredBy defaults to "agent" when options.triggeredBy not provided', async () => {
    const { prisma, mocks } = makePrismaMock({ deal: buildDealFixture({ currentStageId: STAGE_NEW }) });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'advance_stage', targetStageId: STAGE_QUALIFIED, confidence: 0.8 }),
    );

    await evaluateStageTransition(prisma, DEAL_A); // no triggeredBy override

    const histArgs = mocks.createHistory.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(histArgs.data.triggeredBy).toBe('agent');
  });
});

// ─────────────────────────────────────────────
// resolveAdvanceTargetStage direct unit tests (exported for introspection)
// ─────────────────────────────────────────────

describe('resolveAdvanceTargetStage', () => {
  const buildDeal = (currentStageId: string) => ({
    id: DEAL_A,
    tenantId: 'tenant_a',
    pipelineId: PIPELINE_A,
    currentStageId,
    currentStage: DEFAULT_PIPELINE_STAGES.find((s) => s.id === currentStageId)!,
    pipeline: { id: PIPELINE_A, stages: DEFAULT_PIPELINE_STAGES },
  });

  it('explicit valid targetStageId at greater order → returns it', () => {
    const target = resolveAdvanceTargetStage(buildDeal(STAGE_NEW), STAGE_QUOTE_SENT);
    expect(target?.id).toBe(STAGE_QUOTE_SENT);
  });

  it('explicit terminal target at greater order → returns it (Brain may target terminal directly)', () => {
    const target = resolveAdvanceTargetStage(buildDeal(STAGE_QUOTE_SENT), STAGE_WON);
    expect(target?.id).toBe(STAGE_WON);
  });

  it('no explicit target → returns next open Stage by order', () => {
    const target = resolveAdvanceTargetStage(buildDeal(STAGE_NEW));
    expect(target?.id).toBe(STAGE_QUALIFIED);
  });

  it('no explicit target + at last open Stage → returns null', () => {
    const target = resolveAdvanceTargetStage(buildDeal(STAGE_QUOTE_SENT));
    expect(target).toBeNull();
  });
});

// ─────────────────────────────────────────────
// KAN-834 — engine accepts pre-computed brainDecision (cure double-eval)
//
// Sprint 11-pre Gmail smoke 2026-05-05 16:10:54-16:11:01 UTC: dispatcher
// Brain returned advance_stage; engine's internal Brain re-eval returned
// send_follow_up; engine emitted no_transition; KAN-825 chain skipped;
// customer silence. KAN-834 cures by single-source-of-truthing the call.
// ─────────────────────────────────────────────

describe('evaluateStageTransition — KAN-834 pre-computed brainDecision', () => {
  // ── Test 1 — wire-through: pre-computed decision → engine skips internal Brain call
  it('options.brainDecision provided → engine SKIPS internal evaluateDealState call (single Brain call per inbound)', async () => {
    const { prisma } = makePrismaMock({ deal: buildDealFixture() });
    const preComputed = buildBrainDecision({ type: 'advance_stage', confidence: 0.82 });

    await evaluateStageTransition(prisma, DEAL_A, { brainDecision: preComputed });

    // Critical: zero internal Brain calls when pre-computed decision supplied
    expect(evaluateDealStateMock).not.toHaveBeenCalled();
  });

  // ── Test 2 — backwards compat: no brainDecision → falls back to internal call
  it('no options.brainDecision → engine falls back to internal evaluateDealState (cron / operator caller compat)', async () => {
    const { prisma } = makePrismaMock({ deal: buildDealFixture() });
    evaluateDealStateMock.mockResolvedValueOnce(buildBrainDecision({ type: 'wait_for_response' }));

    await evaluateStageTransition(prisma, DEAL_A);

    expect(evaluateDealStateMock).toHaveBeenCalledOnce();
  });

  // ── Test 3 — cure verification: pre-computed advance_stage transitions successfully
  it('pre-computed advance_stage → engine transitions stage successfully (no second-Brain disagreement)', async () => {
    const { prisma, mocks } = makePrismaMock({ deal: buildDealFixture() });
    const preComputed = buildBrainDecision({ type: 'advance_stage', confidence: 0.82 });

    const result = await evaluateStageTransition(prisma, DEAL_A, {
      brainDecision: preComputed,
    });

    expect(result.type).toBe('transitioned');
    if (result.type === 'transitioned') {
      expect(result.toStageId).toBe(STAGE_QUALIFIED); // default-by-order from STAGE_NEW
      expect(result.brainDecision).toBe(preComputed); // verbatim
    }
    // Stage transition write happened
    expect(mocks.updateDeal).toHaveBeenCalledOnce();
    expect(mocks.createHistory).toHaveBeenCalledOnce();
    // Brain only called once (the dispatcher's call, which produced preComputed)
    expect(evaluateDealStateMock).not.toHaveBeenCalled();
  });

  // ── Test 4 — terminal-stage short-circuit fires BEFORE Brain regardless
  it('terminal-stage short-circuit fires BEFORE Brain even when pre-computed decision supplied (closure-state safety)', async () => {
    const { prisma } = makePrismaMock({ deal: buildDealFixture({ currentStageId: STAGE_WON }) });
    const preComputed = buildBrainDecision({ type: 'advance_stage' });

    const result = await evaluateStageTransition(prisma, DEAL_A, {
      brainDecision: preComputed,
    });

    expect(result.type).toBe('skipped');
    if (result.type === 'skipped') {
      expect(result.reason).toBe('already_terminal');
    }
    // Pre-computed decision irrelevant — terminal short-circuit wins
    expect(evaluateDealStateMock).not.toHaveBeenCalled();
  });

  // ── Test 5 — sentinel-token field-name pin: brainDecision flows verbatim into transition write metadata
  it('sentinel-token pin: pre-computed brainDecision flows verbatim into transition write metadata', async () => {
    const { prisma, mocks } = makePrismaMock({ deal: buildDealFixture() });
    const sentinelReasoning = 'KAN-834-sentinel-token-pin-reasoning-abc123';
    const preComputed = buildBrainDecision({
      type: 'advance_stage',
      confidence: 0.82,
      reasoning: sentinelReasoning,
    });

    await evaluateStageTransition(prisma, DEAL_A, { brainDecision: preComputed });

    const dshArgs = mocks.createHistory.mock.calls[0]![0] as {
      data: { metadata: { brainReasoning: string; brainConfidence: number } };
    };
    expect(dshArgs.data.metadata.brainReasoning).toBe(sentinelReasoning);
    expect(dshArgs.data.metadata.brainConfidence).toBe(0.82);
  });

  // ── Test 6 — determinism guarantee: pre-computed path doesn't get bitten by LLM non-determinism
  it('determinism guarantee: even if internal-call mock would return a DIFFERENT decision, pre-computed path is honored', async () => {
    // Setup: queue a HYPOTHETICAL second-call response that DISAGREES with
    // the pre-computed decision (simulates the LLM-non-determinism class
    // bug from 2026-05-05 Gmail smoke). The engine MUST NOT reach this
    // mock — pre-computed wins.
    const { prisma } = makePrismaMock({ deal: buildDealFixture() });
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', confidence: 0.85 }),
    );
    const preComputed = buildBrainDecision({ type: 'advance_stage', confidence: 0.82 });

    const result = await evaluateStageTransition(prisma, DEAL_A, {
      brainDecision: preComputed,
    });

    // Pre-computed decision honored; engine transitions per advance_stage
    expect(result.type).toBe('transitioned');
    // The load-bearing assertion: engine did NOT consult the disagreeing
    // internal-call mock. This is the structural cure.
    expect(evaluateDealStateMock).not.toHaveBeenCalled();
  });
});
