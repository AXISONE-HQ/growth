/**
 * M3-1a — sub-objective-gap-tracker tests.
 *
 * Unit math + persistence semantics:
 *   - prioritize() math: priorityWeight × stageWeight × recencyFactor
 *   - hardTrigger detection (currentStageName / nextStageName match)
 *   - prioritization ordering (hardTrigger first, then score desc)
 *   - known + not_applicable filtered out of unfilled list
 *   - empty-rows → empty prioritization (compute returns empty list)
 *   - unconditional skipDuplicates seed (called every read; UNIQUE
 *     constraint makes existing rows no-ops — self-heals partial state)
 *   - fail-safe on error → empty state + audit row
 */
import { describe, it, expect, vi } from 'vitest';
import { prioritize, shouldEmitDiscovery, computeGapState } from '../sub-objective-gap-tracker.js';
import {
  DEFAULT_SUB_OBJECTIVES_GENERIC_B2B,
  SOFT_TRIGGER_THRESHOLD,
} from '@growth/shared';
import type { PrismaClient } from '@prisma/client';

const NOW = new Date('2026-05-28T12:00:00Z');

function row(
  key: string,
  state: 'unknown' | 'partial' | 'known' | 'not_applicable',
  overrides: { valueText?: string; setAt?: Date; valueType?: 'text' | 'date' | 'numeric' | 'enum_value' } = {},
) {
  return {
    subObjectiveKey: key,
    state,
    valueType: overrides.valueType ?? ('text' as const),
    valueText: overrides.valueText ?? null,
    setAt: overrides.setAt ?? NOW,
  };
}

describe('M3-1a prioritize — unfilled gap selection', () => {
  it('returns empty when all 5 defaults are known', () => {
    const rows = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => row(d.key, 'known'));
    const state = prioritize(rows, {});
    expect(state.prioritizedGaps).toHaveLength(0);
    expect(state.topCandidate).toBeUndefined();
  });

  it('includes unknown rows; excludes known + not_applicable', () => {
    const rows = [
      row('timeline', 'unknown'),
      row('budget', 'known'),
      row('authority', 'not_applicable'),
      row('need', 'partial', { valueText: 'growing team' }),
      row('motivation', 'unknown'),
    ];
    const state = prioritize(rows, {});
    const keys = state.prioritizedGaps.map((g) => g.key);
    expect(keys).toContain('timeline');
    expect(keys).toContain('need');
    expect(keys).toContain('motivation');
    expect(keys).not.toContain('budget');
    expect(keys).not.toContain('authority');
  });

  it('partial state surfaces valueIfPartial', () => {
    const rows = [row('need', 'partial', { valueText: 'growing team' })];
    const state = prioritize(rows, {});
    const need = state.prioritizedGaps.find((g) => g.key === 'need');
    expect(need?.valueIfPartial).toBe('growing team');
  });
});

describe('M3-1a prioritize — hardTrigger detection + ordering', () => {
  it('contact in qualified stage → timeline + need + motivation all hardTrigger=true', () => {
    const rows = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => row(d.key, 'unknown'));
    const state = prioritize(rows, { currentStageName: 'qualified' });
    const timeline = state.prioritizedGaps.find((g) => g.key === 'timeline');
    const budget = state.prioritizedGaps.find((g) => g.key === 'budget');
    expect(timeline?.hardTrigger).toBe(true);
    expect(budget?.hardTrigger).toBe(false); // budget is required at proposal-ready
  });

  it('hardTrigger rows sort before soft-trigger regardless of score', () => {
    const rows = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => row(d.key, 'unknown'));
    const state = prioritize(rows, { currentStageName: 'qualified' });
    // First gap MUST be a hard-trigger row.
    expect(state.prioritizedGaps[0].hardTrigger).toBe(true);
    expect(state.topCandidate?.hardTrigger).toBe(true);
  });

  it('within hardTrigger group, higher priorityWeight sorts first', () => {
    const rows = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => row(d.key, 'unknown'));
    const state = prioritize(rows, { currentStageName: 'qualified' });
    // qualified hard-triggers: timeline (0.9), need (0.75), motivation (0.7)
    const hardOnly = state.prioritizedGaps.filter((g) => g.hardTrigger);
    expect(hardOnly[0].key).toBe('timeline');
    expect(hardOnly[1].key).toBe('need');
    expect(hardOnly[2].key).toBe('motivation');
  });

  it('no stage match → all rows soft-only; sorted by priorityWeight desc', () => {
    const rows = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => row(d.key, 'unknown'));
    const state = prioritize(rows, { currentStageName: 'unknown-stage' });
    expect(state.prioritizedGaps.every((g) => g.hardTrigger === false)).toBe(true);
    expect(state.prioritizedGaps[0].key).toBe('timeline'); // 0.9 priority
  });
});

