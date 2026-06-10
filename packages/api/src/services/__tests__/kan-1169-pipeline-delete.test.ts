/**
 * KAN-1169 — Pipeline delete with reassignment + soft-archive when history exists.
 *
 * Unit tests cover the `checkPipelineDeletability` decision matrix (mocked
 * Prisma counts). Full end-to-end procedure orchestration (deal reassignment,
 * transaction atomicity, audit-row creation, FK cascade behavior) is covered
 * by the real-Postgres integration test
 * `apps/api/src/__tests__/integration/kan-1169-pipeline-delete.test.ts`.
 *
 * Decision matrix coverage:
 *   1. blockReason='last_pipeline' when activePipelineCount === 1
 *   2. blockReason='default_assignment' when tenant.defaultAssignmentPipelineId === pipelineId
 *   3. blockReason=null + dealCount=0 + hasStageHistory=false → hard-delete eligible
 *   4. blockReason=null + dealCount=0 + hasStageHistory=true → soft-archive (empty)
 *   5. blockReason=null + dealCount>0 + hasStageHistory=true → soft-archive (with reassign)
 *   6. destinationCandidates correctly excludes the source pipeline
 *   7. tenant lookup miss (defaultAssignmentPipelineId=null) does not block
 *
 * Procedure scenarios 8-12 (reassign self-rejection, cross-tenant rejection,
 * concurrent race, transaction rollback, initial-stage assignment) land in the
 * integration suite where real Prisma + Postgres FK enforcement runs.
 */
import { describe, it, expect, vi } from 'vitest';
import { checkPipelineDeletability } from '../../../../../apps/api/src/router.js';

type PrismaMock = {
  pipeline: { count: ReturnType<typeof vi.fn> };
  tenant: { findUnique: ReturnType<typeof vi.fn> };
  deal: { count: ReturnType<typeof vi.fn> };
  dealStageHistory: { count: ReturnType<typeof vi.fn> };
};

function buildPrisma(opts: {
  activePipelineCount?: number;
  defaultAssignmentPipelineId?: string | null;
  dealCount?: number;
  destinationCandidates?: number;
  stageHistoryCount?: number;
}): PrismaMock {
  const pipelineCount = vi
    .fn()
    .mockImplementation((args: { where: { id?: { not?: string } } }) => {
      // Destination-candidate query has id.not set; otherwise it's the active-count query.
      if (args.where.id && 'not' in args.where.id) {
        return Promise.resolve(opts.destinationCandidates ?? 0);
      }
      return Promise.resolve(opts.activePipelineCount ?? 2);
    });
  return {
    pipeline: { count: pipelineCount },
    tenant: {
      findUnique: vi.fn().mockResolvedValue({
        defaultAssignmentPipelineId: opts.defaultAssignmentPipelineId ?? null,
      }),
    },
    deal: { count: vi.fn().mockResolvedValue(opts.dealCount ?? 0) },
    dealStageHistory: { count: vi.fn().mockResolvedValue(opts.stageHistoryCount ?? 0) },
  };
}

const TENANT = 'tenant-1';
const PIPELINE = 'pipeline-A';

describe('KAN-1169 — checkPipelineDeletability', () => {
  it('1. blocks when tenant has only one active pipeline', async () => {
    const prisma = buildPrisma({ activePipelineCount: 1 });
    const result = await checkPipelineDeletability(prisma, TENANT, PIPELINE);
    expect(result.blockReason).toBe('last_pipeline');
    expect(result.dealCount).toBe(0);
    expect(result.destinationCandidates).toBe(0);
    expect(result.hasStageHistory).toBe(false);
    // Short-circuits before deal/history queries.
    expect(prisma.deal.count).not.toHaveBeenCalled();
    expect(prisma.dealStageHistory.count).not.toHaveBeenCalled();
  });

  it('2. blocks when pipeline is tenant default-assignment', async () => {
    const prisma = buildPrisma({
      activePipelineCount: 3,
      defaultAssignmentPipelineId: PIPELINE,
    });
    const result = await checkPipelineDeletability(prisma, TENANT, PIPELINE);
    expect(result.blockReason).toBe('default_assignment');
    expect(prisma.deal.count).not.toHaveBeenCalled();
    expect(prisma.dealStageHistory.count).not.toHaveBeenCalled();
  });

  it('3. clear path when pipeline is empty + has no history (hard-delete eligible)', async () => {
    const prisma = buildPrisma({
      activePipelineCount: 3,
      defaultAssignmentPipelineId: 'pipeline-other',
      dealCount: 0,
      destinationCandidates: 2,
      stageHistoryCount: 0,
    });
    const result = await checkPipelineDeletability(prisma, TENANT, PIPELINE);
    expect(result.blockReason).toBeNull();
    expect(result.dealCount).toBe(0);
    expect(result.destinationCandidates).toBe(2);
    expect(result.hasStageHistory).toBe(false);
  });

  it('4. surfaces hasStageHistory=true for empty pipeline (soft-archive path)', async () => {
    const prisma = buildPrisma({
      activePipelineCount: 3,
      dealCount: 0,
      destinationCandidates: 2,
      stageHistoryCount: 5,
    });
    const result = await checkPipelineDeletability(prisma, TENANT, PIPELINE);
    expect(result.blockReason).toBeNull();
    expect(result.dealCount).toBe(0);
    expect(result.hasStageHistory).toBe(true);
  });

  it('5. surfaces hasStageHistory=true for populated pipeline (reassign + archive)', async () => {
    const prisma = buildPrisma({
      activePipelineCount: 3,
      dealCount: 7,
      destinationCandidates: 2,
      stageHistoryCount: 12,
    });
    const result = await checkPipelineDeletability(prisma, TENANT, PIPELINE);
    expect(result.blockReason).toBeNull();
    expect(result.dealCount).toBe(7);
    expect(result.hasStageHistory).toBe(true);
    expect(result.destinationCandidates).toBe(2);
  });

  it('6. destinationCandidates excludes the source pipeline (id.not filter applied)', async () => {
    const prisma = buildPrisma({
      activePipelineCount: 3,
      destinationCandidates: 2,
    });
    await checkPipelineDeletability(prisma, TENANT, PIPELINE);
    // The second pipeline.count call (destinations) must include id.not = PIPELINE.
    const calls = prisma.pipeline.count.mock.calls;
    expect(calls.length).toBe(2);
    const destinationCall = calls[1]?.[0] as { where: { id: { not: string } } } | undefined;
    expect(destinationCall?.where.id.not).toBe(PIPELINE);
  });

  it('7. tenant lookup miss (defaultAssignmentPipelineId=null) does not block', async () => {
    const prisma = buildPrisma({
      activePipelineCount: 3,
      defaultAssignmentPipelineId: null,
      dealCount: 0,
      destinationCandidates: 2,
      stageHistoryCount: 0,
    });
    const result = await checkPipelineDeletability(prisma, TENANT, PIPELINE);
    expect(result.blockReason).toBeNull();
  });
});
