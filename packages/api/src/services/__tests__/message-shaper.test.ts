/**
 * KAN-797a — Message Shaper tests (Phase 2 epic 4 of 5, sub-cohort a).
 *
 * 22 vitest cases (with 5 collapsed into one parametrized it.each) covering:
 * NotFound, all 6 BrainActionType branches, 3 channels (email/sms/meta_messenger),
 * forceChannel override, tone fallback, anti-repetition context counts,
 * brainDecision-prepass-vs-recompute, LLM throw/parse-fail/strict-reject edge cases.
 *
 * brain-service + llm-client mocked via vi.mock per sibling convention. Prisma mocked
 * via hand-rolled vi.fn() per sibling convention.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const evaluateDealStateMock = vi.fn();
const llmCompleteMock = vi.fn();
vi.mock('../brain-service.js', () => ({
  evaluateDealState: (...args: unknown[]) => evaluateDealStateMock(...args),
}));
vi.mock('../llm-client.js', () => ({
  complete: (...args: unknown[]) => llmCompleteMock(...args),
}));

import {
  shapeMessage,
  parseShapeResponse,
  MessageShaperDealNotFoundError,
} from '../message-shaper.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const DEAL_A = 'deal_a';
const CONTACT_A = 'contact_a';
const PIPELINE_A = 'pipeline_a';
const STAGE_NEW = 'stage_new';

interface DealFixtureOpts {
  recentOutbound?: Array<{
    occurredAt: Date;
    engagementType: string;
    channel?: string | null;
    metadata?: Record<string, unknown>;
  }>;
}

function buildDealFixture(opts: DealFixtureOpts = {}) {
  return {
    id: DEAL_A,
    tenantId: TENANT_A,
    contactId: CONTACT_A,
    pipelineId: PIPELINE_A,
    currentStageId: STAGE_NEW,
    contact: {
      id: CONTACT_A,
      tenantId: TENANT_A,
      email: 'alice@acme.com',
      firstName: 'Alice',
      lastName: 'Smith',
      company: 'Acme Inc',
    },
    pipeline: { name: 'Default Sales Pipeline', objectiveType: 'warm_up_lead', objectiveDescription: null },
    currentStage: { name: 'New', outcomeType: 'open' },
    engagements: (opts.recentOutbound ?? []).map((e, i) => ({
      id: `eng_${i}`,
      tenantId: TENANT_A,
      dealId: DEAL_A,
      contactId: CONTACT_A,
      ...e,
      channel: e.channel ?? null,
      metadata: e.metadata ?? {},
    })),
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
  suggestedChannel?: 'email' | 'sms' | 'meta_messenger';
  suggestedTone?: 'curious' | 'professional' | 'urgent' | 'closing';
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
      ...(overrides.suggestedChannel && { suggestedChannel: overrides.suggestedChannel }),
      ...(overrides.suggestedTone && { suggestedTone: overrides.suggestedTone }),
    },
    confidence: 0.8,
    modelTier: 'reasoning' as const,
    llmInputTokens: 400,
    llmOutputTokens: 100,
  };
}

function makePrismaMock(deal: unknown | null) {
  const findUnique = vi.fn(async () => deal);
  const prisma = {
    deal: { findUnique },
  } as unknown as PrismaClient;
  return { prisma, findUnique };
}

function mockLLMOk(payload: Record<string, unknown>, tokens = { input: 480, output: 140 }): void {
  llmCompleteMock.mockResolvedValueOnce({
    text: JSON.stringify(payload),
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    latencyMs: 1100,
    fallbackUsed: false,
  });
}

beforeEach(() => {
  evaluateDealStateMock.mockReset();
  llmCompleteMock.mockReset();
});

// ─────────────────────────────────────────────
// 1. NotFound (Brain Service throws first when re-evaluating; if brainDecision passed and
//    Deal lookup misses, message-shaper throws its own NotFound)
// ─────────────────────────────────────────────

describe('shapeMessage — NotFound', () => {
  it('throws MessageShaperDealNotFoundError when Deal lookup returns null (brainDecision pre-passed)', async () => {
    const { prisma } = makePrismaMock(null);
    const brain = buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'email' });
    await expect(shapeMessage(prisma, 'missing-deal-id', { brainDecision: brain })).rejects.toThrow(
      MessageShaperDealNotFoundError,
    );
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 2-6. Non-send_follow_up Brain actions → no_shape (parametrized)
// ─────────────────────────────────────────────

describe('shapeMessage — non-shape Brain actions', () => {
  it.each([
    ['advance_stage'],
    ['wait_for_response'],
    ['escalate_to_human'],
    ['close_deal_lost'],
    ['no_action'],
  ] as const)('Brain returns %s → no_shape (no LLM compose)', async (actionType) => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(buildBrainDecision({ type: actionType }));

    const result = await shapeMessage(prisma, DEAL_A);

    expect(result.type).toBe('no_shape');
    expect((result as { reason: string }).reason).toContain(actionType);
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 7. send_follow_up + email channel → shaped with subject + body
// ─────────────────────────────────────────────

describe('shapeMessage — email channel', () => {
  it('Brain send_follow_up + email → ShapedMessage with subject + body + tone + tokens', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({
        type: 'send_follow_up',
        suggestedChannel: 'email',
        suggestedTone: 'curious',
        reasoning: 'Lead is warm; ask discovery questions.',
      }),
    );
    mockLLMOk(
      {
        subject: 'Quick question about your evaluation',
        body: 'Hi Alice — saw your reply yesterday. Curious what specifically caught your eye?',
        rationale: 'Open-ended discovery to learn what they value.',
      },
      { input: 510, output: 95 },
    );

    const result = await shapeMessage(prisma, DEAL_A);

    expect(result.type).toBe('shaped');
    const msg = (result as { message: any }).message;
    expect(msg.channel).toBe('email');
    expect(msg.subject).toBe('Quick question about your evaluation');
    expect(msg.body).toContain('Alice');
    expect(msg.tone).toBe('curious');
    expect(msg.rationale).toContain('discovery');
    expect(msg.llmInputTokens).toBe(510);
    expect(msg.llmOutputTokens).toBe(95);
    expect(msg.modelTier).toBe('reasoning');
  });
});

// ─────────────────────────────────────────────
// 8. send_follow_up + sms channel → shaped with body only, maxTokens=200
// ─────────────────────────────────────────────

describe('shapeMessage — sms channel', () => {
  it('Brain send_follow_up + sms → ShapedMessage with body only (no subject); maxTokens=200', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'sms', suggestedTone: 'urgent' }),
    );
    mockLLMOk({
      subject: null,
      body: 'Hi Alice, quick check — still interested in chatting this week?',
      rationale: 'Short urgent nudge, no commitment ask.',
    });

    const result = await shapeMessage(prisma, DEAL_A);

    expect(result.type).toBe('shaped');
    const msg = (result as { message: any }).message;
    expect(msg.channel).toBe('sms');
    expect(msg.subject).toBeUndefined();
    expect(msg.body.length).toBeLessThanOrEqual(160);

    // maxTokens=200 verified via call args.
    const callArgs = llmCompleteMock.mock.calls[0]![0] as { maxTokens: number; callerTag: string };
    expect(callArgs.maxTokens).toBe(200);
    expect(callArgs.callerTag).toBe('message-shaper:shape-sms');
  });
});

// ─────────────────────────────────────────────
// 9. send_follow_up + meta_messenger → shaped with body only
// ─────────────────────────────────────────────

describe('shapeMessage — meta_messenger channel', () => {
  it('Brain send_follow_up + meta_messenger → ShapedMessage with body only', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'meta_messenger' }),
    );
    mockLLMOk({
      body: 'Hi Alice, following up on the demo request — happy to schedule whenever works for you.',
      rationale: 'Conversational follow-up appropriate for messenger.',
    });

    const result = await shapeMessage(prisma, DEAL_A);

    expect(result.type).toBe('shaped');
    const msg = (result as { message: any }).message;
    expect(msg.channel).toBe('meta_messenger');
    expect(msg.subject).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// 10. forceChannel override
// ─────────────────────────────────────────────

describe('shapeMessage — forceChannel override', () => {
  it('options.forceChannel="sms" overrides Brain suggestedChannel="email"', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'email' }),
    );
    mockLLMOk({ body: 'Quick text override test.', rationale: 'forceChannel test.' });

    const result = await shapeMessage(prisma, DEAL_A, { forceChannel: 'sms' });

    expect(result.type).toBe('shaped');
    const msg = (result as { message: any }).message;
    expect(msg.channel).toBe('sms');
    const callArgs = llmCompleteMock.mock.calls[0]![0] as { callerTag: string; maxTokens: number };
    expect(callArgs.callerTag).toBe('message-shaper:shape-sms');
    expect(callArgs.maxTokens).toBe(200);
  });
});

// ─────────────────────────────────────────────
// 11. Tone propagation — Brain "curious" lands in prompt + ShapedMessage.tone
// ─────────────────────────────────────────────

describe('shapeMessage — tone propagation', () => {
  it('Brain suggestedTone="curious" propagates to ShapedMessage.tone + prompt body', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'email', suggestedTone: 'curious' }),
    );
    mockLLMOk({ subject: 'test', body: 'test body', rationale: 'test.' });

    const result = await shapeMessage(prisma, DEAL_A);

    expect((result as { message: any }).message.tone).toBe('curious');
    const callArgs = llmCompleteMock.mock.calls[0]![0] as { userPrompt: string };
    expect(callArgs.userPrompt).toContain('Tone: curious');
  });
});

// ─────────────────────────────────────────────
// 12. Tone fallback — Brain omits suggestedTone → defaults to "professional"
// ─────────────────────────────────────────────

describe('shapeMessage — tone fallback', () => {
  it('Brain omits suggestedTone → defaults to "professional"', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'email' }),
    );
    mockLLMOk({ subject: 'test', body: 'test body', rationale: 'test.' });

    const result = await shapeMessage(prisma, DEAL_A);

    expect((result as { message: any }).message.tone).toBe('professional');
  });
});

// ─────────────────────────────────────────────
// 13. Channel fallback — Brain omits suggestedChannel → defaults to "email"
// ─────────────────────────────────────────────

describe('shapeMessage — channel fallback', () => {
  it('Brain omits suggestedChannel → defaults to "email" (subject required)', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(buildBrainDecision({ type: 'send_follow_up' }));
    mockLLMOk({ subject: 'Default channel test', body: 'body', rationale: 'rationale.' });

    const result = await shapeMessage(prisma, DEAL_A);

    expect(result.type).toBe('shaped');
    const msg = (result as { message: any }).message;
    expect(msg.channel).toBe('email');
    expect(msg.subject).toBe('Default channel test');
  });
});

// ─────────────────────────────────────────────
// 14. Anti-repetition context loaded — 3 outbound → antiRepetitionContextCount=3
// ─────────────────────────────────────────────

describe('shapeMessage — anti-repetition context', () => {
  it('Deal with 3 recent outbound → antiRepetitionContextCount=3 + outbound rendered in prompt', async () => {
    const fixture = buildDealFixture({
      recentOutbound: [
        {
          occurredAt: new Date('2026-04-25T12:00:00Z'),
          engagementType: 'email_send',
          channel: 'email',
          metadata: { subject: 'First nudge', bodyPreview: 'Hi Alice, just checking in...' },
        },
        {
          occurredAt: new Date('2026-04-22T12:00:00Z'),
          engagementType: 'email_send',
          channel: 'email',
          metadata: { subject: 'Initial outreach', bodyPreview: 'Hi Alice, saw your interest...' },
        },
        {
          occurredAt: new Date('2026-04-19T12:00:00Z'),
          engagementType: 'email_send',
          channel: 'email',
          metadata: { subject: 'Welcome', bodyPreview: 'Welcome to Acme onboarding flow.' },
        },
      ],
    });
    const { prisma } = makePrismaMock(fixture);
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'email' }),
    );
    mockLLMOk({ subject: 'Fresh angle', body: 'Trying a new approach.', rationale: 'Avoiding repetition.' });

    const result = await shapeMessage(prisma, DEAL_A);

    const msg = (result as { message: any }).message;
    expect(msg.antiRepetitionContextCount).toBe(3);

    // Verify all 3 outbound subjects appeared in the prompt's anti-repetition block.
    const callArgs = llmCompleteMock.mock.calls[0]![0] as { userPrompt: string };
    expect(callArgs.userPrompt).toContain('First nudge');
    expect(callArgs.userPrompt).toContain('Initial outreach');
    expect(callArgs.userPrompt).toContain('Welcome');
  });
});

// ─────────────────────────────────────────────
// 15. Anti-repetition context limit — recentOutboundLimit=5 caps to 5
// ─────────────────────────────────────────────

describe('shapeMessage — anti-repetition limit', () => {
  it('recentOutboundLimit=2 → only 2 recent outbound loaded (Prisma take=2)', async () => {
    const { prisma, findUnique } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'email' }),
    );
    mockLLMOk({ subject: 'test', body: 'body', rationale: 'r.' });

    await shapeMessage(prisma, DEAL_A, { recentOutboundLimit: 2 });

    // Verify the include.engagements.take was 2.
    const findArgs = findUnique.mock.calls[0]![0] as { include: { engagements: { take: number } } };
    expect(findArgs.include.engagements.take).toBe(2);
  });
});

// ─────────────────────────────────────────────
// 16. Empty anti-repetition context — antiRepetitionContextCount=0
// ─────────────────────────────────────────────

describe('shapeMessage — empty anti-repetition context', () => {
  it('Deal with 0 prior outbound → antiRepetitionContextCount=0 (first-outbound case)', async () => {
    const { prisma } = makePrismaMock(buildDealFixture({ recentOutbound: [] }));
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'email' }),
    );
    mockLLMOk({ subject: 'Welcome', body: 'First outbound.', rationale: 'First contact.' });

    const result = await shapeMessage(prisma, DEAL_A);

    const msg = (result as { message: any }).message;
    expect(msg.antiRepetitionContextCount).toBe(0);
  });
});

// ─────────────────────────────────────────────
// 17. brainDecision pre-pass → no Brain re-eval
// ─────────────────────────────────────────────

describe('shapeMessage — brainDecision pre-pass', () => {
  it('options.brainDecision provided → evaluateDealState NOT called (avoids double Brain eval)', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    const prePassedBrain = buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'email' });
    mockLLMOk({ subject: 'test', body: 'body', rationale: 'r.' });

    await shapeMessage(prisma, DEAL_A, { brainDecision: prePassedBrain });

    expect(evaluateDealStateMock).not.toHaveBeenCalled();
    expect(llmCompleteMock).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────
// 18. brainDecision NOT provided → Brain re-eval fires with correct dealId
// ─────────────────────────────────────────────

describe('shapeMessage — Brain re-eval', () => {
  it('options.brainDecision omitted → evaluateDealState called with dealId', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'email' }),
    );
    mockLLMOk({ subject: 'test', body: 'body', rationale: 'r.' });

    await shapeMessage(prisma, DEAL_A);

    expect(evaluateDealStateMock).toHaveBeenCalledOnce();
    expect(evaluateDealStateMock.mock.calls[0]![1]).toBe(DEAL_A);
  });
});

// ─────────────────────────────────────────────
// 19. LLM throws → gracefulNoShape
// ─────────────────────────────────────────────

describe('shapeMessage — graceful fallback on LLM throw', () => {
  it('LLM throws → no_shape with reason "LLM call failed"', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'email' }),
    );
    llmCompleteMock.mockRejectedValueOnce(new Error('upstream timeout'));

    const result = await shapeMessage(prisma, DEAL_A);

    expect(result.type).toBe('no_shape');
    expect((result as { reason: string }).reason).toContain('LLM call failed');
  });
});

// ─────────────────────────────────────────────
// 20. LLM returns malformed JSON → gracefulNoShape
// ─────────────────────────────────────────────

describe('shapeMessage — graceful fallback on malformed JSON', () => {
  it('LLM returns non-JSON garbage → no_shape with parse error reason', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'email' }),
    );
    llmCompleteMock.mockResolvedValueOnce({
      text: 'Hi Alice, you should write back soon.',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 400,
      outputTokens: 30,
      latencyMs: 800,
      fallbackUsed: false,
    });

    const result = await shapeMessage(prisma, DEAL_A);

    expect(result.type).toBe('no_shape');
    expect((result as { reason: string }).reason).toContain('LLM response invalid');
  });
});

// ─────────────────────────────────────────────
// 21. Email response missing subject → STRICT REJECT (gracefulNoShape)
// ─────────────────────────────────────────────

describe('shapeMessage — strict-reject email missing subject', () => {
  it('email channel + LLM omits subject → no_shape with reason "email missing required subject"', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'email' }),
    );
    mockLLMOk({ body: 'Hi Alice, just checking in.', rationale: 'follow up.' });
    // no subject field at all

    const result = await shapeMessage(prisma, DEAL_A);

    expect(result.type).toBe('no_shape');
    expect((result as { reason: string }).reason).toContain('email missing required subject');
  });

  it('email channel + LLM returns subject="" empty string → STRICT REJECT', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'email' }),
    );
    mockLLMOk({ subject: '   ', body: 'Body present.', rationale: 'r.' });

    const result = await shapeMessage(prisma, DEAL_A);

    expect(result.type).toBe('no_shape');
    expect((result as { reason: string }).reason).toContain('email missing required subject');
  });
});

// ─────────────────────────────────────────────
// 22. SMS body > 160 chars → STRICT REJECT (gracefulNoShape)
// ─────────────────────────────────────────────

describe('shapeMessage — strict-reject SMS too long', () => {
  it('sms channel + body > 160 chars → no_shape with reason "SMS body exceeds 160 chars"', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'sms' }),
    );
    const longBody = 'A'.repeat(161);
    mockLLMOk({ body: longBody, rationale: 'too long.' });

    const result = await shapeMessage(prisma, DEAL_A);

    expect(result.type).toBe('no_shape');
    expect((result as { reason: string }).reason).toContain('SMS body exceeds 160 chars');
  });

  it('sms channel + body exactly 160 chars → ACCEPTED (boundary)', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'sms' }),
    );
    const exactBody = 'A'.repeat(160);
    mockLLMOk({ body: exactBody, rationale: 'exact length.' });

    const result = await shapeMessage(prisma, DEAL_A);

    expect(result.type).toBe('shaped');
    expect((result as { message: any }).message.body.length).toBe(160);
  });
});

// ─────────────────────────────────────────────
// Tier propagation + tenantId (KAN-745 alignment)
// ─────────────────────────────────────────────

describe('shapeMessage — tier + tenantId propagation', () => {
  it('explicit tier="cheap" propagates to llm.complete + ShapedMessage.modelTier', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'email' }),
    );
    mockLLMOk({ subject: 't', body: 'b', rationale: 'r.' });

    const result = await shapeMessage(prisma, DEAL_A, { tier: 'cheap' });

    const callArgs = llmCompleteMock.mock.calls[0]![0] as { tier: string; tenantId: string };
    expect(callArgs.tier).toBe('cheap');
    expect(callArgs.tenantId).toBe(TENANT_A);
    expect((result as { message: any }).message.modelTier).toBe('cheap');
  });

  it('default tier is "reasoning" when option omitted (consequential message-quality posture)', async () => {
    const { prisma } = makePrismaMock(buildDealFixture());
    evaluateDealStateMock.mockResolvedValueOnce(
      buildBrainDecision({ type: 'send_follow_up', suggestedChannel: 'email' }),
    );
    mockLLMOk({ subject: 't', body: 'b', rationale: 'r.' });

    await shapeMessage(prisma, DEAL_A);

    const callArgs = llmCompleteMock.mock.calls[0]![0] as { tier: string };
    expect(callArgs.tier).toBe('reasoning');
  });
});

// ─────────────────────────────────────────────
// parseShapeResponse direct unit tests (exported for introspection)
// ─────────────────────────────────────────────

describe('parseShapeResponse', () => {
  it('strips ```json fences', () => {
    const result = parseShapeResponse(
      '```json\n{"subject":"S","body":"B","rationale":"R"}\n```',
      'email',
    );
    expect(result.ok).toBe(true);
  });

  it('rejects missing body', () => {
    const result = parseShapeResponse(
      JSON.stringify({ subject: 'S', rationale: 'R' }),
      'email',
    );
    expect(result.ok).toBe(false);
  });

  it('rejects missing rationale', () => {
    const result = parseShapeResponse(
      JSON.stringify({ subject: 'S', body: 'B' }),
      'email',
    );
    expect(result.ok).toBe(false);
  });

  it('email: rejects missing subject', () => {
    const result = parseShapeResponse(JSON.stringify({ body: 'B', rationale: 'R' }), 'email');
    expect(result.ok).toBe(false);
  });

  it('email: accepts subject + body + rationale', () => {
    const result = parseShapeResponse(
      JSON.stringify({ subject: 'S', body: 'B', rationale: 'R' }),
      'email',
    );
    expect(result.ok).toBe(true);
  });

  it('sms: rejects body > 160 chars', () => {
    const result = parseShapeResponse(
      JSON.stringify({ body: 'A'.repeat(161), rationale: 'R' }),
      'sms',
    );
    expect(result.ok).toBe(false);
  });

  it('sms: accepts body ≤ 160 chars (no subject required)', () => {
    const result = parseShapeResponse(
      JSON.stringify({ body: 'A'.repeat(159), rationale: 'R' }),
      'sms',
    );
    expect(result.ok).toBe(true);
  });

  it('meta_messenger: accepts body without subject + no length cap', () => {
    const result = parseShapeResponse(
      JSON.stringify({ body: 'A'.repeat(400), rationale: 'R' }),
      'meta_messenger',
    );
    expect(result.ok).toBe(true);
  });
});