describe('M3-1a shouldEmitDiscovery — soft-trigger gating', () => {
  it('hard-trigger topCandidate always emits', () => {
    const state = prioritize(
      DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => row(d.key, 'unknown')),
      { currentStageName: 'qualified' },
    );
    expect(shouldEmitDiscovery(state)).toBe(true);
  });

  it('soft-trigger above SOFT_TRIGGER_THRESHOLD emits', () => {
    // All 5 defaults evaluated (impl iterates DEFAULT_SUB_OBJECTIVES, treats
    // missing rows as unknown). Top: timeline (0.9 × 0.7 = 0.63) above 0.6.
    const state = prioritize([row('timeline', 'unknown')], {});
    expect(state.topCandidate?.score).toBeGreaterThanOrEqual(SOFT_TRIGGER_THRESHOLD);
    expect(shouldEmitDiscovery(state)).toBe(true);
  });

  it('soft-trigger below SOFT_TRIGGER_THRESHOLD does not emit (only motivation unfilled)', () => {
    // Pass all 5 — motivation unknown, rest known. Top candidate is motivation
    // alone (0.7 × 0.7 = 0.49 → below 0.6).
    const rows = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) =>
      row(d.key, d.key === 'motivation' ? 'unknown' : 'known'),
    );
    const state = prioritize(rows, {});
    expect(state.topCandidate?.score).toBeLessThan(SOFT_TRIGGER_THRESHOLD);
    expect(shouldEmitDiscovery(state)).toBe(false);
  });

  it('empty state does not emit', () => {
    expect(shouldEmitDiscovery({ prioritizedGaps: [], topCandidate: undefined })).toBe(false);
  });
});

// ─────────────────────────────────────────────
// computeGapState — fail-safe + seed semantics
// ─────────────────────────────────────────────

function makeStubPrisma(opts: {
  findManyImpl?: () => Promise<unknown[]>;
  createManyImpl?: () => Promise<{ count: number }>;
  auditCreateImpl?: () => Promise<unknown>;
} = {}) {
  const findManyMock = vi.fn(opts.findManyImpl ?? (async () => []));
  const createManyMock = vi.fn(opts.createManyImpl ?? (async () => ({ count: 5 })));
  const auditCreateMock = vi.fn(opts.auditCreateImpl ?? (async () => ({ id: 'audit-1' })));
  return {
    prisma: {
      contactSubObjectiveGapState: {
        findMany: findManyMock,
        createMany: createManyMock,
      },
      auditLog: { create: auditCreateMock },
    } as unknown as PrismaClient,
    findManyMock,
    createManyMock,
    auditCreateMock,
  };
}

