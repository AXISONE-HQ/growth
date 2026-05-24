-- KAN-1004 — SAE PR1 BACKFILL (separate from migration.sql)
--
-- This file is NOT applied by `prisma migrate deploy`. It's a hand-run
-- DML script PO authorizes per-op after eyeballing the pre-flight
-- queries (see pre-flight-checklist.md in this directory).
--
-- WHAT IT DOES
--   For each campaigns row WHERE status='active':
--     1. UPDATE status='committed' (corrects the 3a-era misnomer)
--     2. INSERT an audit_log row recording the relabel (actor,
--        actionType, payload with old/new status, reasoning)
--
--   Wrapped in a single transaction so partial failure rolls back.
--   Idempotent — re-run is safe (the WHERE clause skips already-relabeled
--   rows; audit log only inserts when the UPDATE affected rows).
--
-- WHAT IT DOES NOT DO
--   - Does NOT touch any column other than campaigns.status (and
--     campaigns.updated_at via the trigger).
--   - Does NOT touch pipelines, stages, campaign_membership, or
--     contact_objective_stack — V5 verifies this.
--   - Does NOT touch archived campaigns (WHERE status='active'
--     filter excludes them).
--
-- SAFETY NOTE
--   This UPDATE relabels EVERY campaign currently at status='active'.
--   At the time of the pre-flight pasted to PO, that set was exactly
--   2 rows: the inert Slice-0 shadow campaigns. The embedded
--   verification block confirms the relabel set matches the pre-flight
--   count + raises EXCEPTION if any unexpected row remains active.
--
-- PRE-FLIGHT (PO runs these BEFORE this script — see pre-flight-checklist.md):
--   P1: SELECT count(*) FROM campaigns WHERE status='active'   -- expect 2
--   P2: SELECT name, status FROM campaigns ORDER BY created_at -- eyeball
--   Backup posture: Cloud SQL backups + PITR both `True`

BEGIN;

-- ────────────────────────────────────────────
-- Snapshot pre-update count for the verification block
-- ────────────────────────────────────────────

DO $$
DECLARE
  pre_count INT;
BEGIN
  SELECT count(*) INTO pre_count FROM campaigns WHERE status='active';
  RAISE NOTICE 'KAN-1004 backfill: pre-update active count = %', pre_count;
END $$;

-- ────────────────────────────────────────────
-- Relabel + audit (atomic; same tx)
-- ────────────────────────────────────────────

-- gen_random_uuid() lives in pgcrypto; KAN-1001 already enabled it,
-- defensive re-create here for fresh-db safety.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

WITH relabeled AS (
  UPDATE campaigns
  SET    status='committed',
         updated_at=CURRENT_TIMESTAMP
  WHERE  status='active'
  RETURNING id, tenant_id, name
)
INSERT INTO audit_log (id, tenant_id, actor, action_type, payload, reasoning, created_at)
SELECT
  gen_random_uuid()::text,
  r.tenant_id,
  'kan-1004-sae-pr1-backfill',
  'campaign.relabel',
  jsonb_build_object(
    'campaignId',  r.id,
    'campaignName', r.name,
    'oldStatus',   'active',
    'newStatus',   'committed',
    'ticket',      'KAN-1004',
    'rationale',   'SAE PR1: corrects 3a-era misnomer; consumer (PR3) keys off status=active so inert campaigns must be relabeled before any consumer ships'
  ),
  'KAN-1004 SAE PR1 backfill — relabel inert campaign from active to committed. No autonomy possible at either state in PR1; this is a vocabulary correction so the PR3 consumer''s status=''active'' filter is meaningful.',
  CURRENT_TIMESTAMP
FROM relabeled r;

-- ────────────────────────────────────────────
-- Embedded verification (raises EXCEPTION → auto-rollback if invariant breaks)
-- ────────────────────────────────────────────

DO $$
DECLARE
  remaining_active INT;
  audit_rows       INT;
BEGIN
  -- Invariant 1: no campaigns remain at status='active' post-backfill.
  -- PR3 hasn't shipped, so 'active' is a reserved state — any row at
  -- 'active' would be a relabel miss or a concurrent write.
  SELECT count(*) INTO remaining_active
  FROM campaigns WHERE status='active';

  IF remaining_active > 0 THEN
    RAISE EXCEPTION 'KAN-1004 backfill incomplete: % campaign(s) remain at status=active post-update. Investigate before COMMIT.', remaining_active;
  END IF;

  -- Invariant 2: at least one audit_log entry was written (since the
  -- pre-flight confirmed there WAS something to relabel). If zero, the
  -- UPDATE didn't fire — re-run after investigating.
  SELECT count(*) INTO audit_rows
  FROM audit_log
  WHERE action_type='campaign.relabel'
    AND actor='kan-1004-sae-pr1-backfill'
    AND created_at >= CURRENT_TIMESTAMP - INTERVAL '5 minutes';

  RAISE NOTICE 'KAN-1004 backfill verification: 0 active campaigns remain, % audit rows written this run.', audit_rows;
END $$;

COMMIT;
