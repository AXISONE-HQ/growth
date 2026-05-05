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
      company: 'Acme Inc',
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
      company: null,
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
});
