/**
 * KAN-795 — Pipeline Router tests (Phase 2 epic 2 of 5, sub-cohort a).
 *
 * 15 tests covering: NotFoundError, 0-Pipeline short-circuit, 1-Pipeline
 * short-circuit, multi-Pipeline LLM-driven route, ambiguous LLM escalate,
 * LLM throws, malformed JSON, pipelineId-not-in-candidates rejection,
 * escalate decision propagation, tier override + tenantId propagation,
 * callerTag verification, candidatePipelines snapshot, token propagation,
 * confidence range validation.
 *
 * Follows sibling-service test convention (lead-normalizer.test.ts pattern):
 * mock llm-client via vi.mock + hand-rolled prisma mocks via vi.fn().
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const llmCompleteMock = vi.fn();
vi.mock('../llm-client.js', () => ({
  complete: (...args: unknown[]) => llmCompleteMock(...args),
}));

import {
  routePipelineForNewLead,
  parseRoutingResponse,
  PipelineRouterNotFoundError,
  type PipelineCandidate,
} from '../pipeline-router.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const CONTACT_A = 'contact_a';
const PIPELINE_HUBSPOT = 'pipe-hubspot';
const PIPELINE_META = 'pipe-meta';
const PIPELINE_DEFAULT = 'pipe-default';

interface PrismaMockOpts {
  contact: unknown | null;
  pipelines: PipelineCandidate[];
}

function makePrismaMock(opts: PrismaMockOpts) {
  const findUniqueContact = vi.fn(async () => opts.contact);
  const findManyPipelines = vi.fn(async () => opts.pipelines);
  const prisma = {
    contact: { findUnique: findUniqueContact },
    pipeline: { findMany: findManyPipelines },
  } as unknown as PrismaClient;
  return { prisma, findUniqueContact, findManyPipelines };
}

function defaultContact(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: CONTACT_A,
    tenantId: TENANT_A,
    email: 'alice@acme.com',
    lifecycleStage: 'qualified',
    segment: 'enterprise',
    source: 'manual',
    dataQualityScore: 75,
    externalIds: {},
    ...overrides,
  };
}

function mockLLMOk(payload: Record<string, unknown>, tokens = { input: 320, output: 80 }): void {
  llmCompleteMock.mockResolvedValueOnce({
    text: JSON.stringify(payload),
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    latencyMs: 900,
    fallbackUsed: false,
  });
}

beforeEach(() => {
  llmCompleteMock.mockReset();
});

// ─────────────────────────────────────────────
// 1. NotFoundError
// ─────────────────────────────────────────────

describe('routePipelineForNewLead — NotFoundError', () => {
  it('throws PipelineRouterNotFoundError when contactId does not exist', async () => {
    const { prisma } = makePrismaMock({ contact: null, pipelines: [] });
    await expect(routePipelineForNewLead(prisma, 'missing-contact-id')).rejects.toThrow(
      PipelineRouterNotFoundError,
    );
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 2. 0-Pipeline short-circuit
// ─────────────────────────────────────────────

describe('routePipelineForNewLead — 0-Pipeline short-circuit', () => {
  it('0-Pipeline tenant → no_candidates, no LLM call, confidence=1.0, zero tokens', async () => {
    const { prisma } = makePrismaMock({ contact: defaultContact(), pipelines: [] });

    const result = await routePipelineForNewLead(prisma, CONTACT_A);

    expect(result.decision.type).toBe('no_candidates');
    expect(result.confidence).toBe(1.0);
    expect(result.llmInputTokens).toBe(0);
    expect(result.llmOutputTokens).toBe(0);
    expect(result.candidatePipelines).toEqual([]);
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 3. 1-Pipeline short-circuit
// ─────────────────────────────────────────────

describe('routePipelineForNewLead — 1-Pipeline short-circuit (cost win)', () => {
  it('1-Pipeline tenant → route to that Pipeline, no LLM call, confidence=1.0, zero tokens', async () => {
    const onlyPipeline: PipelineCandidate = {
      id: PIPELINE_HUBSPOT,
      name: 'HubSpot Sales',
      objectiveType: 'send_quote',
      objectiveDescription: null,
    };
    const { prisma } = makePrismaMock({ contact: defaultContact(), pipelines: [onlyPipeline] });

    const result = await routePipelineForNewLead(prisma, CONTACT_A);

    expect(result.decision.type).toBe('route');
    expect((result.decision as { pipelineId: string }).pipelineId).toBe(PIPELINE_HUBSPOT);
    expect(result.confidence).toBe(1.0);
    expect(result.llmInputTokens).toBe(0);
    expect(result.llmOutputTokens).toBe(0);
    expect(result.candidatePipelines).toEqual([onlyPipeline]);
    expect(llmCompleteMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// 4. Multi-Pipeline LLM-driven route
// ─────────────────────────────────────────────

describe('routePipelineForNewLead — multi-Pipeline LLM route', () => {
  it('2-Pipeline tenant + clear LLM choice → route with chosen pipelineId + tokens propagate', async () => {
    const candidates: PipelineCandidate[] = [
      { id: PIPELINE_HUBSPOT, name: 'HubSpot Sales', objectiveType: 'send_quote', objectiveDescription: 'Quote-to-close path' },
      { id: PIPELINE_META, name: 'Meta Lead Ads', objectiveType: 'warm_up_lead', objectiveDescription: 'Warm cold inbound' },
    ];
    const { prisma } = makePrismaMock({ contact: defaultContact(), pipelines: candidates });
    mockLLMOk(
      {
        decision: {
          type: 'route',
          pipelineId: PIPELINE_HUBSPOT,
          reasoning: 'Enterprise + qualified → quote path.',
        },
        confidence: 0.78,
      },
      { input: 425, output: 95 },
    );

    const result = await routePipelineForNewLead(prisma, CONTACT_A);

    expect(result.decision.type).toBe('route');
    expect((result.decision as { pipelineId: string }).pipelineId).toBe(PIPELINE_HUBSPOT);
    expect(result.confidence).toBe(0.78);
    expect(result.llmInputTokens).toBe(425);
    expect(result.llmOutputTokens).toBe(95);
    expect(result.candidatePipelines).toEqual(candidates);
  });
});

// ─────────────────────────────────────────────
// 5. Ambiguous LLM → escalate
// ─────────────────────────────────────────────

describe('routePipelineForNewLead — LLM escalate', () => {
  it('3-Pipeline tenant + ambiguous LLM (escalate decision) → escalate propagated', async () => {
    const candidates: PipelineCandidate[] = [
      { id: PIPELINE_HUBSPOT, name: 'HubSpot', objectiveType: 'send_quote', objectiveDescription: null },
      { id: PIPELINE_META, name: 'Meta', objectiveType: 'warm_up_lead', objectiveDescription: null },
      { id: PIPELINE_DEFAULT, name: 'Default', objectiveType: 'book_appointment', objectiveDescription: null },
    ];
    const { prisma } = makePrismaMock({ contact: defaultContact(), pipelines: candidates });
    mockLLMOk({
      decision: { type: 'escalate', reasoning: 'Multiple equally-good fits; need human judgment.' },
      confidence: 0.3,
    });

    const result = await routePipelineForNewLead(prisma, CONTACT_A);

    expect(result.decision.type).toBe('escalate');
    expect(result.decision.reasoning).toContain('equally-good');
    expect(result.confidence).toBe(0.3);
  });
});

// ─────────────────────────────────────────────
// 6. LLM throws → graceful escalate
// ─────────────────────────────────────────────

describe('routePipelineForNewLead — graceful fallback on LLM throw', () => {
  it('LLM throws → escalate decision, confidence=0, zero tokens', async () => {
    const candidates: PipelineCandidate[] = [
      { id: PIPELINE_HUBSPOT, name: 'HubSpot', objectiveType: 'send_quote', objectiveDescription: null },
      { id: PIPELINE_META, name: 'Meta', objectiveType: 'warm_up_lead', objectiveDescription: null },
    ];
    const { prisma } = makePrismaMock({ contact: defaultContact(), pipelines: candidates });
    llmCompleteMock.mockRejectedValueOnce(new Error('upstream timeout'));

    const result = await routePipelineForNewLead(prisma, CONTACT_A);

    expect(result.decision.type).toBe('escalate');
    expect(result.confidence).toBe(0);
    expect(result.llmInputTokens).toBe(0);
    expect(result.llmOutputTokens).toBe(0);
    expect(result.decision.reasoning).toContain('LLM call failed');
  });
});

// ─────────────────────────────────────────────
// 7. Malformed JSON → graceful escalate
// ─────────────────────────────────────────────

describe('routePipelineForNewLead — graceful fallback on malformed JSON', () => {
  it('LLM returns non-JSON garbage → escalate, confidence=0, zero tokens', async () => {
    const candidates: PipelineCandidate[] = [
      { id: PIPELINE_HUBSPOT, name: 'HubSpot', objectiveType: 'send_quote', objectiveDescription: null },
      { id: PIPELINE_META, name: 'Meta', objectiveType: 'warm_up_lead', objectiveDescription: null },
    ];
    const { prisma } = makePrismaMock({ contact: defaultContact(), pipelines: candidates });
    llmCompleteMock.mockResolvedValueOnce({
      text: 'I think you should pick HubSpot, definitely.',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 300,
      outputTokens: 25,
      latencyMs: 800,
      fallbackUsed: false,
    });

    const result = await routePipelineForNewLead(prisma, CONTACT_A);

    expect(result.decision.type).toBe('escalate');
    expect(result.confidence).toBe(0);
    expect(result.llmInputTokens).toBe(0);
    expect(result.llmOutputTokens).toBe(0);
  });
});

// ─────────────────────────────────────────────
// 8. pipelineId not in candidates → graceful escalate (defensive)
// ─────────────────────────────────────────────

describe('routePipelineForNewLead — defensive pipelineId membership check', () => {
  it('LLM returns valid JSON but pipelineId not in candidates → escalate', async () => {
    const candidates: PipelineCandidate[] = [
      { id: PIPELINE_HUBSPOT, name: 'HubSpot', objectiveType: 'send_quote', objectiveDescription: null },
      { id: PIPELINE_META, name: 'Meta', objectiveType: 'warm_up_lead', objectiveDescription: null },
    ];
    const { prisma } = makePrismaMock({ contact: defaultContact(), pipelines: candidates });
    mockLLMOk({
      decision: {
        type: 'route',
        pipelineId: 'hallucinated-pipeline-id',
        reasoning: 'Made up.',
      },
      confidence: 0.9,
    });

    const result = await routePipelineForNewLead(prisma, CONTACT_A);

    expect(result.decision.type).toBe('escalate');
    expect(result.confidence).toBe(0);
  });
});

// ─────────────────────────────────────────────
// 9. Tier override propagates + tenantId propagates (KAN-745 alignment)
// ─────────────────────────────────────────────

describe('routePipelineForNewLead — tier + tenantId propagation', () => {
  it('explicit tier="cheap" propagates to llm.complete + BrainDecision.modelTier', async () => {
    const candidates: PipelineCandidate[] = [
      { id: PIPELINE_HUBSPOT, name: 'HubSpot', objectiveType: 'send_quote', objectiveDescription: null },
      { id: PIPELINE_META, name: 'Meta', objectiveType: 'warm_up_lead', objectiveDescription: null },
    ];
    const { prisma } = makePrismaMock({ contact: defaultContact(), pipelines: candidates });
    mockLLMOk({
      decision: { type: 'route', pipelineId: PIPELINE_META, reasoning: 'OK' },
      confidence: 0.6,
    });

    const result = await routePipelineForNewLead(prisma, CONTACT_A, { tier: 'cheap' });

    expect(result.modelTier).toBe('cheap');
    const callArg = llmCompleteMock.mock.calls[0]![0] as { tier: string; tenantId: string; callerTag: string };
    expect(callArg.tier).toBe('cheap');
    expect(callArg.tenantId).toBe(TENANT_A);
    expect(callArg.callerTag).toBe('pipeline-router:route-for-new-lead');
  });

  it('default tier is "reasoning" when option omitted (consequential routing posture)', async () => {
    const candidates: PipelineCandidate[] = [
      { id: PIPELINE_HUBSPOT, name: 'HubSpot', objectiveType: 'send_quote', objectiveDescription: null },
      { id: PIPELINE_META, name: 'Meta', objectiveType: 'warm_up_lead', objectiveDescription: null },
    ];
    const { prisma } = makePrismaMock({ contact: defaultContact(), pipelines: candidates });
    mockLLMOk({
      decision: { type: 'route', pipelineId: PIPELINE_HUBSPOT, reasoning: 'OK' },
      confidence: 0.7,
    });

    await routePipelineForNewLead(prisma, CONTACT_A);

    const callArg = llmCompleteMock.mock.calls[0]![0] as { tier: string };
    expect(callArg.tier).toBe('reasoning');
  });
});

// ─────────────────────────────────────────────
// 10. candidatePipelines snapshot in output
// ─────────────────────────────────────────────

describe('routePipelineForNewLead — candidatePipelines snapshot', () => {
  it('candidatePipelines field populated with all loaded candidates (in order)', async () => {
    const candidates: PipelineCandidate[] = [
      { id: PIPELINE_HUBSPOT, name: 'HubSpot Sales', objectiveType: 'send_quote', objectiveDescription: 'Quote path' },
      { id: PIPELINE_META, name: 'Meta Lead Ads', objectiveType: 'warm_up_lead', objectiveDescription: null },
    ];
    const { prisma } = makePrismaMock({ contact: defaultContact(), pipelines: candidates });
    mockLLMOk({
      decision: { type: 'route', pipelineId: PIPELINE_HUBSPOT, reasoning: 'OK' },
      confidence: 0.7,
    });

    const result = await routePipelineForNewLead(prisma, CONTACT_A);

    expect(result.candidatePipelines).toEqual(candidates);
  });
});

// ─────────────────────────────────────────────
// 11. Confidence range — parser rejects out-of-range values
// ─────────────────────────────────────────────

describe('parseRoutingResponse — confidence range validation', () => {
  const candidates: PipelineCandidate[] = [
    { id: PIPELINE_HUBSPOT, name: 'HubSpot', objectiveType: 'send_quote', objectiveDescription: null },
  ];

  it('rejects confidence > 1', () => {
    const result = parseRoutingResponse(
      JSON.stringify({
        decision: { type: 'route', pipelineId: PIPELINE_HUBSPOT, reasoning: 'OK' },
        confidence: 1.5,
      }),
      candidates,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects confidence < 0', () => {
    const result = parseRoutingResponse(
      JSON.stringify({
        decision: { type: 'route', pipelineId: PIPELINE_HUBSPOT, reasoning: 'OK' },
        confidence: -0.5,
      }),
      candidates,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects empty reasoning', () => {
    const result = parseRoutingResponse(
      JSON.stringify({
        decision: { type: 'route', pipelineId: PIPELINE_HUBSPOT, reasoning: '' },
        confidence: 0.5,
      }),
      candidates,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects invalid decision type', () => {
    const result = parseRoutingResponse(
      JSON.stringify({
        decision: { type: 'send_carrier_pigeon', reasoning: 'OK' },
        confidence: 0.5,
      }),
      candidates,
    );
    expect(result.ok).toBe(false);
  });

  it('strips ```json fences', () => {
    const result = parseRoutingResponse(
      `\`\`\`json\n${JSON.stringify({
        decision: { type: 'escalate', reasoning: 'OK' },
        confidence: 0.5,
      })}\n\`\`\``,
      candidates,
    );
    expect(result.ok).toBe(true);
  });
});