describe('M3-1a computeGapState — unconditional skipDuplicates seed (self-heals partial state)', () => {
  it('seeds defaults on EVERY call (no rows.length===0 guard)', async () => {
    // Even with rows present, createMany STILL fires (idempotent on UNIQUE).
    const { prisma, createManyMock } = makeStubPrisma({
      findManyImpl: async () => DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => row(d.key, 'unknown')),
      createManyImpl: async () => ({ count: 0 }), // no rows inserted (existing)
    });
    await computeGapState(prisma, 't-1', 'c-1', {});
    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(createManyMock.mock.calls[0][0]).toMatchObject({
      data: expect.arrayContaining([expect.objectContaining({ subObjectiveKey: 'timeline' })]),
      skipDuplicates: true,
    });
  });

  it('partial-seed scenario: 3 of 5 rows present → seed call backfills missing 2 (count=2)', async () => {
    const { prisma, createManyMock } = makeStubPrisma({
      findManyImpl: async () => [
        row('timeline', 'unknown'),
        row('budget', 'unknown'),
        row('authority', 'unknown'),
      ],
      createManyImpl: async () => ({ count: 2 }), // backfilled need + motivation
    });
    await computeGapState(prisma, 't-1', 'c-1', {});
    expect(createManyMock).toHaveBeenCalledTimes(1);
    // All 5 keys offered to createMany; UNIQUE constraint takes the 3 existing
    // as no-ops, inserts the 2 missing.
    const callData = createManyMock.mock.calls[0][0] as { data: Array<{ subObjectiveKey: string }> };
    const keysOffered = callData.data.map((d) => d.subObjectiveKey);
    expect(keysOffered).toEqual(expect.arrayContaining(['timeline', 'budget', 'authority', 'need', 'motivation']));
  });
});

describe('M3-1a computeGapState — fail-safe on error returns empty list + audit row', () => {
  it('findMany throw → returns empty state + writes read_failed audit row', async () => {
    const { prisma, auditCreateMock } = makeStubPrisma({
      findManyImpl: async () => {
        throw new Error('DB connection lost');
      },
    });
    const result = await computeGapState(prisma, 't-1', 'c-1', {});
    expect(result.prioritizedGaps).toEqual([]);
    expect(result.topCandidate).toBeUndefined();
    // The seed call's audit (sub_objective_gap_state.seeded) may also fire
    // BEFORE findMany; look across ALL audit calls for read_failed.
    const auditCalls = auditCreateMock.mock.calls.map(
      (c) => (c[0] as { data: { actionType: string; payload: Record<string, unknown> } }).data,
    );
    const failureRow = auditCalls.find((d) => d.actionType === 'sub_objective_gap_state.read_failed');
    expect(failureRow).toBeDefined();
    expect((failureRow!.payload as { error: string }).error).toBe('DB connection lost');
  });

  it('createMany throw → returns empty state + read_failed audit row (seed failure is fail-safe too)', async () => {
    const { prisma, auditCreateMock } = makeStubPrisma({
      createManyImpl: async () => {
        throw new Error('UNIQUE violation race');
      },
    });
    const result = await computeGapState(prisma, 't-1', 'c-1', {});
    expect(result.prioritizedGaps).toEqual([]);
    const auditCalls = auditCreateMock.mock.calls.map(
      (c) => (c[0] as { data: { actionType: string } }).data,
    );
    expect(auditCalls.some((d) => d.actionType === 'sub_objective_gap_state.read_failed')).toBe(true);
  });
});

// ─────────────────────────────────────────────
// Multi-tenant rigor — tenantId scoping
// ─────────────────────────────────────────────

describe('M3-1a — multi-tenant scoping', () => {
  it('findMany call WHERE clause scopes to both tenantId AND contactId', async () => {
    const { prisma, findManyMock } = makeStubPrisma();
    await computeGapState(prisma, 'tenant-A', 'contact-A', {});
    expect(findManyMock).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-A', contactId: 'contact-A' },
    });
  });

  it('seed rows ALL carry the call-site tenantId (no leak)', async () => {
    const { prisma, createManyMock } = makeStubPrisma();
    await computeGapState(prisma, 'tenant-B', 'contact-B', {});
    const callData = createManyMock.mock.calls[0][0] as {
      data: Array<{ tenantId: string; contactId: string }>;
    };
    for (const r of callData.data) {
      expect(r.tenantId).toBe('tenant-B');
      expect(r.contactId).toBe('contact-B');
    }
  });
});
