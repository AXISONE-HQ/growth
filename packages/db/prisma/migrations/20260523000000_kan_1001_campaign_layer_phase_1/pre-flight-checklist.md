# KAN-1001 — Pre-flight checklist (PO authorizes per-op before apply)

This Slice 0 migration is the first DB-touching change since KAN-994 was filed (and never actioned). Treat every step here as gated on **explicit PO authorization for that specific step** per the destructive-DB-operation protocol memory.

## 0. Backup posture (before ANY DB touch)

Per `reference_backup_posture_prerequisite`: Cloud SQL backups + PITR both `True` before this session touches schema or data.

```bash
gcloud sql instances describe growth-db \
  --project=growth-493400 \
  --format='value(settings.backupConfiguration.enabled,settings.backupConfiguration.pointInTimeRecoveryEnabled)'
# Expected: "True\tTrue"
```

If either is `False`, ABORT. Enable both, wait for the next scheduled backup window, verify again.

## 1. Pre-flight rowcount (what the backfill will create)

Connect to PROD via the per-op Cloud SQL proxy + read-only psql. **Do NOT use a write-capable role for these queries.**

```sql
-- Q1: How many Campaign rows will the backfill INSERT?
SELECT COUNT(*) AS expected_new_campaigns
FROM pipelines
WHERE objective_id IS NOT NULL
  AND campaign_id IS NULL;

-- Q2: Breakdown by tenant (so you can sanity-check the distribution)
SELECT tenant_id, COUNT(*) AS campaigns_per_tenant
FROM pipelines
WHERE objective_id IS NOT NULL
  AND campaign_id IS NULL
GROUP BY tenant_id
ORDER BY campaigns_per_tenant DESC
LIMIT 20;

-- Q3: Breakdown by segment (so you can sanity-check the stub conditions)
SELECT
  COALESCE(segment::text, 'NULL') AS segment,
  COUNT(*) AS pipelines_with_segment
FROM pipelines
WHERE objective_id IS NOT NULL
  AND campaign_id IS NULL
GROUP BY segment
ORDER BY pipelines_with_segment DESC;

-- Q4: Pipelines that will NOT be backfilled (objective_id IS NULL —
-- the KAN-702 Verify Pipeline fixture, per the Phase 1 strict-fixture
-- decision). These stay unlinked to Campaign until they're either
-- assigned an objective or archived.
SELECT id, tenant_id, name, segment
FROM pipelines
WHERE objective_id IS NULL
LIMIT 20;
```

## 2. Sample-render (eyeball ONE backfilled Campaign row before apply)

Pick any tenant's objective-bound Pipeline + dry-render the Campaign row the backfill would create. **Read-only; no INSERT.**

```sql
-- Pick a sample Pipeline (any row with objective_id NOT NULL)
WITH sample_pipeline AS (
  SELECT id, tenant_id, name, objective_id, segment, created_at
  FROM pipelines
  WHERE objective_id IS NOT NULL
    AND campaign_id IS NULL
  LIMIT 1
)
SELECT
  '<would-be-generated>'              AS id,
  tenant_id,
  name,
  '[KAN-1001 backfill] Campaign created from existing Pipeline; no NL intent recorded.'
                                      AS nl_intent,
  objective_id,
  NULL                                AS strategy,
  jsonb_build_object(
    '_stub',  true,
    '_source', concat('pipeline.segment=', COALESCE(segment::text, 'NULL'))
  )                                   AS audience_conditions,
  'static'::text                      AS audience_mode,
  'active'::text                      AS status,
  100                                 AS priority,
  created_at                          AS activated_at,
  created_at                          AS created_at,
  '<NOW()>'                           AS updated_at
FROM sample_pipeline;
```

Eyeball:
- `audience_conditions` reads `{"_stub":true,"_source":"pipeline.segment=<value>"}` — looks right?
- `nl_intent` has the backfill marker (no leaked PII)
- `tenant_id` + `objective_id` match the source Pipeline
- `audience_mode = 'static'` (inert — stub conditions aren't an evaluable query; static avoids arming Slice 5's dynamic-eval cron on `{_stub:true}`. Mode flips when Phase 2 re-derives real conditions.)
- `status = 'active'` (existing pipelines are live)

## 3. Migration diff (eyeball additive SQL before apply)

The migration.sql in this directory is hand-rolled per the established pattern (matches `20260521010000_kan_962_slice_2a_foundation` shape). Read it end-to-end before applying:

