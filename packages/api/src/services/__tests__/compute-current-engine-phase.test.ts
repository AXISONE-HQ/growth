/**
 * KAN-1064 (Cluster II PR II) — computeCurrentEnginePhase tests.
 *
 * Covers the 7-test surface locked at Phase 1 trace (2026-06-02):
 *   1. Empty gap state → returns `qualify` (first phase, derived)
 *   2. All filled → returns `closing` (last phase, derived) per Q7 sticky lock
 *   3. One unknown in `problem` phase, rest filled → returns `problem` (priority-derived)
 *   4. Operator-set sub-objective in `problem` within 7d → reason `'operator_override'`
 *   5. Operator-set sub-objective in `problem` >7d ago → reason `'derived'` (recency floor)
 *   6. Engine-set sub-objective (source='engine') within 7d → reason `'derived'` (not operator)
 *   7. Orphan setBy (subObjectiveKey not in any phase) → derive normally per Q6 lock
 *   8. `contactRecentSetBy === undefined` → pure-derived path
 *
 * Q2 lock: operator detection via `source === 'manual'` (KAN-1042 PR A2
 * structured discriminator), NOT pattern-matching on setBy strings.
 *
 * Pure-builder helper — no Prisma I/O; ContactSubObjectiveGapState rows
 * hand-constructed with the subset of fields the helper actually reads
 * (subObjectiveKey + state). Other Prisma fields cast via `as unknown as
 * ContactSubObjectiveGapState` to satisfy TypeScript without bloat.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ContactSubObjectiveGapState } from '@prisma/client';
import {
  DEFAULT_ENGINE_PHASES_GENERIC_B2B,
  type BlueprintEnginePhase,
} from '@growth/shared';
import { computeCurrentEnginePhase } from '../brain-service.js';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const CONTACT_A = 'contact_a';

// Helper to build a minimal ContactSubObjectiveGapState row. Only the
// fields the helper reads (subObjectiveKey + state) need real values;
// the rest are typed via the cast to satisfy Prisma's full row shape.
function row(
  subObjectiveKey: string,
  state: ContactSubObjectiveGapState['state'],
): ContactSubObjectiveGapState {
  return {
    id: `gap_${subObjectiveKey}`,
    tenantId: TENANT_A,
    contactId: CONTACT_A,
    subObjectiveKey,
    state,
    valueType: 'text',
    valueText: null,
    valueDate: null,
    valueNumeric: null,
    valueEnum: null,
    source: 'decision_initialize',
    setAt: new Date('2026-05-01T00:00:00.000Z'),
    setBy: 'system:gap-tracker',
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
  } as unknown as ContactSubObjectiveGapState;
}

const PHASES = [...DEFAULT_ENGINE_PHASES_GENERIC_B2B];

describe('KAN-1064 — computeCurrentEnginePhase: derived path', () => {
  it('(1/8) empty gap state → returns first phase (qualify, derived)', () => {
    const result = computeCurrentEnginePhase({
      gapState: [],
      enginePhases: PHASES,
    });
    expect(result.currentPhase.key).toBe('qualify');
    expect(result.reason).toBe('derived');
    expect(result.operatorOverrideRecencyDays).toBeUndefined();
  });

  it('(2/8) all sub-objectives filled across all phases → returns closing (sticky Q7 lock)', () => {
    const allKeys = PHASES.flatMap((p) => p.subObjectives);
    const gapState = allKeys.map((k) => row(k, 'known'));
    const result = computeCurrentEnginePhase({
      gapState,
      enginePhases: PHASES,
    });
    expect(result.currentPhase.key).toBe('closing');
    expect(result.reason).toBe('derived');
  });

  it('(3/8) qualify filled, problem has one unknown → returns problem (priority-derived)', () => {
    // qualify (authority=known); problem (need=known, motivation=unknown,
    // budget=known, cost_of_problem=known) → first unfilled phase is problem.
    const gapState = [
      row('authority', 'known'),
      row('need', 'known'),
      row('motivation', 'unknown'),
      row('budget', 'known'),
      row('cost_of_problem', 'known'),
      row('roi_metrics', 'known'),
      row('timeline', 'known'),
      row('committed_amount', 'known'),
    ];
    const result = computeCurrentEnginePhase({
      gapState,
      enginePhases: PHASES,
    });
    expect(result.currentPhase.key).toBe('problem');
    expect(result.reason).toBe('derived');
  });

  it('not_applicable counts as filled (parity with known)', () => {
    // qualify (authority=not_applicable — treated as filled); problem
    // (need=unknown) → first unfilled phase is problem.
    const gapState = [
      row('authority', 'not_applicable'),
      row('need', 'unknown'),
    ];
    const result = computeCurrentEnginePhase({
      gapState,
      enginePhases: PHASES,
    });
    expect(result.currentPhase.key).toBe('problem');
    expect(result.reason).toBe('derived');
  });

  it("partial state counts as unfilled (parity with unknown)", () => {
    // qualify (authority=partial — treated as unfilled) → returns qualify.
    const gapState = [
      row('authority', 'partial'),
    ];
    const result = computeCurrentEnginePhase({
      gapState,
      enginePhases: PHASES,
    });
    expect(result.currentPhase.key).toBe('qualify');
    expect(result.reason).toBe('derived');
  });

  it('missing row for a configured key → treated as unknown (default unfilled)', () => {
    // gapState is empty, but enginePhases requires authority for qualify.
    // Missing row → state lookup miss → treated as unfilled → returns qualify.
    const result = computeCurrentEnginePhase({
      gapState: [],
      enginePhases: PHASES,
    });
    expect(result.currentPhase.key).toBe('qualify');
  });
});

describe('KAN-1064 — computeCurrentEnginePhase: operator-override path (Q2+Q3+Q6 locks)', () => {
  // Use a synthetic NOW for deterministic recency math. Tests below spy
  // on Date.now per-test (vitest doesn't reset between tests automatically
  // when using mock-time helpers; explicit restore in each test keeps the
  // surface honest).
  const NOW = new Date('2026-06-02T12:00:00.000Z');
  const DAYS_AGO = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

  it('(4/8) operator-set authority within 7d → reason "operator_override", phase qualify', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
    const result = computeCurrentEnginePhase({
      gapState: [
        row('authority', 'known'),
        row('need', 'unknown'), // would derive to problem if not overridden
      ],
      enginePhases: PHASES,
      contactRecentSetBy: {
        setBy: 'fred@axisone.ca',
        setAt: DAYS_AGO(3),
        subObjectiveKey: 'authority',
        source: 'manual',
      },
    });
    expect(result.currentPhase.key).toBe('qualify');
    expect(result.reason).toBe('operator_override');
    expect(result.operatorOverrideRecencyDays).toBeCloseTo(3, 0);
    vi.restoreAllMocks();
  });

  it('(5/8) operator-set sub-objective >7d ago → reason "derived" (recency floor)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
    const result = computeCurrentEnginePhase({
      gapState: [row('need', 'unknown')],
      enginePhases: PHASES,
      contactRecentSetBy: {
        setBy: 'fred@axisone.ca',
        setAt: DAYS_AGO(10), // outside 7-day window
        subObjectiveKey: 'authority',
        source: 'manual',
      },
    });
    expect(result.reason).toBe('derived');
    expect(result.operatorOverrideRecencyDays).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('(6/8) engine-set sub-objective (source="engine") within 7d → reason "derived" (NOT operator)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
    // Q2 lock empirically pinned: source discriminator wins over recency.
    // Engine-set rows NEVER trigger operator-override even within window.
    const result = computeCurrentEnginePhase({
      gapState: [row('need', 'unknown')],
      enginePhases: PHASES,
      contactRecentSetBy: {
        setBy: 'engine_agentic_live',
        setAt: DAYS_AGO(1),
        subObjectiveKey: 'authority',
        source: 'engine',
      },
    });
    expect(result.reason).toBe('derived');
    vi.restoreAllMocks();
  });

  it('(7/8) operator-set ORPHAN subObjectiveKey → derives normally (Q6 lock)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
    // The setBy.subObjectiveKey doesn't belong to any phase in enginePhases
    // (vocab-extension drift simulation — row exists for a key the current
    // Blueprint config hasn't bucketed yet). Falls through to derived path.
    const result = computeCurrentEnginePhase({
      gapState: [row('authority', 'unknown')],
      enginePhases: PHASES,
      contactRecentSetBy: {
        setBy: 'fred@axisone.ca',
        setAt: DAYS_AGO(2),
        subObjectiveKey: 'nonexistent_key_from_future_extension',
        source: 'manual',
      },
    });
    expect(result.currentPhase.key).toBe('qualify');
    expect(result.reason).toBe('derived');
    expect(result.operatorOverrideRecencyDays).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('decision_initialize source is NOT operator (system seed)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
    const result = computeCurrentEnginePhase({
      gapState: [row('need', 'unknown')],
      enginePhases: PHASES,
      contactRecentSetBy: {
        setBy: 'system:gap-tracker',
        setAt: DAYS_AGO(1),
        subObjectiveKey: 'authority',
        source: 'decision_initialize',
      },
    });
    expect(result.reason).toBe('derived');
    vi.restoreAllMocks();
  });

  it('extraction source is NOT operator (LLM auto-extraction)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
    const result = computeCurrentEnginePhase({
      gapState: [row('need', 'unknown')],
      enginePhases: PHASES,
      contactRecentSetBy: {
        setBy: 'system:extractor',
        setAt: DAYS_AGO(1),
        subObjectiveKey: 'authority',
        source: 'extraction',
      },
    });
    expect(result.reason).toBe('derived');
    vi.restoreAllMocks();
  });

  it('enrichment source is NOT operator (data enrichment service)', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
    const result = computeCurrentEnginePhase({
      gapState: [row('need', 'unknown')],
      enginePhases: PHASES,
      contactRecentSetBy: {
        setBy: 'system:enricher',
        setAt: DAYS_AGO(1),
        subObjectiveKey: 'authority',
        source: 'enrichment',
      },
    });
    expect(result.reason).toBe('derived');
    vi.restoreAllMocks();
  });

  it('(8/8) contactRecentSetBy === undefined → pure-derived path', () => {
    const result = computeCurrentEnginePhase({
      gapState: [row('authority', 'unknown')],
      enginePhases: PHASES,
      // contactRecentSetBy omitted
    });
    expect(result.currentPhase.key).toBe('qualify');
    expect(result.reason).toBe('derived');
  });
});

describe('KAN-1064 — computeCurrentEnginePhase: edge cases', () => {
  it('mutates only a local copy of enginePhases (caller array safe)', () => {
    const phases = [...DEFAULT_ENGINE_PHASES_GENERIC_B2B];
    const before = phases.map((p) => p.key);
    computeCurrentEnginePhase({
      gapState: [],
      enginePhases: phases,
    });
    const after = phases.map((p) => p.key);
    expect(after).toEqual(before);
  });

  it('non-canonical priority ordering still derives correctly (sorted internally)', () => {
    // Caller provides phases in arbitrary order; helper sorts by priority.
    const shuffled: BlueprintEnginePhase[] = [
      DEFAULT_ENGINE_PHASES_GENERIC_B2B[2], // proof (priority=3)
      DEFAULT_ENGINE_PHASES_GENERIC_B2B[0], // qualify (priority=1)
      DEFAULT_ENGINE_PHASES_GENERIC_B2B[3], // closing (priority=4)
      DEFAULT_ENGINE_PHASES_GENERIC_B2B[1], // problem (priority=2)
    ];
    const result = computeCurrentEnginePhase({
      gapState: [],
      enginePhases: shuffled,
    });
    // First phase by priority is qualify (priority=1), regardless of input order.
    expect(result.currentPhase.key).toBe('qualify');
  });

  it('throws when enginePhases is empty (caller misuse defensive guard)', () => {
    expect(() =>
      computeCurrentEnginePhase({
        gapState: [],
        enginePhases: [],
      }),
    ).toThrow(/enginePhases array is empty/);
  });
});
