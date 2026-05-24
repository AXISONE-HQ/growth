# KAN-1009 — SAE PR4 Pre-flight checklist (PO authorizes per-op)

Schema-only PR (no backfill — additive nullable column). Runs the
shortened version of the destructive-DB protocol.

## 0. Backup posture

```bash
gcloud sql instances describe growth-db \
  --project=growth-493400 \
  --format='value(settings.backupConfiguration.enabled,settings.backupConfiguration.pointInTimeRecoveryEnabled)'
# Expected: "True\tTrue"
```

## 1. Pre-flight read (PO eyeball before merge)

```sql
-- Confirm: zero tenants have daily_llm_cost_cap_usd set today
-- (column doesn't exist pre-migration, so this should error;
-- post-migration it should return 0 since we don't backfill anyone).
SELECT count(*) FROM tenants;
-- Expected: 1 (AxisOne)
```

## 2. Migration diff (eyeball)

```bash
cat packages/db/prisma/migrations/20260524100000_kan_1009_sae_pr4_tenant_daily_llm_cost_cap/migration.sql
```

Expected: **1 `ALTER TABLE ... ADD COLUMN`**. Zero `DROP`, zero `ALTER COLUMN ... SET NOT NULL` on existing data, zero data mutations. Drift artifacts (HNSW DROP + tenant_objective_selection RENAME) STRIPPED per the migration.sql comment.

## 3. Apply sequence (per-op PO go-ahead)

1. PO authorizes merge (comm-23 zero-new guard — CC runs, reports)
2. Migration auto-applies via KAN-709 v4 chain on merge (additive; ~ms; zero data semantics change)
3. No backfill step (additive nullable column — existing rows stay NULL = env-default applies in app code)
4. V1 verification (CC runs, pastes)

## 4. Post-apply verification (V1)

```sql
-- V1: column exists, is nullable, type matches
SELECT column_name, data_type, is_nullable, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_name='tenants' AND column_name='daily_llm_cost_cap_usd';
-- Expected: daily_llm_cost_cap_usd | numeric | YES | 10 | 2

-- V2: no existing rows have a value set (no backfill ran)
SELECT count(*) AS rows_with_cap_set FROM tenants WHERE daily_llm_cost_cap_usd IS NOT NULL;
-- Expected: 0

-- V3: AxisOne tenant row still healthy, unchanged
SELECT id, name, confidence_threshold, daily_action_limit, daily_llm_cost_cap_usd FROM tenants;
-- Expected: AxisOne row present; daily_llm_cost_cap_usd = NULL (env-default applies in code)
```

## 5. Rollback posture

Pure additive — rollback = `ALTER TABLE tenants DROP COLUMN daily_llm_cost_cap_usd;` (only safe if no app code reads the column; KAN-1009 PR4 ships the reader simultaneously, so post-merge rollback should use PITR, not a manual DROP).
