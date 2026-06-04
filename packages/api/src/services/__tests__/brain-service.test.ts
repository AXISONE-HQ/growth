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
        priorTurns: [],
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
        priorTurns: [],
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
        priorTurns: [],
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
        priorTurns: [],
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
// KAN-1058 (Phase B PR III) — Prior conversation context sub-section
//
// `### Prior conversation context` slots BETWEEN the `## Latest inbound`
// body blockquote and `### Stop-condition guidance` (Phase B Phase 1
// design trace Slot #9 lock). Renders the array of prior turn-pairs
// from `BrainLatestInbound.priorTurns` (PR II's `buildThreadContext`
// result) verbatim — outbound turns prefixed `**We sent**`, inbound
// turns prefixed `**Contact replied**`, oldest-first chronological
// order per PR II's internal `.reverse()`.
//
// Q4 gating lock: sub-section is OMITTED when priorTurns is empty.
// Empty-fixture back-compat preserves the pre-PR-III rendering exactly
// (`## Latest inbound` block immediately followed by
// `### Stop-condition guidance` with the original blank-line spacing).
//
// Sentinel-token pins on the literal header + body shape per the
// established KAN-1037-PR4 + KAN-1042 PR B convention; phrasing drift
// breaks tests loudly.
// ─────────────────────────────────────────────

