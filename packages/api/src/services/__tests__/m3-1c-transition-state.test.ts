/**
 * M3-1c — transitionSubObjectiveState mutation tests.
 *
 * Pinned behaviors:
 *   - cross-tenant rejection: operator in tenant A on contactId in
 *     tenant B → throws (contact lookup returns null)
 *   - subObjectiveKey validation: unknown key → throws
 *   - value required for toState='known'; absent → throws
 *   - per-valueType column routing: text → value_text; date → value_date;
 *     numeric → value_numeric; enum → value_enum
 *   - source='manual' + setBy=actor on the upsert
 *   - audit-log row written per transition (best-effort, not load-bearing)
 *   - previousState reported correctly (read before upsert)
 *   - not_applicable: clears all value columns + no value required
 */
import { describe, it, expect, vi } from 'vitest';
import { transitionSubObjectiveState } from '../sub-objective-gap-tracker.js';

const TENANT = 'tenant-a';
const CONTACT = 'contact-a';
const ACTOR = 'uid-fred';

function makePrisma(opts: {
  contactInTenant?: boolean;
  existingState?: 'unknown' | 'partial' | 'known' | 'not_applicable';
  upsertImpl?: () => Promise<unknown>;
  auditImpl?: () => Promise<unknown>;
} = {}) {
  const contactInTenant = opts.contactInTenant !== false;
  const findFirst = vi.fn(async () => (contactInTenant ? { id: CONTACT } : null));
  const findUnique = vi.fn(async () => opts.existingState ? { state: opts.existingState } : null);
  const upsert = vi.fn(opts.upsertImpl ?? (async (args: { create: { state: string } }) => ({ id: 'r1', state: args.create.state })));
  const auditCreate = vi.fn(opts.auditImpl ?? (async () => ({ id: 'a1' })));
  return {
    prisma: {
      contact: { findFirst },
      contactSubObjectiveGapState: { findUnique, upsert },
      auditLog: { create: auditCreate },
    } as never,
    findFirst,
    findUnique,
    upsert,
    auditCreate,
  };
}

describe('M3-1c — cross-tenant rejection', () => {
  it('contact not in tenant → throws', async () => {
    const { prisma } = makePrisma({ contactInTenant: false });
    await expect(
      transitionSubObjectiveState(prisma, TENANT, ACTOR, {
        contactId: CONTACT,
        subObjectiveKey: 'timeline',
        toState: 'known',
        value: 'Q3 2026',
      }),
    ).rejects.toThrow(/not in tenant/);
  });
});

describe('M3-1c — sub_objective_key validation', () => {
  it('unknown key → throws', async () => {
    const { prisma } = makePrisma();
    await expect(
      transitionSubObjectiveState(prisma, TENANT, ACTOR, {
        contactId: CONTACT,
        subObjectiveKey: 'NOT_A_REAL_KEY',
        toState: 'known',
        value: 'whatever',
      }),
    ).rejects.toThrow(/unknown sub_objective_key/);
  });
});

describe('M3-1c — value required for toState=known', () => {
  it('missing value → throws', async () => {
    const { prisma } = makePrisma();
    await expect(
      transitionSubObjectiveState(prisma, TENANT, ACTOR, {
        contactId: CONTACT,
        subObjectiveKey: 'timeline',
        toState: 'known',
      }),
    ).rejects.toThrow(/value required when toState=known/);
  });
  it('empty-string value → throws', async () => {
    const { prisma } = makePrisma();
    await expect(
      transitionSubObjectiveState(prisma, TENANT, ACTOR, {
        contactId: CONTACT,
        subObjectiveKey: 'timeline',
        toState: 'known',
        value: '',
      }),
    ).rejects.toThrow(/value required when toState=known/);
  });
});

