---
name: State machine extensions must enumerate recovery paths
description: KAN-1119 banked 2026-06-07. When extending a state machine with a new failure-state transition, enumerate ALL paths that can fail and add the recovery transition on each. Missing one path leaves the state machine in a stuck state that only surfaces under PROD load.
type: feedback
---

**The pattern**: A state machine adds a new failure-state transition (e.g., `pending → processing → {dispatched | expired | cancelled}`). The implementation adds the failure recovery (`processing → revert_to_pending`) on the most-obvious failure path. Other failure paths exist (timeout, publish failure, evaluation failure) and they each need the same recovery transition. Missing one leaves rows stuck in `processing` until manual intervention.

**KAN-1119 instance**: `deferred-send-evaluator` atomic CTE claim had `markRevertToPending` on the primary publish-failure path. Three OTHER publish-failure paths existed:
- Subscriber crash mid-dispatch (publish succeeded but downstream failed) → stuck `processing`
- Pub/Sub publish error (Pub/Sub API returned non-OK) → stuck `processing`
- Subscriber timeout (15s ack budget exceeded) → stuck `processing`

The original PR added the cascade discipline (`markRevertToPending` on the first path). Fix-forward #1 surfaced the second + third paths via integration test (`feedback_query_raw_sql_must_have_integration_test_exercising_real_postgres.md` doctrine). All three needed the same recovery transition; the integration test caught what Phase 2 build review missed.

## Anti-pattern

Treating state machine extensions as single-path additions:

1. "I added the failure transition on the publish path" → other failure paths still stuck
2. "The tests cover the happy path + the explicit failure" → enumeration of failure paths must be explicit, not implicit
3. "We'll catch the other paths if/when they break in PROD" → PROD discovery is a stuck-row alert page, not a graceful degradation

The right move: **enumerate every failure path before implementing recovery**. Each one needs the same recovery transition; missing one is an availability bug.

## Forward discipline

When extending a state machine with a new transition (or modifying an existing transition's failure mode):

1. **Enumerate every reachable state under the new transition** — happy path, partial failure, timeout, downstream failure, publish failure, etc.
2. **Add the recovery transition for each enumerated path** — don't rely on "the publish path is the only one that fails"
3. **Write an integration test per failure path** — assert the state machine ends up in the correct recovery state after the simulated failure
4. **Use a state diagram or table** in the Phase 1 trace — make the enumeration visible to reviewers

This is sibling to the **dispatch path 6/7/8/9-step cleanup pattern** (`feedback_smoke_cleanup_pattern_depends_on_dispatch_path.md`) — both reflect that state machines have multiple terminal-or-recovery branches per logical action.

## Related patterns / memos

- `feedback_query_raw_sql_must_have_integration_test_exercising_real_postgres.md` — sibling discipline (integration tests caught KAN-1119 cascade gap)
- `feedback_smoke_cleanup_pattern_depends_on_dispatch_path.md` — sibling pattern (dispatch path variants)
- `feedback_memos_document_tests_enforce.md` — sibling reflection (memo about a class of bugs ≠ test that enforces non-recurrence)

## Banked from

- KAN-1119 (deferred-send-evaluator atomic CTE claim) — original PR plus fix-forward #1 + fix-forward #2 = 3 missing recovery paths surfaced via integration test
- Session date: 2026-06-07