```bash
cat packages/db/prisma/migrations/20260523000000_kan_1001_campaign_layer_phase_1/migration.sql
```

Expected: 4 `CREATE TYPE`, 2 `CREATE TABLE`, 2 `ALTER TABLE … ADD COLUMN` (both nullable), 6 `CREATE INDEX`, 8 `CONSTRAINT … FK` adds. **Zero `DROP`, zero `ALTER COLUMN … SET NOT NULL` on existing tables, zero data mutations.**

## 4. Apply order (gated)

Each step needs PO go-ahead before the next:

1. **PO authorizes**: backups confirmed; pre-flight queries reviewed; sample-render eyeballed
2. **Apply migration.sql** via the KAN-709 v4 deploy chain (single-step proxy + readiness + retry, per the `feedback_kan_709_v4_lifecycle_validated` memory). This creates the empty tables + nullable columns.
3. **PO re-authorizes** (separate go-ahead): backfill is a data mutation, distinct from the schema add
4. **Apply backfill.sql** via the same proxy session. Wrapped in transaction with embedded post-commit verification (raises EXCEPTION if any objective-bound Pipeline remains unbackfilled — auto-rolls back).
5. **Smoke**: PO runs the verification queries below to confirm shape

## 5. Post-apply verification (smoke)

```sql
-- V1: All objective-bound Pipelines now linked to a Campaign
SELECT COUNT(*) AS unbackfilled_pipelines
FROM pipelines
WHERE objective_id IS NOT NULL AND campaign_id IS NULL;
-- Expected: 0

-- V2: Backfilled Campaigns row count matches the pre-flight Q1
SELECT COUNT(*) AS backfilled_campaigns
FROM campaigns
WHERE nl_intent LIKE '[KAN-1001 backfill]%';
-- Expected: matches pre-flight Q1

-- V3: Tenant isolation invariant — every Campaign matches its Pipeline's tenant
SELECT COUNT(*) AS cross_tenant_violations
FROM campaigns c
JOIN pipelines p ON p.campaign_id = c.id
WHERE p.tenant_id != c.tenant_id;
-- Expected: 0

-- V4: Audience-conditions stub shape is correct
SELECT
  audience_conditions->>'_stub'    AS stub_flag,
  audience_conditions->>'_source'  AS source_label,
  COUNT(*)                         AS campaigns_with_this_shape
FROM campaigns
WHERE nl_intent LIKE '[KAN-1001 backfill]%'
GROUP BY 1, 2;
-- Expected: stub_flag='true' for every row; source_label like 'pipeline.segment=<value>'

-- V5: Tier-1.5 routing path UNCHANGED (regression check)
SELECT
  tenant_id,
  COUNT(*) FILTER (WHERE objective_id IS NOT NULL AND segment = 'new_leads') AS new_leads_routes
FROM pipelines
GROUP BY tenant_id
ORDER BY new_leads_routes DESC
LIMIT 10;
-- Expected: matches the pre-apply value (the route configuration didn't change;
-- only the campaign_id column was added next to it).
```

## 6. Rollback posture

Phase 1 is fully additive — rollback is via PITR to before-apply. The new tables can also be dropped manually if PITR is overkill (they're empty after migration.sql and only contain backfill data; no foreign keys point INTO them yet outside of pipelines.campaign_id which is nullable):

```sql
-- Emergency rollback (only if PITR is unavailable):
BEGIN;
  -- Unlink first (pipelines.campaign_id is FK SET NULL, but explicit is safer)
  UPDATE pipelines SET campaign_id = NULL;
  UPDATE contact_objective_stack SET campaign_id = NULL;  -- empty in Phase 1
  -- Drop FKs + columns
  ALTER TABLE pipelines DROP COLUMN campaign_id;
  ALTER TABLE contact_objective_stack DROP COLUMN campaign_id;
  -- Drop tables
  DROP TABLE campaign_membership;
  DROP TABLE campaigns;
  -- Drop types (CASCADE if anything still references — shouldn't in Phase 1)
  DROP TYPE campaign_member_source;
  DROP TYPE campaign_status;
  DROP TYPE campaign_audience_mode;
  DROP TYPE campaign_strategy;
COMMIT;
```

This rollback DESTROYS the backfilled Campaign rows. Use only if PITR isn't an option; PITR is the canonical recovery per `reference_destructive_db_operation_protocol`.
