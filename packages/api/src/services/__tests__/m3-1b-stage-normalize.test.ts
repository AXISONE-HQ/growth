/**
 * M3-1b — lowercase-normalize stage match in prioritize().
 *
 * Pins the case-sensitivity fix surfaced by the M3-1a substrate smoke:
 *   PROD AxisOne stage name is "Qualified" (capital Q), PRD default-set
 *   says `requiredAtStage: 'qualified'`. Exact match missed → only soft-
 *   trigger fired. After normalize fix: hard-trigger reachable regardless
 *   of tenant casing.
 */
import { describe, it, expect } from 'vitest';
import { prioritize } from '../sub-objective-gap-tracker.js';
import { DEFAULT_SUB_OBJECTIVES_GENERIC_B2B } from '@growth/shared';

function row(key: string, state: 'unknown' | 'partial' | 'known' = 'unknown') {
  return {
    subObjectiveKey: key,
    state,
    valueType: 'text' as const,
    valueText: null,
    setAt: new Date('2026-05-28T00:00:00Z'),
  };
}

describe('M3-1b — stage name lowercase-normalize', () => {
  it('Tenant stage "Qualified" (capital Q) matches PRD default "qualified" (lowercase) → hardTrigger=true', () => {
    const rows = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => row(d.key));
    const state = prioritize(rows, { currentStageName: 'Qualified' });
    const timeline = state.prioritizedGaps.find((g) => g.key === 'timeline');
    expect(timeline?.hardTrigger).toBe(true);
    // Top candidate should now be a hard-trigger (was soft pre-fix).
    expect(state.topCandidate?.hardTrigger).toBe(true);
  });

  it('Tenant stage "PROPOSAL-READY" (all-caps) matches PRD default "proposal-ready" → budget+authority hardTrigger', () => {
    const rows = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => row(d.key));
    const state = prioritize(rows, { currentStageName: 'PROPOSAL-READY' });
    const budget = state.prioritizedGaps.find((g) => g.key === 'budget');
    const authority = state.prioritizedGaps.find((g) => g.key === 'authority');
    expect(budget?.hardTrigger).toBe(true);
    expect(authority?.hardTrigger).toBe(true);
  });

  it('Tenant stage with whitespace-or-different word still does NOT match (semantic match, not fuzzy)', () => {
    const rows = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => row(d.key));
    const state = prioritize(rows, { currentStageName: 'qualified-leads' });
    const timeline = state.prioritizedGaps.find((g) => g.key === 'timeline');
    expect(timeline?.hardTrigger).toBe(false);
  });

  it('nextStageName ALSO normalized (looking-ahead match)', () => {
    const rows = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => row(d.key));
    const state = prioritize(rows, {
      currentStageName: 'discovery-call',
      nextStageName: 'Qualified', // upper-Q next stage
    });
    const timeline = state.prioritizedGaps.find((g) => g.key === 'timeline');
    expect(timeline?.hardTrigger).toBe(true);
  });

  it('exact lowercase match still works (back-compat with pre-fix behavior)', () => {
    const rows = DEFAULT_SUB_OBJECTIVES_GENERIC_B2B.map((d) => row(d.key));
    const state = prioritize(rows, { currentStageName: 'qualified' });
    const timeline = state.prioritizedGaps.find((g) => g.key === 'timeline');
    expect(timeline?.hardTrigger).toBe(true);
  });
});
