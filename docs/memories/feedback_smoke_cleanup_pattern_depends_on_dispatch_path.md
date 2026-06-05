---
name: Smoke Op D cleanup pattern depends on dispatch path (defer-completed vs defer-gated vs terminal_won)
description: KAN-1098 smoke 2026-06-05. The 6/7/8/9-step cleanup variant depends on what the engine chain did. Defer-to-completed adds engagement rows (KAN-816 outbound sidecar). Defer-to-gated adds deferred_sends row. terminal_won transitions add customer + customer_lifecycle_event + deal_stage_history (per KAN-963 + KAN-1081 hooks). Select cleanup variant by dispatch-path inspection at Op C.
type: feedback
---

**KAN-1098 smoke Op D 2026-06-05**: Pre-Op-D, I expected the 7-step pattern (6-step base + deferred_sends) per `feedback_smoke_cleanup_extended_for_terminal_won_dealstagehistory_artifacts`. Actually needed 8-step (no `messages` table in this schema; KAN-816 routes outbound through engagements sidecar so `actions` is 0; deferred_sends is 0 because dispatch went all-the-way-through). Cleanup variant selection rule has surfaced enough now to crystallize.

## The dispatch-path → cleanup-variant matrix

Inspect at Op C, BEFORE Op D:

| Engine path observed | Add rows | Pattern |
|---|---|---|
| Engine → send-policy ALLOW → dispatch published end-to-end (in-window) | engagements (inbound + outbound), decisions, contact_sub_objective_gap_state (auto-seeded BANT-8) | **base 6-step + deferred_sends sanity-check** = 7 step or 8 step depending on whether `messages` table exists in schema |
| Engine → send-policy DEFER → deferred_sends row written, no dispatch | engagements (inbound only), deferred_sends, contact_sub_objective_gap_state | **base 6-step + deferred_sends DELETE** = 7 step |
| Engine → send-policy DENY | engagements (inbound only), audit_log row (preserved per forensic discipline) | **base 6-step only** = 6 step |
| Engine emits `advance_stage` (Cluster III) | + deal_stage_history rows | **+1 step: DELETE FROM deal_stage_history** = 8/9 step |
| Engine reaches terminal_won (KAN-963 + KAN-1081 hooks) | + customer rows, customer_lifecycle_event rows | **+2 steps: DELETE FROM customer_lifecycle_event, DELETE FROM customers** = 9/10 step |

## Schema-presence guard

Before any DELETE, verify table existence:

```sql
SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN (
  'actions','escalations','engagements','contact_sub_objective_gap_state',
  'decisions','deferred_sends','deals','contacts','messages','customers',
  'customer_lifecycle_event','deal_stage_history'
);
```

Tables that don't exist in current schema (e.g., `messages` per KAN-1093 schema state) should be SKIPPED, not DELETE-attempted (the abort cascades the entire transaction).

## Always preserved

`audit_log` is NEVER deleted (forensic chain discipline — per `feedback_compaction_can_drift_cleanup_sql_pattern_memory`).

## Anti-pattern (what we did in KAN-1098)

Pre-Op-D, drafted 8-step including `messages` table. Op D transaction aborted on first DELETE because `messages` doesn't exist in this schema (banked memo from KAN-1093 session noted this; I forgot to apply it). Re-ran with 8-step minus `messages` plus `deferred_sends` sanity-check; succeeded.

The schema-presence check would have caught this proactively. ~5-second query, prevents the abort + retry.

## The canonical 6-step base (always applicable)

```sql
BEGIN;
DELETE FROM actions WHERE contact_id = '<contact_id>';        -- step 1
DELETE FROM escalations WHERE contact_id = '<contact_id>';    -- step 2
DELETE FROM engagements WHERE contact_id = '<contact_id>';    -- step 3
DELETE FROM contact_sub_objective_gap_state WHERE contact_id = '<contact_id>';  -- step 4
DELETE FROM decisions WHERE contact_id = '<contact_id>';      -- step 5
DELETE FROM deals WHERE contact_id = '<contact_id>';          -- step 7 (must come AFTER engagements + decisions FKs)
DELETE FROM contacts WHERE id = '<contact_id>';               -- step 8 (last)
COMMIT;
```

FK ordering load-bearing: engagements → deals → contacts; decisions → contacts; contact_sub_objective_gap_state → contacts.

## Add-ons by dispatch path

- **+ deferred_sends DELETE** when policy deferred OR sanity-checking
- **+ deal_stage_history DELETE** when advance_stage fired (before deals)
- **+ customer_lifecycle_event DELETE + customers DELETE** when terminal_won (before deals)
- **+ messages DELETE** if + ONLY IF the schema has that table

## Sibling memos

- `feedback_smoke_cleanup_extended_for_terminal_won_dealstagehistory_artifacts` — KAN-1081 9-step pattern for terminal_won
- `feedback_compaction_can_drift_cleanup_sql_pattern_memory` — destruction-flag-gate + audit_log preservation discipline
- `feedback_destructive_flag_gate` — per-op auth on destructive ops

## Forward discipline

Before drafting Op D SQL block:

1. Query `pg_tables` to confirm cleanup-target tables exist in current schema
2. Inspect Op C dispatch-path observation (defer? completed? terminal? advance_stage?) to select variant
3. Surface variant choice in Op D proposal to Fred for per-op auth
4. Audit_log NEVER in the DELETE list

Bounded ~30-second addition to Op D planning. Prevents transaction abort + Op D retry cost.
