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
  };
} {
  const campaignCreate = vi.fn().mockResolvedValue({ id: 'camp-new-1' });
  const campaignUpdate = vi.fn().mockResolvedValue({});
  const turnCreate = vi.fn().mockResolvedValue({});
  const prisma: OrchestratorPrisma = {
    campaign: {
      create: campaignCreate as never,
      update: campaignUpdate as never,
      findFirst: vi.fn().mockResolvedValue(null) as never,
    },
    campaignConversationTurn: {
      create: turnCreate as never,
    },
  };
  return { prisma, spies: { campaignCreate, campaignUpdate, turnCreate } };
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