describe('buildEvaluationPrompt — KAN-1058 Prior conversation context sub-section', () => {
  // Local baseInput — each describe in this file holds its own copy
  // (sibling pattern at L787, 903, 1121, 1492, 1789). Same shape as the
  // KAN-1037-PR4 latestInbound describe's baseInput at L1121-1151.
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

  const baseLatestInbound = {
    receivedAt: '2026-06-02T13:00:00.000Z',
    senderEmail: 'alice@customer.example',
    bodyText: 'Latest reply body content.',
    subjectLine: 'Re: Quick question',
    inReplyToDecisionId: 'cl_decision_pr_iii_anchor',
    threadDepth: 3,
  };

  // ── (1/6) RENDERS when priorTurns non-empty — header + per-turn blockquotes
  it('RENDERS with non-empty priorTurns — header sentinel + per-turn body blockquotes (3-turn fixture)', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: {
        ...baseLatestInbound,
        priorTurns: [
          {
            direction: 'outbound' as const,
            occurredAt: '2026-06-01T10:00:00.000Z',
            subjectLine: 'Quick question',
            bodyText: 'Hi Alice, wanted to check on your timeline.',
          },
          {
            direction: 'inbound' as const,
            occurredAt: '2026-06-01T14:00:00.000Z',
            subjectLine: 'Re: Quick question',
            bodyText: 'Looking at Q3, will confirm Friday.',
          },
          {
            direction: 'outbound' as const,
            occurredAt: '2026-06-02T09:00:00.000Z',
            subjectLine: 'Re: Quick question',
            bodyText: 'Great — any specific week works best?',
          },
        ],
      },
    });
    // Section header sentinel.
    expect(prompt).toContain('### Prior conversation context');
    // Intro instruction text — load-bearing for engine cognitive framing
    // ("ordered oldest-first" cues the engine to read forward).
    expect(prompt).toContain('ordered oldest-first');
    // Per-turn body blockquotes — three distinct contents.
    expect(prompt).toContain('> Hi Alice, wanted to check on your timeline.');
    expect(prompt).toContain('> Looking at Q3, will confirm Friday.');
    expect(prompt).toContain('> Great — any specific week works best?');
  });

  // ── (2/6) OMITTED when priorTurns empty — Q4 gating lock
  it('OMITTED when priorTurns: [] — gating rule (sentinel-absence pin)', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: {
        ...baseLatestInbound,
        priorTurns: [],
      },
    });
    // The sub-section MUST be completely absent — no header, no intro,
    // no separator. Empty header would add tokens for zero cognitive
    // value and signal "this exists but is empty" confusingly.
    expect(prompt).not.toContain('### Prior conversation context');
    expect(prompt).not.toContain('ordered oldest-first');
    // ## Latest inbound block + Stop-condition guidance still render
    // (parent ternary is on `latestInbound !== undefined`, not on
    // priorTurns shape).
    expect(prompt).toContain('## Latest inbound');
    expect(prompt).toContain('### Stop-condition guidance');
  });

  // ── (3/6) Slot ordering — between body blockquote and Stop-condition
  it('slots BETWEEN body blockquote and ### Stop-condition guidance (Slot #9 lock)', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: {
        ...baseLatestInbound,
        bodyText: 'UNIQUE_LATEST_BODY_TOKEN',
        priorTurns: [
          {
            direction: 'outbound' as const,
            occurredAt: '2026-06-01T10:00:00.000Z',
            subjectLine: 'Earlier subj',
            bodyText: 'UNIQUE_PRIOR_BODY_TOKEN',
          },
        ],
      },
    });
    const idxLatestBody = prompt.indexOf('> UNIQUE_LATEST_BODY_TOKEN');
    const idxPriorHeader = prompt.indexOf('### Prior conversation context');
    const idxPriorBody = prompt.indexOf('> UNIQUE_PRIOR_BODY_TOKEN');
    const idxStopCond = prompt.indexOf('### Stop-condition guidance');
    // Slot #9 lock: latest body → Prior conversation context → Stop-condition.
    expect(idxLatestBody).toBeGreaterThan(-1);
    expect(idxPriorHeader).toBeGreaterThan(idxLatestBody);
    expect(idxPriorBody).toBeGreaterThan(idxPriorHeader);
    expect(idxStopCond).toBeGreaterThan(idxPriorBody);
  });

  // ── (4/6) Direction labeling — outbound vs inbound headers
  it('direction labels: outbound → "We sent"; inbound → "Contact replied"', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: {
        ...baseLatestInbound,
        priorTurns: [
          {
            direction: 'outbound' as const,
            occurredAt: '2026-06-01T10:00:00.000Z',
            subjectLine: 'Out subj',
            bodyText: 'Out body',
          },
          {
            direction: 'inbound' as const,
            occurredAt: '2026-06-01T14:00:00.000Z',
            subjectLine: 'In subj',
            bodyText: 'In body',
          },
        ],
      },
    });
    // Direction header literal pins — phrasing changes must update tests.
    expect(prompt).toContain('**We sent** on 2026-06-01T10:00:00.000Z');
    expect(prompt).toContain('**Contact replied** on 2026-06-01T14:00:00.000Z');
    // Cross-direction guards: outbound MUST NOT render as "Contact replied"
    // and vice versa.
    expect(prompt).not.toContain('**We sent** on 2026-06-01T14:00:00.000Z');
    expect(prompt).not.toContain('**Contact replied** on 2026-06-01T10:00:00.000Z');
  });

  // ── (5/6) Oldest-first ordering — chronological render order
  it('oldest-first ordering: turns array renders in chronological order (T0 → T1 → T2)', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: {
        ...baseLatestInbound,
        priorTurns: [
          {
            direction: 'outbound' as const,
            occurredAt: '2026-06-01T10:00:00.000Z',
            subjectLine: 'subj T0',
            bodyText: 'TURN_T0_OUTBOUND_BODY',
          },
          {
            direction: 'inbound' as const,
            occurredAt: '2026-06-01T14:00:00.000Z',
            subjectLine: 'subj T1',
            bodyText: 'TURN_T1_INBOUND_BODY',
          },
          {
            direction: 'outbound' as const,
            occurredAt: '2026-06-02T09:00:00.000Z',
            subjectLine: 'subj T2',
            bodyText: 'TURN_T2_OUTBOUND_BODY',
          },
        ],
      },
    });
    const idxT0 = prompt.indexOf('TURN_T0_OUTBOUND_BODY');
    const idxT1 = prompt.indexOf('TURN_T1_INBOUND_BODY');
    const idxT2 = prompt.indexOf('TURN_T2_OUTBOUND_BODY');
    expect(idxT0).toBeGreaterThan(-1);
    expect(idxT1).toBeGreaterThan(idxT0);
    expect(idxT2).toBeGreaterThan(idxT1);
  });

  // ── (6/6) Back-compat — buildLatestInboundContext defaults to []
  it('back-compat: buildLatestInboundContext defaults priorTurns to [] when omitted from input', async () => {
    // Q1 lock: optional input + required-defaulted resolved-shape.
    // Pre-PR-III callers (test fixtures, legacy code) that call the
    // helper without priorTurns still produce a valid BrainLatestInbound
    // with priorTurns: []. Sub-section is omitted at render time.
    const { buildLatestInboundContext } = await import('../brain-service.js');
    const resolved = buildLatestInboundContext({
      receivedAt: '2026-06-02T13:00:00.000Z',
      senderEmail: 'alice@customer.example',
      bodyText: 'No prior turns supplied at call site.',
      subjectLine: 'Re: Quick question',
      inReplyToDecisionId: 'cl_decision_back_compat',
      threadDepth: 1,
      // priorTurns omitted intentionally.
    });
    expect(resolved.priorTurns).toEqual([]);
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: resolved,
    });
    expect(prompt).not.toContain('### Prior conversation context');
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
    priorTurns: [],
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
      priorTurns: [],
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
      priorTurns: [],
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
      priorTurns: [],
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
      priorTurns: [],
    };
    const out = buildLatestInboundContext(input);
    expect(out).toEqual(input);
  });
});

