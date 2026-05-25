/**
 * KAN-1029 regression — engine read-surface contract test.
 *
 * Pins that every engine Zod schema parses the actual PROD-data shapes
 * (verified 2026-05-25 via scripts/prod-schema-audit-engine-parse.ts —
 * the audit harness that surfaced this class of bug).
 *
 * Background:
 *   KAN-1028 relaxed 4 fields on ObjectiveSchema after engine crashes
 *   on PROD data. The fix was instance-scoped (the known vocab/enum
 *   mismatches) and missed `blueprintId: z.string().optional()` —
 *   `.optional()` rejects `null`, but all 8 PROD Objective rows have
 *   `blueprint_id = NULL`. Same class as KAN-1028, surfaced one ticket
 *   late. The exhaustive PROD-shape audit also surfaced
 *   `ContactStateSchema.subObjectives` expecting `record<T>` but Prisma
 *   defaults the column to `[]`.
 *
 * This test is the durable win — it converts "engine schema matches the
 * real data contract" from a hope into a CI gate, so the class can't
 * regress without a failing test. Table-driven over the real PROD-shape
 * fixtures so the same harness covers (a) today's reality, (b) the
 * legacy backward-compat shape, (c) the populated future-contract
 * shape (TBD, pinned).
 *
 * Drift harness:
 *   When PROD shapes drift (e.g. a tenant migration adds new fields,
 *   or a new tenant onboards with a value vocab we hadn't seen), re-run
 *   the live audit via `npx tsx scripts/prod-schema-audit-engine-parse.ts`
 *   to re-derive the canonical shapes — then add the new fixtures here.
 */
import { describe, it, expect } from 'vitest';
import {
  ObjectiveSchema,
  SubObjectiveSchema,
  ContactStateSchema,
} from '../objective-gap-analyzer.js';

// ─────────────────────────────────────────────────────────────────────────
// PROD-shape fixtures — captured from the live audit 2026-05-25.
// Update these in lockstep with the audit script when PROD drifts.
// ─────────────────────────────────────────────────────────────────────────

// Every PROD Objective row today has: blueprint_id=NULL, success_condition={},
// sub_objectives=[], type=one of the 8-value catalog string vocabulary.
// Verified via `SELECT … FROM objectives;` against growth-493400 PROD,
// 2026-05-25.
const PROD_OBJECTIVE_CATALOG = [
  'book_appointment',
  'sell_online',
  'enrich_lead',
  'warm_up',
  'reactivate',
  'retain_customer',
  'upsell',
  'recover_failed_payment',
];

// Every PROD ContactObjectiveStack row today has: sub_objectives=[],
// strategy_current=NULL, confidence_score=NULL. Verified 2026-05-25.
const PROD_STACK_BASELINE = {
  id: 'be6cd711-27ca-400b-b603-5290c6f998d9',
  contactId: 'ffbdc3f2-bb62-4753-b3c7-7c242bd56759',
  objectiveId: 'd0b0068d-6207-4329-9ede-2c9fc3ad0fb7',
  subObjectives: [], // ← the empty-array default (Prisma @default("[]"))
  strategyCurrent: null,
  confidenceScore: 0, // engine transform at run-decision-for-contact:681 does `?? 0`
  updatedAt: '2026-05-25T20:00:00.000Z',
};

describe('KAN-1029 — ObjectiveSchema PROD-shape contract', () => {
  for (const catalogType of PROD_OBJECTIVE_CATALOG) {
    it(`parses the PROD shape for type='${catalogType}' (blueprint_id=null, success_condition={}, sub_objectives=[])`, () => {
      const prodShape = {
        id: 'cc629050-41e8-4d50-82f7-733187a7a993',
        tenantId: '9ca85088-f65b-4bac-b098-fff742281ede',
        type: catalogType,
        name: `Test ${catalogType}`,
        successCondition: {},
        subObjectives: [],
        blueprintId: null, // ← the value-class that bit smoke-2
        createdAt: '2026-05-24T10:00:00.000Z',
      };
      expect(() => ObjectiveSchema.parse(prodShape)).not.toThrow();
    });
  }

  it('accepts blueprintId=undefined (legacy, sibling of null)', () => {
    const shape = {
      id: 'a', tenantId: 'b', type: 'warm_up', name: 'x',
      successCondition: {}, subObjectives: [],
      // blueprintId omitted → undefined
      createdAt: '2026-05-24T10:00:00.000Z',
    };
    expect(() => ObjectiveSchema.parse(shape)).not.toThrow();
  });

  it('accepts blueprintId as a real UUID string (populated future case)', () => {
    const shape = {
      id: 'a', tenantId: 'b', type: 'warm_up', name: 'x',
      successCondition: {}, subObjectives: [],
      blueprintId: '8359abfe-c090-4cc5-9811-3dc949f345ff',
      createdAt: '2026-05-24T10:00:00.000Z',
    };
    expect(() => ObjectiveSchema.parse(shape)).not.toThrow();
  });

  it('rejects when REQUIRED fields are absent (relaxation is targeted, not shape-stripping)', () => {
    expect(() => ObjectiveSchema.parse({})).toThrow();
    expect(() => ObjectiveSchema.parse({ id: 'a' })).toThrow();
    expect(() => ObjectiveSchema.parse({ id: 'a', tenantId: 'b' })).toThrow();
  });
});

