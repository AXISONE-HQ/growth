/**
 * KAN-1025 — runShadow pipeline-correctness regression test.
 *
 * Pins the Option-X invariants surfaced by the 2026-05-25 cast audit. The
 * 2026-05-25 15:35Z PROD incident ($0.0955, 3 retries) was caused by
 * `(analyzeGapsForContact as any)({...})` — a cast that hid a calling-
 * convention mismatch (positional fn called with 1 object arg). The audit
 * surfaced that ALL FOUR pipeline steps (gaps → strategy → action →
 * confidence) had wrong call shapes hidden by `(fn as any)(...)` casts.
 *
 * This test mocks the 4 pipeline functions at module level and asserts
 * `runDecisionForContact` calls each with its TYPED input shape (not
 * `{prisma, tenantId, contactId, context}` smashed against every fn).
 * The assertions are at the call-shape level (not the integration level)
 * because the goal is to catch any future re-introduction of the
 * `(fn as any)(...)` pattern — the cast itself is the bug class.
 *
 * Broader integration coverage (real pipeline execution against a faked
 * Prisma + full Zod-compliant fixtures) is tracked under KAN-1024 as a
 * separate scope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the four pipeline modules BEFORE importing run-decision-for-contact.
// Each mock returns a canned typed result matching the real schema.
vi.mock('../objective-gap-analyzer.js', () => ({
  analyzeGapsForContact: vi.fn(async () => ({
    contactId: 'contact-test-1',
    tenantId: 'tenant-test-1',
    objectiveId: 'objective-warm-up',
    objectiveType: 'lead_conversion',
    analyzedAt: '2026-05-25T16:00:00Z',
    overallProgress: 0.4,
    overallHealth: 'at_risk' as const,
    totalSubObjectives: 3,
    completedCount: 1,
    inProgressCount: 1,
    gapCount: 1,
    gaps: [],
    primaryGap: {
      subObjectiveId: 'sub-1',
      subObjectiveName: 'Identify decision-maker',
      category: 'engagement',
      severity: 'high' as const,
      reason: 'stalled' as const,
      weight: 1,
      priorityScore: 0.8,
      blockedBy: [],
      suggestedActions: ['Send follow-up email'],
    },
    recommendedStrategy: 're_engage' as const,
    contextSummary: 'Stalled in qualification stage',
  })),
  analyzeAllGapsForContact: vi.fn(async () => []),
  GapSchema: {} as never,
  GapReportSchema: {} as never,
  SubObjectiveSchema: {} as never,
  ObjectiveSchema: {} as never,
  createObjectiveGapRouter: vi.fn(),
  analyzeSubObjective: vi.fn(),
  calculateGapSeverity: vi.fn(),
  calculatePriorityScore: vi.fn(),
  prioritizeGaps: vi.fn(),
  assessObjectiveHealth: vi.fn(),
  recommendStrategy: vi.fn(),
  generateContextSummary: vi.fn(),
  generateSuggestedActions: vi.fn(),
}));

vi.mock('../strategy-selector.js', () => ({
  selectStrategy: vi.fn(async () => ({
    contactId: 'contact-test-1',
    tenantId: 'tenant-test-1',
    objectiveId: 'objective-warm-up',
    selectedStrategy: 're_engage' as const,
    confidence: 75,
    reasoning: 'Stalled contact; re-engagement is appropriate.',
    selectionMethod: 'rule_based' as const,
    alternativeStrategies: [],
    selectedAt: '2026-05-25T16:00:01Z',
  })),
  StrategySelectionInputSchema: {} as never,
  StrategySelectionResultSchema: {} as never,
}));

vi.mock('../action-determiner.js', () => ({
  determineAction: vi.fn(() => ({
    contactId: 'contact-test-1',
    tenantId: 'tenant-test-1',
    objectiveId: 'objective-warm-up',
    actionType: 'send_message' as const,
    channel: 'email' as const,
    reasoning: 'Email is preferred channel; send re-engagement message.',
    actionPayload: {
      messageTemplate: 'reengage_v1',
      messageVariables: { firstName: 'Test' },
    },
    determinedAt: '2026-05-25T16:00:02Z',
  })),
  ActionDeterminerInputSchema: {} as never,
  ActionDeterminerResultSchema: {} as never,
}));

vi.mock('../confidence-scorer.js', () => ({
  scoreConfidence: vi.fn(async () => ({
    contactId: 'contact-test-1',
    tenantId: 'tenant-test-1',
    objectiveId: 'objective-warm-up',
    overallConfidence: 65,
    factors: [
      { name: 'gap_severity', score: 70, weight: 0.3, weightedScore: 21, reasoning: 'High severity' },
    ],
    riskFlags: [],
    scoredAt: '2026-05-25T16:00:03Z',
  })),
  ConfidenceScorerInputSchema: {} as never,
  ConfidenceScorerResultSchema: {} as never,
}));

// Now import — mocks are in effect.
import { runDecisionForContact } from '../run-decision-for-contact.js';
import { analyzeGapsForContact } from '../objective-gap-analyzer.js';
import { selectStrategy } from '../strategy-selector.js';
import { determineAction } from '../action-determiner.js';
import { scoreConfidence } from '../confidence-scorer.js';

const TENANT_ID = 'tenant-test-1';
const CONTACT_ID = 'contact-test-1';
const OBJECTIVE_ID = 'objective-warm-up';

function buildFakePrisma() {
  const decisionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'decision-1',
    ...data,
  }));
  const escalationCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'escalation-1',
    ...data,
  }));
  const agenticShadowDecisionCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'asd-1',
    ...data,
  }));

  const tx = {
    decision: { create: decisionCreate },
    escalation: { create: escalationCreate },
  };

  const prisma = {
    contact: {
      findFirst: vi.fn(async () => ({
        id: CONTACT_ID,
        tenantId: TENANT_ID,
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'Contact',
        lifecycleStage: 'qualified',
        segment: 'smb',
        source: 'form_fill',
        dataQualityScore: 80,
        currentPipelineId: null,
        currentStageId: null,
        tenant: {
          id: TENANT_ID,
          confidenceThreshold: 70,
          autoApproveEnabled: false,
          autoEscalateFlags: [],
          blockedActionTypes: [],
          requireHumanApproval: false,
          agenticModeEnabled: false,
        },
      })),
    },
    contactObjectiveStack: {
      findFirst: vi.fn(async () => ({
        id: 'stack-1',
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        objectiveId: OBJECTIVE_ID,
        status: 'active',
        priority: 100,
      })),
      findMany: vi.fn(async () => []),
    },
    tenant: {
      findUnique: vi.fn(async () => ({
        id: TENANT_ID,
        confidenceThreshold: 70,
        autoApproveEnabled: false,
        planTier: 'pro',
      })),
    },
    action: { findMany: vi.fn(async () => []) },
    decision: { findMany: vi.fn(async () => []), create: decisionCreate },
    outcome: { findMany: vi.fn(async () => []) },
    deal: { findFirst: vi.fn(async () => null) },
    pipeline: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
    stage: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
    pipelineMicroObjective: { findMany: vi.fn(async () => []) },
    knowledgeFilter: { findMany: vi.fn(async () => []) },
    brainSnapshot: { findFirst: vi.fn(async () => null) },
    channelConnection: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
    escalation: { create: escalationCreate },
    agenticShadowDecision: { create: agenticShadowDecisionCreate },
    $transaction: vi.fn(async (fn: (tx: typeof tx) => unknown) => fn(tx)),
  } as unknown as Parameters<typeof runDecisionForContact>[0];

  return { prisma, decisionCreate, escalationCreate, agenticShadowDecisionCreate };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('KAN-1025 — runShadow pipeline calling-convention regression', () => {
  it('analyzeGapsForContact is called with positional args (prisma, tenantId, contactId, objectiveId) — NOT an object', async () => {
    const { prisma } = buildFakePrisma();
    await runDecisionForContact(prisma, { tenantId: TENANT_ID, contactId: CONTACT_ID });

    // The bug at 2026-05-25 15:35Z: was called as `({prisma, tenantId, contactId, context})`.
    // The fix: positional args.
    expect(analyzeGapsForContact).toHaveBeenCalledWith(
      prisma,                  // arg[0]: PrismaClient
      TENANT_ID,               // arg[1]: tenantId
      CONTACT_ID,              // arg[2]: contactId
      OBJECTIVE_ID,            // arg[3]: objectiveId (from active stack)
    );
  });

  it('selectStrategy is called with the typed StrategySelectionInput shape (NOT smashed-object)', async () => {
    const { prisma } = buildFakePrisma();
    await runDecisionForContact(prisma, { tenantId: TENANT_ID, contactId: CONTACT_ID });

    // Before X fix: was called as `({prisma, tenantId, contactId, gaps, context})`.
    // After X fix: typed shape including objectiveType / overallProgress / overallHealth / gapCount /
    // primaryGap / recommendedStrategy / contactContext / brainContext.
    expect(selectStrategy).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: CONTACT_ID,
        tenantId: TENANT_ID,
        objectiveId: OBJECTIVE_ID,
        objectiveType: 'lead_conversion',
        overallProgress: 0.4,
        overallHealth: 'at_risk',
        gapCount: 1,
        primaryGap: expect.objectContaining({
          subObjectiveId: 'sub-1',
          severity: 'high',
        }),
        recommendedStrategy: 're_engage',
      }),
    );
    // Specifically: 'prisma' and 'gaps' and 'context' MUST NOT be in the call.
    const calls = (selectStrategy as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const callArg = calls[0]?.[0] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty('prisma');
    expect(callArg).not.toHaveProperty('gaps');
    expect(callArg).not.toHaveProperty('context');
  });

  it('determineAction is called with selectedStrategy from strategy result + objectiveId', async () => {
    const { prisma } = buildFakePrisma();
    await runDecisionForContact(prisma, { tenantId: TENANT_ID, contactId: CONTACT_ID });

    expect(determineAction).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: CONTACT_ID,
        tenantId: TENANT_ID,
        objectiveId: OBJECTIVE_ID,
        selectedStrategy: 're_engage',          // from strategyResult.selectedStrategy
        strategyConfidence: 75,                  // from strategyResult.confidence
        strategyReasoning: expect.any(String),
      }),
    );
  });

  it('scoreConfidence is called with actionType from action result + selectedStrategy from strategy result', async () => {
    const { prisma } = buildFakePrisma();
    await runDecisionForContact(prisma, { tenantId: TENANT_ID, contactId: CONTACT_ID });

    expect(scoreConfidence).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: CONTACT_ID,
        tenantId: TENANT_ID,
        objectiveId: OBJECTIVE_ID,
        selectedStrategy: 're_engage',           // from strategyResult
        strategyConfidence: 75,                  // from strategyResult
        actionType: 'send_message',              // from actionResult.actionType (NOT .action.type)
        actionReasoning: expect.any(String),
      }),
    );
  });

  it('Decision row gets real strategy/action enum values (NOT "[object Object]")', async () => {
    const { prisma, decisionCreate } = buildFakePrisma();
    await runDecisionForContact(prisma, { tenantId: TENANT_ID, contactId: CONTACT_ID });

    expect(decisionCreate).toHaveBeenCalled();
    const decisionCall = decisionCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    const strategySelected = decisionCall.data.strategySelected as string;
    const actionType = decisionCall.data.actionType as string;

    expect(strategySelected).toBe('re_engage');        // real strategy enum
    expect(actionType).toBe('send_message');           // real action enum
    expect(strategySelected).not.toBe('[object Object]');
    expect(actionType).not.toBe('[object Object]');
  });

  it('confidence is a real numeric (NOT the 0-from-broken-fallback)', async () => {
    const { prisma, decisionCreate } = buildFakePrisma();
    await runDecisionForContact(prisma, { tenantId: TENANT_ID, contactId: CONTACT_ID });

    const decisionCall = decisionCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    const confidence = decisionCall.data.confidence as number;
    // scoreConfidence returned overallConfidence=65; runShadow normalizes /100 → 0.65
    expect(confidence).toBe(0.65);
    expect(confidence).not.toBe(0);
  });

  it('routes to ESCALATED + writes Escalation row when autoApproveEnabled=false', async () => {
    const { prisma, escalationCreate } = buildFakePrisma();
    const result = await runDecisionForContact(prisma, { tenantId: TENANT_ID, contactId: CONTACT_ID });

    expect((result as { outcome?: string }).outcome).toBe('ESCALATED');
    expect(escalationCreate).toHaveBeenCalled();

    const escalationCall = escalationCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    const aiSuggestion = escalationCall.data.aiSuggestion as string;
    // Was: '[object Object]' (pre-fix). Now: real action type string.
    expect(aiSuggestion).toBe('send_message');

    const ctx = escalationCall.data.context as Record<string, unknown>;
    expect(typeof ctx.confidence).toBe('number');
    expect(ctx.confidence).toBe(0.65);
  });
});
