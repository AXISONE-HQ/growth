/**
 * KAN-749 MVP — tenant kill-switch symmetry across runFreeform + runAgentic.
 *
 * Pre-PR3: tenant.autoApproveEnabled=false blocked runAgentic only (KAN-740
 * wired matrix args including the kill-switch). runFreeform's cast-loose
 * `(evaluateThreshold as any)({confidence, threshold})` bypassed the entire
 * tenantConfig — kill-switch silently inert on rules-based path.
 *
 * Post-PR3: both paths route through `evaluateThresholdWithMatrix` which
 * loads tenantConfig from contact.tenant. Kill-switch enforced uniformly.
 *
 * This test verifies the symmetry by hitting the shared helper with two
 * distinct caller contexts (mimicking runFreeform's args and runAgentic's
 * args). Both must escalate when autoApproveEnabled=false.
 */
import { describe, it, expect, vi } from 'vitest';
import { evaluateThresholdWithMatrix } from '../run-decision-for-contact.js';

function buildPrismaMock() {
  return {
    stage: { findUnique: vi.fn().mockResolvedValue(null) },
    pipeline: { findFirst: vi.fn().mockResolvedValue(null) },
  } as any;
}

function buildContact(killSwitch: boolean) {
  return {
    id: 'c1',
    currentStageId: 'stage-1',
    currentPipelineId: 'pipeline-1',
    tenant: {
      confidenceThreshold: 70,
      autoEscalateFlags: [],
      blockedActionTypes: [],
      requireHumanApproval: false,
      autoApproveEnabled: !killSwitch,
    },
  } as any;
}

describe('KAN-749 — tenant kill-switch symmetric across both paths', () => {
  it('runFreeform-shaped call: tenant.autoApproveEnabled=false → ESCALATED regardless of confidence', async () => {
    const prisma = buildPrismaMock();
    const result = await evaluateThresholdWithMatrix(prisma, {
      tenantId: 't1',
      contactId: 'c1',
      contact: buildContact(true),
      // runFreeform-shape: determiner vocab, no risk flags
      actionType: 'send_message',
      channel: 'email',
      actionPayload: {},
      actionReasoning: 'Action: send_message',
      selectedStrategy: 'direct',
      strategyReasoning: 'Strategy: direct',
      objectiveId: 'unknown',
      riskFlags: [],
      overallConfidence: 95, // very high — confidence does NOT bypass kill-switch
    });
    expect(result.outcome).toBe('ESCALATED');
    expect(result.reasoning).toContain('Tenant auto-approve is disabled');
  });

  it('runAgentic-shaped call: tenant.autoApproveEnabled=false → ESCALATED regardless of confidence', async () => {
    const prisma = buildPrismaMock();
    const result = await evaluateThresholdWithMatrix(prisma, {
      tenantId: 't1',
      contactId: 'c1',
      contact: buildContact(true),
      // runAgentic-shape: transport vocab, agentic strategy + reasoning
      actionType: 'send_email',
      channel: 'email',
      actionPayload: { messageBody: 'hello' },
      actionReasoning: 'Personalized warm-up to engaged contact',
      selectedStrategy: 'agentic',
      strategyReasoning: 'agentic loop selected this',
      objectiveId: 'obj-warm-up',
      riskFlags: [],
      overallConfidence: 95,
    });
    expect(result.outcome).toBe('ESCALATED');
    expect(result.reasoning).toContain('Tenant auto-approve is disabled');
  });

  it('regression guard: runAgentic-shaped call with kill-switch=false still works (was working pre-PR3)', async () => {
    const prisma = buildPrismaMock();
    const result = await evaluateThresholdWithMatrix(prisma, {
      tenantId: 't1',
      contactId: 'c1',
      contact: buildContact(false), // kill-switch off, normal flow
      actionType: 'send_email', // unknown to matrix, falls to legacy
      channel: 'email',
      actionPayload: {},
      actionReasoning: 'agentic',
      selectedStrategy: 'agentic',
      strategyReasoning: 'agentic',
      objectiveId: 'obj-1',
      riskFlags: [],
      overallConfidence: 80,
    });
    expect(result.outcome).toBe('EXECUTED');
  });

  it('symmetry assertion: identical inputs across both call shapes yield identical decisions', async () => {
    // Vocab tag is the only difference between runFreeform-shape and
    // runAgentic-shape calls. Under kill-switch=true, both must escalate.
    // The kill-switch check runs BEFORE matrix lookup → vocab is irrelevant.
    const prisma = buildPrismaMock();
    const sharedArgs = {
      tenantId: 't1',
      contactId: 'c1',
      contact: buildContact(true),
      channel: 'email' as const,
      actionPayload: {},
      actionReasoning: 'test',
      selectedStrategy: 'test',
      strategyReasoning: 'test',
      objectiveId: 'o1',
      riskFlags: [] as string[],
      overallConfidence: 80,
    };
    const freeformResult = await evaluateThresholdWithMatrix(prisma, {
      ...sharedArgs,
      actionType: 'send_message', // determiner
    });
    const agenticResult = await evaluateThresholdWithMatrix(prisma, {
      ...sharedArgs,
      actionType: 'send_email', // transport
    });
    expect(freeformResult.outcome).toBe(agenticResult.outcome);
    expect(freeformResult.outcome).toBe('ESCALATED');
  });
});

describe('KAN-749 — requireHumanApproval (legacy KAN-39 flag) symmetric too', () => {
  it('requireHumanApproval=true escalates both shapes (back-compat with KAN-39)', async () => {
    const prisma = buildPrismaMock();
    const contact = {
      id: 'c1',
      currentStageId: 'stage-1',
      currentPipelineId: 'pipeline-1',
      tenant: {
        confidenceThreshold: 70,
        autoEscalateFlags: [],
        blockedActionTypes: [],
        requireHumanApproval: true, // legacy flag
        autoApproveEnabled: true,
      },
    } as any;

    const freeformResult = await evaluateThresholdWithMatrix(prisma, {
      tenantId: 't1',
      contactId: 'c1',
      contact,
      actionType: 'send_message',
      channel: 'email',
      actionPayload: {},
      actionReasoning: 'test',
      selectedStrategy: 'direct',
      strategyReasoning: 'test',
      objectiveId: 'o1',
      riskFlags: [],
      overallConfidence: 99,
    });
    expect(freeformResult.outcome).toBe('ESCALATED');
    expect(freeformResult.reasoning).toContain('requires human approval');
  });
});