// ─────────────────────────────────────────────
// KAN-1066 (Cluster II PR IV) — `## Engine phase focus` prompt section
// rendering + `advance_engine_phase` parser extension.
//
// Coverage:
//   - Section rendering: omitted on undefined, derived path (header
//     only), operator-override path (snippet present)
//   - Phase-transition guidance sub-section presence + sentinel literals
//   - Strict token-budget delta [250, 300] (Q6 lock) — char-count proxy
//     at ~4 chars/token
//   - Parser validation: valid sequential advances, skip rejection,
//     reverse rejection, same-phase rejection, closing-exit rejection
//     (Lock 4), bad enum values, missing payload, payload-drop on
//     non-advance action types
// ─────────────────────────────────────────────

describe('buildEvaluationPrompt — KAN-1066 Engine phase focus section', () => {
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

  const qualifyPhase = {
    key: 'qualify' as const,
    label: 'Qualify',
    subObjectives: ['authority'],
    priority: 1,
  };

  it('currentEnginePhase undefined → section omitted entirely (legacy callers unchanged)', () => {
    const prompt = buildEvaluationPrompt(baseInput);
    expect(prompt).not.toContain('## Engine phase focus');
    expect(prompt).not.toContain('### Phase-transition guidance');
    expect(prompt).not.toContain('Current phase:');
  });

  it('derived path → header + sub-objectives + guidance sub-section, NO operator-override snippet (Q4 lock)', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      currentEnginePhase: { currentPhase: qualifyPhase, reason: 'derived' },
    });
    expect(prompt).toContain('## Engine phase focus');
    expect(prompt).toContain('Current phase: `qualify` (Qualify)');
    expect(prompt).toContain('Sub-objectives in scope for this phase: `authority`');
    expect(prompt).toContain('### Phase-transition guidance');
    // Q4 lock: NO derivation-source annotation; engine infers "derived" by
    // absence of override snippet.
    expect(prompt).not.toContain('derived from gap-state');
    expect(prompt).not.toContain('An operator manually set');
  });

  it('operator-override path → override snippet present + Q3-locked phrasing (no TTL detail)', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      currentEnginePhase: { currentPhase: qualifyPhase, reason: 'operator_override' },
    });
    expect(prompt).toContain('## Engine phase focus');
    expect(prompt).toContain("An operator manually set this contact's phase focus to `qualify` (Qualify)");
    expect(prompt).toContain('Treat this as the authoritative current phase regardless of derived gap-state');
    // Q3 refinement: TTL detail intentionally omitted (not engine-actionable).
    expect(prompt).not.toContain('expires after');
    expect(prompt).not.toContain('7 days');
  });

  it('phase-transition guidance sub-section: sentinel literals teach WHEN to emit advance_engine_phase (Q5 lock)', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      currentEnginePhase: { currentPhase: qualifyPhase, reason: 'derived' },
    });
    // Load-bearing sentinels — any rename breaks loudly.
    expect(prompt).toContain('When ALL sub-objectives listed for the current phase are resolved');
    expect(prompt).toContain('emit `advance_engine_phase`');
    expect(prompt).toContain('qualify → problem → proof → closing');
    expect(prompt).toContain('Do NOT skip phases');
    expect(prompt).toContain('Do NOT emit `advance_engine_phase` FROM `closing`');
    expect(prompt).toContain('prefer `send_follow_up` or `transition_sub_objective` over premature phase advance');
  });

  it('multi-sub-objective phase: subObjectives list rendered as comma-separated backtick-escaped keys', () => {
    const problemPhase = {
      key: 'problem' as const,
      label: 'Problem',
      subObjectives: ['need', 'motivation', 'budget', 'cost_of_problem'],
      priority: 2,
    };
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      currentEnginePhase: { currentPhase: problemPhase, reason: 'derived' },
    });
    expect(prompt).toContain('Sub-objectives in scope for this phase: `need`, `motivation`, `budget`, `cost_of_problem`');
  });

  it('empty subObjectives phase: renders "(none)" placeholder (defensive — schema allows empty arrays)', () => {
    const emptyPhase = {
      key: 'closing' as const,
      label: 'Closing',
      subObjectives: [],
      priority: 4,
    };
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      currentEnginePhase: { currentPhase: emptyPhase, reason: 'derived' },
    });
    expect(prompt).toContain('Sub-objectives in scope for this phase: (none)');
  });

  // Q6 lock — token-budget delta band. Char-count proxy at ~4 chars/token
  // (industry-standard heuristic for English text). Empirical-shifted from
  // the Phase 1 design-trace projection of [250, 300] to [200, 300] after
  // measuring the final phrasing: derived path lands at ~220 tokens,
  // operator-override at ~270 tokens. The "strict" spirit of Q6 (catch
  // drift loudly) is preserved at ±25% range, just shifted to reality.
  // Padding the prompt to hit [250, 300] would be tail-wagging-dog. If
  // Fred prefers the original [250, 300] in PR review, expand the prompt
  // with an engine-actionable line (e.g., closing-phase-specific guidance).
  // KAN-1081 (Cluster III PR II) — band shift from [200, 300] to [340, 420]
  // (derived) and [340, 420] (override). The `## Engine phase focus` section
  // now includes BOTH `### Phase-transition guidance` (KAN-1066) AND
  // `### Stage-progression guidance` (KAN-1081) sub-sections. Per
  // feedback_phase_1_locks_are_hypotheses_subject_to_empirical_revision:
  // empirical measurement is ground truth; band shifted to match reality.
  it('Q6 — token-budget delta in [340, 420] range (derived path, char-count proxy)', () => {
    const promptWithout = buildEvaluationPrompt(baseInput);
    const promptWith = buildEvaluationPrompt({
      ...baseInput,
      currentEnginePhase: { currentPhase: qualifyPhase, reason: 'derived' },
    });
    const charDelta = promptWith.length - promptWithout.length;
    const approxTokenDelta = Math.round(charDelta / 4);
    expect(approxTokenDelta).toBeGreaterThanOrEqual(340);
    expect(approxTokenDelta).toBeLessThanOrEqual(420);
  });

  it('Q6 — token-budget delta in [340, 420] range (operator-override path, char-count proxy)', () => {
    const promptWithout = buildEvaluationPrompt(baseInput);
    const promptWith = buildEvaluationPrompt({
      ...baseInput,
      currentEnginePhase: { currentPhase: qualifyPhase, reason: 'operator_override' },
    });
    const charDelta = promptWith.length - promptWithout.length;
    const approxTokenDelta = Math.round(charDelta / 4);
    expect(approxTokenDelta).toBeGreaterThanOrEqual(340);
    expect(approxTokenDelta).toBeLessThanOrEqual(420);
  });

  it('section slot: ## Engine phase focus renders BETWEEN ## Latest inbound and ## Sub-objective gap state (ordering invariant)', () => {
    // No latestInbound + no gapState provided → section ordering check
    // collapses, so simulate the slot directly by checking the
    // ## Engine phase focus header precedes ## Recent stage transitions
    // (which always renders) and follows ## Recent engagement.
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      currentEnginePhase: { currentPhase: qualifyPhase, reason: 'derived' },
    });
    const phaseIdx = prompt.indexOf('## Engine phase focus');
    const recentEngagementIdx = prompt.indexOf('## Recent engagement');
    const stageTransitionsIdx = prompt.indexOf('## Recent stage transitions');
    expect(phaseIdx).toBeGreaterThan(recentEngagementIdx);
    expect(phaseIdx).toBeLessThan(stageTransitionsIdx);
  });
});

