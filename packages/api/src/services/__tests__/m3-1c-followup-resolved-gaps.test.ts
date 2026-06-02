/**
 * M3-1c-followup — prioritize() also populates resolvedGaps for the UI.
 *
 * Pinned behaviors:
 *   - Resolved rows (known + not_applicable) surface in resolvedGaps
 *   - Resolved rows do NOT appear in prioritizedGaps (engine path preserved)
 *   - Per-valueType value column routes correctly into the single
 *     `value: string | null` ResolvedGap surface (text/date/numeric/enum)
 *   - not_applicable rows have value=null (UI renders "not applicable")
 *   - setBy + setAt + source provenance fields carry through
 *   - empty resolvedGaps when no rows are known/not_applicable
 *   - back-compat: engine consumers reading only prioritizedGaps see no behavior change
 */
import { describe, it, expect } from 'vitest';
import { prioritize } from '../sub-objective-gap-tracker.js';
import { DEFAULT_SUB_OBJECTIVES_GENERIC_B2B } from '@growth/shared';

const SET_AT = new Date('2026-05-28T19:13:37Z');

function row(
  key: string,
  state: 'unknown' | 'partial' | 'known' | 'not_applicable',
  overrides: {
    valueText?: string;
    valueDate?: Date;
    valueNumeric?: number;
    valueEnum?: string;
    valueType?: 'text' | 'date' | 'numeric' | 'enum_value';
    source?: 'decision_initialize' | 'manual' | 'extraction' | 'enrichment';
    setBy?: string;
  } = {},
) {
  return {
    subObjectiveKey: key,
    state,
    valueType: overrides.valueType ?? ('text' as const),
    valueText: overrides.valueText ?? null,
    valueDate: overrides.valueDate ?? null,
    valueNumeric: overrides.valueNumeric ?? null,
    valueEnum: overrides.valueEnum ?? null,
    source: overrides.source ?? null,
    setBy: overrides.setBy ?? null,
    setAt: SET_AT,
  };
}

describe('M3-1c-followup — resolvedGaps surface', () => {
  it('known row appears in resolvedGaps; NOT in prioritizedGaps', () => {
    const rows = [row('timeline', 'known', { valueText: 'Q3 2026', source: 'manual', setBy: 'fred@axisone.ca' })];
    const state = prioritize(rows, {});
    expect(state.resolvedGaps).toHaveLength(1);
    expect(state.resolvedGaps[0]).toMatchObject({
      key: 'timeline',
      label: 'When are they looking to start?',
      state: 'known',
      value: 'Q3 2026',
      source: 'manual',
      setBy: 'fred@axisone.ca',
      setAt: SET_AT.toISOString(),
    });
    expect(state.prioritizedGaps.find((g) => g.key === 'timeline')).toBeUndefined();
  });

  it('not_applicable row appears in resolvedGaps with value=null', () => {
    const rows = [row('authority', 'not_applicable', { source: 'manual', setBy: 'fred@axisone.ca' })];
    const state = prioritize(rows, {});
    const naRow = state.resolvedGaps.find((g) => g.key === 'authority');
    expect(naRow).toMatchObject({
      key: 'authority',
      state: 'not_applicable',
      value: null,
    });
  });

  it('per-valueType value routing — enum → value_enum', () => {
    // budget's def is valueType='enum' in DEFAULT_SUB_OBJECTIVES_GENERIC_B2B
    // → prioritize's switch routes to value_enum column.
    const rows = [row('budget', 'known', { valueEnum: '50k-100k', valueType: 'enum_value' })];
    const state = prioritize(rows, {});
    const resolved = state.resolvedGaps.find((g) => g.key === 'budget');
    expect(resolved?.value).toBe('50k-100k');
  });

  // Note on date + numeric routing: the current DEFAULT_SUB_OBJECTIVES_GENERIC_B2B
  // 5-set only uses valueType ∈ {'text', 'enum'}. Date + numeric switch branches
  // in prioritize() are future-proofing for the M3 slice #5 Blueprint loader
  // (per-vertical sets — Real Estate might want timeline as date, automotive
  // might want budget as numeric). prioritize() does ROUTE by def.valueType,
  // so testing date/numeric routing requires injecting a custom def — out of
  // MVP scope. Coverage of value-column writes by valueType lives in
  // m3-1c-transition-state.test.ts (exercises the upsert path, which is what
  // the Blueprint-loader-driven values will hit).

  it('mixed states — 1 known, N-1 unknown → resolved has 1, prioritized has N-1 (engine path preserved across vocab extensions)', () => {
    // KAN-1063 (Cluster II PR I) — assertion made vocab-extension-resilient.
    // Pre-KAN-1063: 5 BANT keys → 1 known + 4 unknown. Post-KAN-1063: 8 keys
    // (5 BANT + 3 KAN-1050) → 1 known + 7 unknown. Future Blueprint-loader
    // vocab extensions stay green without test edits.
    const rows = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) =>
      d.key === 'timeline' ? row(d.key, 'known', { valueText: 'Q3 2026' }) : row(d.key, 'unknown'),
    );
    const state = prioritize(rows, {});
    expect(state.resolvedGaps).toHaveLength(1);
    expect(state.resolvedGaps[0].key).toBe('timeline');
    expect(state.prioritizedGaps).toHaveLength(DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.length - 1);
    expect(state.prioritizedGaps.find((g) => g.key === 'timeline')).toBeUndefined();
  });

  it('no resolved rows → resolvedGaps is empty array (back-compat)', () => {
    const rows = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => row(d.key, 'unknown'));
    const state = prioritize(rows, {});
    expect(state.resolvedGaps).toEqual([]);
  });

  it('engine back-compat — adding resolvedGaps does NOT change prioritizedGaps or topCandidate shape', () => {
    const rows = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => row(d.key, 'unknown'));
    const state = prioritize(rows, { currentStageName: 'Qualified' });
    // Pre-followup behavior unchanged.
    expect(state.topCandidate?.hardTrigger).toBe(true);
    expect(state.prioritizedGaps[0].hardTrigger).toBe(true);
    // KAN-1063 (Cluster II PR I) — assertion made vocab-extension-resilient.
    // All N entries unknown → all N appear in prioritizedGaps. Future
    // Blueprint-loader vocab extensions stay green without test edits.
    expect(state.prioritizedGaps).toHaveLength(DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.length);
  });

  it('source defaults to decision_initialize when row.source is null (legacy rows before this slice)', () => {
    const rows = [row('timeline', 'known', { valueText: 'Q3 2026' })]; // no source
    const state = prioritize(rows, {});
    expect(state.resolvedGaps[0].source).toBe('decision_initialize');
  });
});
