/**
 * KAN-749 MVP — runFreeform-side matrix wiring (symmetric with runAgentic).
 *
 * Tests the shared `evaluateThresholdWithMatrix` helper that both runAgentic
 * (line 440) and runFreeform (line 869, post-PR3) call into. Matrix args
 * loaded from contact's stage/pipeline rows; tenantConfig from contact.tenant.
 *
 * Pre-PR3 state: runFreeform passed only {confidence, threshold} via
 * `(evaluateThreshold as any)` cast — matrix args inert on rules-based path.
 * PR3 closes the asymmetry by routing both paths through the shared helper.
 */
import { describe, it, expect, vi } from 'vitest';
import { evaluateThresholdWithMatrix } from '../run-decision-for-contact.js';

function buildPrismaMock(opts: {
  stageMatrix?: Record<string, unknown> | null;
  pipelineMatrix?: Record<string, unknown> | null;
}) {
  return {
    stage: {
      findUnique: vi.fn().mockResolvedValue(
        opts.stageMatrix !== undefined ? { autoApproveMatrix: opts.stageMatrix } : null,
      ),
    },
    pipeline: {
      findFirst: vi.fn().mockResolvedValue(
        opts.pipelineMatrix !== undefined
          ? { defaultAutoApproveMatrix: opts.pipelineMatrix }
          : null,
      ),
    },
  } as any;
}

function buildContact(overrides: {
  currentStageId?: string | null;
  currentPipelineId?: string | null;
  tenantOverrides?: Record<string, unknown>;
} = {}) {
  return {
    id: 'c1',
    currentStageId: 'currentStageId' in overrides ? overrides.currentStageId : 'stage-1',
    currentPipelineId:
      'currentPipelineId' in overrides ? overrides.currentPipelineId : 'pipeline-1',
    tenant: {
      confidenceThreshold: 70,
      autoEscalateFlags: [],
      blockedActionTypes: [],
      requireHumanApproval: false,
      autoApproveEnabled: true,
      // KAN-1005 M2-1 — opt-in to aiPermissions for action types this
      // file's matrix-fall-through tests exercise. Default-deny enforcement
      // matrix is in threshold-gate-kan-1005-enforcement.test.ts.
      aiPermissions: {
        actionTypes: {
          send_followup_email: 'auto',
          send_message: 'auto',
          send_warm_up_email: 'auto',
        },
      },
      ...(overrides.tenantOverrides ?? {}),
    },
  } as any;
}

const BASE_ARGS = {
  tenantId: 't1',
  contactId: 'c1',
  actionType: 'send_followup_email',
  channel: 'email' as const,
  actionPayload: {},
  actionReasoning: 'follow-up',
  selectedStrategy: 'direct',
  strategyReasoning: 'engaged',
  objectiveId: 'o1',
  riskFlags: [] as string[],
  overallConfidence: 80,
};

describe('KAN-749 — evaluateThresholdWithMatrix (shared helper for runFreeform + runAgentic)', () => {
  it('stage matrix override → matrix decision wins over PLATFORM_AUTO_APPROVE_DEFAULTS', async () => {
    const prisma = buildPrismaMock({
      stageMatrix: {
        send_followup_email: { threshold: 0.5, default: 'auto', rationale: 'stage override' },
      },
      pipelineMatrix: null,
    });
    const result = await evaluateThresholdWithMatrix(prisma, {
      ...BASE_ARGS,
      contact: buildContact(),
      overallConfidence: 60, // matrix threshold 50 → 60 ≥ 50 → approved
    });
    expect(result.outcome).toBe('EXECUTED');
    expect(result.reasoning).toContain('auto-approve matrix threshold 50');
  });

  it('pipeline matrix used when stage matrix is null', async () => {
    const prisma = buildPrismaMock({
      stageMatrix: null,
      pipelineMatrix: {
        send_followup_email: { threshold: 0.85, default: 'auto', rationale: 'pipeline override' },
      },
    });
    const result = await evaluateThresholdWithMatrix(prisma, {
      ...BASE_ARGS,
      contact: buildContact(),
      overallConfidence: 80, // 85 → 80 < 85 → human_review (escalated)
    });
    expect(result.outcome).toBe('ESCALATED');
    expect(result.reasoning).toContain('auto-approve matrix threshold 85');
  });

  it('both matrices null → falls through to PLATFORM_AUTO_APPROVE_DEFAULTS', async () => {
    const prisma = buildPrismaMock({ stageMatrix: null, pipelineMatrix: null });
    const result = await evaluateThresholdWithMatrix(prisma, {
      ...BASE_ARGS,
      contact: buildContact(),
      actionType: 'send_followup_email', // platform default: 0.7 → 70
      overallConfidence: 80, // ≥ 70 → approved
    });
    expect(result.outcome).toBe('EXECUTED');
    // platform defaults still surface as "auto-approve matrix threshold" — not legacy
    expect(result.reasoning).toContain('auto-approve matrix threshold');
  });

  it('vocab mismatch (runFreeform determiner vocab) → fall-through to legacy threshold', async () => {
    const prisma = buildPrismaMock({
      stageMatrix: {
        send_followup_email: { threshold: 0.5, default: 'auto', rationale: 'stage' },
      },
      pipelineMatrix: null,
    });
    // Determiner vocab — not in matrix, not in PLATFORM_AUTO_APPROVE_DEFAULTS
    const result = await evaluateThresholdWithMatrix(prisma, {
      ...BASE_ARGS,
      contact: buildContact(),
      actionType: 'send_message',
      overallConfidence: 80, // tenant 70 → 80 ≥ 70 → approved (legacy path)
    });
    expect(result.outcome).toBe('EXECUTED');
    expect(result.reasoning).toContain('legacy threshold');
  });

  it('contact without stage/pipeline IDs → no DB lookup, falls to platform defaults', async () => {
    const prisma = buildPrismaMock({});
    const result = await evaluateThresholdWithMatrix(prisma, {
      ...BASE_ARGS,
      contact: buildContact({ currentStageId: null, currentPipelineId: null }),
      overallConfidence: 80,
    });
    expect(result.outcome).toBe('EXECUTED');
    expect(prisma.stage.findUnique).not.toHaveBeenCalled();
    expect(prisma.pipeline.findFirst).not.toHaveBeenCalled();
  });
});