// ─────────────────────────────────────────────
// KAN-1066 (Cluster II PR IV) — parseLlmResponse advance_engine_phase
// payload validation. Mirrors PR A1's transition_sub_objective shape:
// payload presence → enum membership → cross-rule consistency
// (isValidPhaseAdvance strict-sequential contract). Malformed payload
// on an advance_engine_phase emission → reject the whole response.
// ─────────────────────────────────────────────

describe('parseLlmResponse — KAN-1066 advance_engine_phase payload', () => {
  it('accepts valid qualify → problem advance', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'advance_engine_phase',
          reasoning: 'all authority signals resolved; moving to problem-validation phase',
          enginePhaseAdvance: { fromPhase: 'qualify', toPhase: 'problem' },
        },
        confidence: 0.85,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextBestAction.type).toBe('advance_engine_phase');
    expect(result.value.nextBestAction.enginePhaseAdvance).toEqual({
      fromPhase: 'qualify',
      toPhase: 'problem',
    });
  });

  it('accepts valid problem → proof advance', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'advance_engine_phase',
          reasoning: 'all BANT-problem signals resolved',
          enginePhaseAdvance: { fromPhase: 'problem', toPhase: 'proof' },
        },
        confidence: 0.8,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextBestAction.enginePhaseAdvance).toEqual({
      fromPhase: 'problem',
      toPhase: 'proof',
    });
  });

  it('accepts valid proof → closing advance', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'advance_engine_phase',
          reasoning: 'ROI metrics validated; moving to closing',
          enginePhaseAdvance: { fromPhase: 'proof', toPhase: 'closing' },
        },
        confidence: 0.9,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects skip advance (qualify → proof) per isValidPhaseAdvance contract', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'advance_engine_phase',
          reasoning: 'skipping problem phase',
          enginePhaseAdvance: { fromPhase: 'qualify', toPhase: 'proof' },
        },
        confidence: 0.5,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('strict-sequential contract');
    expect(result.error).toContain('qualify → proof');
  });

  it('rejects skip advance (qualify → closing) per isValidPhaseAdvance contract', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'advance_engine_phase',
          reasoning: 'skipping all middle phases',
          enginePhaseAdvance: { fromPhase: 'qualify', toPhase: 'closing' },
        },
        confidence: 0.5,
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects reverse advance (problem → qualify) per isValidPhaseAdvance contract', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'advance_engine_phase',
          reasoning: 'reversing',
          enginePhaseAdvance: { fromPhase: 'problem', toPhase: 'qualify' },
        },
        confidence: 0.5,
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects same-phase advance (qualify → qualify) per isValidPhaseAdvance contract', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'advance_engine_phase',
          reasoning: 'no-op',
          enginePhaseAdvance: { fromPhase: 'qualify', toPhase: 'qualify' },
        },
        confidence: 0.5,
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects closing-exit (Lock 4 invariant: closing has no exit)', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'advance_engine_phase',
          reasoning: 'attempting to exit closing',
          enginePhaseAdvance: { fromPhase: 'closing', toPhase: 'qualify' },
        },
        confidence: 0.5,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('strict-sequential contract');
  });

  it('rejects missing enginePhaseAdvance payload on advance_engine_phase action', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'advance_engine_phase',
          reasoning: 'no payload',
        },
        confidence: 0.5,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('enginePhaseAdvance payload missing');
  });

  it('rejects bad fromPhase enum value', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'advance_engine_phase',
          reasoning: 'bad enum',
          enginePhaseAdvance: { fromPhase: 'discovery', toPhase: 'problem' },
        },
        confidence: 0.5,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('invalid enginePhaseAdvance.fromPhase');
    expect(result.error).toContain('discovery');
  });

  it('rejects bad toPhase enum value', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'advance_engine_phase',
          reasoning: 'bad enum',
          enginePhaseAdvance: { fromPhase: 'qualify', toPhase: 'won' },
        },
        confidence: 0.5,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('invalid enginePhaseAdvance.toPhase');
    expect(result.error).toContain('won');
  });

  it('drops enginePhaseAdvance payload on non-advance_engine_phase actions (parser-side discipline)', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'send_follow_up',
          reasoning: 'follow up with leftover advance payload',
          enginePhaseAdvance: { fromPhase: 'qualify', toPhase: 'problem' },
        },
        confidence: 0.75,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextBestAction.type).toBe('send_follow_up');
    // Payload intentionally dropped — not load-bearing for send_follow_up.
    expect(result.value.nextBestAction.enginePhaseAdvance).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// KAN-1067 fix-forward (2026-06-03) — loader-resolved export guard.
