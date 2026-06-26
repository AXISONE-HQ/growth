/**
 * KAN-1184 — Conversational orchestrator unit tests.
 *
 * SPO-locked coverage scope:
 *   - 3 confidence-level routes (high/medium/low)
 *   - 4 dimensions transition correctly (Product → Objectives → Timeline → Audience)
 *   - Reset semantics (intent confirmation + system turn write)
 *   - Persistence assertions (every turn writes to CampaignConversationTurn)
 *   - Tier selection heuristic (each branch tested)
 *   - Edge: empty message rejected by Zod (covered at tRPC; not unit-testable here)
 *   - Edge: LLM returns malformed JSON → graceful degradation to clarification
 *
 * Mocks: prisma + llm + audienceCount injected via dependency-injection
 * pattern; pure-function helpers tested directly without injection.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  handleChatTurn,
  nextDimensionToExtract,
  selectTier,
  isResetIntent,
  parseDimensionExtraction,
  buildExtractionPrompt,
  buildMultiDimExtractionPrompt,
  reconcileCommittedTargetState,
  resolveRelativeDate,
  undeterminedDimensions,
  type OrchestratorPrisma,
  type LLMCompleteFn,
  type AudienceCountFn,
} from '../conversational-orchestrator.js';
import {
  emptyConversationState,
  type ConversationState,
} from '@growth/shared';

// ─────────────────────────────────────────────
// Helper factories
// ─────────────────────────────────────────────

function makePrismaMock(): {
  prisma: OrchestratorPrisma;
  spies: {
    campaignCreate: ReturnType<typeof vi.fn>;
    campaignUpdate: ReturnType<typeof vi.fn>;
    turnCreate: ReturnType<typeof vi.fn>;
    auditCreate: ReturnType<typeof vi.fn>;
  };
} {
  const campaignCreate = vi.fn().mockResolvedValue({ id: 'camp-new-1' });
  const campaignUpdate = vi.fn().mockResolvedValue({});
  const turnCreate = vi.fn().mockResolvedValue({});
  const auditCreate = vi.fn().mockResolvedValue({});
  const prisma: OrchestratorPrisma = {
    campaign: {
      create: campaignCreate as never,
      update: campaignUpdate as never,
      findFirst: vi.fn().mockResolvedValue(null) as never,
    },
    campaignConversationTurn: {
      create: turnCreate as never,
    },
    auditLog: {
      create: auditCreate as never,
    },
  };
  return {
    prisma,
    spies: { campaignCreate, campaignUpdate, turnCreate, auditCreate },
  };
}

function makeLlm(text: string): LLMCompleteFn {
  return vi.fn().mockResolvedValue({
    text,
    model: 'claude-sonnet-4-6',
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 800,
  }) as unknown as LLMCompleteFn;
}

function makeAudienceCount(count = 1247): AudienceCountFn {
  return vi.fn().mockResolvedValue({
    count,
    isThin: false,
    historicalValueUsd: 0,
  }) as unknown as AudienceCountFn;
}

// ─────────────────────────────────────────────
// Pure function tests — no LLM, no prisma
// ─────────────────────────────────────────────

describe('KAN-1184 / KAN-1219 G3 — nextDimensionToExtract', () => {
  it('empty state → entityType (first dimension per Q1 lock)', () => {
    expect(nextDimensionToExtract(emptyConversationState())).toBe('entityType');
  });

  it('entityType confirmed (product) → product', () => {
    const state: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: 'confirmed', value: 'product' },
    };
    expect(nextDimensionToExtract(state)).toBe('product');
  });

  it('entityType + product confirmed → objectives', () => {
    const state: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: 'confirmed', value: 'product' },
      product: { kind: 'confirmed', value: 'ABC' },
    };
    expect(nextDimensionToExtract(state)).toBe('objectives');
  });

  it('entityType + product + objectives confirmed → timeline', () => {
    const state: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: 'confirmed', value: 'product' },
      product: { kind: 'confirmed', value: 'ABC' },
      objectives: { kind: 'confirmed', value: { goalType: 'deals', goalTarget: 50 } },
    };
    expect(nextDimensionToExtract(state)).toBe('timeline');
  });

  it('entityType + product + objectives + timeline confirmed → audience (product campaign)', () => {
    const state: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: 'confirmed', value: 'product' },
      product: { kind: 'confirmed', value: 'ABC' },
      objectives: { kind: 'confirmed', value: { goalType: 'deals', goalTarget: 50 } },
      timeline: { kind: 'confirmed', value: { windowStart: '2026-07-01', windowEnd: '2026-09-30' } },
    };
    expect(nextDimensionToExtract(state)).toBe('audience');
  });

  it('vehicle campaign skips audience per Q3 lock — timeline confirmed → null', () => {
    const state: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: 'confirmed', value: 'vehicle' },
      product: { kind: 'confirmed', value: { year: 2023, bodyStyle: 'suv' } },
      objectives: { kind: 'confirmed', value: { goalType: 'units', goalTarget: 4 } },
      timeline: { kind: 'confirmed', value: { windowStart: '2026-07-01', windowEnd: '2026-09-30' } },
    };
    expect(nextDimensionToExtract(state)).toBeNull();
  });

  it('all 5 confirmed (product campaign) → null (hand off to Action Plan generator)', () => {
    const state: ConversationState = {
      entityType: { kind: 'confirmed', value: 'product' },
      product: { kind: 'confirmed', value: 'ABC' },
      objectives: { kind: 'confirmed', value: {} },
      timeline: { kind: 'confirmed', value: {} },
      audience: { kind: 'confirmed', value: {} },
    };
    expect(nextDimensionToExtract(state)).toBeNull();
  });

  it('proposed state does NOT count as confirmed — first-Empty-wins includes Proposed', () => {
    const state: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: 'proposed', value: 'product', confidence: 'high' },
    };
    // First non-confirmed wins; entityType is proposed-not-confirmed → still entityType
    expect(nextDimensionToExtract(state)).toBe('entityType');
  });
});

describe('KAN-1184 — selectTier (Q-ADD C1 hybrid heuristic)', () => {
  const state = emptyConversationState();

  it('message > 50 chars → reasoning', () => {
    const msg = 'I want to sell 50 units of our flagship product by end of next quarter';
    expect(selectTier(msg, state)).toBe('reasoning');
  });

  it('message contains ? → reasoning (operator asking back)', () => {
    expect(selectTier('what about timing?', state)).toBe('reasoning');
  });

  it('short confirmation "yes" → cheap', () => {
    expect(selectTier('yes', state)).toBe('cheap');
  });

  it('short confirmation "ok" → cheap', () => {
    expect(selectTier('ok', state)).toBe('cheap');
  });

  it('short confirmation "yep" → cheap', () => {
    expect(selectTier('yep', state)).toBe('cheap');
  });

  it('short non-confirmation defaults to reasoning', () => {
    expect(selectTier('hmm let me see', state)).toBe('reasoning');
  });

  it('multiple proposed dimensions → reasoning', () => {
    const multiProposed: ConversationState = {
      ...emptyConversationState(),
      product: { kind: 'proposed', value: 'A', confidence: 'medium' },
      objectives: { kind: 'proposed', value: {}, confidence: 'medium' },
    };
    expect(selectTier('yes', multiProposed)).toBe('reasoning');
  });
});

describe('KAN-1184 — isResetIntent (Q-ADD C6 conservative classifier)', () => {
  it('"start over" → reset intent', () => {
    expect(isResetIntent('start over')).toBe(true);
  });

  it('"reset" → reset intent', () => {
    expect(isResetIntent('reset')).toBe(true);
  });

  it('"let me try again" → reset intent', () => {
    expect(isResetIntent('let me try again')).toBe(true);
  });

  it('"restart" → reset intent', () => {
    expect(isResetIntent('restart')).toBe(true);
  });

  it('"let me think again" → NOT reset (ambiguous; should not trigger)', () => {
    expect(isResetIntent('let me think again')).toBe(false);
  });

  it('case insensitive — "Start Over" → reset', () => {
    expect(isResetIntent('Start Over')).toBe(true);
  });

  it('embedded mention — "I will start over later" → NOT reset (anchored to start of message)', () => {
    expect(isResetIntent('I will start over later')).toBe(false);
  });
});

describe('KAN-1184 — parseDimensionExtraction (LLM output robustness)', () => {
  it('valid high-confidence extraction → kind=extracted', () => {
    const out = parseDimensionExtraction(
      JSON.stringify({
        kind: 'extracted',
        value: 'Product ABC',
        confidence: 'high',
        aiMessage: 'Got it — Product ABC.',
      }),
      'product',
    );
    expect(out.kind).toBe('extracted');
    if (out.kind === 'extracted') {
      expect(out.value).toBe('Product ABC');
      expect(out.confidence).toBe('high');
    }
  });

  it('low confidence → clarification (Q-ADD C5 lock)', () => {
    const out = parseDimensionExtraction(
      JSON.stringify({
        kind: 'extracted',
        value: 'unclear',
        confidence: 'low',
        aiMessage: 'Could you tell me more about which product?',
      }),
      'product',
    );
    expect(out.kind).toBe('clarification');
  });

  it('invalid confidence → clarification (defensive)', () => {
    const out = parseDimensionExtraction(
      JSON.stringify({
        kind: 'extracted',
        value: 'x',
        confidence: 'bogus',
      }),
      'product',
    );
    expect(out.kind).toBe('clarification');
  });

  it('malformed JSON → graceful clarification', () => {
    const out = parseDimensionExtraction(
      'not even JSON',
      'product',
    );
    expect(out.kind).toBe('clarification');
  });

  it('markdown-fenced JSON is unwrapped', () => {
    const out = parseDimensionExtraction(
      '```json\n{"kind":"extracted","value":"X","confidence":"high","aiMessage":"ok"}\n```',
      'product',
    );
    expect(out.kind).toBe('extracted');
  });

  it('kind=clarification passes through with message', () => {
    const out = parseDimensionExtraction(
      JSON.stringify({
        kind: 'clarification',
        aiMessage: 'Which product specifically?',
      }),
      'product',
    );
    expect(out.kind).toBe('clarification');
    if (out.kind === 'clarification') {
      expect(out.aiMessage).toContain('Which product');
    }
  });
});

describe('KAN-1184 — buildExtractionPrompt (Step 3 locks)', () => {
  it('includes the doctrine preamble', () => {
    const prompt = buildExtractionPrompt('product', emptyConversationState(), new Date('2026-06-15T00:00:00Z'));
    expect(prompt).toMatch(/operator-honest/i);
    expect(prompt).toMatch(/no euphemism/i);
  });

  it('includes current state JSON', () => {
    const prompt = buildExtractionPrompt('objectives', emptyConversationState(), new Date('2026-06-15T00:00:00Z'));
    expect(prompt).toMatch(/Current 4-dimension capture state/);
    expect(prompt).toMatch(/"entityType"/);
    expect(prompt).toMatch(/"product"/);
  });

  it('includes target dimension descriptor', () => {
    const prompt = buildExtractionPrompt('audience', emptyConversationState(), new Date('2026-06-15T00:00:00Z'));
    expect(prompt).toMatch(/Target dimension to extract: audience/);
  });

  it('includes audience vocabulary only when dim === audience', () => {
    const productPrompt = buildExtractionPrompt('product', emptyConversationState(), new Date('2026-06-15T00:00:00Z'));
    expect(productPrompt).not.toMatch(/orders\.placedAt/);
    const audiencePrompt = buildExtractionPrompt('audience', emptyConversationState(), new Date('2026-06-15T00:00:00Z'));
    expect(audiencePrompt).toMatch(/orders\.placedAt/);
    expect(audiencePrompt).toMatch(/orders\.refundedAt/);
  });

  it('includes todayUtc for date-aware extraction', () => {
    const today = new Date('2026-06-15T12:00:00Z');
    const prompt = buildExtractionPrompt('timeline', emptyConversationState(), today);
    expect(prompt).toMatch(/2026-06-15/);
  });

  it('KAN-1219 G3 — entityType dim emits operator-honest classifier prompt', () => {
    const prompt = buildExtractionPrompt(
      'entityType',
      emptyConversationState(),
      new Date('2026-06-15T00:00:00Z'),
    );
    expect(prompt).toMatch(/Target dimension to extract: entityType/);
    expect(prompt).toMatch(/"product" or "vehicle"/);
    expect(prompt).toMatch(/dealer inventory/i);
  });

  it('KAN-1219 G3 — product dim renders vehicle prompt example when entityType=vehicle', () => {
    const vehicleState: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: 'confirmed', value: 'vehicle' },
    };
    const prompt = buildExtractionPrompt(
      'product',
      vehicleState,
      new Date('2026-06-15T00:00:00Z'),
    );
    expect(prompt).toMatch(/bodyStyle/);
    expect(prompt).toMatch(/vinHints/);
    expect(prompt).toMatch(/year.*make.*model/i);
  });

  it('KAN-1219 G3 — product dim renders catalog product example when entityType=product', () => {
    const productState: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: 'confirmed', value: 'product' },
    };
    const prompt = buildExtractionPrompt(
      'product',
      productState,
      new Date('2026-06-15T00:00:00Z'),
    );
    expect(prompt).toMatch(/product\/offering name/);
    expect(prompt).not.toMatch(/bodyStyle/);
  });
});

// ─────────────────────────────────────────────
// handleChatTurn integration (mocked deps)
// ─────────────────────────────────────────────

describe('KAN-1184 — handleChatTurn (full state-machine integration)', () => {
  it('first turn (no campaignId) creates Draft Campaign + persists operator + AI turns', async () => {
    const { prisma, spies } = makePrismaMock();
    const llm = makeLlm(
      JSON.stringify({
        kind: 'extracted',
        value: 'Product ABC',
        confidence: 'high',
        aiMessage: 'Got it — Product ABC.',
      }),
    );
    const audience = makeAudienceCount();

    // KAN-1219 Slice G3 — entityType is the first dimension extracted per Q1
    // lock; this scenario tests the 'product' extraction step so the
    // operator-confirmed entityType='product' precondition is wired in.
    const entityTypeConfirmed: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: 'confirmed', value: 'product' },
    };
    const result = await handleChatTurn(prisma, llm, audience, {
      tenantId: 'tenant-1',
      message: 'I want to sell Product ABC',
      state: entityTypeConfirmed,
    });

    expect(spies.campaignCreate).toHaveBeenCalledTimes(1);
    // Operator turn + AI turn persisted = 2 calls
    expect(spies.turnCreate.mock.calls.length).toBeGreaterThanOrEqual(2);
    // KAN-1201 L2 — confidence=high + prior kind=empty → auto-confirm.
    // Pre-KAN-1201 this returned 'dimension_proposed' (which encoded the
    // state-machine bug as expected behavior; the test passed because the
    // assertion matched the broken hardcoded `kind:'proposed'` at the orchestrator's
    // build-state line). Q-ADD C5 docstring (lines 12-19) explicitly said
    // `high → auto-transition`; KAN-1201 wires the missing transition.
    expect(result.kind).toBe('dimension_confirmed');
  });

  it('reset intent → kind=reset; ConversationState resets to all-empty', async () => {
    const { prisma, spies } = makePrismaMock();
    const llm = makeLlm('{"kind":"extracted","value":"x","confidence":"high","aiMessage":"ok"}');
    const audience = makeAudienceCount();
    const someConfirmed: ConversationState = {
      ...emptyConversationState(),
      product: { kind: 'confirmed', value: 'ABC' },
    };

    const result = await handleChatTurn(prisma, llm, audience, {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'start over',
      state: someConfirmed,
    });

    expect(result.kind).toBe('reset');
    if (result.kind === 'reset') {
      // All 5 dimensions reset to empty (KAN-1219 G3 — entityType included)
      expect(result.state.entityType.kind).toBe('empty');
      expect(result.state.product.kind).toBe('empty');
      expect(result.state.objectives.kind).toBe('empty');
      expect(result.state.timeline.kind).toBe('empty');
      expect(result.state.audience.kind).toBe('empty');
    }
    // Operator turn + system turn + AI turn = 3 turn writes minimum
    expect(spies.turnCreate.mock.calls.length).toBeGreaterThanOrEqual(3);
    // System turn written
    const systemTurnCall = spies.turnCreate.mock.calls.find(
      (c) => (c[0] as { data: { turnType: string } }).data.turnType === 'system',
    );
    expect(systemTurnCall).toBeDefined();
  });

  it('all 5 dimensions already confirmed → kind=all_dimensions_confirmed (no LLM call)', async () => {
    const { prisma } = makePrismaMock();
    const llm = makeLlm('should not be called');
    const audience = makeAudienceCount();
    const allConfirmed: ConversationState = {
      entityType: { kind: 'confirmed', value: 'product' },
      product: { kind: 'confirmed', value: 'ABC' },
      objectives: { kind: 'confirmed', value: { goalType: 'deals', goalTarget: 50 } },
      timeline: { kind: 'confirmed', value: { windowStart: '2026-07-01', windowEnd: '2026-09-30' } },
      audience: { kind: 'confirmed', value: { field: 'country', op: 'in', values: ['CA'] } },
    };

    const result = await handleChatTurn(prisma, llm, audience, {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'looks good',
      state: allConfirmed,
    });

    expect(result.kind).toBe('all_dimensions_confirmed');
    // LLM NOT called when all dimensions confirmed
    expect(llm).not.toHaveBeenCalled();
  });

  it('audience dimension surfaces concrete count (Q-ADD C4 inline composition)', async () => {
    const { prisma } = makePrismaMock();
    const llm = makeLlm(
      JSON.stringify({
        kind: 'extracted',
        value: { field: 'country', op: 'in', values: ['CA'] },
        confidence: 'high',
        aiMessage: 'Audience: Canadian contacts.',
      }),
    );
    const audience = makeAudienceCount(1247);
    const tilAudience: ConversationState = {
      entityType: { kind: 'confirmed', value: 'product' },
      product: { kind: 'confirmed', value: 'ABC' },
      objectives: { kind: 'confirmed', value: {} },
      timeline: { kind: 'confirmed', value: {} },
      audience: { kind: 'empty' },
    };

    const result = await handleChatTurn(prisma, llm, audience, {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'Canadian contacts',
      state: tilAudience,
    });

    // KAN-1201 — fixture has product+objectives+timeline already CONFIRMED
    // and audience EMPTY; an LLM response with confidence=high confirms
    // audience (L2), which closes the 4-set → L5 fires all_dimensions_confirmed.
    // Pre-KAN-1201 this asserted `dimension_proposed` because the orchestrator
    // could never reach all-confirmed (hardcoded kind:'proposed' on every
    // extraction). The audience-count annotation persists into the aiMessage
    // regardless of the result kind (annotation is appended before the
    // shouldConfirm branch).
    expect(result.kind).toBe('all_dimensions_confirmed');
    if (result.kind === 'all_dimensions_confirmed') {
      expect(result.aiMessage).toMatch(/1,247 contacts match/);
    }
  });

  it('LLM throws → kind=analyzer_unavailable; operator turn still persisted', async () => {
    const { prisma, spies } = makePrismaMock();
    const llm = vi.fn().mockRejectedValue(new Error('LLM timeout')) as unknown as LLMCompleteFn;
    const audience = makeAudienceCount();

    const result = await handleChatTurn(prisma, llm, audience, {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'I want to sell Product ABC',
      state: emptyConversationState(),
    });

    expect(result.kind).toBe('analyzer_unavailable');
    // Operator turn + analyzer-unavailable AI turn = 2 writes minimum
    expect(spies.turnCreate.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('low-confidence LLM output → kind=clarification; state unchanged', async () => {
    const { prisma } = makePrismaMock();
    const llm = makeLlm(
      JSON.stringify({
        kind: 'extracted',
        value: 'unclear',
        confidence: 'low',
        aiMessage: 'Could you tell me which product specifically?',
      }),
    );
    const audience = makeAudienceCount();

    const result = await handleChatTurn(prisma, llm, audience, {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'something to sell',
      state: emptyConversationState(),
    });

    expect(result.kind).toBe('clarification');
    if (result.kind === 'clarification') {
      // Product dimension still empty (no state advancement)
      expect(result.state.product.kind).toBe('empty');
    }
  });

  it('malformed LLM JSON → graceful clarification turn (Step 7 edge case)', async () => {
    const { prisma } = makePrismaMock();
    const llm = makeLlm('this is not JSON at all');
    const audience = makeAudienceCount();

    const result = await handleChatTurn(prisma, llm, audience, {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'something',
      state: emptyConversationState(),
    });

    expect(result.kind).toBe('clarification');
  });
});

// ─────────────────────────────────────────────
// KAN-1224 Phase A — panel-commit dimension state propagation
//
// Operator pain (KAN-1230): after committing a vehicle via TargetEntityPanel
// (a separate commitTarget mutation), the client-held ConversationState still
// shows product=Pending, so the LLM re-asks "How many CR-Vs?". The orchestrator
// now reconciles against Campaign DB truth so the panel-answered dimensions are
// skipped.
// ─────────────────────────────────────────────

describe('KAN-1224 Phase A — reconcileCommittedTargetState (pure)', () => {
  const committedVehicle = {
    targetEntityType: 'vehicle',
    targetEntityIds: ['veh-1'],
    proposedPlan: {
      vehicleTargetDescriptor: {
        maxCount: 1,
        year: 2007,
        make: 'Honda',
        model: 'CR-V',
        condition: 'used',
      },
    },
  };

  it('no committed target → state returned unchanged', () => {
    const state = emptyConversationState();
    expect(reconcileCommittedTargetState(state, null)).toEqual(state);
    expect(
      reconcileCommittedTargetState(state, {
        targetEntityType: null,
        targetEntityIds: [],
      }),
    ).toEqual(state);
  });

  it('committed vehicle → entityType + product marked confirmed', () => {
    const out = reconcileCommittedTargetState(
      emptyConversationState(),
      committedVehicle,
    );
    expect(out.entityType).toEqual({ kind: 'confirmed', value: 'vehicle' });
    expect(out.product.kind).toBe('confirmed');
    // product value carries the descriptor computed at commit time
    expect(out.product).toMatchObject({
      kind: 'confirmed',
      value: { make: 'Honda', model: 'CR-V', condition: 'used', maxCount: 1 },
    });
    // does NOT touch downstream dimensions
    expect(out.objectives.kind).toBe('empty');
    expect(out.timeline.kind).toBe('empty');
  });

  it('never downgrades a dimension the client already confirmed', () => {
    const state: ConversationState = {
      ...emptyConversationState(),
      product: { kind: 'confirmed', value: { make: 'Toyota' } },
    };
    const out = reconcileCommittedTargetState(state, committedVehicle);
    // client's confirmed product preserved (not overwritten by descriptor)
    expect(out.product).toEqual({ kind: 'confirmed', value: { make: 'Toyota' } });
  });

  it('product mode → product confirmed carries committed entity IDs', () => {
    const out = reconcileCommittedTargetState(emptyConversationState(), {
      targetEntityType: 'product',
      targetEntityIds: ['prod-1', 'prod-2'],
      proposedPlan: null,
    });
    expect(out.entityType).toEqual({ kind: 'confirmed', value: 'product' });
    expect(out.product).toEqual({
      kind: 'confirmed',
      value: { committedEntityIds: ['prod-1', 'prod-2'] },
    });
  });
});

describe('KAN-1224 Phase A — handleChatTurn skips panel-committed product', () => {
  it('committed vehicle target → next extraction is objectives, NOT product', async () => {
    const { prisma } = makePrismaMock();
    // DB truth: operator committed a vehicle via TargetEntityPanel.
    (prisma.campaign.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      targetEntityType: 'vehicle',
      targetEntityIds: ['veh-1'],
      proposedPlan: {
        vehicleTargetDescriptor: { maxCount: 1, make: 'Honda', model: 'CR-V' },
      },
    });
    // Post-reconcile, entityType + product are confirmed → only objectives +
    // timeline remain → KAN-1230 multi-dim path. The prompt must NOT re-ask
    // product (it was reconciled from the panel commit).
    const llm = makeLlm(
      JSON.stringify({
        objectives: {
          extracted: true,
          value: { goalType: 'units', goalTarget: 1, goalDescription: 'Sell the CR-V' },
          confidence: 0.9,
        },
        timeline: { extracted: false, confidence: 0.2 },
      }),
    );
    const audience = makeAudienceCount();

    // Client state is STALE: entityType confirmed (chat) but product still
    // Pending because the panel commit never touched this in-memory state.
    const staleState: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: 'confirmed', value: 'vehicle' },
    };

    const result = await handleChatTurn(prisma, llm, audience, {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'I want to move this car',
      state: staleState,
    });

    // Multi-dim extraction ran for the remaining dims; product was NOT re-asked.
    const firstCall = (llm as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstCall.callerTag).toBe('orchestrator:multidim');
    // The multi-dim prompt only covered the still-undetermined dims (no product).
    expect(firstCall.systemPrompt).not.toContain('### product');
    // Reconciliation confirmed product (self-heals the client on setState).
    if ('state' in result && result.state) {
      expect(result.state.product.kind).toBe('confirmed');
      expect(result.state.objectives.kind).toBe('confirmed');
    }
    if (result.kind === 'dimensions_extracted') {
      expect(result.advanced.map((a) => a.dimensionKey)).not.toContain('product');
    }
  });
});

// ─────────────────────────────────────────────
// KAN-1230 B1 — multi-dimension extraction
//
// One LLM pass extracts several dimensions from a compound operator message.
// Per-dim confidence routes each independently (≥0.85 confirm, 0.6–0.85
// propose, <0.6 skip). entityType resolves first so `product` routes through
// the vehicle normalizer in the same turn (Risk A).
// ─────────────────────────────────────────────

describe('KAN-1230 B1 — multi-dimension extraction', () => {
  const ENTITY_TYPE_FIRST = 'entityType';

  it('"Generate 100 leads by 2026-09-30" → objectives + timeline confirmed in one turn', async () => {
    const { prisma } = makePrismaMock();
    const llm = makeLlm(
      JSON.stringify({
        entityType: { extracted: false, confidence: 0.3 },
        product: { extracted: false, confidence: 0.2 },
        objectives: {
          extracted: true,
          value: { goalType: 'units', goalTarget: 100, goalDescription: 'Generate 100 leads' },
          confidence: 0.9,
        },
        timeline: {
          extracted: true,
          value: { windowStart: '2026-06-23T00:00:00.000Z', windowEnd: '2026-09-30T00:00:00.000Z' },
          confidence: 0.9,
        },
        audience: { extracted: false, confidence: 0.2 },
      }),
    );
    const result = await handleChatTurn(prisma, llm, makeAudienceCount(), {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'Generate 100 leads by 2026-09-30',
      state: emptyConversationState(),
    });

    // multi-dim caller tag proves the multi-dim path ran (not single-dim).
    expect((llm as ReturnType<typeof vi.fn>).mock.calls[0][0].callerTag).toBe('orchestrator:multidim');
    expect(result.kind).toBe('dimensions_extracted');
    if (result.kind !== 'dimensions_extracted') return;
    expect(result.state.objectives.kind).toBe('confirmed');
    expect(result.state.timeline.kind).toBe('confirmed');
    const advancedDims = result.advanced.map((a) => a.dimensionKey).sort();
    expect(advancedDims).toEqual(['objectives', 'timeline']);
  });

  it('Risk A — "Sell 5 Honda CR-Vs": entityType resolves first, product routes through VEHICLE normalizer', async () => {
    const { prisma, spies } = makePrismaMock();
    const llm = makeLlm(
      JSON.stringify({
        entityType: { extracted: true, value: 'vehicle', confidence: 0.95 },
        product: {
          extracted: true,
          value: { make: 'Honda', model: 'CR-V', maxCount: 5 },
          confidence: 0.9,
        },
        objectives: {
          extracted: true,
          value: { goalType: 'units', goalTarget: 5, goalDescription: 'Sell 5 Honda CR-Vs' },
          confidence: 0.88,
        },
        timeline: { extracted: false, confidence: 0.2 },
        audience: { extracted: false, confidence: 0.1 },
      }),
    );
    const result = await handleChatTurn(prisma, llm, makeAudienceCount(), {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'Sell 5 Honda CR-Vs',
      state: emptyConversationState(),
    });

    expect(result.kind).toBe('dimensions_extracted');
    if (result.kind !== 'dimensions_extracted') return;
    expect(result.state.entityType).toEqual({ kind: 'confirmed', value: 'vehicle' });
    expect(result.state.product.kind).toBe('confirmed');
    // 3 dims advanced in one turn
    expect(result.advanced.map((a) => a.dimensionKey).sort()).toEqual(
      ['entityType', 'objectives', 'product'].sort(),
    );

    // LOAD-BEARING Risk A proof: product was persisted to
    // proposedPlan.vehicleTargetDescriptor (the vehicle-normalizer path),
    // NOT to goalProductId (the product passthrough path). If entityType had
    // not resolved first, product would have routed through product-normalizer.
    const planUpdate = spies.campaignUpdate.mock.calls.find(
      (c) => (c[0] as { data?: { proposedPlan?: { vehicleTargetDescriptor?: unknown } } }).data?.proposedPlan?.vehicleTargetDescriptor,
    );
    expect(planUpdate).toBeDefined();
    // KAN-1235 — "Sell 5 …" is goal-context; the echoed maxCount is stripped
    // (== goalTarget, no target-context signal) → target ALL matching CR-Vs.
    const persistedDescriptor = (
      planUpdate?.[0] as {
        data: { proposedPlan: { vehicleTargetDescriptor: Record<string, unknown> } };
      }
    ).data.proposedPlan.vehicleTargetDescriptor;
    expect(persistedDescriptor).toMatchObject({ make: 'Honda', model: 'CR-V' });
    expect(persistedDescriptor.maxCount).toBeUndefined();
    // and NOT persisted as a product (goalProductId)
    const productUpdate = spies.campaignUpdate.mock.calls.find(
      (c) => (c[0] as { data?: { goalProductId?: unknown } }).data?.goalProductId,
    );
    expect(productUpdate).toBeUndefined();
  });

  it('mixed-confidence — "Maybe like 10 leads soon": objectives confirmed, vague timeline skipped (stays Pending)', async () => {
    const { prisma } = makePrismaMock();
    const llm = makeLlm(
      JSON.stringify({
        entityType: { extracted: false, confidence: 0.3 },
        product: { extracted: false, confidence: 0.2 },
        objectives: {
          extracted: true,
          value: { goalType: 'units', goalTarget: 10, goalDescription: '10 leads' },
          confidence: 0.9,
        },
        timeline: {
          extracted: true,
          value: { windowStart: '2026-06-23T00:00:00.000Z', windowEnd: '2026-07-23T00:00:00.000Z' },
          confidence: 0.4,
          reason: "vague 'soon'",
        },
        audience: { extracted: false, confidence: 0.2 },
      }),
    );
    const result = await handleChatTurn(prisma, llm, makeAudienceCount(), {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'Maybe like 10 leads soon',
      state: emptyConversationState(),
    });

    expect(result.kind).toBe('dimensions_extracted');
    if (result.kind !== 'dimensions_extracted') return;
    expect(result.state.objectives.kind).toBe('confirmed');
    // low-confidence timeline skipped — stays Pending, turn does not crash.
    expect(result.state.timeline.kind).toBe('empty');
    expect(result.advanced.map((a) => a.dimensionKey)).toEqual(['objectives']);
  });

  it('multi-audit — emits one campaign.dimension_advanced per confirmed dim', async () => {
    const { prisma, spies } = makePrismaMock();
    const llm = makeLlm(
      JSON.stringify({
        entityType: { extracted: false, confidence: 0.3 },
        product: { extracted: false, confidence: 0.2 },
        objectives: {
          extracted: true,
          value: { goalType: 'units', goalTarget: 100, goalDescription: 'Generate 100 leads' },
          confidence: 0.9,
        },
        timeline: {
          extracted: true,
          value: { windowStart: '2026-06-23T00:00:00.000Z', windowEnd: '2026-09-30T00:00:00.000Z' },
          confidence: 0.9,
        },
        audience: { extracted: false, confidence: 0.2 },
      }),
    );
    await handleChatTurn(prisma, llm, makeAudienceCount(), {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'Generate 100 leads by 2026-09-30',
      state: emptyConversationState(),
    });

    const dimAdvanced = spies.auditCreate.mock.calls.filter(
      (c) => (c[0] as { data: { actionType: string } }).data.actionType === 'campaign.dimension_advanced',
    );
    expect(dimAdvanced).toHaveLength(2);
    const dims = dimAdvanced
      .map((c) => (c[0] as { data: { payload: { dimension: string } } }).data.payload.dimension)
      .sort();
    expect(dims).toEqual(['objectives', 'timeline']);
    // payload shape (Memo 53): action + via for metric attribution
    expect((dimAdvanced[0][0] as { data: { payload: Record<string, unknown> } }).data.payload).toMatchObject({
      action: 'confirm',
      via: 'chat_multidim',
    });
  });

  it('does NOT trigger multi-dim when only one dimension remains (single-dim fallback — Risk B)', async () => {
    const { prisma } = makePrismaMock();
    // entityType + product + objectives + timeline confirmed; only audience left.
    const oneLeft: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: 'confirmed', value: 'product' },
      product: { kind: 'confirmed', value: 'Widget' },
      objectives: { kind: 'confirmed', value: { goalType: 'units', goalTarget: 10, goalDescription: 'x' } },
      timeline: { kind: 'confirmed', value: { windowStart: '2026-06-23T00:00:00.000Z', windowEnd: '2026-07-23T00:00:00.000Z' } },
    };
    const llm = makeLlm(
      JSON.stringify({ kind: 'extracted', value: { field: 'lifecycleStage', op: 'in', values: ['lead'] }, confidence: 'high', aiMessage: 'Audience set.' }),
    );
    await handleChatTurn(prisma, llm, makeAudienceCount(), {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'leads only',
      state: oneLeft,
    });
    // single-dim path → caller tag is the dimension, not multidim.
    expect((llm as ReturnType<typeof vi.fn>).mock.calls[0][0].callerTag).toBe('orchestrator:audience');
    expect(ENTITY_TYPE_FIRST).toBe('entityType');
  });
});

// ─────────────────────────────────────────────
// KAN-1230 B2 — filter targets + relative timeline + audience-prompt fix
//
// Canonical acceptance sentence (Memo 56 #10): "sell 10 used cars by end of
// month" → all 4 dimensions extracted in one turn, audience skipped.
// ─────────────────────────────────────────────

describe('KAN-1230 B2.2 — resolveRelativeDate (UTC)', () => {
  const TODAY = new Date('2026-06-24T12:00:00.000Z'); // Wednesday

  it('"end of month" → last instant of current month', () => {
    expect(resolveRelativeDate('end of month', TODAY)?.toISOString()).toBe('2026-06-30T23:59:59.999Z');
  });
  it('"by end of this month" (embedded) → same', () => {
    expect(resolveRelativeDate('sell them by end of this month', TODAY)?.toISOString()).toBe('2026-06-30T23:59:59.999Z');
  });
  it('"end of Q3" → 2026-09-30', () => {
    expect(resolveRelativeDate('end of Q3', TODAY)?.toISOString()).toBe('2026-09-30T23:59:59.999Z');
  });
  it('"end of quarter" (current = Q2) → 2026-06-30', () => {
    expect(resolveRelativeDate('end of quarter', TODAY)?.toISOString()).toBe('2026-06-30T23:59:59.999Z');
  });
  it('"in 30 days" → today + 30, end of day', () => {
    expect(resolveRelativeDate('in 30 days', TODAY)?.toISOString()).toBe('2026-07-24T23:59:59.999Z');
  });
  it('"next week" → +7 days end of day', () => {
    expect(resolveRelativeDate('next week', TODAY)?.toISOString()).toBe('2026-07-01T23:59:59.999Z');
  });
  it('"next quarter" → first day of Q3', () => {
    expect(resolveRelativeDate('next quarter', TODAY)?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });
  it('"by Friday" → upcoming Friday (2026-06-26)', () => {
    expect(resolveRelativeDate('by Friday', TODAY)?.toISOString()).toBe('2026-06-26T23:59:59.999Z');
  });
  it('unrecognized phrase → null (caller falls back to ISO parse)', () => {
    expect(resolveRelativeDate('whenever we feel like it', TODAY)).toBeNull();
    expect(resolveRelativeDate('2026-09-30T00:00:00.000Z', TODAY)).toBeNull();
  });
});

describe('KAN-1230 B2.5 / KAN-1232 — undeterminedDimensions excludes audience until entityType=product', () => {
  it('empty state (entityType unknown) → audience NOT included', () => {
    expect(undeterminedDimensions(emptyConversationState())).not.toContain('audience');
  });
  it('vehicle campaign → audience NOT included', () => {
    const s: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: 'confirmed', value: 'vehicle' },
    };
    expect(undeterminedDimensions(s)).not.toContain('audience');
  });
  it('confirmed product campaign → audience IS included', () => {
    const s: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: 'confirmed', value: 'product' },
    };
    expect(undeterminedDimensions(s)).toContain('audience');
  });
  it('multi-dim prompt for a vehicle campaign does not list ### audience', () => {
    const s: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: 'confirmed', value: 'vehicle' },
    };
    const prompt = buildMultiDimExtractionPrompt(undeterminedDimensions(s), s, new Date('2026-06-24T00:00:00Z'));
    expect(prompt).not.toContain('### audience');
  });
});

describe('KAN-1230 B2 — "sell 10 used cars by end of month" extracts 4 dims in one turn', () => {
  it('entityType + filter descriptor + objectives + timeline all advance; audience never asked', async () => {
    const { prisma } = makePrismaMock();
    const llm = makeLlm(
      JSON.stringify({
        entityType: { extracted: true, value: 'vehicle', confidence: 0.95 },
        // KAN-1235 — simulate the LLM still echoing the goal number into
        // maxCount; B2 must strip it (goal-vs-target). Post-B1 the LLM should
        // not emit maxCount here at all.
        product: { extracted: true, value: { condition: 'used', maxCount: 10 }, confidence: 0.9 },
        objectives: {
          extracted: true,
          value: { goalType: 'units', goalTarget: 10, goalDescription: 'Sell 10 used cars' },
          confidence: 0.9,
        },
        // B2.2 — relative phrase; server resolves against todayUtc
        timeline: { extracted: true, value: { windowEnd: 'end of month' }, confidence: 0.9 },
      }),
    );
    const result = await handleChatTurn(prisma, llm, makeAudienceCount(), {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'sell 10 used cars by end of month',
      state: emptyConversationState(),
    });

    // Vehicle mode needs only 4 dims (audience skipped) — all confirmed in ONE
    // turn → the canonical 1-turn extraction, ready for Action Plan generation.
    expect(result.kind).toBe('all_dimensions_confirmed');
    if (!('state' in result)) return;
    expect(result.state.entityType).toEqual({ kind: 'confirmed', value: 'vehicle' });
    expect(result.state.product.kind).toBe('confirmed');
    // KAN-1235 — "sell 10" is the GOAL, not a vehicle cap. B2 strips the
    // echoed maxCount (== goalTarget, no target-context signal) → the descriptor
    // targets ALL matching used cars, not first 10.
    expect(result.state.product).toMatchObject({
      kind: 'confirmed',
      value: { condition: 'used' },
    });
    expect(
      (result.state.product.value as Record<string, unknown>).maxCount,
    ).toBeUndefined();
    expect(result.state.objectives.kind).toBe('confirmed');
    expect(result.state.timeline.kind).toBe('confirmed');
    // audience never entered the ask (vehicle mode) — stays empty/skipped
    expect(result.state.audience.kind).toBe('empty');
    // the multi-dim prompt the LLM saw did not mention audience
    expect((llm as ReturnType<typeof vi.fn>).mock.calls[0][0].systemPrompt).not.toContain('### audience');
  });
});

// ─────────────────────────────────────────────
// KAN-1233 — multi-dim product value-shape contract when entityType is
// undetermined. Operator can state entityType + product in one message
// ("sell 10 used cars"); the product contract must offer BOTH the vehicle
// descriptor OBJECT and the product STRING so the LLM binds to the right shape.
// ─────────────────────────────────────────────

describe('KAN-1233 — multi-dim product contract presents both shapes pre-entityType', () => {
  const TODAY = new Date('2026-06-24T00:00:00.000Z');

  it('entityType undetermined → product shape offers vehicle OBJECT + product STRING', () => {
    const dims = undeterminedDimensions(emptyConversationState());
    const prompt = buildMultiDimExtractionPrompt(dims, emptyConversationState(), TODAY);
    // Pull the ### product section
    const productSection = prompt.split('### product')[1]?.split('### ')[0] ?? '';
    expect(productSection).toMatch(/entityType = "vehicle"/);
    expect(productSection).toMatch(/JSON OBJECT/);
    expect(productSection).toMatch(/entityType = "product"/);
    expect(productSection).toMatch(/STRING/);
    // the explicit "10 used cars" → object cue
    expect(productSection).toMatch(/condition.*used.*maxCount/);
  });

  it('confirmed PRODUCT campaign → product shape is the STRING contract only', () => {
    const s: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: 'confirmed', value: 'product' },
    };
    const prompt = buildMultiDimExtractionPrompt(undeterminedDimensions(s), s, TODAY);
    const productSection = prompt.split('### product')[1]?.split('### ')[0] ?? '';
    // Not the dual-shape KAN-1233 block (no "entityType = \"vehicle\"" cue)
    expect(productSection).not.toMatch(/entityType = "vehicle"/);
    expect(productSection).toMatch(/STRING/);
  });
});

// ─────────────────────────────────────────────
// KAN-1235 — goal-vs-target maxCount semantics + refinement affordance.
// ─────────────────────────────────────────────

describe('KAN-1235 — goal vs target maxCount', () => {
  it('B2 — target-context ("promote my 5 BMWs") PRESERVES maxCount', async () => {
    const { prisma } = makePrismaMock();
    const llm = makeLlm(
      JSON.stringify({
        entityType: { extracted: true, value: 'vehicle', confidence: 0.95 },
        product: { extracted: true, value: { make: 'BMW', maxCount: 5 }, confidence: 0.9 },
        // no objectives (promote ≠ a sales goal)
      }),
    );
    const result = await handleChatTurn(prisma, llm, makeAudienceCount(), {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'promote my 5 BMWs',
      state: emptyConversationState(),
    });
    if (!('state' in result)) throw new Error('expected state');
    expect(result.state.product).toMatchObject({
      kind: 'confirmed',
      value: { make: 'BMW', maxCount: 5 },
    });
  });

  it('B3 — broad descriptor ("sell 50 used cars") → refinement invitation', async () => {
    const { prisma } = makePrismaMock();
    const llm = makeLlm(
      JSON.stringify({
        entityType: { extracted: true, value: 'vehicle', confidence: 0.95 },
        // LLM still echoes maxCount; B2 strips it → broad descriptor
        product: { extracted: true, value: { condition: 'used', maxCount: 50 }, confidence: 0.9 },
        objectives: {
          extracted: true,
          value: { goalType: 'units', goalTarget: 50, goalDescription: 'Sell 50 used cars' },
          confidence: 0.9,
        },
      }),
    );
    const result = await handleChatTurn(prisma, llm, makeAudienceCount(), {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'sell 50 used cars',
      state: emptyConversationState(),
    });
    if (!('state' in result)) throw new Error('expected state');
    // maxCount stripped (goal-context)
    expect((result.state.product.value as Record<string, unknown>).maxCount).toBeUndefined();
    // refinement invitation appended (broad descriptor — no make/model)
    expect(result.aiMessage).toMatch(/specific makes or models/i);
  });

  it('B3 — specific descriptor ("sell 10 used Hondas") → NO refinement (would be noise)', async () => {
    const { prisma } = makePrismaMock();
    const llm = makeLlm(
      JSON.stringify({
        entityType: { extracted: true, value: 'vehicle', confidence: 0.95 },
        product: { extracted: true, value: { condition: 'used', make: 'Honda', maxCount: 10 }, confidence: 0.9 },
        objectives: {
          extracted: true,
          value: { goalType: 'units', goalTarget: 10, goalDescription: 'Sell 10 used Hondas' },
          confidence: 0.9,
        },
      }),
    );
    const result = await handleChatTurn(prisma, llm, makeAudienceCount(), {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'sell 10 used Hondas',
      state: emptyConversationState(),
    });
    if (!('state' in result)) throw new Error('expected state');
    // make present → descriptor specific → no refinement noise
    expect(result.aiMessage).not.toMatch(/specific makes or models/i);
    // maxCount still stripped (goal-context, make≠target signal)
    expect((result.state.product.value as Record<string, unknown>).maxCount).toBeUndefined();
    expect((result.state.product.value as Record<string, unknown>).make).toBe('Honda');
  });
});

// ─────────────────────────────────────────────
// KAN-1235b — generic vehicle target with no filter confirms an EMPTY
// descriptor ({} = all matching) instead of leaving product Pending, so the
// panel + scoreboard engage.
// ─────────────────────────────────────────────

describe('KAN-1235b — empty-descriptor confirm for bare "cars"', () => {
  it('"sell 50 cars next month" (no product filter) → product confirms as {} + refinement', async () => {
    const { prisma, spies } = makePrismaMock();
    const llm = makeLlm(
      JSON.stringify({
        entityType: { extracted: true, value: 'vehicle', confidence: 0.95 },
        product: { extracted: false }, // no filter signal in "cars"
        objectives: {
          extracted: true,
          value: { goalType: 'units', goalTarget: 50, goalDescription: 'Sell 50 cars' },
          confidence: 0.9,
        },
        timeline: { extracted: true, value: { windowEnd: 'next month' }, confidence: 0.9 },
      }),
    );
    const result = await handleChatTurn(prisma, llm, makeAudienceCount(), {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'sell 50 cars next month',
      state: emptyConversationState(),
    });
    if (!('state' in result)) throw new Error('expected state');
    // product defaulted to ALL matching (empty descriptor), not left Pending
    expect(result.state.product).toEqual({ kind: 'confirmed', value: {} });
    // refinement invitation fires (broad descriptor)
    expect(result.aiMessage).toMatch(/specific makes or models/i);
    // persisted as an empty vehicleTargetDescriptor
    const planUpdate = spies.campaignUpdate.mock.calls.find(
      (c) =>
        (c[0] as { data?: { proposedPlan?: { vehicleTargetDescriptor?: unknown } } }).data
          ?.proposedPlan?.vehicleTargetDescriptor !== undefined,
    );
    expect(planUpdate).toBeDefined();
    expect(
      (planUpdate?.[0] as { data: { proposedPlan: { vehicleTargetDescriptor: unknown } } }).data
        .proposedPlan.vehicleTargetDescriptor,
    ).toEqual({});
  });

  it('does NOT override a real product proposal (filter present stays as extracted)', async () => {
    const { prisma } = makePrismaMock();
    const llm = makeLlm(
      JSON.stringify({
        entityType: { extracted: true, value: 'vehicle', confidence: 0.95 },
        product: { extracted: true, value: { condition: 'used' }, confidence: 0.9 },
      }),
    );
    const result = await handleChatTurn(prisma, llm, makeAudienceCount(), {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'promote my used cars',
      state: emptyConversationState(),
    });
    if (!('state' in result)) throw new Error('expected state');
    // the extracted filter is preserved (NOT clobbered to {})
    expect(result.state.product).toMatchObject({ kind: 'confirmed', value: { condition: 'used' } });
  });
});

// ─────────────────────────────────────────────
// KAN-1235d — post-confirmation refinement re-extraction. After the vehicle
// product is confirmed, "actually just Hondas" must re-filter (merge make into
// the descriptor), not be swallowed by the all-confirmed early-return.
// ─────────────────────────────────────────────

describe('KAN-1235d — post-confirmation refinement', () => {
  const confirmedVehicleState = (): ConversationState => ({
    entityType: { kind: 'confirmed', value: 'vehicle' },
    product: { kind: 'confirmed', value: { condition: 'used' } },
    objectives: { kind: 'confirmed', value: { goalType: 'units', goalTarget: 50 } },
    timeline: { kind: 'confirmed', value: { windowEnd: '2026-07-31' } },
    audience: { kind: 'empty' },
  });

  it('"actually just Hondas" → merges make:Honda into the confirmed descriptor', async () => {
    const { prisma, spies } = makePrismaMock();
    const llm = makeLlm(
      '{"kind":"extracted","value":{"make":"Honda"},"confidence":"high","aiMessage":"ok"}',
    );
    const result = await handleChatTurn(prisma, llm, makeAudienceCount(), {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'actually just Hondas',
      state: confirmedVehicleState(),
    });
    expect(result.kind).toBe('dimensions_extracted');
    if (!('state' in result)) throw new Error('expected state');
    // merged — existing condition kept, make added
    expect(result.state.product).toEqual({
      kind: 'confirmed',
      value: { condition: 'used', make: 'Honda' },
    });
    expect(result.aiMessage).toMatch(/Honda/);
    // persisted + audited as a refine
    const auditRefine = spies.auditCreate.mock.calls.find(
      (c) => (c[0] as { data?: { payload?: { action?: string } } }).data?.payload?.action === 'refine',
    );
    expect(auditRefine).toBeDefined();
  });

  it('"just confirm" → bare confirmation, NOT a refinement → all-confirmed', async () => {
    const { prisma } = makePrismaMock();
    const llm = makeLlm('{}');
    const result = await handleChatTurn(prisma, llm, makeAudienceCount(), {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'just confirm',
      state: confirmedVehicleState(),
    });
    expect(result.kind).toBe('all_dimensions_confirmed');
  });

  it('"looks good" → no refinement signal → all-confirmed (no re-extraction)', async () => {
    const { prisma } = makePrismaMock();
    const llm = makeLlm('{}');
    const result = await handleChatTurn(prisma, llm, makeAudienceCount(), {
      campaignId: 'camp-1',
      tenantId: 'tenant-1',
      message: 'looks good',
      state: confirmedVehicleState(),
    });
    expect(result.kind).toBe('all_dimensions_confirmed');
  });
});
