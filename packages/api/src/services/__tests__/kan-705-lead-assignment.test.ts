/**
 * Tests for KAN-705 — hybrid lead → pipeline assignment.
 *
 * Three layers of coverage:
 *
 *   1. Pure predicate language (matchesConditions): scalar / array-IN / operators (eq, ne, gte, lte, gt, lt, in)
 *   2. Pure rule walker (evaluateRules): priority order, isActive filter, first-match wins, empty-conditions catch-all
 *   3. AI fallback (aiAssignmentFallback): catalog rendering, JSON parse, unknown-pipeline-id rejection, confidence clamp
 *   4. Orchestrator (assignLeadToPipeline): rule branch + ai_fallback branch + each of 3 below-threshold postures
 *      (stay_unassigned, default_pipeline, escalate_to_human) + audit log shape + multi-tenant rule isolation
 *      + skipIfAssigned idempotency
 *
 * Note: tests against the orchestrator mock the Prisma client at the delegate
 * level. Real DB integration runs in a separate test runner once the
 * migration lands; these unit tests only assert the ORCHESTRATION shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type Anthropic from '@anthropic-ai/sdk';
import {
  matchesConditions,
  evaluateRules,
  aiAssignmentFallback,
  assignLeadToPipeline,
  type AssignmentRuleRow,
  type LeadAttributes,
  type PipelineSummary,
} from '../lead-assignment.js';
import { __setLLMClientsForTest } from '../llm-client.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const CONTACT_ID = '33333333-3333-3333-3333-333333333333';
const PIPELINE_HUBSPOT = 'pipe-hubspot';
const PIPELINE_META = 'pipe-meta';
const PIPELINE_DEFAULT = 'pipe-default';
const STAGE_INITIAL_HUBSPOT = 'stage-initial-hubspot';

beforeEach(() => {
  vi.restoreAllMocks();
  __setLLMClientsForTest({ anthropic: null, openai: null, pubsub: null });
});

// ─────────────────────────────────────────────
// Layer 1 — predicate language
// ─────────────────────────────────────────────

describe('matchesConditions predicate language', () => {
  const lead: LeadAttributes = {
    source: 'hubspot',
    segment: 'enterprise',
    lifecycleStage: 'qualified',
    dataQualityScore: 75,
    email: 'alice@acme.com',
    emailDomain: 'acme.com',
  };

  it('scalar equality match', () => {
    expect(matchesConditions(lead, { source: 'hubspot' })).toBe(true);
    expect(matchesConditions(lead, { source: 'meta' })).toBe(false);
  });

  it('array → IN match', () => {
    expect(matchesConditions(lead, { source: ['hubspot', 'meta', 'manual'] })).toBe(true);
    expect(matchesConditions(lead, { source: ['meta', 'manual'] })).toBe(false);
  });

  it('explicit eq operator', () => {
    expect(matchesConditions(lead, { source: { eq: 'hubspot' } })).toBe(true);
  });

  it('ne (not-equal) operator', () => {
    expect(matchesConditions(lead, { source: { ne: 'manual' } })).toBe(true);
    expect(matchesConditions(lead, { source: { ne: 'hubspot' } })).toBe(false);
  });

  it('numeric comparators (gte, lte, gt, lt)', () => {
    expect(matchesConditions(lead, { dataQualityScore: { gte: 70 } })).toBe(true);
    expect(matchesConditions(lead, { dataQualityScore: { gte: 80 } })).toBe(false);
    expect(matchesConditions(lead, { dataQualityScore: { lte: 75 } })).toBe(true);
    expect(matchesConditions(lead, { dataQualityScore: { gt: 75 } })).toBe(false);
    expect(matchesConditions(lead, { dataQualityScore: { lt: 76 } })).toBe(true);
  });

  it('explicit `in` operator', () => {
    expect(matchesConditions(lead, { lifecycleStage: { in: ['lead', 'qualified', 'sql'] } })).toBe(true);
    expect(matchesConditions(lead, { lifecycleStage: { in: ['lead', 'sql'] } })).toBe(false);
  });

  it('AND across multiple keys', () => {
    expect(
      matchesConditions(lead, { source: 'hubspot', segment: 'enterprise', dataQualityScore: { gte: 70 } }),
    ).toBe(true);
    // Any single failing key flips the whole condition.
    expect(
      matchesConditions(lead, { source: 'hubspot', segment: 'smb' }),
    ).toBe(false);
  });

  it('empty conditions object always matches (catch-all rule pattern)', () => {
    expect(matchesConditions(lead, {})).toBe(true);
  });

  it('unknown operator returns false (defensive)', () => {
    expect(matchesConditions(lead, { source: { weirdOp: 'hubspot' } })).toBe(false);
  });

  it('numeric comparators do not match non-numeric values', () => {
    expect(matchesConditions(lead, { source: { gte: 70 } })).toBe(false);
  });
});

// ─────────────────────────────────────────────
// Layer 2 — rule walker
// ─────────────────────────────────────────────

describe('evaluateRules priority + isActive', () => {
  const lead: LeadAttributes = { source: 'hubspot', segment: 'enterprise' };

  function rule(id: string, priority: number, conditions: Record<string, unknown>, isActive = true): AssignmentRuleRow {
    return { id, pipelineId: `pipe-${id}`, priority, conditions, isActive };
  }

  it('lower priority number wins on multi-match (priority sort asc)', () => {
    const out = evaluateRules(
      [
        rule('high', 100, { source: 'hubspot' }),
        rule('low', 1, { source: 'hubspot' }), // wins
        rule('mid', 50, { source: 'hubspot' }),
      ],
      lead,
    );
    expect(out?.id).toBe('low');
  });

  it('skips inactive rules even when they would match at higher priority', () => {
    const out = evaluateRules(
      [
        rule('inactive-high-pri', 1, { source: 'hubspot' }, false),
        rule('active', 50, { source: 'hubspot' }),
      ],
      lead,
    );
    expect(out?.id).toBe('active');
  });

  it('returns null on no-match', () => {
    const out = evaluateRules([rule('a', 1, { source: 'meta' })], lead);
    expect(out).toBeNull();
  });

  it('catch-all rule (empty conditions) at lowest priority captures all leads on miss', () => {
    const out = evaluateRules(
      [
        rule('specific', 10, { source: 'meta' }), // miss
        rule('catch-all', 1000, {}), // matches anything
      ],
      lead,
    );
    expect(out?.id).toBe('catch-all');
  });
});

// ─────────────────────────────────────────────
// Layer 3 — AI fallback
// ─────────────────────────────────────────────

function makeAnthropicMock(create: ReturnType<typeof vi.fn>) {
  return { messages: { create } } as unknown as Anthropic;
}

function anthropicJsonResponse(payload: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

describe('aiAssignmentFallback', () => {
  const pipelines: PipelineSummary[] = [
    { id: PIPELINE_HUBSPOT, name: 'HubSpot Sales', objectiveType: 'send_quote', objectiveDescription: 'Move qualified leads to a signed quote' },
    { id: PIPELINE_META, name: 'Meta Lead Ads', objectiveType: 'warm_up_lead', objectiveDescription: 'Warm cold inbound' },
  ];

  it('calls Sonnet (reasoning tier) and returns structured output', async () => {
    const create = vi.fn(async () =>
      anthropicJsonResponse({
        pipelineId: PIPELINE_HUBSPOT,
        confidence: 0.78,
        reasoning: 'Lead has enterprise segment + qualified stage — matches HubSpot Sales objective.',
      }),
    );
    __setLLMClientsForTest({ anthropic: makeAnthropicMock(create), pubsub: null });

    const out = await aiAssignmentFallback(
      { source: 'manual', segment: 'enterprise', lifecycleStage: 'qualified' },
      pipelines,
    );
    expect(out?.pipelineId).toBe(PIPELINE_HUBSPOT);
    expect(out?.confidence).toBe(0.78);
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-4-6' });
  });

  it('rejects LLM-returned pipelineId not in the catalog (defensive)', async () => {
    const create = vi.fn(async () =>
      anthropicJsonResponse({ pipelineId: 'hallucinated-pipe-id', confidence: 0.9, reasoning: '...' }),
    );
    __setLLMClientsForTest({ anthropic: makeAnthropicMock(create), pubsub: null });

    const out = await aiAssignmentFallback({ source: 'manual' }, pipelines);
    expect(out).toBeNull();
  });

  it('clamps confidence to [0, 1]', async () => {
    const create = vi.fn(async () =>
      anthropicJsonResponse({ pipelineId: PIPELINE_HUBSPOT, confidence: 1.5, reasoning: '...' }),
    );
    __setLLMClientsForTest({ anthropic: makeAnthropicMock(create), pubsub: null });

    const out = await aiAssignmentFallback({ source: 'manual' }, pipelines);
    expect(out?.confidence).toBe(1);
  });

  it('returns null on malformed LLM JSON', async () => {
    const create = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'not even json' }],
      usage: { input_tokens: 5, output_tokens: 5 },
    }));
    __setLLMClientsForTest({ anthropic: makeAnthropicMock(create), pubsub: null });

    const out = await aiAssignmentFallback({ source: 'manual' }, pipelines);
    expect(out).toBeNull();
  });

  it('returns null when pipeline catalog is empty (no-op)', async () => {
    const out = await aiAssignmentFallback({ source: 'manual' }, []);
    expect(out).toBeNull();
  });
});

// ─────────────────────────────────────────────
// Layer 4 — orchestrator
// ─────────────────────────────────────────────

interface PrismaMockState {
  contact: any;
  tenant: Partial<{
    belowThresholdPosture: string | null;
    defaultAssignmentPipelineId: string | null;
    aiAssignmentConfidenceThreshold: number | null;
  }>;
  rules: AssignmentRuleRow[];
  pipelines: PipelineSummary[];
  initialStageId: string | null;
}

function makePrismaMock(state: PrismaMockState) {
  const updateContact = vi.fn(async () => state.contact);
  const createAuditLog = vi.fn(async () => ({ id: 'audit-1' }));
  const createEscalation = vi.fn(async () => ({ id: 'esc-1' }));
  const findFirstStage = vi.fn(async () => (state.initialStageId ? { id: state.initialStageId } : null));
  const findAssignmentRules = vi.fn(async () => state.rules);
  const findPipelines = vi.fn(async () => state.pipelines);
  const createLeadStageHistory = vi.fn(async () => ({ id: 'lsh-1' }));

  const prisma: any = {
    contact: {
      findUnique: vi.fn(async () => state.contact),
      update: updateContact,
    },
    tenant: {
      findUnique: vi.fn(async () => state.tenant),
    },
    auditLog: { create: createAuditLog },
    escalation: { create: createEscalation },
    assignmentRule: { findMany: findAssignmentRules },
    pipeline: { findMany: findPipelines },
    stage: { findFirst: findFirstStage },
    leadStageHistory: { create: createLeadStageHistory },
  };

  return { prisma: prisma as PrismaClient, mocks: { updateContact, createAuditLog, createEscalation, findAssignmentRules, findPipelines, createLeadStageHistory } };
}

function defaultContact(overrides: Partial<PrismaMockState['contact']> = {}) {
  return {
    id: CONTACT_ID,
    tenantId: TENANT_A,
    source: 'hubspot',
    segment: 'enterprise',
    lifecycleStage: 'qualified',
    dataQualityScore: 75,
    email: 'alice@acme.com',
    externalIds: {},
    currentPipelineId: null,
    currentStageId: null,
    ...overrides,
  };
}

function rule(id: string, priority: number, conditions: Record<string, unknown>, pipelineId = PIPELINE_HUBSPOT): AssignmentRuleRow {
  return { id, pipelineId, priority, conditions, isActive: true };
}

describe('assignLeadToPipeline orchestrator — rule branch', () => {
  it('rule match → updates Contact + writes LeadStageHistory + emits audit log with mode=rule', async () => {
    const { prisma, mocks } = makePrismaMock({
      contact: defaultContact(),
      tenant: { aiAssignmentConfidenceThreshold: 0.5 },
      rules: [rule('rule-hubspot', 1, { source: 'hubspot' })],
      pipelines: [],
      initialStageId: STAGE_INITIAL_HUBSPOT,
    });

    const out = await assignLeadToPipeline(prisma, CONTACT_ID);

    expect(out).toEqual({
      mode: 'rule',
      ruleId: 'rule-hubspot',
      pipelineId: PIPELINE_HUBSPOT,
      stageId: STAGE_INITIAL_HUBSPOT,
    });
    expect(mocks.updateContact).toHaveBeenCalledTimes(1);
    expect((mocks.updateContact.mock.calls[0][0] as any).data).toMatchObject({
      currentPipelineId: PIPELINE_HUBSPOT,
      currentStageId: STAGE_INITIAL_HUBSPOT,
    });
    expect(mocks.createLeadStageHistory).toHaveBeenCalledTimes(1);
    expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
    const auditPayload = (mocks.createAuditLog.mock.calls[0][0] as any).data;
    expect(auditPayload.actionType).toBe('lead_assignment');
    expect(auditPayload.payload.assignmentMode).toBe('rule');
    expect(auditPayload.payload.ruleId).toBe('rule-hubspot');
  });

  it('multi-tenant isolation — assignmentRule.findMany filters by tenantId', async () => {
    const { prisma, mocks } = makePrismaMock({
      contact: defaultContact({ tenantId: TENANT_B }),
      tenant: { aiAssignmentConfidenceThreshold: 0.5 },
      rules: [],
      pipelines: [{ id: PIPELINE_DEFAULT, name: 'Default', objectiveType: 'warm_up_lead', objectiveDescription: null }],
      initialStageId: null,
    });
    __setLLMClientsForTest({
      anthropic: makeAnthropicMock(vi.fn(async () => anthropicJsonResponse({ pipelineId: PIPELINE_DEFAULT, confidence: 0.0, reasoning: 'low' }))),
      pubsub: null,
    });

    await assignLeadToPipeline(prisma, CONTACT_ID);

    const findManyArgs = mocks.findAssignmentRules.mock.calls[0][0] as any;
    expect(findManyArgs.where).toMatchObject({ tenantId: TENANT_B, isActive: true });
    expect(findManyArgs.orderBy).toEqual({ priority: 'asc' });
  });

  it('skipIfAssigned: true → no rule eval, no AI call, returns pre-existing assignment', async () => {
    const { prisma, mocks } = makePrismaMock({
      contact: defaultContact({ currentPipelineId: PIPELINE_META, currentStageId: 'stage-x' }),
      tenant: {},
      rules: [rule('would-match', 1, { source: 'hubspot' })],
      pipelines: [],
      initialStageId: null,
    });

    const out = await assignLeadToPipeline(prisma, CONTACT_ID, { skipIfAssigned: true });

    expect(out.mode).toBe('rule');
    expect((out as any).pipelineId).toBe(PIPELINE_META);
    expect(mocks.findAssignmentRules).not.toHaveBeenCalled();
    expect(mocks.updateContact).not.toHaveBeenCalled();
  });
});

describe('assignLeadToPipeline orchestrator — ai_fallback branch', () => {
  it('rules miss + AI confidence ≥ threshold → mode=ai_fallback, persists assignment', async () => {
    const { prisma, mocks } = makePrismaMock({
      contact: defaultContact({ source: 'manual' }),
      tenant: { aiAssignmentConfidenceThreshold: 0.5 },
      rules: [rule('hubspot-only', 1, { source: 'hubspot' })], // miss
      pipelines: [{ id: PIPELINE_META, name: 'Meta Ads', objectiveType: 'warm_up_lead', objectiveDescription: null }],
      initialStageId: STAGE_INITIAL_HUBSPOT,
    });
    __setLLMClientsForTest({
      anthropic: makeAnthropicMock(vi.fn(async () => anthropicJsonResponse({ pipelineId: PIPELINE_META, confidence: 0.82, reasoning: 'manual lead → warm-up' }))),
      pubsub: null,
    });

    const out = await assignLeadToPipeline(prisma, CONTACT_ID);

    expect(out.mode).toBe('ai_fallback');
    expect((out as any).pipelineId).toBe(PIPELINE_META);
    expect((out as any).confidence).toBe(0.82);
    expect(mocks.updateContact).toHaveBeenCalledTimes(1);
    const auditPayload = (mocks.createAuditLog.mock.calls[0][0] as any).data.payload;
    expect(auditPayload.assignmentMode).toBe('ai_fallback');
    expect(auditPayload.aiConfidence).toBe(0.82);
    expect(auditPayload.confidenceThreshold).toBe(0.5);
  });
});

describe('assignLeadToPipeline orchestrator — below-threshold posture branches', () => {
  function setupBelowThreshold(posture: string, defaultAssignmentPipelineId?: string) {
    const { prisma, mocks } = makePrismaMock({
      contact: defaultContact({ source: 'manual' }),
      tenant: {
        belowThresholdPosture: posture,
        defaultAssignmentPipelineId: defaultAssignmentPipelineId ?? null,
        aiAssignmentConfidenceThreshold: 0.5,
      },
      rules: [],
      pipelines: [{ id: PIPELINE_META, name: 'Meta', objectiveType: 'warm_up_lead', objectiveDescription: null }],
      initialStageId: STAGE_INITIAL_HUBSPOT,
    });
    // AI returns low confidence — below threshold.
    __setLLMClientsForTest({
      anthropic: makeAnthropicMock(vi.fn(async () => anthropicJsonResponse({ pipelineId: PIPELINE_META, confidence: 0.2, reasoning: 'unsure' }))),
      pubsub: null,
    });
    return { prisma, mocks };
  }

  it('posture=stay_unassigned → mode=unassigned, no Contact update, audit log only', async () => {
    const { prisma, mocks } = setupBelowThreshold('stay_unassigned');
    const out = await assignLeadToPipeline(prisma, CONTACT_ID);
    expect(out.mode).toBe('unassigned');
    expect(mocks.updateContact).not.toHaveBeenCalled();
    expect(mocks.createEscalation).not.toHaveBeenCalled();
    expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
    const audit = (mocks.createAuditLog.mock.calls[0][0] as any).data.payload;
    expect(audit.assignmentMode).toBe('unassigned');
    expect(audit.aiConfidence).toBe(0.2);
  });

  it('posture=default_pipeline + tenant has defaultAssignmentPipelineId → routes to that pipeline', async () => {
    const { prisma, mocks } = setupBelowThreshold('default_pipeline', PIPELINE_DEFAULT);
    const out = await assignLeadToPipeline(prisma, CONTACT_ID);
    expect(out.mode).toBe('default_pipeline');
    expect((out as any).pipelineId).toBe(PIPELINE_DEFAULT);
    expect(mocks.updateContact).toHaveBeenCalledTimes(1);
    expect((mocks.updateContact.mock.calls[0][0] as any).data.currentPipelineId).toBe(PIPELINE_DEFAULT);
  });

  it('posture=default_pipeline but no defaultAssignmentPipelineId set → falls through to stay_unassigned', async () => {
    const { prisma, mocks } = setupBelowThreshold('default_pipeline'); // no default set
    const out = await assignLeadToPipeline(prisma, CONTACT_ID);
    expect(out.mode).toBe('unassigned');
    expect(mocks.updateContact).not.toHaveBeenCalled();
  });

  it('posture=escalate_to_human → creates Escalation, mode=escalated, no Contact update', async () => {
    const { prisma, mocks } = setupBelowThreshold('escalate_to_human');
    const out = await assignLeadToPipeline(prisma, CONTACT_ID);
    expect(out.mode).toBe('escalated');
    expect(mocks.createEscalation).toHaveBeenCalledTimes(1);
    expect(mocks.updateContact).not.toHaveBeenCalled();
    const escArgs = (mocks.createEscalation.mock.calls[0][0] as any).data;
    expect(escArgs.triggerType).toBe('lead_assignment_below_threshold');
    expect(escArgs.status).toBe('open');
  });
});