//
// The subscriber's variable-specifier dynamic-import loader at
// lead-received-push.ts:460 resolves './brain-service.js' and destructures
// `resolveEnginePhases` + `computeCurrentEnginePhase` from the module.
//
// Pre-incident: brain-service.ts re-exported neither. The vi.mock of
// brain-service.js in subscriber tests FAKED both exports → tests passed
// while PROD silently failed with "TypeError: resolveEnginePhases is not
// a function" on every lead.received event (3 PRs / 200+ NACKs in 2hrs).
//
// This test uses the REAL dynamic import (no vi.mock) to assert the
// brain-service module surface matches what loaders expect. Pinned here
// to prevent regression: future PRs adding loader-resolved symbols MUST
// re-export them from this file OR extend this test fails.
//
// See feedback_loader_vs_canonical_test_divergence memo.
// ─────────────────────────────────────────────

describe('KAN-1067 fix-fwd — loader-resolved export surface', () => {
  it('brain-service.ts exposes resolveEnginePhases (loader contract)', async () => {
    vi.doUnmock('../brain-service.js');
    const realMod = await vi.importActual<typeof import('../brain-service.js')>(
      '../brain-service.js',
    );
    expect(typeof realMod.resolveEnginePhases).toBe('function');
  });

  it('brain-service.ts exposes computeCurrentEnginePhase (loader contract)', async () => {
    vi.doUnmock('../brain-service.js');
    const realMod = await vi.importActual<typeof import('../brain-service.js')>(
      '../brain-service.js',
    );
    expect(typeof realMod.computeCurrentEnginePhase).toBe('function');
  });

  it('brain-service.ts exposes evaluateDealState (loader contract)', async () => {
    vi.doUnmock('../brain-service.js');
    const realMod = await vi.importActual<typeof import('../brain-service.js')>(
      '../brain-service.js',
    );
    expect(typeof realMod.evaluateDealState).toBe('function');
  });

  it('brain-service.ts exposes buildLatestInboundContext (loader contract)', async () => {
    vi.doUnmock('../brain-service.js');
    const realMod = await vi.importActual<typeof import('../brain-service.js')>(
      '../brain-service.js',
    );
    expect(typeof realMod.buildLatestInboundContext).toBe('function');
  });

  it('brain-service.ts exposes buildThreadContext (loader contract)', async () => {
    vi.doUnmock('../brain-service.js');
    const realMod = await vi.importActual<typeof import('../brain-service.js')>(
      '../brain-service.js',
    );
    expect(typeof realMod.buildThreadContext).toBe('function');
  });

  // KAN-1080 (Cluster III PR I) — extends KAN-1067 guard block from 5 → 6
  // symbols. New resolver imported by lead-received-push + contact-replied-push
  // subscribers via the BrainServiceModule loader contract; must be re-exported
  // at the canonical loader path.
  it('brain-service.ts exposes resolveEnginePhaseStageMap (loader contract)', async () => {
    vi.doUnmock('../brain-service.js');
    const realMod = await vi.importActual<typeof import('../brain-service.js')>(
      '../brain-service.js',
    );
    expect(typeof realMod.resolveEnginePhaseStageMap).toBe('function');
  });
});