describe('KAN-1029 — ContactStateSchema PROD-shape contract', () => {
  it('parses the PROD baseline (sub_objectives=[], strategyCurrent=null, confidenceScore=0)', () => {
    expect(() => ContactStateSchema.parse(PROD_STACK_BASELINE)).not.toThrow();
  });

  it('coerces empty-array subObjectives to empty-object map (zero data loss in empty case)', () => {
    const parsed = ContactStateSchema.parse(PROD_STACK_BASELINE);
    expect(parsed.subObjectives).toEqual({});
  });

  it('accepts populated subObjectives as a KEYED MAP (dormant contract — when a writer lands, it MUST emit this shape)', () => {
    const populated = {
      ...PROD_STACK_BASELINE,
      subObjectives: {
        'sub-1': { status: 'in_progress', attempts: 1 },
        'sub-2': { status: 'completed', completedAt: '2026-05-24T10:00:00.000Z' },
        'sub-3': { status: 'not_started' },
      },
    };
    const parsed = ContactStateSchema.parse(populated);
    expect(Object.keys(parsed.subObjectives)).toHaveLength(3);
    expect(parsed.subObjectives['sub-1'].status).toBe('in_progress');
  });

  it('rejects a POPULATED ARRAY for subObjectives (writer-contract guard — surfaces "writer emitted wrong shape")', () => {
    // The coercion only fires on EMPTY [] (treated as "no entries yet").
    // A non-empty array means a writer has populated this incorrectly —
    // the engine indexes by string key (lines 559/583), arrays would
    // silently mismatch. Fail loudly.
    const populatedArray = {
      ...PROD_STACK_BASELINE,
      subObjectives: [{ id: 'sub-1', status: 'in_progress' }],
    };
    expect(() => ContactStateSchema.parse(populatedArray)).toThrow();
  });

  it('accepts strategyCurrent=null and a populated string (Prisma String?)', () => {
    expect(() => ContactStateSchema.parse({ ...PROD_STACK_BASELINE, strategyCurrent: null })).not.toThrow();
    expect(() => ContactStateSchema.parse({ ...PROD_STACK_BASELINE, strategyCurrent: 'direct' })).not.toThrow();
  });

  it('accepts confidenceScore=null and a 0..100 number (Prisma Float?)', () => {
    expect(() => ContactStateSchema.parse({ ...PROD_STACK_BASELINE, confidenceScore: null })).not.toThrow();
    expect(() => ContactStateSchema.parse({ ...PROD_STACK_BASELINE, confidenceScore: 75 })).not.toThrow();
    expect(() => ContactStateSchema.parse({ ...PROD_STACK_BASELINE, confidenceScore: 101 })).toThrow();
  });
});

describe('KAN-1029 — SubObjectiveSchema preemptive null-tolerance (dormant in PROD; pinned for the future-writer)', () => {
  const minimal = { id: 's1', name: 'X', status: 'in_progress', category: 'awareness' };

  it('accepts description=null (Prisma JSON sub-field)', () => {
    expect(() => SubObjectiveSchema.parse({ ...minimal, description: null })).not.toThrow();
  });
  it('accepts description=undefined', () => {
    expect(() => SubObjectiveSchema.parse({ ...minimal })).not.toThrow();
  });

  it('accepts metadata=null', () => {
    expect(() => SubObjectiveSchema.parse({ ...minimal, metadata: null })).not.toThrow();
  });

  it('accepts dependsOn=null and defaults to []', () => {
    const parsed = SubObjectiveSchema.parse({ ...minimal, dependsOn: null });
    expect(parsed.dependsOn).toEqual([]);
  });
  it('accepts dependsOn=undefined and defaults to []', () => {
    const parsed = SubObjectiveSchema.parse({ ...minimal });
    expect(parsed.dependsOn).toEqual([]);
  });
  it('accepts dependsOn populated', () => {
    const parsed = SubObjectiveSchema.parse({ ...minimal, dependsOn: ['s2', 's3'] });
    expect(parsed.dependsOn).toEqual(['s2', 's3']);
  });

  it('still requires the core fields (id, name, status, category)', () => {
    expect(() => SubObjectiveSchema.parse({})).toThrow();
    expect(() => SubObjectiveSchema.parse({ id: 's1' })).toThrow();
  });
});
