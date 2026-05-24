# KAN-1004 — SAE PR1 Pre-flight checklist (PO authorizes per-op before apply)

First gated PR of the Safe Autonomous Execution epic. Treats every step as gated on **explicit PO authorization for that specific step** per the destructive-DB-operation protocol memory.

## 0. Backup posture (before ANY DB touch)

Per `reference_backup_posture_prerequisite`: Cloud SQL backups + PITR both `True` before this session touches schema or data.

```bash
gcloud sql instances describe growth-db \
  --project=growth-493400 \
  --format='value(settings.backupConfiguration.enabled,settings.backupConfiguration.pointInTimeRecoveryEnabled)'
# Expected: "True\tTrue"
```

If either is `False`, ABORT.

## 1. Pre-flight rowset (PO eyeball BEFORE backfill apply)

Connect to PROD via the per-op Cloud SQL proxy + read-only psql (Secret Manager credentials, fresh proxy on :5434 per the established Slice 0 pattern). **Do NOT use a write-capable role for these queries.**

```sql
-- P1: exact backfill rowset (expect 2: the inert Slice-0 shadow campaigns)
SELECT count(*) AS to_relabel, array_agg(name) AS names
FROM campaigns WHERE status='active';

-- P2: confirm the archived smoke campaigns are NOT in scope
SELECT name, status FROM campaigns ORDER BY created_at;
```

Expected:
- `to_relabel = 2`
- `names = ["Book Demo — New Leads", "Enrich Incomplete Leads"]` (the KAN-1001 Slice 0 backfill campaigns)
- 2 additional rows with `status='archived'` (the KAN-1002 smoke campaigns: "New Leads 90-Day Warm-Up Campaign", "Current Customer Retention Campaign")

If `to_relabel ≠ 2`: STOP. Reconcile before any write. A larger set means something committed since the smoke; a smaller set means data drift.

## 2. Migration diff (eyeball additive SQL before apply)

The migration.sql is hand-rolled, mirrors the KAN-1001 Slice 0 pattern. Read it end-to-end:

```bash
cat packages/db/prisma/migrations/20260524000000_kan_1004_sae_pr1_campaign_state_model/migration.sql
```

Expected: **2 `ALTER TYPE … ADD VALUE` statements**. Zero `DROP`, zero `ALTER COLUMN`, zero data mutations. Not wrapped in BEGIN/COMMIT (PG requirement for `ADD VALUE`).

The Prisma `migrate diff --script` output also produces a spurious `DROP INDEX knowledge_chunk_embedding_hnsw_idx` and a `RENAME INDEX` on `tenant_objective_selection`. Both are known Prisma drift artifacts (per `feedback_prisma_vector_index_silent_drop_drift`), STRIPPED from this migration. The committed `migration.sql` contains ONLY the 2 ADD VALUE lines.

## 3. Apply order (gated)

Each step needs PO go-ahead before the next:

1. **PO authorizes**: backups confirmed; pre-flight queries reviewed; sample output approved
2. **PO authorizes merge**: comm-23 zero-new guard CC has run + reported. Merge triggers KAN-709 v4 deploy chain.
3. **Migration auto-applies** via KAN-709 v4 (single-step proxy + readiness + retry). This adds the 2 enum values; zero data semantics change. PG's `ALTER TYPE … ADD VALUE` is idempotent at the catalog level (Prisma's migration ledger prevents re-application).
4. **PO re-authorizes** (distinct go-ahead): backfill is a DML mutation, distinct from the schema add
5. **Apply backfill.sql** via the same per-op proxy session. Wrapped in transaction with embedded post-commit verification (raises EXCEPTION if any active campaigns remain — auto-rolls back).
6. **V1–V5 verification** (CC runs, pastes)

## 4. Post-apply verification (V1–V5)

```sql
-- V1: zero campaigns at status='active' post-backfill
SELECT count(*) AS still_active FROM campaigns WHERE status='active';
-- Expected: 0

-- V2: 2 campaigns at status='committed', both expected names, tenant-scoped
SELECT id, tenant_id, name, status, audience_evaluated_at, audience_snapshot_count
FROM campaigns WHERE status='committed'
ORDER BY created_at;
-- Expected: 2 rows, names = "Book Demo — New Leads", "Enrich Incomplete Leads"

-- V3: archived smoke campaigns unchanged
SELECT name, status, archived_at FROM campaigns WHERE status='archived' ORDER BY created_at;
-- Expected: 2 rows, names = the KAN-1002 smoke campaigns, archived_at populated

-- V4: audit_log entries for the relabel
SELECT id, actor, action_type, payload->>'campaignId' AS campaign_id,
       payload->>'oldStatus' AS old_status, payload->>'newStatus' AS new_status, created_at
FROM audit_log
WHERE action_type='campaign.relabel' AND actor='kan-1004-sae-pr1-backfill'
ORDER BY created_at;
-- Expected: 2 rows, both oldStatus='active', newStatus='committed'

-- V5: zero pipelines/memberships/stack rows touched (only campaigns.status changed)
SELECT
  (SELECT count(*) FROM pipelines WHERE updated_at >= CURRENT_TIMESTAMP - INTERVAL '5 minutes') AS pipelines_touched,
  (SELECT count(*) FROM campaign_membership WHERE joined_at >= CURRENT_TIMESTAMP - INTERVAL '5 minutes') AS memberships_touched,
  (SELECT count(*) FROM contact_objective_stack WHERE updated_at >= CURRENT_TIMESTAMP - INTERVAL '5 minutes') AS stack_touched;
-- Expected: 0, 0, 0
```

## 5. Rollback posture

Migration: PG cannot drop enum values without rewriting the type (catalog limitation). Practical rollback = leave the values unused. No row references `'committed'` or `'paused'` until PR3 ships, so the additive enum values are inert as long as the code doesn't write them.

Backfill: PITR to the pre-apply timestamp restores `status='active'` on the 2 relabeled rows. Alternative emergency rollback: `UPDATE campaigns SET status='active', updated_at=CURRENT_TIMESTAMP WHERE status='committed' AND id IN (<the 2 ids from V2>)`. Audit log rows stay (provenance trail).

If both apply cleanly and V1-V5 pass, no rollback is needed.