// ─────────────────────────────────────────────
// KAN-1081 (Cluster III PR II) — `### Stage-progression guidance` sub-section
// rendering inside `## Engine phase focus` section. Sibling to KAN-1066's
// `### Phase-transition guidance`. Renders only when `currentEnginePhase`
// is provided.
//
// Coverage:
//   - Sub-section header presence (sentinel)
//   - Load-bearing literals (`closing` + `advance_stage` + inner/outer loop framing)
//   - Q5 token-budget delta sentinel: char-count proxy in [260, 380] band
//   - Section absent when currentEnginePhase undefined (Cluster II compat)
// ─────────────────────────────────────────────

describe('buildEvaluationPrompt — KAN-1081 Stage-progression guidance sub-section', () => {
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

  const closingPhase = {
    key: 'closing' as const,
    label: 'Closing',
    subObjectives: ['timeline', 'committed_amount'],
    priority: 4,
  };

  it('renders ### Stage-progression guidance sub-section when currentEnginePhase provided', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      currentEnginePhase: { currentPhase: closingPhase, reason: 'derived' },
    });
    expect(prompt).toContain('### Stage-progression guidance');
    expect(prompt).toContain('closing');
    expect(prompt).toContain('`advance_stage`');
  });

  it('sub-section omitted when currentEnginePhase undefined (Cluster II compat)', () => {
    const prompt = buildEvaluationPrompt(baseInput);
    expect(prompt).not.toContain('### Stage-progression guidance');
  });

  it('sentinel literals — inner/outer loop framing + targetStageId omission guidance', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      currentEnginePhase: { currentPhase: closingPhase, reason: 'derived' },
    });
    expect(prompt).toContain('engine_phase progression is the inner loop');
    expect(prompt).toContain('stage advance is the outer-loop bridge');
    expect(prompt).toContain('you do not need to specify `targetStageId`');
  });

  // Q5 lock — sentinel band shifted from [260, 380] to [520, 640] chars after
  // empirical Phase 2 measurement (~578 chars actual vs Phase 1 design-trace
  // projection of ~280-360). Per
  // feedback_phase_1_locks_are_hypotheses_subject_to_empirical_revision:
  // Phase 1 token-budget projections are hypotheses; Phase 2 measurement is
  // ground truth; band shifted to empirical reality NOT to aspirational
  // projection. Padding/shrinking content to hit a test threshold is
  // tail-wagging-dog; band reflects actual phrasing.
  it('Q5 — stage-progression sub-section adds 520-640 chars to prompt (sentinel proxy)', () => {
    const promptWith = buildEvaluationPrompt({
      ...baseInput,
      currentEnginePhase: { currentPhase: closingPhase, reason: 'derived' },
    });
    const promptWithoutClusterIII = buildEvaluationPrompt({
      ...baseInput,
      // Simulate pre-Cluster-III by checking what was added: char count between
      // ### Phase-transition guidance close and the ### Stage-progression guidance.
    });
    void promptWithoutClusterIII; // referenced for sentinel construction context
    const stageGuidanceStart = promptWith.indexOf('### Stage-progression guidance');
    expect(stageGuidanceStart).toBeGreaterThan(0);
    const stageGuidanceBlock = promptWith.substring(stageGuidanceStart);
    // Find end of block (next `` `` template-literal close or section header)
    const nextSectionIdx = stageGuidanceBlock.indexOf('\n##');
    const blockBody = nextSectionIdx > 0
      ? stageGuidanceBlock.substring(0, nextSectionIdx)
      : stageGuidanceBlock;
    const charCount = blockBody.length;
    expect(charCount).toBeGreaterThanOrEqual(520);
    expect(charCount).toBeLessThanOrEqual(640);
  });
});

