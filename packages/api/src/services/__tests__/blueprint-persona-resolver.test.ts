/**
 * KAN-1093 (Cluster IV-B PR I) — blueprint-persona-resolver tests.
 *
 * Coverage:
 *   - Resolution order: Tenant override > Blueprint > DEFAULT_PERSONA_GENERIC_B2B
 *   - Tenant not found → DEFAULT fallback
 *   - Blueprint missing on Tenant → DEFAULT fallback
 *   - Malformed Json (any field) → coerce to DEFAULT values (per-field fail-safe)
 *   - Prisma error → catch + best-effort audit + return DEFAULT
 *   - toneDefaults coercion: arbitrary keys filtered to EnginePhaseKey; non-BrainSuggestedTone values discarded
 *   - Empty arrays/objects preserved (no over-coercion to DEFAULT)
 *   - Loader-resolved export guard via vi.importActual (KAN-1067 pattern carried)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { resolveBlueprintPersona } from '../blueprint-persona-resolver.js';
import { DEFAULT_PERSONA_GENERIC_B2B } from '@growth/shared';

const TENANT_A = '11111111-1111-1111-1111-111111111111';

interface FakePrisma {
  tenant: { findUnique: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
}

function makePrisma(): FakePrisma {
  return {
    tenant: { findUnique: vi.fn() },
    auditLog: { create: vi.fn(async () => ({ id: 'audit-1' })) },
  };
}

const VALID_OVERRIDE_PERSONA = {
  name: 'AxisOne Premium',
  voice: 'consultative and warm',
  toneDefaults: {
    qualify: 'curious',
    closing: 'closing',
  },
  brandAttributes: ['premium', 'enterprise', 'trusted'],
  voiceExamples: ['Hey {{firstName}}, I noticed your team has been exploring...'],
};

const VALID_BLUEPRINT_PERSONA = {
  name: 'Generic Vertical',
  voice: 'professional yet approachable',
  toneDefaults: {
    problem: 'professional',
  },
  brandAttributes: ['established'],
  voiceExamples: [],
};

describe('resolveBlueprintPersona — resolution order', () => {
  let prisma: FakePrisma;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('Tenant override takes precedence over Blueprint', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      personaOverride: VALID_OVERRIDE_PERSONA,
      blueprint: { persona: VALID_BLUEPRINT_PERSONA },
    });

    const result = await resolveBlueprintPersona(prisma as unknown as PrismaClient, TENANT_A);

    expect(result.name).toBe('AxisOne Premium');
    expect(result.voice).toBe('consultative and warm');
    expect(result.toneDefaults).toEqual({ qualify: 'curious', closing: 'closing' });
    expect(result.brandAttributes).toEqual(['premium', 'enterprise', 'trusted']);
  });

  it('Blueprint default applies when Tenant override is null', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      personaOverride: null,
      blueprint: { persona: VALID_BLUEPRINT_PERSONA },
    });

    const result = await resolveBlueprintPersona(prisma as unknown as PrismaClient, TENANT_A);

    expect(result.name).toBe('Generic Vertical');
    expect(result.voice).toBe('professional yet approachable');
    expect(result.toneDefaults).toEqual({ problem: 'professional' });
  });

  it('DEFAULT_PERSONA_GENERIC_B2B fallback when both override and Blueprint are null', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      personaOverride: null,
      blueprint: { persona: null },
    });

    const result = await resolveBlueprintPersona(prisma as unknown as PrismaClient, TENANT_A);

    expect(result).toEqual(DEFAULT_PERSONA_GENERIC_B2B);
    expect(result.toneDefaults).toEqual({});
    expect(result.brandAttributes).toEqual([]);
    expect(result.voiceExamples).toEqual([]);
  });

  it('Tenant not found → DEFAULT fallback', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);

    const result = await resolveBlueprintPersona(prisma as unknown as PrismaClient, TENANT_A);

    expect(result).toEqual(DEFAULT_PERSONA_GENERIC_B2B);
  });

  it('Blueprint missing on Tenant (null relation) → DEFAULT fallback when override also null', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      personaOverride: null,
      blueprint: null,
    });

    const result = await resolveBlueprintPersona(prisma as unknown as PrismaClient, TENANT_A);

    expect(result).toEqual(DEFAULT_PERSONA_GENERIC_B2B);
  });
});

describe('resolveBlueprintPersona — coercion + fail-safe', () => {
  let prisma: FakePrisma;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('Malformed name (number) → coerces to DEFAULT name; other fields preserved', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      personaOverride: {
        name: 42,
        voice: 'valid voice',
        toneDefaults: {},
        brandAttributes: [],
        voiceExamples: [],
      },
      blueprint: null,
    });

    const result = await resolveBlueprintPersona(prisma as unknown as PrismaClient, TENANT_A);

    expect(result.name).toBe(DEFAULT_PERSONA_GENERIC_B2B.name);
    expect(result.voice).toBe('valid voice');
  });

  it('toneDefaults: invalid tone values dropped per-phase; valid values retained', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      personaOverride: {
        name: 'X',
        voice: 'X',
        toneDefaults: {
          qualify: 'curious',           // valid
          problem: 'INVALID_TONE',      // dropped
          proof: 'professional',        // valid
          closing: 'urgent',            // valid
          nonsense_phase: 'curious',    // dropped — not an EnginePhaseKey
        },
        brandAttributes: [],
        voiceExamples: [],
      },
      blueprint: null,
    });

    const result = await resolveBlueprintPersona(prisma as unknown as PrismaClient, TENANT_A);

    expect(result.toneDefaults).toEqual({
      qualify: 'curious',
      proof: 'professional',
      closing: 'urgent',
    });
  });

  it('brandAttributes: non-string entries dropped; valid strings retained', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      personaOverride: {
        name: 'X',
        voice: 'X',
        toneDefaults: {},
        brandAttributes: ['valid', 42, null, '', 'also-valid'],
        voiceExamples: [],
      },
      blueprint: null,
    });

    const result = await resolveBlueprintPersona(prisma as unknown as PrismaClient, TENANT_A);

    expect(result.brandAttributes).toEqual(['valid', 'also-valid']);
  });

  it('Prisma error → catches + best-effort audit + returns DEFAULT', async () => {
    prisma.tenant.findUnique.mockRejectedValue(new Error('connection refused'));

    const result = await resolveBlueprintPersona(prisma as unknown as PrismaClient, TENANT_A);

    expect(result).toEqual(DEFAULT_PERSONA_GENERIC_B2B);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const auditCall = prisma.auditLog.create.mock.calls[0][0] as {
      data: { actionType: string; actor: string; reasoning: string };
    };
    expect(auditCall.data.actionType).toBe('blueprint_persona.resolve_failed');
    expect(auditCall.data.actor).toBe('system:blueprint-persona-resolver');
    expect(auditCall.data.reasoning).toBe('connection refused');
  });

  it('Empty arrays preserved (no over-coercion to DEFAULT)', async () => {
    prisma.tenant.findUnique.mockResolvedValue({
      personaOverride: {
        name: 'Customized',
        voice: 'Custom voice',
        toneDefaults: {},
        brandAttributes: [],
        voiceExamples: [],
      },
      blueprint: null,
    });

    const result = await resolveBlueprintPersona(prisma as unknown as PrismaClient, TENANT_A);

    expect(result.name).toBe('Customized');
    expect(result.voice).toBe('Custom voice');
    expect(result.toneDefaults).toEqual({});
    expect(result.brandAttributes).toEqual([]);
    expect(result.voiceExamples).toEqual([]);
  });
});

describe('resolveBlueprintPersona — loader contract (KAN-1067 pattern)', () => {
  it('canonical loader path re-exports resolveBlueprintPersona from brain-service.js', async () => {
    // Per `feedback_loader_vs_canonical_test_divergence` (KAN-1067 incident):
    // subscribers load via variable-specifier dynamic import of brain-service.js.
    // The symbol MUST be re-exported there OR the test-vs-runtime divergence
    // pattern recurs. This assertion guards the contract at test time.
    const actual = await vi.importActual<typeof import('../brain-service.js')>('../brain-service.js');
    expect(typeof (actual as { resolveBlueprintPersona?: unknown }).resolveBlueprintPersona).toBe('function');
  });
});
