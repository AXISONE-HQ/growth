/**
 * KAN-1064 (Cluster II PR II) — resolveEnginePhases tests.
 *
 * Covers the 6-test surface from Phase 1 trace:
 *   1. Tenant override present → returns override
 *   2. Tenant override null, Blueprint enginePhases set → returns Blueprint config
 *   3. Both null → returns DEFAULT_ENGINE_PHASES_GENERIC_B2B
 *   4. No Blueprint relation (Tenant.blueprintId null) → returns DEFAULT
 *   5. Prisma throw → fail-safe to DEFAULT + warn-log
 *   6. Audit row `engine_phases.resolve_failed` written on throw (best-effort)
 *
 * Q4 lock: fail-safe to DEFAULT on any prisma throw; audit-row write is
 * best-effort (own try/catch so it doesn't propagate).
 *
 * Prisma mocked via hand-rolled vi.fn() per sibling convention
 * (brain-service.test.ts, build-thread-context.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  DEFAULT_ENGINE_PHASES_GENERIC_B2B,
  type BlueprintEnginePhase,
} from '@growth/shared';
import { resolveEnginePhases } from '../blueprint-engine-phases-resolver.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

const TENANT_OVERRIDE_PHASES: BlueprintEnginePhase[] = [
  { key: 'qualify', label: 'Custom-Qualify', subObjectives: ['authority', 'custom_key'], priority: 1 },
  { key: 'problem', label: 'Custom-Problem', subObjectives: ['need'], priority: 2 },
  { key: 'proof', label: 'Custom-Proof', subObjectives: ['roi_metrics'], priority: 3 },
  { key: 'closing', label: 'Custom-Closing', subObjectives: ['timeline'], priority: 4 },
];

const BLUEPRINT_PHASES: BlueprintEnginePhase[] = [
  { key: 'qualify', label: 'BP-Qualify', subObjectives: ['authority'], priority: 1 },
  { key: 'problem', label: 'BP-Problem', subObjectives: ['need', 'motivation'], priority: 2 },
  { key: 'proof', label: 'BP-Proof', subObjectives: ['roi_metrics'], priority: 3 },
  { key: 'closing', label: 'BP-Closing', subObjectives: ['timeline'], priority: 4 },
];

let findUniqueMock: ReturnType<typeof vi.fn>;
let auditCreateMock: ReturnType<typeof vi.fn>;
let mockPrisma: PrismaClient;

beforeEach(() => {
  findUniqueMock = vi.fn();
  auditCreateMock = vi.fn().mockResolvedValue({ id: 'audit_x' });
  mockPrisma = {
    tenant: { findUnique: findUniqueMock },
    auditLog: { create: auditCreateMock },
  } as unknown as PrismaClient;
});

describe('KAN-1064 — resolveEnginePhases', () => {
  // ── (1/6) Tenant override wins ──
  it('returns Tenant override when present (highest precedence)', async () => {
    findUniqueMock.mockResolvedValueOnce({
      enginePhasesOverride: { phases: TENANT_OVERRIDE_PHASES },
      blueprint: { enginePhases: { phases: BLUEPRINT_PHASES } }, // ignored when override present
    });
    const result = await resolveEnginePhases(mockPrisma, TENANT_A);
    expect(result).toEqual(TENANT_OVERRIDE_PHASES);
    // Labels carry through to confirm we returned the override, not Blueprint.
    expect(result[0].label).toBe('Custom-Qualify');
  });

  // ── (2/6) Blueprint wins when no override ──
  it('returns Blueprint enginePhases when Tenant override is null', async () => {
    findUniqueMock.mockResolvedValueOnce({
      enginePhasesOverride: null,
      blueprint: { enginePhases: { phases: BLUEPRINT_PHASES } },
    });
    const result = await resolveEnginePhases(mockPrisma, TENANT_A);
    expect(result).toEqual(BLUEPRINT_PHASES);
    expect(result[0].label).toBe('BP-Qualify');
  });

  // ── (3/6) DEFAULT fallback when both null ──
  it('returns DEFAULT_ENGINE_PHASES_GENERIC_B2B when both override and Blueprint config are null', async () => {
    findUniqueMock.mockResolvedValueOnce({
      enginePhasesOverride: null,
      blueprint: { enginePhases: null },
    });
    const result = await resolveEnginePhases(mockPrisma, TENANT_A);
    // Structural equality on the default content.
    expect(result).toEqual([...DEFAULT_ENGINE_PHASES_GENERIC_B2B]);
    expect(result[0].key).toBe('qualify');
    expect(result[3].key).toBe('closing');
  });

  // ── (4/6) No Blueprint relation ──
  it('returns DEFAULT when Tenant has no Blueprint relation (blueprintId null)', async () => {
    findUniqueMock.mockResolvedValueOnce({
      enginePhasesOverride: null,
      blueprint: null, // Tenant.blueprintId was null, so the relation lookup returns null
    });
    const result = await resolveEnginePhases(mockPrisma, TENANT_A);
    expect(result).toEqual([...DEFAULT_ENGINE_PHASES_GENERIC_B2B]);
  });

  // ── (5/6) Prisma throw → fail-safe to DEFAULT + warn-log ──
  it('returns DEFAULT on prisma throw (Q4 lock fail-safe + warn-log)', async () => {
    findUniqueMock.mockRejectedValueOnce(new Error('prisma connection lost'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await resolveEnginePhases(mockPrisma, TENANT_A);
    expect(result).toEqual([...DEFAULT_ENGINE_PHASES_GENERIC_B2B]);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/resolveEnginePhases failed/);
    expect(warnSpy.mock.calls[0][0]).toContain(TENANT_A);
    expect(warnSpy.mock.calls[0][0]).toContain('prisma connection lost');
    warnSpy.mockRestore();
  });

  // ── (6/6) Audit row written on throw ──
  it('writes engine_phases.resolve_failed audit row on prisma throw (best-effort)', async () => {
    findUniqueMock.mockRejectedValueOnce(new Error('DB connection refused'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await resolveEnginePhases(mockPrisma, TENANT_A);
    // Audit row sentinel.
    expect(auditCreateMock).toHaveBeenCalledTimes(1);
    const auditArg = auditCreateMock.mock.calls[0][0] as {
      data: {
        tenantId: string;
        actor: string;
        actionType: string;
        payload: { tenantId: string; error: string };
      };
    };
    expect(auditArg.data.tenantId).toBe(TENANT_A);
    expect(auditArg.data.actor).toBe('system:blueprint-engine-phases-resolver');
    expect(auditArg.data.actionType).toBe('engine_phases.resolve_failed');
    expect(auditArg.data.payload.error).toBe('DB connection refused');
    vi.restoreAllMocks();
  });
});

describe('KAN-1064 — resolveEnginePhases: defensive edge cases', () => {
  it('returns DEFAULT when Tenant row not found (defense-in-depth)', async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await resolveEnginePhases(mockPrisma, TENANT_A);
    expect(result).toEqual([...DEFAULT_ENGINE_PHASES_GENERIC_B2B]);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/tenant not found/);
    warnSpy.mockRestore();
  });

  it('returns DEFAULT when override has malformed shape (non-array phases)', async () => {
    findUniqueMock.mockResolvedValueOnce({
      enginePhasesOverride: { phases: 'not an array' },
      blueprint: null,
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await resolveEnginePhases(mockPrisma, TENANT_A);
    expect(result).toEqual([...DEFAULT_ENGINE_PHASES_GENERIC_B2B]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/malformed enginePhases config/),
    );
    warnSpy.mockRestore();
  });

  it('returns DEFAULT when override has empty phases array', async () => {
    findUniqueMock.mockResolvedValueOnce({
      enginePhasesOverride: { phases: [] },
      blueprint: null,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await resolveEnginePhases(mockPrisma, TENANT_A);
    expect(result).toEqual([...DEFAULT_ENGINE_PHASES_GENERIC_B2B]);
    vi.restoreAllMocks();
  });

  it('Tenant override absent + Blueprint config absent + audit-create also throws → still returns DEFAULT (belt-and-suspenders)', async () => {
    findUniqueMock.mockRejectedValueOnce(new Error('prisma down'));
    auditCreateMock.mockRejectedValueOnce(new Error('audit also down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await resolveEnginePhases(mockPrisma, TENANT_A);
    expect(result).toEqual([...DEFAULT_ENGINE_PHASES_GENERIC_B2B]);
    vi.restoreAllMocks();
  });
});