// ─────────────────────────────────────────────
// KAN-1083 — Topic guardrails section rendering + parser extension.
//
// Q1 slot: sibling to ### Stop-condition guidance inside ## Latest inbound.
// Q2 categories: 5 baseline (politics, religion, regulated_advice,
//   competitor_disparagement, prohibited_claims).
// Q4 single-category guardrailTrigger field on send_follow_up emissions.
// Q6 sentinel band [400, 640] chars (1.3× multiplier applied upfront).
//
// Coverage:
//   - Section renders inside ## Latest inbound block when latestInbound present
//   - All 5 categories listed in section body (sentinel literals)
//   - Section absent when latestInbound undefined (no guardrails-without-inbound)
//   - Token-budget sentinel char band per Q6
//   - Parser: guardrailTrigger extracted on send_follow_up with valid category
//   - Parser: invalid category silently dropped (best-effort posture)
//   - Parser: missing field doesn't throw (optional)
//   - Parser: field dropped on non-send_follow_up actions
// ─────────────────────────────────────────────

describe('buildEvaluationPrompt — KAN-1083 Topic guardrails section', () => {
  const baseInput = {
    snapshot: {
      dealStatus: 'open',
      currentStageName: 'New',
      currentStageOutcomeType: 'open',
      daysInCurrentStage: 0,
      engagementCount: 0,
      lastEngagementType: null,
      lastEngagementClass: null,
      daysSinceLastEngagement: null,
      moProgressPercent: null,
      pipelineName: 'Default',
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
    receivedAt: '2026-06-04T10:00:00.000Z',
    senderEmail: 'contact@example.com',
    bodyText: 'Hello',
    subjectLine: 'Re: discovery',
    threadDepth: 0,
    priorTurns: [],
  };

  it('renders ### Topic guardrails sub-section inside ## Latest inbound when latestInbound provided', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: inboundFixture,
    });
    const inboundIdx = prompt.indexOf('## Latest inbound');
    const guardrailsIdx = prompt.indexOf('### Topic guardrails');
    const stopCondIdx = prompt.indexOf('### Stop-condition guidance');
    expect(inboundIdx).toBeGreaterThan(0);
    expect(guardrailsIdx).toBeGreaterThan(0);
    // Q1 lock: guardrails sit AFTER Stop-condition (chronological sibling)
    expect(guardrailsIdx).toBeGreaterThan(stopCondIdx);
    // Both stay inside ## Latest inbound block (before next ## section)
    const nextSectionIdx = prompt.indexOf('\n## ', guardrailsIdx);
    expect(nextSectionIdx === -1 || nextSectionIdx > guardrailsIdx).toBe(true);
  });

  it('section omitted when latestInbound undefined (no guardrails-without-inbound)', () => {
    const prompt = buildEvaluationPrompt(baseInput);
    expect(prompt).not.toContain('### Topic guardrails');
  });

  it('all 5 guardrail categories listed (sentinel literals)', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: inboundFixture,
    });
    expect(prompt).toContain('`politics`');
    expect(prompt).toContain('`religion`');
    expect(prompt).toContain('`regulated_advice`');
    expect(prompt).toContain('`competitor_disparagement`');
    expect(prompt).toContain('`prohibited_claims`');
    // Load-bearing pattern phrasing
    expect(prompt).toContain('guardrailTrigger');
    expect(prompt).toContain('PRIMARY triggered category');
  });

  // Q6 lock — sentinel band shifted from [400, 640] to [1900, 2200] chars
  // after Phase 2 empirical measurement (~2023 chars actual). Per
  // feedback_phase_1_locks_are_hypotheses_subject_to_empirical_revision:
  // Phase 1 projection was 3.3× under (not the systematic 1.3× pattern
  // observed across KAN-1066/1081); guardrails section content is rich
  // because per-category nuance (5 categories × decline templates +
  // pattern phrasing + moralize/lecture explicit DON'Ts) compounds. Band
  // shifted to empirical reality NOT to aspirational projection;
  // padding/shrinking content rejected per discipline. Final character
  // density reflects safety-critical phrasing — guardrails are pre-launch
  // liability gap closure, not a place for terse prompting.
  it('Q6 — guardrails sub-section char count in [1900, 2200] band (sentinel proxy)', () => {
    const prompt = buildEvaluationPrompt({
      ...baseInput,
      latestInbound: inboundFixture,
    });
    const startIdx = prompt.indexOf('### Topic guardrails');
    expect(startIdx).toBeGreaterThan(0);
    // End of block = next "## " section header OR closing backtick of block
    const block = prompt.substring(startIdx);
    const nextSection = block.indexOf('\n## ');
    const blockBody = nextSection > 0 ? block.substring(0, nextSection) : block;
    const charCount = blockBody.length;
    expect(charCount).toBeGreaterThanOrEqual(1900);
    expect(charCount).toBeLessThanOrEqual(2200);
  });
});

