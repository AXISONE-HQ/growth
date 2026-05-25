/**
 * KAN-1028 regression — ObjectiveSchema parses all 8 PROD catalog
 * Objective shapes without throwing.
 *
 * Background: 2026-05-25 17:41Z scenario-1 attempt #3 crashed because
 * `ObjectiveSchema.type` was a 7-value Zod enum (lead_conversion,
 * customer_retention, upsell, re_engagement, onboarding, renewal,
 * win_back) but the PROD catalog has 8 different values; only `upsell`
 * overlapped. 7/8 rows would crash on parse. Plus ALL 8 rows have empty
 * `success_condition: {}` while the engine required `{metric, operator,
 * value}` — so even fixing #1 would surface #2/3/4 as next-up crashes.
 *
 * The fix relaxes ObjectiveSchema.type and successCondition to free-form
 * (per schema.prisma:352-358 design intent: "Free-form string (NOT the
 * ObjectiveType enum)"). This test pins that all 8 catalog rows parse
 * cleanly + the latent SubObjectiveStatus/category relaxations don't
 * regress on existing valid shapes.
 *
 * Discipline (memory `feedback_engine_schema_claims_discipline.md`):
 * validate Zod against real PROD data shapes, not just tsc.
 */
import { describe, it, expect } from 'vitest';
import { ObjectiveSchema, SubObjectiveSchema, SubObjectiveStatus } from '../objective-gap-analyzer.js';

// The 8 catalog Objective types as they exist in PROD today (verified
// 2026-05-25 via gcloud + psql). Locked here so a future PROD migration
// that adds a 9th value is visibly documented.
const PROD_CATALOG_TYPES = [
  'book_appointment',
  'sell_online',
  'enrich_lead',
  'warm_up',
  'reactivate',
  'retain_customer',
  'upsell',
  'recover_failed_payment',
];

describe('KAN-1028 — ObjectiveSchema accepts all 8 PROD catalog shapes', () => {
  for (const catalogType of PROD_CATALOG_TYPES) {
    it(`parses Objective with type='${catalogType}' + empty successCondition={}`, () => {
      // Mirror the actual PROD row shape — empty success_condition, no
      // subObjectives, no blueprintId. Engine code never reads inner
      // fields of successCondition (line 664 passthrough only).
      const prodShape = {
        id: 'cc629050-41e8-4d50-82f7-733187a7a993',
        tenantId: '9ca85088-f65b-4bac-b098-fff742281ede',
        type: catalogType,
        name: `Test ${catalogType}`,
        successCondition: {}, // ← empty, as in all 8 PROD rows
        subObjectives: [], // ← empty, as in all 8 PROD rows
        createdAt: '2026-05-24T10:00:00.000Z',
      };
      expect(() => ObjectiveSchema.parse(prodShape)).not.toThrow();
    });
  }

  it('still parses successCondition with the legacy {metric, operator, value} shape (backward compat)', () => {
    const legacyShape = {
      id: 'aa',
      tenantId: 'bb',
      type: 'lead_conversion', // also still works (relaxation is permissive)
      name: 'Legacy',
      successCondition: {
        metric: 'qualified_leads',
        operator: 'gte',
        value: 10,
        timeframeDays: 30,
      },
      subObjectives: [],
      createdAt: '2026-05-24T10:00:00.000Z',
    };
    expect(() => ObjectiveSchema.parse(legacyShape)).not.toThrow();
  });

  it('defaults successCondition to {} when omitted (matches z.record(z.unknown()).optional().default({}))', () => {
    const noSuccessCondShape = {
      id: 'cc',
      tenantId: 'dd',
      type: 'warm_up',
      name: 'No success condition',
      // successCondition omitted entirely
      subObjectives: [],
      createdAt: '2026-05-24T10:00:00.000Z',
    };
    const parsed = ObjectiveSchema.parse(noSuccessCondShape);
    expect(parsed.successCondition).toEqual({});
  });
});

describe('KAN-1028 — SubObjectiveStatus + SubObjectiveSchema.category relaxed to z.string()', () => {
  it('accepts the legacy 5-value status enum', () => {
    for (const status of ['not_started', 'in_progress', 'completed', 'failed', 'skipped']) {
      expect(() => SubObjectiveStatus.parse(status)).not.toThrow();
    }
  });

  it('accepts arbitrary status strings (relaxation property)', () => {
    expect(() => SubObjectiveStatus.parse('paused')).not.toThrow();
    expect(() => SubObjectiveStatus.parse('blocked_by_human_review')).not.toThrow();
  });

  it('SubObjectiveSchema.category accepts the 6 legacy values + arbitrary strings', () => {
    const base = {
      id: 's1',
      name: 'Identify decision-maker',
      status: 'in_progress',
    };
    for (const cat of ['awareness', 'engagement', 'qualification', 'conversion', 'retention', 'expansion', 'discovery', 'product_demo']) {
      expect(() => SubObjectiveSchema.parse({ ...base, category: cat })).not.toThrow();
    }
  });

  it('SubObjectiveSchema preserves required fields (id, name, status, category) — relaxation is vocab-only, not shape-stripping', () => {
    expect(() => SubObjectiveSchema.parse({})).toThrow();
    expect(() => SubObjectiveSchema.parse({ id: 's1' })).toThrow();
    expect(() => SubObjectiveSchema.parse({ id: 's1', name: 'X' })).toThrow();
    expect(() => SubObjectiveSchema.parse({ id: 's1', name: 'X', status: 'X' })).toThrow();
    expect(() =>
      SubObjectiveSchema.parse({ id: 's1', name: 'X', status: 'X', category: 'Y' }),
    ).not.toThrow();
  });
});
