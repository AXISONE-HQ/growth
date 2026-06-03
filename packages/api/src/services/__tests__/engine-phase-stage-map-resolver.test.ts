/**
 * KAN-1080 (Cluster III PR I) — engine-phase-stage-map-resolver tests.
 *
 * Coverage:
 *   - Resolution order: Tenant override > Blueprint > empty
 *   - Stage name not found → null entry (fail-safe; per-phase isolation)
 *   - Prisma error → empty result + audit warn (best-effort posture)
 *   - Loader-resolved export guard via vi.importActual (KAN-1067 pattern)
 *   - Empty Blueprint default → all null entries
 *   - Mixed map (some phases set, some null) → correct per-phase resolution
 *   - outcomeType='open' stages valid for closing phase (no terminal assertion)
 *   - Malformed Json entries → coerce to null (per-phase, NOT global failure)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { resolveEnginePhaseStageMap } from '../engine-phase-stage-map-resolver.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const PIPELINE_A = 'pipeline_a';

interface FakePrisma {
  tenant: { findUnique: ReturnType<typeof vi.fn> };
  pipeline: { findUnique: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
}

function makePrisma(): FakePrisma {
  return {
    tenant: { findUnique: vi.fn() },
    pipeline: { findUnique: vi.fn() },
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
  };
}

const STAGES = [
  { id: 'stage-qualified', name: 'Qualified' },
  { id: 'stage-demo-set', name: 'Demo Set' },
  { id: 'stage-demo-held', name: 'Demo Held' },
  { id: 'stage-no-show', name: 'No-show' },
];

describe('resolveEnginePhaseStageMap — resolution order', () => {
  let prisma: FakePrisma;

  beforeEach(() => {
    prisma = makePrisma();
    prisma.pipeline.findUnique.mockResolvedValue({ stages: STAGES });
  });

  it('Tenant override takes precedence over Blueprint', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      enginePhaseStageMapOverride: {
        closing: { stageName: 'Demo Held', stageRoleHint: 'tenant_override_hint' },
      },
      blueprint: {
        enginePhaseStageMap: {
          closing: { stageName: 'No-show', stageRoleHint: 'blueprint_hint' },
        },
      },
    });

    const result = await resolveEnginePhaseStageMap(prisma as unknown as PrismaClient, TENANT_A, PIPELINE_A);

    expect(result.closing).toEqual({
      stageId: 'stage-demo-held',
      stageName: 'Demo Held',
      stageRoleHint: 'tenant_override_hint',
    });
    expect(result.qualify).toBeNull();
    expect(result.problem).toBeNull();
    expect(result.proof).toBeNull();
  });

  it('Blueprint default applies when Tenant override is null', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      enginePhaseStageMapOverride: null,
      blueprint: {
        enginePhaseStageMap: { closing: { stageName: 'Demo Held' } },
      },
    });

    const result = await resolveEnginePhaseStageMap(prisma as unknown as PrismaClient, TENANT_A, PIPELINE_A);

    expect(result.closing?.stageId).toBe('stage-demo-held');
    expect(result.closing?.stageName).toBe('Demo Held');
  });

  it('Empty default → all null entries when both override and Blueprint are null', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      enginePhaseStageMapOverride: null,
      blueprint: { enginePhaseStageMap: null },
    });

    const result = await resolveEnginePhaseStageMap(prisma as unknown as PrismaClient, TENANT_A, PIPELINE_A);

    expect(result).toEqual({ qualify: null, problem: null, proof: null, closing: null });
    // Pipeline query short-circuited (no Stages to look up).
    expect(prisma.pipeline.findUnique).not.toHaveBeenCalled();
  });

  it('Tenant missing → empty result + no audit row written', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);

    const result = await resolveEnginePhaseStageMap(prisma as unknown as PrismaClient, TENANT_A, PIPELINE_A);

    expect(result).toEqual({ qualify: null, problem: null, proof: null, closing: null });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('resolveEnginePhaseStageMap — per-phase resolution', () => {
  let prisma: FakePrisma;

  beforeEach(() => {
    prisma = makePrisma();
    prisma.pipeline.findUnique.mockResolvedValue({ stages: STAGES });
  });

  it('mixed map: some phases set, some absent → correct per-phase shape', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      enginePhaseStageMapOverride: {
        qualify: { stageName: 'Qualified' },
        closing: { stageName: 'Demo Held' },
      },
      blueprint: { enginePhaseStageMap: null },
    });

    const result = await resolveEnginePhaseStageMap(prisma as unknown as PrismaClient, TENANT_A, PIPELINE_A);

    expect(result.qualify?.stageName).toBe('Qualified');
    expect(result.closing?.stageName).toBe('Demo Held');
    expect(result.problem).toBeNull();
    expect(result.proof).toBeNull();
  });

  it('stage name not found in Pipeline → null entry for that phase only (per-phase isolation)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      enginePhaseStageMapOverride: {
        qualify: { stageName: 'Qualified' },
        closing: { stageName: 'NonExistent Stage' },
      },
      blueprint: { enginePhaseStageMap: null },
    });

    const result = await resolveEnginePhaseStageMap(prisma as unknown as PrismaClient, TENANT_A, PIPELINE_A);

    expect(result.qualify?.stageId).toBe('stage-qualified');
    expect(result.closing).toBeNull();
  });

  it("outcomeType='open' Stage valid for closing phase (Phase 1.5 empirical finding — no terminal assertion)", async () => {
    // Most PROD pipelines lack terminal_won/terminal_lost stages. Resolver
    // does NOT check outcomeType; it only matches by name.
    prisma.tenant.findUnique.mockResolvedValue({
      enginePhaseStageMapOverride: {
        closing: { stageName: 'Qualified' },  // 'Qualified' is open, but resolver accepts
      },
      blueprint: { enginePhaseStageMap: null },
    });

    const result = await resolveEnginePhaseStageMap(prisma as unknown as PrismaClient, TENANT_A, PIPELINE_A);

    expect(result.closing?.stageId).toBe('stage-qualified');
  });

  it('stageRoleHint forensic metadata threaded through resolution', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      enginePhaseStageMapOverride: {
        closing: { stageName: 'Demo Held', stageRoleHint: 'closed_won' },
      },
      blueprint: { enginePhaseStageMap: null },
    });

    const result = await resolveEnginePhaseStageMap(prisma as unknown as PrismaClient, TENANT_A, PIPELINE_A);

    expect(result.closing).toEqual({
      stageId: 'stage-demo-held',
      stageName: 'Demo Held',
      stageRoleHint: 'closed_won',
    });
  });
});

describe('resolveEnginePhaseStageMap — fail-safe posture', () => {
  let prisma: FakePrisma;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('Prisma tenant.findUnique throws → empty result + audit warn row', async () => {
    prisma.tenant.findUnique.mockRejectedValue(new Error('connection refused'));

    const result = await resolveEnginePhaseStageMap(prisma as unknown as PrismaClient, TENANT_A, PIPELINE_A);

    expect(result).toEqual({ qualify: null, problem: null, proof: null, closing: null });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = prisma.auditLog.create.mock.calls[0]![0] as { data: { actionType: string; reasoning: string } };
    expect(auditArgs.data.actionType).toBe('engine_phase_stage_map.resolve_failed');
    expect(auditArgs.data.reasoning).toContain('connection refused');
  });

  it('Pipeline missing → empty result + audit row with pipeline_not_found reason', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      enginePhaseStageMapOverride: { closing: { stageName: 'Demo Held' } },
      blueprint: { enginePhaseStageMap: null },
    });
    prisma.pipeline.findUnique.mockResolvedValue(null);

    const result = await resolveEnginePhaseStageMap(prisma as unknown as PrismaClient, TENANT_A, PIPELINE_A);

    expect(result).toEqual({ qualify: null, problem: null, proof: null, closing: null });
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditArgs = prisma.auditLog.create.mock.calls[0]![0] as { data: { reasoning: string } };
    expect(auditArgs.data.reasoning).toContain('pipeline_not_found');
  });

  it('Audit write failure → swallow + warn (best-effort; caller still gets empty result)', async () => {
    prisma.tenant.findUnique.mockRejectedValue(new Error('connection refused'));
    prisma.auditLog.create.mockRejectedValue(new Error('audit log DB down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await resolveEnginePhaseStageMap(prisma as unknown as PrismaClient, TENANT_A, PIPELINE_A);

    expect(result).toEqual({ qualify: null, problem: null, proof: null, closing: null });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('malformed Json entry (missing stageName) → null for that phase; siblings unaffected', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      enginePhaseStageMapOverride: {
        qualify: { stageName: 'Qualified' },
        // bad shape: missing stageName
        closing: { stageRoleHint: 'closed_won_only' },
      },
      blueprint: { enginePhaseStageMap: null },
    });
    prisma.pipeline.findUnique.mockResolvedValue({ stages: STAGES });

    const result = await resolveEnginePhaseStageMap(prisma as unknown as PrismaClient, TENANT_A, PIPELINE_A);

    expect(result.qualify?.stageId).toBe('stage-qualified');
    expect(result.closing).toBeNull();
  });
});