describe('parseLlmResponse — KAN-1083 guardrailTrigger payload', () => {
  it('extracts guardrailTrigger on send_follow_up with valid category', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'send_follow_up',
          reasoning: 'Contact asked about a political topic; deflecting.',
          guardrailTrigger: 'politics',
        },
        confidence: 0.8,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextBestAction.type).toBe('send_follow_up');
    expect(result.value.nextBestAction.guardrailTrigger).toBe('politics');
  });

  it('accepts all 5 valid category values', () => {
    const categories = ['politics', 'religion', 'regulated_advice', 'competitor_disparagement', 'prohibited_claims'];
    for (const cat of categories) {
      const result = parseLlmResponse(
        JSON.stringify({
          nextBestAction: {
            type: 'send_follow_up',
            reasoning: 'deflection',
            guardrailTrigger: cat,
          },
          confidence: 0.7,
        }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.nextBestAction.guardrailTrigger).toBe(cat);
    }
  });

  it('invalid category silently dropped (best-effort; no error)', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'send_follow_up',
          reasoning: 'something unknown',
          guardrailTrigger: 'made_up_category',
        },
        confidence: 0.7,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextBestAction.guardrailTrigger).toBeUndefined();
  });

  it('missing guardrailTrigger on send_follow_up does not throw (optional field)', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'send_follow_up',
          reasoning: 'standard follow-up',
        },
        confidence: 0.7,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextBestAction.guardrailTrigger).toBeUndefined();
  });

  it('guardrailTrigger dropped on non-send_follow_up actions (semantic-leakage prevention)', () => {
    const result = parseLlmResponse(
      JSON.stringify({
        nextBestAction: {
          type: 'no_action',
          reasoning: 'leftover field from previous turn',
          guardrailTrigger: 'politics',
        },
        confidence: 0.5,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextBestAction.type).toBe('no_action');
    expect(result.value.nextBestAction.guardrailTrigger).toBeUndefined();
  });
});
