---
name: Phase 1.5 PROD sniff may reveal empty cognitive infrastructure — ship anyway
description: KAN-1113 banked 2026-06-06. When Phase 1 design assumes data exists for a feature, Phase 1.5 PROD sniff may reveal the data is empty. Ship the UI anyway with empty-state branch as the day-1 render. UI auto-lights-up when data flows; honest framing > delaying ship.
type: feedback
---

**The pattern**: Phase 1 design trace assumes the underlying data exists (e.g., "BrainSnapshot is populated for the tenant, so we can compute Company Truth %"). Phase 1.5 PROD sniff (just before code edits) verifies the empirical state. Sometimes the discovery is jarring:

- Entire `brain_snapshots` table is empty across PROD (0 distinct tenants)
- Entire `blueprints` table is empty across PROD (0 rows)
- Pre-launch cognitive infrastructure: the engine has been running but never written

**KAN-1113 instance**: Phase 1 designed Brain Layers panel around the `BrainSnapshot` schema. Phase 1.5 sniff:

```sql
SELECT COUNT(*) FROM brain_snapshots;       -- 0
SELECT COUNT(*) FROM blueprints;            -- 0
SELECT blueprint_id FROM tenants WHERE id = '<AxisOne>';  -- NULL
```

The cognitive infrastructure exists in the schema but has zero PROD data. KAN-1113's panel would render empty-state for the AxisOne tenant on day-1.

## Anti-pattern

Treating empty PROD data as a blocker:

1. "We need to backfill BrainSnapshot before shipping" → blocks dashboard close
2. "We need to write a migration" → out-of-scope, blocks ship
3. "We need to wait until the engine writes data" → indefinite delay

The right move: **ship the UI with empty-state branch as day-1 render**. The UI auto-evolves when data flows.

## Forward discipline

When Phase 1.5 PROD sniff reveals empty data for a feature:

1. **Surface the finding** in the HALT before code edits
2. **Design an HONEST EMPTY-STATE BRANCH** with operator-actionable copy
   - Example: "growth is ready to learn. Connect a Blueprint in Settings to give the engine a starting model — cognitive readiness will grow from there."
3. **Document the day-1 render in PR description** — operator transparency for first viewing
4. **Ship the panel + verify empty-state works at smoke**
5. UI auto-evolves when data flows — no future UI work needed

This is **Doctrine 5 manifesting at the right friction point**: operator sees what's missing + how to fix it (not lying about completion).

## Related patterns / memos

- `feedback_step_0_can_surface_empirical_data_realities_reframing_phase_1_locks.md` — sibling pattern (Step 0 surfaces empirical reality)
- `feedback_decision_feed_union_pattern_composite_chronological_view.md` — sibling pattern (UNION delivers UX without schema migration)
- `feedback_phase_1_loc_estimates_undercount_state_handling.md` — state-branch cost

## Banked from

- KAN-1113 (Brain Layers) — 0 BrainSnapshot + 0 Blueprint rows in PROD → shipped honest empty-state UX
- Session date: 2026-06-06
