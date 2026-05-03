/**
 * KAN-793 — Default Pipeline lazy bootstrap tests.
 *
 * Coverage:
 *   1. First call (no existing Pipeline) → creates Pipeline + 7 Stages with
 *      correct order / isInitial / isTerminal / outcomeType / followUpCadence
 *      / objectiveType=warm_up_lead.
 *   2. Idempotency — second call with existing Pipeline returns it without
 *      creating duplicates (Stage createMany NOT called).
 *   3. Tenant isolation — findFirst filters by tenantId.
 *   4. Stage shape conformance — exactly 1 isInitial Stage (the partial
 *      UNIQUE in schema would catch drift in DB, but the helper itself
 *      should produce conformant data).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ensureTenantHasDefaultPipeline } from '../default-pipeline-bootstrap.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

function makePrismaMock(opts: { existingPipeline: { id: string; tenantId: string } | null }) {
  const findFirstPipeline = vi.fn(async () => opts.existingPipeline);
  const createPipeline = vi.fn(async (args: any) => ({
    id: 'created-pipeline-id',
    ...args.data,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const createManyStages = vi.fn(async (args: any) => ({ count: args.data.length }));

  // KAN-793: $transaction wrapper — invoke the callback with a tx that has
  // the same delegate shape as the outer prisma. Sufficient for unit tests.
  const txClient: any = {
    pipeline: { create: createPipeline },
    stage: { createMany: createManyStages },
  };
  const transaction = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(txClient));

  const prisma: any = {
    pipeline: {
      findFirst: findFirstPipeline,
      create: createPipeline,
    },
    stage: { createMany: createManyStages },
    $transaction: transaction,
  };

  return { prisma: prisma as PrismaClient, mocks: { findFirstPipeline, createPipeline, createManyStages, transaction } };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ensureTenantHasDefaultPipeline — first call creates 7-Stage default', () => {
  it('creates Pipeline with objectiveType=warm_up_lead + correct name/description', async () => {
    const { prisma, mocks } = makePrismaMock({ existingPipeline: null });
    await ensureTenantHasDefaultPipeline(prisma, TENANT_A);

    expect(mocks.createPipeline).toHaveBeenCalledTimes(1);
    const pipelineArgs = (mocks.createPipeline.mock.calls[0][0] as any).data;
    expect(pipelineArgs.tenantId).toBe(TENANT_A);
    expect(pipelineArgs.name).toBe('Default Sales Pipeline');
    expect(pipelineArgs.objectiveType).toBe('warm_up_lead');
    expect(pipelineArgs.isActive).toBe(true);
    expect(pipelineArgs.order).toBe(0);
  });

  it('creates exactly 7 Stages with correct names + order', async () => {
    const { prisma, mocks } = makePrismaMock({ existingPipeline: null });
    await ensureTenantHasDefaultPipeline(prisma, TENANT_A);

    expect(mocks.createManyStages).toHaveBeenCalledTimes(1);
    const stages = (mocks.createManyStages.mock.calls[0][0] as any).data as any[];
    expect(stages).toHaveLength(7);
    expect(stages.map((s) => s.name)).toEqual([
      'New',
      'Contacted',
      'Qualified',
      'Proposal Sent',
      'Negotiating',
      'Closed Won',
      'Closed Lost',
    ]);
    expect(stages.map((s) => s.order)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('exactly 1 Stage marked isInitial (the "New" stage at order=0)', async () => {
    const { prisma, mocks } = makePrismaMock({ existingPipeline: null });
    await ensureTenantHasDefaultPipeline(prisma, TENANT_A);

    const stages = (mocks.createManyStages.mock.calls[0][0] as any).data as any[];
    const initials = stages.filter((s) => s.isInitial);
    expect(initials).toHaveLength(1);
    expect(initials[0].name).toBe('New');
    expect(initials[0].order).toBe(0);
  });

  it('terminal stages have outcomeType=terminal_won/lost + isTerminal=true + empty followUpCadence', async () => {
    const { prisma, mocks } = makePrismaMock({ existingPipeline: null });
    await ensureTenantHasDefaultPipeline(prisma, TENANT_A);

    const stages = (mocks.createManyStages.mock.calls[0][0] as any).data as any[];
    const won = stages.find((s) => s.name === 'Closed Won');
    const lost = stages.find((s) => s.name === 'Closed Lost');

    expect(won.isTerminal).toBe(true);
    expect(won.outcomeType).toBe('terminal_won');
    expect(won.followUpCadence).toEqual({});

    expect(lost.isTerminal).toBe(true);
    expect(lost.outcomeType).toBe('terminal_lost');
    expect(lost.followUpCadence).toEqual({});
  });

  it('open stages have outcomeType=open + non-empty followUpCadence with PRD-mandated keys', async () => {
    const { prisma, mocks } = makePrismaMock({ existingPipeline: null });
    await ensureTenantHasDefaultPipeline(prisma, TENANT_A);

    const stages = (mocks.createManyStages.mock.calls[0][0] as any).data as any[];
    const open = stages.filter((s) => s.outcomeType === 'open');
    expect(open).toHaveLength(5);
    for (const s of open) {
      expect(s.isTerminal).toBe(false);
      expect(s.followUpCadence).toMatchObject({
        firstNudgeAfterHours: expect.any(Number),
        maxNudges: expect.any(Number),
        idleStaleAfterDays: expect.any(Number),
      });
    }
  });
});

describe('ensureTenantHasDefaultPipeline — idempotency', () => {
  it('returns existing Pipeline when tenant already has one — no Pipeline.create or Stage.createMany call', async () => {
    const existing = { id: 'existing-pipeline-id', tenantId: TENANT_A };
    const { prisma, mocks } = makePrismaMock({ existingPipeline: existing });

    const result = await ensureTenantHasDefaultPipeline(prisma, TENANT_A);

    expect(result).toEqual(existing);
    expect(mocks.findFirstPipeline).toHaveBeenCalledTimes(1);
    expect(mocks.createPipeline).not.toHaveBeenCalled();
    expect(mocks.createManyStages).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('findFirst filters by tenantId + isActive=true (multi-tenant isolation)', async () => {
    const { prisma, mocks } = makePrismaMock({ existingPipeline: null });
    await ensureTenantHasDefaultPipeline(prisma, TENANT_B);

    const findFirstArgs = (mocks.findFirstPipeline.mock.calls[0][0] as any);
    expect(findFirstArgs.where).toMatchObject({ tenantId: TENANT_B, isActive: true });
    expect(findFirstArgs.orderBy).toEqual({ createdAt: 'asc' });
  });
});