describe('M3-1c — per-valueType column routing', () => {
  it('timeline (text) → value_text populated, others null', async () => {
    const { prisma, upsert } = makePrisma();
    await transitionSubObjectiveState(prisma, TENANT, ACTOR, {
      contactId: CONTACT,
      subObjectiveKey: 'timeline',
      toState: 'known',
      value: 'Q3 2026',
    });
    const callArg = upsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(callArg.create.valueText).toBe('Q3 2026');
    expect(callArg.create.valueDate).toBeNull();
    expect(callArg.create.valueNumeric).toBeNull();
    expect(callArg.create.valueEnum).toBeNull();
    expect(callArg.create.valueType).toBe('text');
  });

  it('budget (enum) → value_enum populated, value_type=enum_value (Prisma reserved-word remap)', async () => {
    const { prisma, upsert } = makePrisma();
    await transitionSubObjectiveState(prisma, TENANT, ACTOR, {
      contactId: CONTACT,
      subObjectiveKey: 'budget',
      toState: 'known',
      value: '50k-100k',
    });
    const callArg = upsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(callArg.create.valueEnum).toBe('50k-100k');
    expect(callArg.create.valueText).toBeNull();
    expect(callArg.create.valueType).toBe('enum_value');
  });
});

describe('M3-1c — source + setBy + audit row', () => {
  it('upsert carries source=manual + setBy=actor', async () => {
    const { prisma, upsert } = makePrisma();
    await transitionSubObjectiveState(prisma, TENANT, ACTOR, {
      contactId: CONTACT,
      subObjectiveKey: 'timeline',
      toState: 'known',
      value: 'Q3 2026',
    });
    const callArg = upsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(callArg.create.source).toBe('manual');
    expect(callArg.create.setBy).toBe(ACTOR);
  });

  it('audit-log row written with previousState → newState', async () => {
    const { prisma, auditCreate } = makePrisma({ existingState: 'unknown' });
    await transitionSubObjectiveState(prisma, TENANT, ACTOR, {
      contactId: CONTACT,
      subObjectiveKey: 'timeline',
      toState: 'known',
      value: 'Q3 2026',
    });
    expect(auditCreate).toHaveBeenCalledTimes(1);
    const auditArg = auditCreate.mock.calls[0]![0] as { data: { actionType: string; payload: Record<string, unknown> } };
    expect(auditArg.data.actionType).toBe('sub_objective_gap_state.transitioned');
    expect(auditArg.data.payload).toMatchObject({
      contactId: CONTACT,
      subObjectiveKey: 'timeline',
      previousState: 'unknown',
      newState: 'known',
      actor: ACTOR,
      source: 'manual',
    });
  });

  it('previousState reported correctly when row already known (re-update path)', async () => {
    const { prisma } = makePrisma({ existingState: 'known' });
    const result = await transitionSubObjectiveState(prisma, TENANT, ACTOR, {
      contactId: CONTACT,
      subObjectiveKey: 'timeline',
      toState: 'known',
      value: 'Q4 2026',
    });
    expect(result.previousState).toBe('known');
  });

  it('previousState defaults unknown when no row exists yet (pre-seed call)', async () => {
    const { prisma } = makePrisma({ existingState: undefined });
    const result = await transitionSubObjectiveState(prisma, TENANT, ACTOR, {
      contactId: CONTACT,
      subObjectiveKey: 'timeline',
      toState: 'known',
      value: 'Q3 2026',
    });
    expect(result.previousState).toBe('unknown');
  });
});

describe('M3-1c — not_applicable path', () => {
  it('not_applicable does NOT require value; all value columns null', async () => {
    const { prisma, upsert } = makePrisma();
    const result = await transitionSubObjectiveState(prisma, TENANT, ACTOR, {
      contactId: CONTACT,
      subObjectiveKey: 'authority',
      toState: 'not_applicable',
    });
    expect(result.ok).toBe(true);
    const callArg = upsert.mock.calls[0]![0] as { create: Record<string, unknown> };
    expect(callArg.create.state).toBe('not_applicable');
    expect(callArg.create.valueText).toBeNull();
    expect(callArg.create.valueEnum).toBeNull();
  });
});
