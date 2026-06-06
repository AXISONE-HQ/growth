---
name: Phase 1 LoC estimates routinely undercount state-handling + helpers + test infra
description: KAN-1102/1103/1107/1108 banked 2026-06-06. Phase 1 build summaries default to "happy path implementation" line counts. They omit loading/empty/error/populated state branches, helper extractions, test infrastructure boilerplate, and per-state copy refinements. Realistic delivery is 2.5-3x the naive estimate. Multiply naive estimates 2.5-3x for budget realism.
type: feedback
---

**The pattern**: Phase 1 LoC estimates focus on the happy-path implementation lines (e.g., "add useEffect quartet + render block = +100 LoC"). They consistently omit:

1. **State-branch handling** (loading skeleton + empty-state copy + error+Retry + populated render = 4× the happy-path lines)
2. **Helper extraction** (class-fix discipline routinely extracts page-local helpers to `apps/web/src/lib/` mid-build)
3. **Test infrastructure boilerplate** (mocks + builders + per-state assertions + sentinel tests = ~2× the implementation)
4. **Per-state copy refinements** (operator-actionable empty-state copy iterates with PO during build)

**Empirical multipliers from Dashboard v2 epic**:

| PR | Phase 1 naive | Actual delivered | Multiplier |
| --- | --- | --- | --- |
| KAN-1102 | ~+164 LoC | ~+450 LoC | 2.7x |
| KAN-1103 | ~+355 LoC | ~+580 LoC | 1.6x |
| KAN-1107 | ~+700 LoC | ~+810 LoC | 1.2x |
| KAN-1108 | ~+900 LoC | ~+625 LoC | 0.7x (UNDER — schema reframe lightened scope) |
| KAN-1113 | ~+530-680 LoC | ~+398 LoC | 0.6x (UNDER — schema reframe lightened scope) |

The PRs that came in UNDER estimate (KAN-1108, KAN-1113) did so because **Phase 1 found schema artifacts that simplified design** (Pipeline aggregations via groupBy; BrainSnapshot model already exists). The PRs that came in OVER followed the discipline-anchored realistic 2.5-3x multiplier.

## Forward discipline

When estimating Phase 1 LoC, **multiply the naive happy-path estimate by 2.5-3x** for the realistic delivery range. Surface BOTH numbers in the build outline section so Phase 1 review captures the budget reality.

If Phase 1 enumeration surfaces schema reframes that simplify design (e.g., "this aggregation is already in BrainSnapshot"), surface this in the "upfront finding" section AND note in the build outline that the estimate may come in UNDER the realistic range. Don't pad to fit projection.

## Related patterns / memos

- `feedback_phase_1_must_verify_codebase_data_fetching_idiom.md` — Phase 1 must verify actual codebase patterns (not assume)
- `feedback_step_0_can_surface_empirical_data_realities_reframing_phase_1_locks.md` — Phase 1 design locks may shift on empirical data
- `feedback_phase_1_must_enumerate_all_callers_of_modified_service_helpers.md` — Phase 1 enumeration discipline

## Banked from

- KAN-1102 (Escalation Queue) — 2.7x multiplier
- KAN-1103 (KPI strip + Audit Log) — 1.6x multiplier
- KAN-1107 (Decision Feed + Agent Actions) — 1.2x multiplier
- KAN-1108 (Pipeline Health + Focus Contact + Sub-objective Gap) — 0.7x (UNDER; schema reframe)
- KAN-1113 (Brain Layers) — 0.6x (UNDER; schema reframe)
- Session dates: 2026-06-05 + 2026-06-06
