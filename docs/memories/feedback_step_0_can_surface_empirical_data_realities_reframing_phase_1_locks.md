---
name: Step 0 enumeration can surface empirical data realities that reframe Phase 1 locks
description: KAN-1107 banked 2026-06-06. Phase 1 design decisions are based on schema + assumed empirical state. Step 0 enumeration (just before code edits) may reveal the empirical state differs (e.g., Action table empty in PROD). Hybrid fallback pattern (canonical signal + heuristic backup) handles gracefully without delaying ship.
type: feedback
---

**The pattern**: Phase 1 design trace locks decisions based on **schema reality + assumed empirical state**. The assumed state often turns out wrong:

- Assumed: "Action table has rows we can project to channel labels"
- Actual: "Action table has 0 rows for AxisOne tenant (engine pre-launch governance)"
- Assumed: "BrainSnapshot exists for tenant"
- Actual: "BrainSnapshot table empty across entire PROD database"

Step 0 enumeration (just before code edits, after Fred greenlight) is the discipline checkpoint where empirical reality gets verified against Phase 1 assumptions.

**KAN-1107 instance**: Phase 1 locked Q6 channel derivation as "JOIN Decision → Action.channel". Step 0 PROD sniff revealed Action table has 0 rows. Naive consequence: channel chip would render "—" for every row at PROD scale today.

**Hybrid fallback resolution**: server-side hybrid `actions[0]?.channel ?? actionTypeToChannel[d.actionType] ?? null`. Operator gets the best available signal today (actionType-derived) + the correct signal tomorrow (Action.channel when populated).

## Anti-pattern

Treating the empirical mismatch as a blocker:

1. "We can't ship until Action table has rows" → delays ship indefinitely (engine hasn't dispatched any actions yet)
2. "We need to write a migration to backfill Action rows" → scope expansion + side effects
3. "We need to redesign the panel" → re-opens Phase 1 design + waste

The right move is **hybrid fallback** — design for both states (empty + populated) from the start. UI auto-evolves when data flows.

## Forward discipline

Step 0 enumeration must include an empirical PROD data check:

```bash
# Via Cloud SQL Proxy authorized read; OR via tRPC call against PROD endpoint
SELECT COUNT(*) FROM <table> WHERE tenant_id = '<tenant>';
SELECT DISTINCT <field> FROM <table> WHERE tenant_id = '<tenant>' LIMIT 50;
```

If the empirical state differs from Phase 1 assumption:

1. **Surface the finding** in the Step 0 HALT
2. **Apply hybrid fallback** — design for both states
3. **Document expected day-1 render** in the PR description
4. **DO NOT delay ship** — the UI design that handles empty + populated is robust both ways

## Related patterns / memos

- `feedback_phase_1_5_prod_sniff_can_reveal_empty_cognitive_infrastructure.md` — sibling memo (BrainSnapshot empty case)
- `feedback_decision_feed_union_pattern_composite_chronological_view.md` — sibling memo (UNION pattern is also a hybrid)
- `feedback_phase_1_loc_estimates_undercount_state_handling.md` — state branches are the cost of hybrid resolution

## Banked from

- KAN-1107 (Decision Feed + Agent Actions) — Action table 0 rows in PROD → Q6 hybrid
- Session date: 2026-06-06
