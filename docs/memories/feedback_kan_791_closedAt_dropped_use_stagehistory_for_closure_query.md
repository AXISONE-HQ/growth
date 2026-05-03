# feedback_kan_791_closedAt_dropped_use_stagehistory_for_closure_query

**Trigger:** Deal.closedAt was DROPPED in the KAN-791 Phase 1 pivot. Closure is signaled by Deal.currentStageId pointing at a Stage with outcomeType IN (terminal_won, terminal_lost). To query "when did this Deal close?", read DealStageHistory.transitionedAt for the transition INTO the terminal Stage. Single source of truth via Stage.outcomeType + DealStageHistory.transitionedAt — no denorm column to drift.

**Empirical anchor:** KAN-796a pre-flight (2026-05-03) caught this when reviewing the spec's writeTransition pseudocode which set `closedAt: transitionedAt` on terminal-stage transitions. Verified empirically via `grep -nE "closedAt|closed_at" packages/db/prisma/schema.prisma` — only match was a comment at line 1118 documenting the KAN-791 drop. Without the catch, KAN-796a would have written code referencing a non-existent column → runtime errors on every terminal-stage transition.

---

## The canonical "when did this Deal close?" query

```sql
SELECT MAX(transitioned_at)
FROM deal_stage_history dsh
JOIN stages s ON dsh.to_stage_id = s.id
WHERE dsh.deal_id = $1
  AND s.outcome_type IN ('terminal_won', 'terminal_lost');
```

Returns the timestamp of the transition INTO the terminal Stage. NULL if the Deal is still open. If the Deal was somehow re-opened (Phase 1 design says no, but defense in depth), MAX returns the most recent closure event.

---

## Why empirically

**Three forces drove the KAN-791 drop:**

1. **Single source of truth.** `Stage.outcomeType` is the canonical "is this a closed state?" signal. Adding `Deal.closedAt` would denormalize that — every transition into a terminal Stage would need to set BOTH `currentStageId` and `closedAt` consistently, and a future bug in the writer could leave them inconsistent (currentStageId pointing at terminal Stage but closedAt still NULL, or vice versa).

2. **Audit-trail completeness.** `DealStageHistory.transitionedAt` already records when each transition happened, including the transition INTO the terminal Stage. Reading from the audit trail is more honest about what happened than reading a denorm timestamp that was only updated at one specific moment.

3. **Consistent closure-query path for both terminal_won and terminal_lost.** `Deal.closedAt` would have collapsed both into one timestamp; the audit-trail approach lets queries distinguish between "closed-won at T1" vs "closed-lost at T2" by joining to the Stage and inspecting outcomeType.

---

## What this enables

```sql
-- "List all Deals that closed in the last 30 days, by outcome"
SELECT d.id, s.outcome_type, dsh.transitioned_at AS closed_at
FROM deals d
JOIN stages s ON d.current_stage_id = s.id
JOIN deal_stage_history dsh
  ON dsh.deal_id = d.id AND dsh.to_stage_id = s.id
WHERE s.outcome_type IN ('terminal_won', 'terminal_lost')
  AND dsh.transitioned_at >= NOW() - INTERVAL '30 days'
ORDER BY dsh.transitioned_at DESC;

-- "Average days-from-open-to-close for closed_won Deals"
SELECT AVG(EXTRACT(EPOCH FROM (closed_at - opened_at))) / 86400 AS avg_days_to_won
FROM (
  SELECT
    d.id,
    d.created_at AS opened_at,
    MAX(dsh.transitioned_at) AS closed_at
  FROM deals d
  JOIN deal_stage_history dsh ON dsh.deal_id = d.id
  JOIN stages s ON dsh.to_stage_id = s.id
  WHERE s.outcome_type = 'terminal_won'
  GROUP BY d.id, d.created_at
) t;
```

Both queries are derivable from the existing schema. A `closedAt` column would have been denorm of these joins.

---

## When to apply

- Any code that wants to query "when did this Deal close?" — use the canonical join above
- Any new PRD that almost reintroduces a denorm `closedAt` column — push back; the join is fine
- Any consumer that needs closure semantics — branch on `currentStage.outcomeType` not on `closedAt IS NOT NULL`

**When NOT to apply:**

- If the join becomes a hot-path performance issue (haven't seen this — the query plans well with the existing `(deal_id, transitioned_at)` index on DealStageHistory)
- If a future PRD truly needs a denorm timestamp for some specific OLAP path (then add it as a derived column with a clear materialized-view discipline, not as a Deal column)

---

## Defensive coverage

KAN-796a tests verify the absence of `closedAt` writes:

```ts
expect('closedAt' in updateArgs.data).toBe(false);
```

3 separate test sites assert this — Tests #7, #11, #18. Catches future regression that might re-introduce the denorm column. Sibling discipline to KAN-793 commit-0 LeadStageHistory cleanup.

---

## Cross-references

- KAN-791 (origin — schema pivot dropped Deal.closedAt + DealStatus enum)
- KAN-796a — pre-flight catch + defensive test coverage
- [`feedback_phase_1_pivot_kan_786_to_kan_791_lifecycle_model.md`](./feedback_phase_1_pivot_kan_786_to_kan_791_lifecycle_model.md) — the pivot context
- [`feedback_kan_791_dropped_model_residual_references.md`](./feedback_kan_791_dropped_model_residual_references.md) — sibling cleanup pattern
- [`feedback_stage_transition_engine_brain_consumer_pattern.md`](./feedback_stage_transition_engine_brain_consumer_pattern.md) — KAN-796a stage-transition-engine

---

## Status

**Active.** Closure-query pattern applies to any reporting / analytics / Phase 4+ epic that needs Deal closure timing.
