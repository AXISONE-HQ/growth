/**
 * Tests for KAN-705 — hybrid lead → pipeline assignment.
 * KAN-795 refactor (Phase 2 epic 2 of 5) — Layer 3 (AI fallback) moved to
 * pipeline-router.test.ts; this file mocks `routePipelineForNewLead` at the
 * orchestrator boundary to test the rule → router → posture dispatch.
 *
 * Three layers of coverage:
 *
 *   1. Pure predicate language (matchesConditions): scalar / array-IN / operators (eq, ne, gte, lte, gt, lt, in)
 *   2. Pure rule walker (evaluateRules): priority order, isActive filter, first-match wins, empty-conditions catch-all
 *   3. Orchestrator (assignLeadToPipeline): rule branch + ai_fallback branch (via mocked pipeline-router)
 *      + each of 3 below-threshold postures (stay_unassigned, default_pipeline, escalate_to_human)
 *      + audit log shape + multi-tenant rule isolation + skipIfAssigned idempotency
 *      + KAN-795 router integration: route → ai_fallback, escalate → posture, no_candidates → posture+warn
 *
 * Note: tests against the orchestrator mock the Prisma client at the delegate
 * level. Real DB integration runs in a separate test runner once the
 * migration lands; these unit tests only assert the ORCHESTRATION shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// KAN-795: mock pipeline-router BEFORE importing the module under test.
const routePipelineForNewLeadMock = vi.fn();
vi.mock('../pipeline-router.js', () => ({
  routePipelineForNewLead: (...args: unknown[]) => routePipelineForNewLeadMock(...args),
}));

import {
  matchesConditions,
  evaluateRules,
  assignLeadToPipeline,
  type AssignmentRuleRow,
  type LeadAttributes,
} from '../lead-assignment.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const CONTACT_ID = '33333333-3333-3333-3333-333333333333';
const PIPELINE_HUBSPOT = 'pipe-hubspot';
const PIPELINE_META = 'pipe-meta';
const PIPELINE_DEFAULT = 'pipe-default';
const STAGE_INITIAL_HUBSPOT = 'stage-initial-hubspot';

beforeEach(() => {
  vi.restoreAllMocks();
  routePipelineForNewLeadMock.mockReset();
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
// Layer 3 — orchestrator
// (KAN-795: pipeline-router unit tests live in pipeline-router.test.ts)
// ─────────────────────────────────────────────

interface PrismaMockState {
  contact: any;
  tenant: Partial<{
    belowThresholdPosture: string | null;
    defaultAssignmentPipelineId: string | null;
    aiAssignmentConfidenceThreshold: number | null;
  }>;
  rules: AssignmentRuleRow[];
  initialStageId: string | null;
}

function makePrismaMock(state: PrismaMockState) {
  const updateContact = vi.fn(async () => state.contact);
  const createAuditLog = vi.fn(async () => ({ id: 'audit-1' }));
  const createEscalation = vi.fn(async () => ({ id: 'esc-1' }));
  const findFirstStage = vi.fn(async () => (state.initialStageId ? { id: state.initialStageId } : null));
  const findAssignmentRules = vi.fn(async () => state.rules);

  // KAN-793: stage-transition audit moved to DealStageHistory (deal-scoped per
  // KAN-791). Written by lead-received-push when it creates the wrapping Deal,
  // not by lead-assignment. This mock no longer carries leadStageHistory; the
  // DealStageHistory write is covered by the KAN-793 lead-received-push tests.
  // KAN-795: pipeline.findMany no longer called from lead-assignment;
  // pipeline-router loads its own candidates internally.
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
    stage: { findFirst: findFirstStage },
  };

  return { prisma: prisma as PrismaClient, mocks: { updateContact, createAuditLog, createEscalation, findAssignmentRules } };
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

/**
 * Build a PipelineRoutingDecision-shaped mock return for routePipelineForNewLead.
 */
