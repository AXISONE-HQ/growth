/**
 * KAN-794 — Brain Service tests.
 *
 * 12 tests covering: NotFound, terminal short-circuit, send_follow_up,
 * close_deal_lost, LLM throws, malformed JSON, wrong-shape JSON, snapshot
 * computation, MO progress percent, tier override, idempotency, token
 * propagation.
 *
 * llm-client mocked via vi.mock per sibling convention (lead-normalizer.test.ts).
 * Prisma mocked via hand-rolled vi.fn() per sibling convention
 * (engagement-service.test.ts / kan-705-lead-assignment.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// Mock llm-client BEFORE importing the module under test.
const llmCompleteMock = vi.fn();
vi.mock('../llm-client.js', () => ({
  complete: (...args: unknown[]) => llmCompleteMock(...args),
}));

import {
  evaluateDealState,
  computeMoProgressPercent,
  parseLlmResponse,
  buildEvaluationPrompt,
  BrainServiceNotFoundError,
  type BrainDecision,
} from '../brain-service.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const DEAL_A = 'deal_a';
const CONTACT_A = 'contact_a';
const PIPELINE_A = 'pipeline_a';
const STAGE_NEW = 'stage_new';
const STAGE_QUALIFIED = 'stage_qualified';

interface DealFixtureOverrides {
  enteredStageAt?: Date;
  microObjectiveProgress?: unknown;
  currentStage?: { name: string; outcomeType: 'open' | 'terminal_won' | 'terminal_lost' };
  pipeline?: { name: string; objectiveType: string };
  engagements?: Array<{
    occurredAt: Date;
    engagementType: string;
    signalClass: 'positive' | 'negative' | 'neutral';
    channel?: string | null;
  }>;
  stageHistory?: Array<{
    transitionedAt: Date;
    fromStageId: string | null;
    toStageId: string;
    triggeredBy: string;
  }>;
}

function buildDealFixture(overrides: DealFixtureOverrides = {}): unknown {
  return {
    id: DEAL_A,
    tenantId: TENANT_A,
    contactId: CONTACT_A,
    pipelineId: PIPELINE_A,
    currentStageId: STAGE_NEW,
    enteredStageAt: overrides.enteredStageAt ?? new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    microObjectiveProgress: overrides.microObjectiveProgress ?? {},
    value: 0,
    currency: 'USD',
    correlationId: 'deal:test',
    metadata: {},
    contact: {
      id: CONTACT_A,
      tenantId: TENANT_A,
      email: 'alice@acme.com',
      firstName: 'Alice',
      lastName: 'Smith',
      companyName: 'Acme Inc',
    },
    pipeline: overrides.pipeline ?? { name: 'Default Sales Pipeline', objectiveType: 'warm_up_lead' },
    currentStage: overrides.currentStage ?? { name: 'New', outcomeType: 'open' as const },
    engagements: (overrides.engagements ?? []).map((e, i) => ({
      id: `eng_${i}`,
      tenantId: TENANT_A,
      dealId: DEAL_A,
      contactId: CONTACT_A,
      ...e,
    })),
    stageHistory: (overrides.stageHistory ?? []).map((t, i) => ({
      id: `dsh_${i}`,
      dealId: DEAL_A,
      ...t,
    })),
  };
}

function makePrismaMock(deal: unknown | null) {
  const findUnique = vi.fn(async () => deal);
  const prisma = {
    deal: { findUnique },
  } as unknown as PrismaClient;
  return { prisma, findUnique };
}

function mockLLMOk(payload: Record<string, unknown>, tokens = { input: 450, output: 120 }): void {
  llmCompleteMock.mockResolvedValueOnce({
    text: JSON.stringify(payload),
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    latencyMs: 1234,
    fallbackUsed: false,
  });
}

beforeEach(() => {
  llmCompleteMock.mockReset();
});

// ─────────────────────────────────────────────
// 1. NotFound
// ─────────────────────────────────────────────

describe('evaluateDealState — NotFound', () => {
  it('throws BrainServiceNotFoundError when dealId does not exist', async () => {
    const { prisma } = makePrismaMock(null);
    await expect(evaluateDealState(prisma, 'missing-deal-id')).rejects.toThrow(
      BrainServiceNotFoundError,
    );
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 2. Terminal short-circuit
// ─────────────────────────────────────────────

describe('evaluateDealState — terminal short-circuit', () => {
  it('returns no_action with confidence=1.0 + zero tokens when Stage.outcomeType=terminal_won (no LLM call)', async () => {
    const { prisma } = makePrismaMock(
      buildDealFixture({
        currentStage: { name: 'Closed Won', outcomeType: 'terminal_won' },
      }),
    );

    const decision = await evaluateDealState(prisma, DEAL_A);

    expect(decision.nextBestAction.type).toBe('no_action');
    expect(decision.confidence).toBe(1.0);
    expect(decision.llmInputTokens).toBe(0);
    expect(decision.llmOutputTokens).toBe(0);
    expect(decision.currentStateSnapshot.dealStatus).toBe('closed_won');
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });

  it('also short-circuits on terminal_lost', async () => {
    const { prisma } = makePrismaMock(
      buildDealFixture({
        currentStage: { name: 'Closed Lost', outcomeType: 'terminal_lost' },
      }),
    );

    const decision = await evaluateDealState(prisma, DEAL_A);

    expect(decision.nextBestAction.type).toBe('no_action');
    expect(decision.currentStateSnapshot.dealStatus).toBe('closed_lost');
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 3. Happy path — send_follow_up
// ─────────────────────────────────────────────

describe('evaluateDealState — happy path send_follow_up', () => {
  it('open Deal with positive recent engagement → send_follow_up with channel/tone', async () => {
    const { prisma } = makePrismaMock(
      buildDealFixture({
        engagements: [
          {
            occurredAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
            engagementType: 'email_received',
            signalClass: 'positive',
            channel: 'email',
          },
        ],
      }),
    );
    mockLLMOk({
      nextBestAction: {
        type: 'send_follow_up',
        reasoning: 'Contact replied positively yesterday; strike while warm.',
        suggestedChannel: 'email',
        suggestedTone: 'curious',
        targetStageId: null,
      },
      confidence: 0.82,
    });

    const decision = await evaluateDealState(prisma, DEAL_A);

    expect(decision.nextBestAction.type).toBe('send_follow_up');
    expect(decision.nextBestAction.suggestedChannel).toBe('email');
    expect(decision.nextBestAction.suggestedTone).toBe('curious');
    expect(decision.confidence).toBe(0.82);
    expect(decision.llmInputTokens).toBeGreaterThan(0);
    expect(decision.llmOutputTokens).toBeGreaterThan(0);
    expect(decision.modelTier).toBe('reasoning');
  });
});

// ─────────────────────────────────────────────
// 4. Happy path — close_deal_lost
// ─────────────────────────────────────────────

describe('evaluateDealState — happy path close_deal_lost', () => {
  it('open Deal stalled (no engagement in 30+ days) → close_deal_lost', async () => {
    const { prisma } = makePrismaMock(
      buildDealFixture({
        enteredStageAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
        engagements: [],
      }),
    );
    mockLLMOk({
      nextBestAction: {
        type: 'close_deal_lost',
        reasoning: 'No engagement in 45 days; stalled past nurturing window.',
        suggestedChannel: null,
        suggestedTone: null,
        targetStageId: null,
      },
      confidence: 0.75,
    });

    const decision = await evaluateDealState(prisma, DEAL_A);

    expect(decision.nextBestAction.type).toBe('close_deal_lost');
    expect(decision.confidence).toBe(0.75);
    expect(decision.llmInputTokens).toBeGreaterThan(0);
    expect(decision.llmOutputTokens).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────
// 5. LLM throws → graceful fallback
// ─────────────────────────────────────────────

describe('evaluateDealState — graceful fallback on LLM throw', () => {
  it('LLM throws → no_action + confidence=0 + zero tokens', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    llmCompleteMock.mockRejectedValueOnce(new Error('upstream timeout'));

    const decision = await evaluateDealState(prisma, DEAL_A);

    expect(decision.nextBestAction.type).toBe('no_action');
    expect(decision.confidence).toBe(0);
    expect(decision.llmInputTokens).toBe(0);
    expect(decision.llmOutputTokens).toBe(0);
    expect(decision.nextBestAction.reasoning).toContain('LLM call failed');
  });
});

// ─────────────────────────────────────────────
// 6. Malformed JSON → graceful fallback
// ─────────────────────────────────────────────

describe('evaluateDealState — graceful fallback on malformed JSON', () => {
  it('LLM returns non-JSON garbage → no_action + confidence=0 + zero tokens', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    llmCompleteMock.mockResolvedValueOnce({
      text: 'I think you should send a follow-up email. Definitely.',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 400,
      outputTokens: 30,
      latencyMs: 1000,
      fallbackUsed: false,
    });

    const decision = await evaluateDealState(prisma, DEAL_A);

    expect(decision.nextBestAction.type).toBe('no_action');
    expect(decision.confidence).toBe(0);
    expect(decision.llmInputTokens).toBe(0);
    expect(decision.llmOutputTokens).toBe(0);
  });
});

// ─────────────────────────────────────────────
// 7. Wrong-shape JSON → graceful fallback
// ─────────────────────────────────────────────

describe('evaluateDealState — graceful fallback on wrong-shape JSON', () => {
  it('LLM returns valid JSON but missing nextBestAction → no_action + confidence=0', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    llmCompleteMock.mockResolvedValueOnce({
      text: JSON.stringify({ confidence: 0.7, action: 'send_email' }),
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 400,
      outputTokens: 30,
      latencyMs: 1000,
      fallbackUsed: false,
    });

    const decision = await evaluateDealState(prisma, DEAL_A);

    expect(decision.nextBestAction.type).toBe('no_action');
    expect(decision.confidence).toBe(0);
    expect(decision.llmInputTokens).toBe(0);
    expect(decision.llmOutputTokens).toBe(0);
  });

  it('LLM returns invalid action type → no_action + confidence=0', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    llmCompleteMock.mockResolvedValueOnce({
      text: JSON.stringify({
        nextBestAction: { type: 'send_carrier_pigeon', reasoning: '...' },
        confidence: 0.5,
      }),
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 400,
      outputTokens: 30,
      latencyMs: 1000,
      fallbackUsed: false,
    });

    const decision = await evaluateDealState(prisma, DEAL_A);

    expect(decision.nextBestAction.type).toBe('no_action');
    expect(decision.confidence).toBe(0);
  });
});

// ─────────────────────────────────────────────
// 8. Snapshot fields populated correctly
// ─────────────────────────────────────────────

describe('evaluateDealState — snapshot computation', () => {
  it('snapshot fields populated from Deal + Engagement + Pipeline state', async () => {
    const enteredStageAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const lastEngagementAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const { prisma } = makePrismaMock(
      buildDealFixture({
        enteredStageAt,
        microObjectiveProgress: {
          mo_intro: { completedAt: '2026-04-29T10:00:00Z' },
          mo_qualified: {},
        },
        currentStage: { name: 'Qualified', outcomeType: 'open' },
        pipeline: { name: 'B2B Demo Pipeline', objectiveType: 'book_appointment' },
        engagements: [
          {
            occurredAt: lastEngagementAt,
            engagementType: 'email_reply',
            signalClass: 'positive',
            channel: 'email',
          },
          {
            occurredAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
            engagementType: 'email_open',
            signalClass: 'positive',
            channel: 'email',
          },
        ],
      }),
    );
    mockLLMOk({
      nextBestAction: { type: 'wait_for_response', reasoning: 'Recent engagement; give time.' },
      confidence: 0.6,
    });

    const decision = await evaluateDealState(prisma, DEAL_A);

    expect(decision.currentStateSnapshot).toMatchObject({
      dealStatus: 'open',
      currentStageName: 'Qualified',
      currentStageOutcomeType: 'open',
      daysInCurrentStage: 7,
      engagementCount: 2,
      lastEngagementType: 'email_reply',
      lastEngagementClass: 'positive',
      daysSinceLastEngagement: 2,
      moProgressPercent: 50,
      pipelineName: 'B2B Demo Pipeline',
      pipelineObjectiveType: 'book_appointment',
    });
  });
});

// ─────────────────────────────────────────────
// 9. moProgressPercent computation (unit)
// ─────────────────────────────────────────────

describe('computeMoProgressPercent', () => {
  it('returns null for empty / null / non-object input', () => {
    expect(computeMoProgressPercent(null)).toBeNull();
    expect(computeMoProgressPercent({})).toBeNull();
    expect(computeMoProgressPercent('string')).toBeNull();
    expect(computeMoProgressPercent([])).toBeNull();
  });

  it('returns correct percent for partial completion', () => {
    expect(
      computeMoProgressPercent({
        a: { completedAt: '2026-04-29T00:00:00Z' },
        b: {},
        c: {},
        d: { completedAt: '2026-04-30T00:00:00Z' },
      }),
    ).toBe(50);
  });

  it('returns 100 when all entries have completedAt', () => {
    expect(
      computeMoProgressPercent({
        a: { completedAt: '2026-04-29T00:00:00Z' },
        b: { completedAt: '2026-04-30T00:00:00Z' },
      }),
    ).toBe(100);
  });

  it('returns 0 when no entry has completedAt', () => {
    expect(computeMoProgressPercent({ a: {}, b: {} })).toBe(0);
  });
});

// ─────────────────────────────────────────────
// 10. Tier override propagates
// ─────────────────────────────────────────────

describe('evaluateDealState — tier override', () => {
  it('explicit tier="cheap" propagates to llm-client.complete + BrainDecision.modelTier', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    mockLLMOk({
      nextBestAction: { type: 'wait_for_response', reasoning: 'OK' },
      confidence: 0.5,
    });

    const decision = await evaluateDealState(prisma, DEAL_A, { tier: 'cheap' });

    expect(decision.modelTier).toBe('cheap');
    const callArg = llmCompleteMock.mock.calls[0]![0] as { tier: string; tenantId: string };
    expect(callArg.tier).toBe('cheap');
    // tenantId derived from deal.tenantId per KAN-745 per-tenant cost partition
    expect(callArg.tenantId).toBe(TENANT_A);
  });

  it('default tier is "reasoning" when option omitted', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    mockLLMOk({
      nextBestAction: { type: 'wait_for_response', reasoning: 'OK' },
      confidence: 0.5,
    });

    await evaluateDealState(prisma, DEAL_A);

    const callArg = llmCompleteMock.mock.calls[0]![0] as { tier: string; callerTag: string };
    expect(callArg.tier).toBe('reasoning');
    expect(callArg.callerTag).toBe('brain-service:evaluate-deal-state');
  });
});

// ─────────────────────────────────────────────
// 11. Idempotency
// ─────────────────────────────────────────────

describe('evaluateDealState — idempotency', () => {
  it('same input state + same mocked LLM response → same decision shape (modulo evaluatedAt)', async () => {
    const fixture = buildDealFixture({
      enteredStageAt: new Date('2026-04-25T00:00:00Z'),
      engagements: [
        {
          occurredAt: new Date('2026-04-29T00:00:00Z'),
          engagementType: 'email_received',
          signalClass: 'positive',
          channel: 'email',
        },
      ],
    });

    const llmPayload = {
      nextBestAction: {
        type: 'send_follow_up',
        reasoning: 'Warm contact.',
        suggestedChannel: 'email',
        suggestedTone: 'professional',
      },
      confidence: 0.7,
    };

    const { prisma: prisma1 } = makePrismaMock(fixture);
    mockLLMOk(llmPayload);
    const decision1 = await evaluateDealState(prisma1, DEAL_A);

    const { prisma: prisma2 } = makePrismaMock(fixture);
    mockLLMOk(llmPayload);
    const decision2 = await evaluateDealState(prisma2, DEAL_A);

    // Compare everything except evaluatedAt (always Date.now()).
    const stripDate = (d: BrainDecision) => ({ ...d, evaluatedAt: undefined });
    expect(stripDate(decision1)).toEqual(stripDate(decision2));
  });
});

// ─────────────────────────────────────────────
// 12. Token propagation
// ─────────────────────────────────────────────

describe('evaluateDealState — token propagation', () => {
  it('inputTokens/outputTokens from llm-client.complete propagate to BrainDecision', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    mockLLMOk(
      { nextBestAction: { type: 'wait_for_response', reasoning: 'OK' }, confidence: 0.5 },
      { input: 837, output: 142 },
    );

    const decision = await evaluateDealState(prisma, DEAL_A);

    expect(decision.llmInputTokens).toBe(837);
    expect(decision.llmOutputTokens).toBe(142);
  });
});

// ─────────────────────────────────────────────
// parseLlmResponse direct unit tests (defensive parsing — exported for introspection)
// ─────────────────────────────────────────────

describe('parseLlmResponse', () => {
  it('strips ```json fences', () => {
    const result = parseLlmResponse(
      '```json\n{"nextBestAction":{"type":"no_action","reasoning":"ok"},"confidence":0.5}\n```',
    );
    expect(result.ok).toBe(true);
  });

  it('rejects confidence > 1', () => {
    const result = parseLlmResponse(
      '{"nextBestAction":{"type":"no_action","reasoning":"ok"},"confidence":1.5}',
    );
    expect(result.ok).toBe(false);
  });

  it('rejects empty reasoning', () => {
    const result = parseLlmResponse(
      '{"nextBestAction":{"type":"no_action","reasoning":""},"confidence":0.5}',
    );
    expect(result.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────
// KAN-1042 PR A1 — transition_sub_objective action type + payload
// validation. The new action vocabulary requires a structural payload
// (subObjectiveTransition) carrying the BANT-5 subObjectiveKey + toState +
// value. parseLlmResponse rejects the response on any structural break;
// caller falls back to gracefulFallback (no_action with 0 confidence)
// rather than letting the broken decision flow downstream.
// ─────────────────────────────────────────────

describe('parseLlmResponse — KAN-1042 transition_sub_objective payload', () => {
  it('accepts valid transition_sub_objective with timeline+known+string value', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'transition_sub_objective',
          reasoning: 'Contact replied "looking to start in Q3" — timeline is now known.',
          subObjectiveTransition: {
            subObjectiveKey: 'timeline',
            toState: 'known',
            value: 'Q3 2026',
          },
        },
        confidence: 0.85,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextBestAction.type).toBe('transition_sub_objective');
    expect(result.value.nextBestAction.subObjectiveTransition).toEqual({
      subObjectiveKey: 'timeline',
      toState: 'known',
      value: 'Q3 2026',
    });
  });

  it('accepts valid transition_sub_objective with budget+known+number value', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'transition_sub_objective',
          reasoning: 'Contact stated budget is $50K.',
          subObjectiveTransition: {
            subObjectiveKey: 'budget',
            toState: 'known',
            value: 50000,
          },
        },
        confidence: 0.78,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextBestAction.subObjectiveTransition?.value).toBe(50000);
  });

  it('accepts valid transition_sub_objective with toState=not_applicable + null value', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'transition_sub_objective',
          reasoning: 'Contact noted they have no budget constraint.',
          subObjectiveTransition: {
            subObjectiveKey: 'budget',
            toState: 'not_applicable',
            value: null,
          },
        },
        confidence: 0.7,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextBestAction.subObjectiveTransition?.toState).toBe('not_applicable');
    expect(result.value.nextBestAction.subObjectiveTransition?.value).toBe(null);
  });

  it('rejects transition_sub_objective when subObjectiveTransition payload is missing', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'transition_sub_objective',
          reasoning: 'no payload',
        },
        confidence: 0.6,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('subObjectiveTransition payload missing');
  });

  it('rejects transition_sub_objective with non-BANT-5 subObjectiveKey (vocab discipline)', () => {
    // "crm_used" is OUTSIDE the BANT-5 vocab — the parser MUST reject
    // even if the engine attempts it. Mirrors the router enum clamp at
    // apps/api/src/router.ts:6617. Vocab extension is KAN-1050.
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'transition_sub_objective',
          reasoning: 'Contact uses HubSpot — should transition crm_used.',
          subObjectiveTransition: {
            subObjectiveKey: 'crm_used',
            toState: 'known',
            value: 'HubSpot',
          },
        },
        confidence: 0.8,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('invalid subObjectiveTransition.subObjectiveKey');
    expect(result.error).toContain('BANT-5');
  });

  it('rejects transition_sub_objective with invalid toState', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'transition_sub_objective',
          reasoning: 'bad state',
          subObjectiveTransition: {
            subObjectiveKey: 'timeline',
            toState: 'partial', // not in {known | not_applicable}
            value: 'Q3 2026',
          },
        },
        confidence: 0.7,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('invalid subObjectiveTransition.toState');
  });

  it('rejects toState=known with null value (cross-rule consistency)', () => {
    // Mirrors the service-level guard at sub-objective-gap-tracker.ts:334
    // — toState='known' requires a non-null, non-empty value. Catching
    // here means the dispatcher arm never sees a broken upsert input.
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'transition_sub_objective',
          reasoning: 'known with null value',
          subObjectiveTransition: {
            subObjectiveKey: 'timeline',
            toState: 'known',
            value: null,
          },
        },
        confidence: 0.7,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('value required');
    expect(result.error).toContain('known');
  });

  it('rejects toState=known with empty-string value (cross-rule consistency)', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'transition_sub_objective',
          reasoning: 'known with empty string',
          subObjectiveTransition: {
            subObjectiveKey: 'authority',
            toState: 'known',
            value: '   ', // whitespace-only
          },
        },
        confidence: 0.7,
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects boolean value (router contract is string|number|null)', () => {
    // Boolean is intentionally NOT supported (PRD lock decision #7 — match
    // router enum at apps/api/src/router.ts:6619 exactly). Boolean signals
    // must be cast to enum_value strings at the dispatcher layer.
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'transition_sub_objective',
          reasoning: 'authority is boolean',
          subObjectiveTransition: {
            subObjectiveKey: 'authority',
            toState: 'known',
            value: true,
          },
        },
        confidence: 0.7,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('string | number | null');
  });

  it('drops subObjectiveTransition payload on non-transition action types (defensive)', () => {
    // The engine MAY emit a stray subObjectiveTransition payload on a
    // wrong action type (e.g., send_follow_up with leftover transition
    // payload from a prior decision template). The parser drops it
    // silently — the action type is the source of truth.
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'send_follow_up',
          reasoning: 'follow up with leftover transition payload',
          subObjectiveTransition: {
            subObjectiveKey: 'timeline',
            toState: 'known',
            value: 'Q3 2026',
          },
        },
        confidence: 0.75,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextBestAction.type).toBe('send_follow_up');
    // Payload is intentionally dropped — not load-bearing for send_follow_up.
    expect(result.value.nextBestAction.subObjectiveTransition).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// KAN-825 — buildEvaluationPrompt directive Trigger block
// Sentinel-token contract pin: any rename/removal/conditional drift on
// the literal `## Trigger` block or the `post_stage_advance` enum value
// breaks these tests immediately.
// ─────────────────────────────────────────────

describe('buildEvaluationPrompt — KAN-825 directive Trigger block', () => {
  const baseInput = {
    snapshot: {
      dealStatus: 'open',
      currentStageName: 'Qualified',
      currentStageOutcomeType: 'open',
      daysInCurrentStage: 0,
      engagementCount: 2,
      lastEngagementType: 'email_received',
      lastEngagementClass: 'positive',
      daysSinceLastEngagement: 0,
      moProgressPercent: null,
      pipelineName: 'Default Sales Pipeline',
      pipelineObjectiveType: 'book_appointment',
    },
    contact: {
      id: 'c',
      tenantId: 't',
      email: 'fred@example.com',
      firstName: 'Fred',
      lastName: null,
      companyName: null,
      phone: null,
      currentStageId: null,
      microObjectiveProgress: {},
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never,
    recentEngagements: [],
    recentTransitions: [],
  };

  it('triggerContext=inbound (default) → NO ## Trigger block in prompt (legacy unchanged)', () => {
    const prompt = buildEvaluationPrompt(baseInput);
    expect(prompt).not.toContain('## Trigger');
    expect(prompt).not.toContain('post_stage_advance');
    expect(prompt).not.toContain('Strong preference');
    // Legacy ## Deal context still leads
    expect(prompt.startsWith('## Deal context')).toBe(true);
  });

  it('triggerContext=post_stage_advance → ## Trigger block precedes ## Deal context with directive phrasing', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      triggerContext: 'post_stage_advance',
      postStageAdvance: { fromStageName: 'New', toStageName: 'Qualified' },
    });
    // Block leads
    expect(prompt.startsWith('## Trigger')).toBe(true);
    // Sentinel tokens — these are the contract pins. Any rename breaks here.
    expect(prompt).toContain('## Trigger');
    expect(prompt).toContain('triggerContext=post_stage_advance');
    expect(prompt).toContain('Strong preference: send_follow_up');
    expect(prompt).toContain('silence at this point produces a UX dead-end');
    // Stage names rendered into the directive
    expect(prompt).toContain('from New to Qualified');
    expect(prompt).toContain('NOT yet been notified');
  });

  it('triggerContext=post_stage_advance with missing postStageAdvance → fallback labels rendered (not crash)', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      triggerContext: 'post_stage_advance',
      // No postStageAdvance — render fallbacks
    });
    expect(prompt).toContain('## Trigger');
    // Fallback: '(prior stage)' for from + snapshot's currentStageName for to
    expect(prompt).toContain('(prior stage)');
    expect(prompt).toContain('to Qualified'); // snapshot.currentStageName fallback
  });

  // KAN-835 — sentinel-token pin for post_wait_acknowledgment directive.
  // Three load-bearing literals enforce the directive strength (mirrors
  // KAN-825's evidence that exact phrasing produced chained Brain
  // confidence 0.92).
  it('KAN-835 — triggerContext=post_wait_acknowledgment renders directive Trigger block with all sentinel literals', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      triggerContext: 'post_wait_acknowledgment',
    });
    expect(prompt.startsWith('## Trigger')).toBe(true);
    // Three load-bearing sentinels — any rename breaks loudly.
    expect(prompt).toContain('triggerContext=post_wait_acknowledgment');
    expect(prompt).toContain(
      'Strong preference: send_follow_up with a brief acknowledgment',
    );
    expect(prompt).toContain('silence after the customer engaged produces a UX dead-end');
    // DO NOT-style instructions explicitly bias against wait/advance loops
    expect(prompt).toContain('DO NOT return wait_for_response');
    expect(prompt).toContain('DO NOT return advance_stage');
    // Escalation carve-out present (Sprint 11b handoff)
    expect(prompt).toContain('escalate_to_human');
  });

  it('KAN-835 — post_wait_acknowledgment block does NOT render fromStageName/toStageName (those are post_stage_advance only)', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      triggerContext: 'post_wait_acknowledgment',
      // postStageAdvance present but irrelevant to this trigger context
      postStageAdvance: { fromStageName: 'New', toStageName: 'Qualified' },
    });
    // Stage names only render in the post_stage_advance block.
    expect(prompt).not.toContain('from New to Qualified');
    expect(prompt).not.toContain('post_stage_advance');
    // But IS the post_wait_acknowledgment shape
    expect(prompt).toContain('triggerContext=post_wait_acknowledgment');
  });
});

// ─────────────────────────────────────────────
// KAN-828 — `## Company knowledge` section in Brain prompt
// Sentinel-token pins on chunk_text + source_title per architect spec §3.4
// + KAN-817 / KAN-825 / KAN-835 / KAN-839 contract pin pattern.
// ─────────────────────────────────────────────

describe('buildEvaluationPrompt — KAN-828 Company knowledge section', () => {
  const baseInput = {
    snapshot: {
      dealStatus: 'open',
      currentStageName: 'New',
      currentStageOutcomeType: 'open',
      daysInCurrentStage: 0,
      engagementCount: 1,
      lastEngagementType: 'email_received',
      lastEngagementClass: 'positive',
      daysSinceLastEngagement: 0,
      moProgressPercent: null,
      pipelineName: 'Default Pipeline',
      pipelineObjectiveType: 'book_appointment',
    },
    contact: {
      id: 'c',
      tenantId: 't',
      email: 'fred@example.com',
      firstName: 'Fred',
      lastName: null,
      companyName: null,
      phone: null,
      currentStageId: null,
      microObjectiveProgress: {},
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never,
    recentEngagements: [],
    recentTransitions: [],
  };

  it('Test 1 — KB-tenant + relevant inbound → ## Company knowledge populated with chunk text + source title', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      knowledge: {
        chunks: [
          {
            chunk_id: 'c1',
            source_id: 's1',
            source_title: 'Knowledge Doc',
            category: 'faq',
            chunk_text: 'The Knowledge Layer chunk size is 500 tokens with 50-token overlap.',
            score: 0.91,
          },
        ],
        tenantHasAnyKnowledge: true,
      },
    });
    expect(prompt).toContain('## Company knowledge (relevant to this conversation)');
    expect(prompt).toContain('1. [Knowledge Doc] (faq) — score 0.91');
    expect(prompt).toContain(
      'The Knowledge Layer chunk size is 500 tokens with 50-token overlap.',
    );
  });

  it('Test 2 — no-KB tenant → "(none — no company knowledge configured yet)" empty case 1 verbatim', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      knowledge: { chunks: [], tenantHasAnyKnowledge: false },
    });
    expect(prompt).toContain('## Company knowledge (relevant to this conversation)');
    expect(prompt).toContain('(none — no company knowledge configured yet)');
  });

  it('Test 3 — has-KB tenant + nothing relevant → "(none relevant to this message)" empty case 2 verbatim', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      knowledge: { chunks: [], tenantHasAnyKnowledge: true },
    });
    expect(prompt).toContain('## Company knowledge (relevant to this conversation)');
    expect(prompt).toContain('(none relevant to this message)');
  });

  it('Test 4 — knowledge=null → section omitted from prompt entirely (no inbound to ground against)', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      knowledge: null,
    });
    expect(prompt).not.toContain('## Company knowledge');
    expect(prompt).not.toContain('(none — no company knowledge configured yet)');
    expect(prompt).not.toContain('(none relevant to this message)');
  });

  it('Test 5 — sentinel-token pin: chunk_text + source_title sentinels appear verbatim in rendered prompt', () => {
    const sentinelTitle = 'KAN-828-pin-source-title-token-qrs456';
    const sentinelText = 'KAN-828-pin-chunk-text-token-tuv789 — proves verbatim flow.';
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      knowledge: {
        chunks: [
          {
            chunk_id: 'c1',
            source_id: 's1',
            source_title: sentinelTitle,
            category: 'faq',
            chunk_text: sentinelText,
            score: 0.88,
          },
        ],
        tenantHasAnyKnowledge: true,
      },
    });
    expect(prompt).toContain(sentinelTitle);
    expect(prompt).toContain(sentinelText);
  });

  it('Test 6 — section ordering: Company knowledge appears AFTER Recent stage transitions and BEFORE Decision required', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      knowledge: {
        chunks: [
          {
            chunk_id: 'c1',
            source_id: 's1',
            source_title: 'Doc',
            category: 'faq',
            chunk_text: 'content',
            score: 0.9,
          },
        ],
        tenantHasAnyKnowledge: true,
      },
    });
    const idxTransitions = prompt.indexOf('## Recent stage transitions');
    const idxKnowledge = prompt.indexOf('## Company knowledge');
    const idxDecision = prompt.indexOf('## Decision required');
    expect(idxTransitions).toBeGreaterThan(-1);
    expect(idxKnowledge).toBeGreaterThan(idxTransitions);
    expect(idxDecision).toBeGreaterThan(idxKnowledge);
  });

  it('Test 7 — token budget: 3 chunks at 400-char each + section header stays well under typical Brain prompt budget', () => {
    // 400 chars × 3 chunks = 1200 chars of content + ~100 chars section
    // header + ~50 chars per chunk metadata = ~1450 chars total. ~360
    // tokens at cl100k_base. Well within 1500-token KB cap.
    const longText = 'x'.repeat(500); // > 400 to verify per-chunk truncation
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      knowledge: {
        chunks: [
          { chunk_id: 'c1', source_id: 's1', source_title: 'A', category: 'faq', chunk_text: longText, score: 0.9 },
          { chunk_id: 'c2', source_id: 's1', source_title: 'B', category: 'faq', chunk_text: longText, score: 0.85 },
          { chunk_id: 'c3', source_id: 's1', source_title: 'C', category: 'faq', chunk_text: longText, score: 0.8 },
        ],
        tenantHasAnyKnowledge: true,
      },
    });
    // Per-chunk 400-char truncation enforced
    expect(prompt).toContain('x'.repeat(400));
    expect(prompt).not.toContain('x'.repeat(401));
    // Total prompt length sanity — ~3 × 400 + headers ≈ < 2000 chars added
    // by the KB section. Existing prompt baseline is ~600 chars; total
    // should stay well under 4000 chars (≈ 1000 tokens).
    expect(prompt.length).toBeLessThan(4000);
  });
});

// ─────────────────────────────────────────────
// KAN-828 — extractQueryTextFromInbound helper
// ─────────────────────────────────────────────

describe('extractQueryTextFromInbound — KAN-828 query text resolution', () => {
  it('returns bodyPreview when present on most-recent inbound', async () => {
    const { extractQueryTextFromInbound } = await import('../brain-service.js');
    const result = extractQueryTextFromInbound([
      {
        engagementType: 'email_received',
        metadata: { bodyPreview: 'How does X work?', subject: 'Question' },
      },
    ]);
    expect(result).toBe('How does X work?');
  });

  it('falls back to subject when bodyPreview empty/null', async () => {
    const { extractQueryTextFromInbound } = await import('../brain-service.js');
    const result = extractQueryTextFromInbound([
      {
        engagementType: 'email_received',
        metadata: { bodyPreview: null, subject: 'Refund policy' },
      },
    ]);
    expect(result).toBe('Refund policy');
  });

  it('returns null when both subject + bodyPreview empty', async () => {
    const { extractQueryTextFromInbound } = await import('../brain-service.js');
    const result = extractQueryTextFromInbound([
      { engagementType: 'email_received', metadata: { bodyPreview: '', subject: '' } },
    ]);
    expect(result).toBeNull();
  });

  it('skips outbound engagements; uses first inbound found', async () => {
    const { extractQueryTextFromInbound } = await import('../brain-service.js');
    const result = extractQueryTextFromInbound([
      { engagementType: 'email_send', metadata: { bodyPreview: 'outbound — should be skipped' } },
      { engagementType: 'email_received', metadata: { bodyPreview: 'inbound — pick this' } },
    ]);
    expect(result).toBe('inbound — pick this');
  });

  it('returns null on empty engagement list', async () => {
    const { extractQueryTextFromInbound } = await import('../brain-service.js');
    expect(extractQueryTextFromInbound([])).toBeNull();
  });
});

// ─────────────────────────────────────────────
// KAN-1037-PR4 — `## Latest inbound` section in Brain prompt
//
// M3-2.5c reply-loop-closure: FIRST time the prompt template renders
// inbound BODY text. Sentinel-token pins on the section header +
// metadata line + blockquote prefix + multi-line `\n> ` handling.
// Same contract-pin discipline as the KAN-825 / KAN-828 blocks above.
// ─────────────────────────────────────────────

describe('buildEvaluationPrompt — KAN-1037-PR4 Latest inbound section', () => {
  const baseInput = {
    snapshot: {
      dealStatus: 'open',
      currentStageName: 'Qualified',
      currentStageOutcomeType: 'open',
      daysInCurrentStage: 1,
      engagementCount: 2,
      lastEngagementType: 'email_received',
      lastEngagementClass: 'positive',
      daysSinceLastEngagement: 0,
      moProgressPercent: 40,
      pipelineName: 'Default Pipeline',
      pipelineObjectiveType: 'book_appointment',
    },
    contact: {
      id: 'c',
      tenantId: 't',
      email: 'alice@customer.example',
      firstName: 'Alice',
      lastName: null,
      companyName: 'Customer Co',
      phone: null,
      currentStageId: null,
      microObjectiveProgress: {},
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never,
    recentEngagements: [],
    recentTransitions: [],
  };

  it('OMITTED when latestInbound undefined (legacy callers unchanged — lead-received Phase 2, post-stage-advance, sync trpc, etc.)', () => {
    const prompt = buildEvaluationPrompt(baseInput);
    expect(prompt).not.toContain('## Latest inbound');
    expect(prompt).not.toContain('The contact replied on');
    // Section ordering invariant preserved: Recent engagement →
    // (no Latest inbound block) → Recent stage transitions.
    expect(prompt.indexOf('## Recent engagement')).toBeLessThan(
      prompt.indexOf('## Recent stage transitions'),
    );
  });

  it('RENDERS when latestInbound defined — sentinel tokens for header, metadata line, blockquote body, threadDepth', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: {
        receivedAt: '2026-05-31T13:41:12.489Z',
        senderEmail: 'alice@customer.example',
        bodyText:
          "Yes, I'm looking to start in Q3. Can we set up a 30-minute call next Tuesday afternoon?",
        subjectLine: 'Re: Quick question about pricing',
        inReplyToDecisionId: 'cl_decision_pr4_render_test',
        threadDepth: 1,
      },
    });
    // Section header — sentinel token.
    expect(prompt).toContain('## Latest inbound');
    // Metadata line — `receivedAt` + `threadDepth` rendered.
    expect(prompt).toContain('The contact replied on 2026-05-31T13:41:12.489Z');
    expect(prompt).toContain('(thread depth: 1)');
    // From + Subject lines.
    expect(prompt).toContain('From: alice@customer.example');
    expect(prompt).toContain('Subject: Re: Quick question about pricing');
    // Blockquote prefix + body verbatim (load-bearing: engine sees the
    // contact's words).
    expect(prompt).toContain(
      "> Yes, I'm looking to start in Q3. Can we set up a 30-minute call next Tuesday afternoon?",
    );
  });

  it('multi-line bodyText: each newline gets prefixed with `> ` (RFC 5322-style blockquote)', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: {
        receivedAt: '2026-05-31T13:41:12.489Z',
        senderEmail: 'alice@customer.example',
        bodyText: 'Line one of reply.\nLine two with details.\nLine three closing.',
        subjectLine: 'Re: pricing',
        inReplyToDecisionId: 'cl_decision_multiline',
        threadDepth: 1,
      },
    });
    // Three blockquoted lines — `\n> ` prefix on each continuation.
    expect(prompt).toContain('> Line one of reply.');
    expect(prompt).toContain('> Line two with details.');
    expect(prompt).toContain('> Line three closing.');
  });

  it('section slots BETWEEN ## Recent engagement and ## Recent stage transitions (ordering invariant)', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: {
        receivedAt: '2026-05-31T13:41:12.489Z',
        senderEmail: 'alice@customer.example',
        bodyText: 'short body',
        subjectLine: 'subj',
        inReplyToDecisionId: 'cl_decision_ordering',
        threadDepth: 1,
      },
    });
    const idxEngagement = prompt.indexOf('## Recent engagement');
    const idxLatest = prompt.indexOf('## Latest inbound');
    const idxTransitions = prompt.indexOf('## Recent stage transitions');
    expect(idxEngagement).toBeGreaterThan(-1);
    expect(idxLatest).toBeGreaterThan(idxEngagement);
    expect(idxTransitions).toBeGreaterThan(idxLatest);
  });

  it('preserves verbatim body content (no sanitization of nested `> ` quotes per KAN-839 precedent)', () => {
    // The contact may quote prior content in their reply. KAN-839's
    // Shaper-side `## Recent inbound from contact` section passes
    // verbatim and works empirically — same convention here.
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: {
        receivedAt: '2026-05-31T13:41:12.489Z',
        senderEmail: 'alice@customer.example',
        bodyText:
          'Great — yes to Tuesday.\n\n> On Tuesday, you wrote:\n> Sounds good.\n\nBest, Alice',
        subjectLine: 'Re: pricing',
        inReplyToDecisionId: 'cl_decision_nested_quote',
        threadDepth: 1,
      },
    });
    // The "> On Tuesday, you wrote:" line passes through verbatim with an
    // ADDITIONAL `> ` prefix from the section's blockquote wrapper. Engine
    // handles nested-quote ambiguity per KAN-839 empirical precedent.
    expect(prompt).toContain('> > On Tuesday, you wrote:');
    expect(prompt).toContain('> Best, Alice');
  });
});

// ─────────────────────────────────────────────
// KAN-1042 PR B — prompt extensions
//
// Two new conditional surfaces in `buildEvaluationPrompt`:
//   1. `### Stop-condition guidance` appended INSIDE the `## Latest
//      inbound` block (renders when latestInbound !== undefined).
//   2. `## Sub-objective gap state for this contact` slotted BETWEEN
//      `## Latest inbound` and `## Recent stage transitions` (renders
//      when subObjectiveGapState has non-empty prioritizedGaps OR
//      resolvedGaps).
//
// New helper: formatGapStateForContact — walks
// DEFAULT_SUB_OBJECTIVES_GENERIC_B2B in canonical BANT-5 order; merges
// resolvedGaps + prioritizedGaps + defensive 'unknown' fallback.
//
// Sentinel-token pins on literal phrasing (mirrors KAN-825's `##
// Trigger` block pattern at L786+) so prompt-phrasing drift breaks
// tests loudly. Phase 2.5 A/B iteration may refine; any rename of the
// section headers or load-bearing instruction phrases must update these
// tests in the same PR.
// ─────────────────────────────────────────────

describe('buildEvaluationPrompt — KAN-1042 PR B prompt extensions', () => {
  const baseInput = {
    snapshot: {
      dealStatus: 'open',
      currentStageName: 'Qualified',
      currentStageOutcomeType: 'open',
      daysInCurrentStage: 0,
      engagementCount: 2,
      lastEngagementType: 'email_received',
      lastEngagementClass: 'positive',
      daysSinceLastEngagement: 0,
      moProgressPercent: null,
      pipelineName: 'Default Sales Pipeline',
      pipelineObjectiveType: 'book_appointment',
    },
    contact: {
      id: 'c',
      tenantId: 't',
      email: 'fred@example.com',
      firstName: 'Fred',
      lastName: null,
      companyName: null,
      phone: null,
      currentStageId: null,
      microObjectiveProgress: {},
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never,
    recentEngagements: [],
    recentTransitions: [],
  };

  const inboundFixture = {
    receivedAt: '2026-06-01T18:00:00.000Z',
    senderEmail: 'alice@acme.com',
    bodyText: 'Yes, looking to start in Q3. Set up a 30-min call next Tuesday?',
    subjectLine: 'Re: Pricing inquiry',
    inReplyToDecisionId: 'cl_dec_anchor',
    threadDepth: 1,
  };

  // Mixed-state gap state for the canonical-order test: 2 known
  // (timeline + authority), 1 not_applicable (budget), 2 unknown
  // (need + motivation).
  const mixedGapState = {
    prioritizedGaps: [
      {
        key: 'need',
        label: 'What problem are they solving?',
        valueType: 'text' as const,
        state: 'unknown' as const,
        priorityWeight: 0.75,
        requiredAtStage: 'qualified',
        recencyDaysSinceLastEval: 0,
        score: 0.75,
        hardTrigger: true,
      },
      {
        key: 'motivation',
        label: "Why now? What's driving this?",
        valueType: 'text' as const,
        state: 'unknown' as const,
        priorityWeight: 0.7,
        requiredAtStage: 'qualified',
        recencyDaysSinceLastEval: 0,
        score: 0.7,
        hardTrigger: true,
      },
    ],
    topCandidate: {
      key: 'need',
      label: 'What problem are they solving?',
      score: 0.75,
      hardTrigger: true,
    },
    resolvedGaps: [
      {
        key: 'timeline',
        label: 'When are they looking to start?',
        valueType: 'text' as const,
        state: 'known' as const,
        value: 'Q3 2026',
        source: 'manual' as const,
        setBy: 'fred@axisone.ca',
        setAt: '2026-06-01T15:00:00.000Z',
      },
      {
        key: 'authority',
        label: 'Are they the decision maker?',
        valueType: 'enum' as const,
        state: 'known' as const,
        value: 'VP of Sales',
        source: 'engine' as const,
        setBy: 'engine_agentic_live',
        setAt: '2026-06-01T16:00:00.000Z',
      },
      {
        key: 'budget',
        label: "What's their budget range?",
        valueType: 'enum' as const,
        state: 'not_applicable' as const,
        value: null,
        source: 'manual' as const,
        setBy: 'fred@axisone.ca',
        setAt: '2026-06-01T15:00:00.000Z',
      },
    ],
  };

  // ── (1/8) gap-state mixed-states render with all 5 BANT keys in canonical order
  it('gap-state mixed states: all 5 BANT keys render in canonical priority order with value annotations on known rows', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      subObjectiveGapState: mixedGapState,
    });

    // Section header rendered.
    expect(prompt).toContain('## Sub-objective gap state for this contact');
    // Instruction phrasing sentinel (load-bearing — Phase 2.5 A/B iteration
    // may refine; rename breaks this test).
    expect(prompt).toContain('emit a `transition_sub_objective` action');
    expect(prompt).toContain('Cite the specific reply text in your reasoning');

    // Canonical-order assertion: timeline → budget → authority → need → motivation.
    const timelineIdx = prompt.indexOf('- timeline:');
    const budgetIdx = prompt.indexOf('- budget:');
    const authorityIdx = prompt.indexOf('- authority:');
    const needIdx = prompt.indexOf('- need:');
    const motivationIdx = prompt.indexOf('- motivation:');
    expect(timelineIdx).toBeGreaterThan(0);
    expect(budgetIdx).toBeGreaterThan(timelineIdx);
    expect(authorityIdx).toBeGreaterThan(budgetIdx);
    expect(needIdx).toBeGreaterThan(authorityIdx);
    expect(motivationIdx).toBeGreaterThan(needIdx);

    // Per-state rendering.
    expect(prompt).toContain('- timeline: known (value: "Q3 2026")');
    expect(prompt).toContain('- budget: not_applicable');
    expect(prompt).toContain('- authority: known (value: "VP of Sales")');
    expect(prompt).toContain('- need: unknown');
    expect(prompt).toContain('- motivation: unknown');
  });

  // ── (2/8) gap-state defensive-fallback: missing key from BOTH arrays → renders as 'unknown'
  it("gap-state defensive fallback: when a BANT key is absent from both prioritizedGaps AND resolvedGaps, renders as 'unknown'", () => {
    // Only resolvedGaps contains `timeline` — the other 4 BANT keys are
    // absent from both arrays. The helper must defensively render each as
    // 'unknown' so the engine treats them as fillable.
    const partialGapState = {
      prioritizedGaps: [],
      topCandidate: undefined,
      resolvedGaps: [
        {
          key: 'timeline',
          label: 'When are they looking to start?',
          valueType: 'text' as const,
          state: 'known' as const,
          value: 'Q3 2026',
          source: 'manual' as const,
          setBy: 'fred@axisone.ca',
          setAt: '2026-06-01T15:00:00.000Z',
        },
      ],
    };
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      subObjectiveGapState: partialGapState,
    });
    expect(prompt).toContain('## Sub-objective gap state for this contact');
    expect(prompt).toContain('- timeline: known (value: "Q3 2026")');
    expect(prompt).toContain('- budget: unknown');
    expect(prompt).toContain('- authority: unknown');
    expect(prompt).toContain('- need: unknown');
    expect(prompt).toContain('- motivation: unknown');
  });

  // ── (3/8) gap-state renders when prioritizedGaps is non-empty (resolvedGaps empty)
  it('gap-state section renders when prioritizedGaps has entries (resolvedGaps empty)', () => {
    const onlyPrioritized = {
      prioritizedGaps: [
        {
          key: 'timeline',
          label: 'When are they looking to start?',
          valueType: 'text' as const,
          state: 'unknown' as const,
          priorityWeight: 0.9,
          requiredAtStage: 'qualified',
          recencyDaysSinceLastEval: 0,
          score: 0.9,
          hardTrigger: true,
        },
      ],
      topCandidate: {
        key: 'timeline',
        label: 'When are they looking to start?',
        score: 0.9,
        hardTrigger: true,
      },
      resolvedGaps: [],
    };
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      subObjectiveGapState: onlyPrioritized,
    });
    expect(prompt).toContain('## Sub-objective gap state for this contact');
    expect(prompt).toContain('- timeline: unknown');
  });

  // ── (4/8) gap-state OMITTED when subObjectiveGapState undefined (legacy callers)
  it('gap-state section OMITTED when subObjectiveGapState undefined (legacy caller back-compat)', () => {
    const prompt = buildEvaluationPrompt(baseInput);
    expect(prompt).not.toContain('## Sub-objective gap state for this contact');
    expect(prompt).not.toContain('transition_sub_objective');
  });

  // ── (5/8) gap-state OMITTED when BOTH arrays empty (transient compute failure fail-safe)
  it("gap-state section OMITTED when both prioritizedGaps AND resolvedGaps are empty (transient computeGapState failure fail-safe)", () => {
    const emptyGapState = {
      prioritizedGaps: [],
      topCandidate: undefined,
      resolvedGaps: [],
    };
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      subObjectiveGapState: emptyGapState,
    });
    expect(prompt).not.toContain('## Sub-objective gap state for this contact');
  });

  // ── (6/8) Stop-condition sub-section renders inside Latest inbound block when latestInbound provided
  it('Stop-condition sub-section renders inside `## Latest inbound` block when latestInbound provided', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: inboundFixture,
    });
    // Sub-header renders.
    expect(prompt).toContain('### Stop-condition guidance');
    // Load-bearing instruction phrases (sentinel pins).
    expect(prompt).toContain('prefer `close_deal_lost` over `send_follow_up`');
    expect(prompt).toContain('emit `escalate_to_human`');
    expect(prompt).toContain('Cite the specific opt-out phrasing');
    // Slot check: sub-section appears INSIDE the Latest inbound block —
    // after the body blockquote, before `## Recent stage transitions`.
    const inboundIdx = prompt.indexOf('## Latest inbound');
    const stopCondIdx = prompt.indexOf('### Stop-condition guidance');
    const stageHistoryIdx = prompt.indexOf('## Recent stage transitions');
    expect(inboundIdx).toBeGreaterThan(0);
    expect(stopCondIdx).toBeGreaterThan(inboundIdx);
    expect(stageHistoryIdx).toBeGreaterThan(stopCondIdx);
  });

  // ── (7/8) Stop-condition sub-section OMITTED when latestInbound undefined
  it('Stop-condition sub-section OMITTED when latestInbound undefined (no inbound to interpret)', () => {
    const prompt = buildEvaluationPrompt(baseInput);
    expect(prompt).not.toContain('### Stop-condition guidance');
    expect(prompt).not.toContain('## Latest inbound');
  });

  // ── (8/8) Both new sections render together when latestInbound + gap-state both provided
  it('Both sections render in correct order when latestInbound AND non-empty subObjectiveGapState are both provided', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: inboundFixture,
      subObjectiveGapState: mixedGapState,
    });
    // Both sections present.
    expect(prompt).toContain('## Latest inbound');
    expect(prompt).toContain('### Stop-condition guidance');
    expect(prompt).toContain('## Sub-objective gap state for this contact');
    expect(prompt).toContain('## Recent stage transitions');
    // Slot ordering: Latest inbound (with stop-condition inside) → gap-state
    // → Recent stage transitions. Per Phase 1 Q2 + Q3 architecture.
    const inboundIdx = prompt.indexOf('## Latest inbound');
    const stopCondIdx = prompt.indexOf('### Stop-condition guidance');
    const gapStateIdx = prompt.indexOf('## Sub-objective gap state for this contact');
    const stageHistoryIdx = prompt.indexOf('## Recent stage transitions');
    expect(stopCondIdx).toBeGreaterThan(inboundIdx);
    expect(gapStateIdx).toBeGreaterThan(stopCondIdx);
    expect(stageHistoryIdx).toBeGreaterThan(gapStateIdx);
  });
});

// ─────────────────────────────────────────────
// KAN-1052 — Initial lead body reading
//
// Extends the latestInbound cognitive surface from reply-chain-only
// (PR4) to initial-lead inbounds. Engine now reads first-inbound body
// content on the FIRST evaluation, not just on replies.
//
// Q4 sentinel pin: initial-lead phrasing ("reached out for the first
// time" via threadDepth === 0) vs reply phrasing ("replied" via
// threadDepth > 0). Any future regression to the bare "replied"
// hardcode breaks these tests loudly.
// ─────────────────────────────────────────────

describe('buildEvaluationPrompt — KAN-1052 initial lead body reading', () => {
  const baseInput = {
    snapshot: {
      dealStatus: 'open',
      currentStageName: 'New',
      currentStageOutcomeType: 'open',
      daysInCurrentStage: 0,
      engagementCount: 1,
      lastEngagementType: 'email_received',
      lastEngagementClass: 'positive',
      daysSinceLastEngagement: 0,
      moProgressPercent: null,
      pipelineName: 'Default Sales Pipeline',
      pipelineObjectiveType: 'book_appointment',
    },
    contact: {
      id: 'c',
      tenantId: 't',
      email: 'alice@acme.com',
      firstName: 'Alice',
      lastName: null,
      companyName: 'Acme Inc',
      phone: null,
      currentStageId: null,
      microObjectiveProgress: {},
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never,
    recentEngagements: [],
    recentTransitions: [],
  };

  // ── (1/4) Initial-lead with body (threadDepth=0) — phrasing pin
  it('initial-lead with body (threadDepth=0): renders "reached out for the first time" + Stop-condition guidance follows', () => {
    const initialLeadInbound = {
      receivedAt: '2026-06-02T00:00:00.000Z',
      senderEmail: 'alice@acme.com',
      bodyText: 'Hi, looking to learn more about your offering. Any time for a call?',
      subjectLine: 'Pricing inquiry',
      inReplyToDecisionId: 'evt_initial_lead_anchor',
      threadDepth: 0,
    };
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: initialLeadInbound,
    });
    expect(prompt).toContain('The contact reached out for the first time on 2026-06-02T00:00:00.000Z');
    expect(prompt).not.toContain('The contact replied on');
    expect(prompt).toContain('> Hi, looking to learn more');
    expect(prompt).toContain('### Stop-condition guidance');
    const inboundIdx = prompt.indexOf('## Latest inbound');
    const stopCondIdx = prompt.indexOf('### Stop-condition guidance');
    expect(stopCondIdx).toBeGreaterThan(inboundIdx);
  });

  // ── (2/4) Reply-path back-compat (threadDepth=1) — phrasing pin
  it('reply-path back-compat (threadDepth=1): renders "replied" verbatim — Q4 sentinel pin against initial-lead phrasing regression', () => {
    const replyInbound = {
      receivedAt: '2026-06-02T01:00:00.000Z',
      senderEmail: 'alice@acme.com',
      bodyText: 'Yes, looking to start in Q3.',
      subjectLine: 'Re: Pricing inquiry',
      inReplyToDecisionId: 'cl_decision_real_anchor',
      threadDepth: 1,
    };
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: replyInbound,
    });
    expect(prompt).toContain('The contact replied on 2026-06-02T01:00:00.000Z');
    expect(prompt).not.toContain('reached out for the first time');
  });

  // ── (3/4) Initial-lead with empty bodyText — graceful render
  it('initial-lead with empty bodyText: section still renders header + body slot intact (parent ternary gates on latestInbound, not bodyText)', () => {
    const initialLeadInbound = {
      receivedAt: '2026-06-02T00:00:00.000Z',
      senderEmail: 'alice@acme.com',
      bodyText: '',
      subjectLine: 'Empty body case',
      inReplyToDecisionId: 'evt_anchor',
      threadDepth: 0,
    };
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: initialLeadInbound,
    });
    expect(prompt).toContain('## Latest inbound');
    expect(prompt).toContain('reached out for the first time');
    expect(prompt).toContain('> ');
  });

  // ── (4/4) buildLatestInboundContext helper — pure passthrough sentinel
  it('buildLatestInboundContext: passes input fields through verbatim (Cluster I roadmap pin)', async () => {
    const { buildLatestInboundContext } = await import('../brain-service.js');
    const input = {
      receivedAt: '2026-06-02T02:00:00.000Z',
      senderEmail: 'sender@example.com',
      bodyText: 'body content',
      subjectLine: 'subject text',
      inReplyToDecisionId: 'anchor_id',
      threadDepth: 5,
    };
    const out = buildLatestInboundContext(input);
    expect(out).toEqual(input);
  });
});