function routerResponse(overrides: {
  type: 'route' | 'escalate' | 'no_candidates';
  pipelineId?: string;
  reasoning?: string;
  confidence?: number;
}) {
  const baseReasoning =
    overrides.type === 'route'
      ? 'AI router chose this Pipeline.'
      : overrides.type === 'escalate'
        ? 'AI router could not pick a single best fit.'
        : 'Tenant has no active Pipelines.';
  return {
    contactId: CONTACT_ID,
    evaluatedAt: new Date(),
    candidatePipelines: [],
    decision:
      overrides.type === 'route'
        ? { type: 'route', pipelineId: overrides.pipelineId ?? PIPELINE_META, reasoning: overrides.reasoning ?? baseReasoning }
        : overrides.type === 'escalate'
          ? { type: 'escalate', reasoning: overrides.reasoning ?? baseReasoning }
          : { type: 'no_candidates', reasoning: overrides.reasoning ?? baseReasoning },
    confidence: overrides.confidence ?? (overrides.type === 'route' ? 0.82 : 0.0),
    modelTier: 'reasoning' as const,
    llmInputTokens: overrides.type === 'route' ? 350 : 0,
    llmOutputTokens: overrides.type === 'route' ? 90 : 0,
  };
}

describe('assignLeadToPipeline orchestrator — rule branch', () => {
  it('rule match → updates Contact + emits audit log with mode=rule (KAN-793: stage-history write moved to lead-received-push)', async () => {
    const { prisma, mocks } = makePrismaMock({
      contact: defaultContact(),
      tenant: { aiAssignmentConfidenceThreshold: 0.5 },
      rules: [rule('rule-hubspot', 1, { source: 'hubspot' })],
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
    expect(mocks.createAuditLog).toHaveBeenCalledTimes(1);
    const auditPayload = (mocks.createAuditLog.mock.calls[0][0] as any).data;
    expect(auditPayload.actionType).toBe('lead_assignment');
    expect(auditPayload.payload.assignmentMode).toBe('rule');
    expect(auditPayload.payload.ruleId).toBe('rule-hubspot');
    // KAN-795: rule branch should NOT invoke the router.
    expect(routePipelineForNewLeadMock).not.toHaveBeenCalled();
  });

  it('multi-tenant isolation — assignmentRule.findMany filters by tenantId', async () => {
    const { prisma, mocks } = makePrismaMock({
      contact: defaultContact({ tenantId: TENANT_B }),
      tenant: { aiAssignmentConfidenceThreshold: 0.5 },
      rules: [],
      initialStageId: null,
    });
    routePipelineForNewLeadMock.mockResolvedValueOnce(
      routerResponse({ type: 'route', pipelineId: PIPELINE_DEFAULT, confidence: 0.0 }),
    );

    await assignLeadToPipeline(prisma, CONTACT_ID);

    const findManyArgs = mocks.findAssignmentRules.mock.calls[0][0] as any;
    expect(findManyArgs.where).toMatchObject({ tenantId: TENANT_B, isActive: true });
    expect(findManyArgs.orderBy).toEqual({ priority: 'asc' });
  });

  it('skipIfAssigned: true → no rule eval, no router call, returns pre-existing assignment', async () => {
    const { prisma, mocks } = makePrismaMock({
      contact: defaultContact({ currentPipelineId: PIPELINE_META, currentStageId: 'stage-x' }),
      tenant: {},
      rules: [rule('would-match', 1, { source: 'hubspot' })],
      initialStageId: null,
    });

    const out = await assignLeadToPipeline(prisma, CONTACT_ID, { skipIfAssigned: true });

    expect(out.mode).toBe('rule');
    expect((out as any).pipelineId).toBe(PIPELINE_META);
    expect(mocks.findAssignmentRules).not.toHaveBeenCalled();
    expect(mocks.updateContact).not.toHaveBeenCalled();
    expect(routePipelineForNewLeadMock).not.toHaveBeenCalled();
  });
});

describe('assignLeadToPipeline orchestrator — KAN-795 router integration', () => {
  it('router decision=route AND confidence ≥ threshold → mode=ai_fallback, persists assignment', async () => {
    const { prisma, mocks } = makePrismaMock({
      contact: defaultContact({ source: 'manual' }),
      tenant: { aiAssignmentConfidenceThreshold: 0.5 },
      rules: [rule('hubspot-only', 1, { source: 'hubspot' })], // miss → router
      initialStageId: STAGE_INITIAL_HUBSPOT,
    });
    routePipelineForNewLeadMock.mockResolvedValueOnce(
      routerResponse({
        type: 'route',
        pipelineId: PIPELINE_META,
        reasoning: 'manual lead → warm-up',
        confidence: 0.82,
      }),
    );

    const out = await assignLeadToPipeline(prisma, CONTACT_ID);

    expect(out.mode).toBe('ai_fallback');
    expect((out as any).pipelineId).toBe(PIPELINE_META);
    expect((out as any).confidence).toBe(0.82);
    expect((out as any).reasoning).toBe('manual lead → warm-up');
    expect(mocks.updateContact).toHaveBeenCalledTimes(1);
    const auditPayload = (mocks.createAuditLog.mock.calls[0][0] as any).data.payload;
    expect(auditPayload.assignmentMode).toBe('ai_fallback');
    expect(auditPayload.aiConfidence).toBe(0.82);
    expect(auditPayload.confidenceThreshold).toBe(0.5);
    // Router invoked exactly once with the contactId.
    expect(routePipelineForNewLeadMock).toHaveBeenCalledTimes(1);
    expect(routePipelineForNewLeadMock.mock.calls[0][1]).toBe(CONTACT_ID);
  });

  it('router decision=escalate → falls through to posture (escalate_to_human → mode=escalated)', async () => {
    const { prisma, mocks } = makePrismaMock({
      contact: defaultContact({ source: 'manual' }),
      tenant: {
        belowThresholdPosture: 'escalate_to_human',
        aiAssignmentConfidenceThreshold: 0.5,
      },
      rules: [],
      initialStageId: STAGE_INITIAL_HUBSPOT,
    });
    routePipelineForNewLeadMock.mockResolvedValueOnce(
      routerResponse({ type: 'escalate', confidence: 0.0, reasoning: 'ambiguous fit' }),
    );

    const out = await assignLeadToPipeline(prisma, CONTACT_ID);

    expect(out.mode).toBe('escalated');
    expect(mocks.createEscalation).toHaveBeenCalledTimes(1);
    expect(mocks.updateContact).not.toHaveBeenCalled();
    // Audit log captures the router's escalate reasoning.
    const audit = (mocks.createAuditLog.mock.calls[0][0] as any).data.payload;
    expect(audit.assignmentMode).toBe('escalated');
    expect(audit.aiReasoning).toContain('Pipeline router escalated');
    expect(audit.aiReasoning).toContain('ambiguous fit');
  });

  it('router decision=no_candidates → falls through to posture + warning logged (defensive)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { prisma } = makePrismaMock({
      contact: defaultContact({ source: 'manual' }),
      tenant: {
        belowThresholdPosture: 'stay_unassigned',
        aiAssignmentConfidenceThreshold: 0.5,
      },
      rules: [],
      initialStageId: null,
    });
    routePipelineForNewLeadMock.mockResolvedValueOnce(
      routerResponse({ type: 'no_candidates', confidence: 1.0, reasoning: 'tenant has zero Pipelines' }),
    );

    const out = await assignLeadToPipeline(prisma, CONTACT_ID);

    expect(out.mode).toBe('unassigned');
    // Warning fires because no_candidates shouldn't happen post-bootstrap.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0] as string).toContain('pipeline-router returned no_candidates');
    warnSpy.mockRestore();
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
      initialStageId: STAGE_INITIAL_HUBSPOT,
    });
    // Router returns route with low confidence — below threshold → posture dispatch.
    routePipelineForNewLeadMock.mockResolvedValueOnce(
      routerResponse({ type: 'route', pipelineId: PIPELINE_META, confidence: 0.2, reasoning: 'unsure' }),
    );
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
