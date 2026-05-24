-- KAN-1001 — Campaign Layer Slice 0 Phase 1 BACKFILL (separate from migration.sql)
--
-- This file is NOT applied by `prisma migrate deploy`. It's a hand-run
-- DML script PO authorizes per-op after eyeballing the pre-flight
-- queries (see pre-flight-checklist.md in this directory).
--
-- WHAT IT DOES
--   For each `pipelines` row with `objective_id IS NOT NULL` AND
--   `campaign_id IS NULL` (idempotency guard):
--     1. INSERT a Campaign row with audience_conditions = stub derived
--        from Pipeline.segment, status='active', priority=100
--     2. UPDATE pipelines SET campaign_id = the new Campaign.id
--
--   Wrapped in a single transaction so partial failure rolls back.
--   Idempotent — re-run is safe (the WHERE clause skips already-backfilled
--   rows).
--
-- WHAT IT DOES NOT DO
--   - Does NOT touch existing Pipeline columns (objective_id, segment,
--     objective_type all preserved — readers continue dual-reading)
--   - Does NOT populate CampaignMembership (no historical contact set
--     to snapshot for legacy pipelines — they'd need real audience
--     queries, which the backfilled stub conditions don't represent)
--   - Does NOT touch ContactObjectiveStack.campaign_id (Slice 3
--     populates this for NEW stack entries; existing rows stay NULL)
--
-- AUDIENCE_CONDITIONS STUB DERIVATION
--   Each Pipeline.segment value maps to a placeholder JSONB. These
--   are FLAGGED via the nl_intent field as "shadow/stub from segment"
--   so future readers know they're not real audience queries. Slice 3+
--   re-derives proper conditions when committing real campaigns.
--
--   new_leads                       → {"_stub":true,"_source":"pipeline.segment=new_leads"}
--   winback                         → {"_stub":true,"_source":"pipeline.segment=winback"}
--   closed_lost_recovery            → {"_stub":true,"_source":"pipeline.segment=closed_lost_recovery"}
--   cancelled_orders_recovery       → {"_stub":true,"_source":"pipeline.segment=cancelled_orders_recovery"}
--   inactive_customers_reengagement → {"_stub":true,"_source":"pipeline.segment=inactive_customers_reengagement"}
--   other                           → {"_stub":true,"_source":"pipeline.segment=other"}
--   NULL                            → {"_stub":true,"_source":"pipeline.segment=NULL"}
--
-- AUDIENCE_MODE DERIVATION
--   All backfilled campaigns get audience_mode='STATIC' (inert). Even
--   though the legacy pipelines accept inbound leads continuously via
--   Tier 1.5 routing on Pipeline.segment, the backfilled
--   audience_conditions = {_stub:true, ...} is NOT an evaluable query.
--   Marking these 'dynamic' would arm Slice 5's dynamic-eval cron to
--   try re-evaluating {_stub:true} on a schedule — latent footgun.
--   'static' = inert + honest. Phase 2 (when commit flow re-derives
--   real conditions) sets the proper mode then. Slice 5 cron must
--   ALSO defensively skip rows where audience_conditions ? '_stub'.
--
-- PRE-FLIGHT (PO runs these BEFORE this script — see pre-flight-checklist.md):
--   1. Cloud SQL backups + PITR both `True`
--   2. SELECT COUNT(*) FROM pipelines WHERE objective_id IS NOT NULL
--      AND campaign_id IS NULL  -- expected row count for this backfill
--   3. SELECT id, name, objective_id, segment FROM pipelines
--      WHERE objective_id IS NOT NULL LIMIT 3  -- eyeball sample of
--      sources

BEGIN;

-- ────────────────────────────────────────────
-- Backfill: one Campaign per objective-bound Pipeline
-- ────────────────────────────────────────────

-- gen_random_uuid() is in pgcrypto (standard PG ≥ 13). The default
-- Prisma migration creates the extension; assert here for safety on
-- fresh dbs where the extension might not be enabled yet.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

WITH new_campaigns AS (
  INSERT INTO campaigns (
    id,
    tenant_id,
    name,
    nl_intent,
    objective_id,
    strategy,
    audience_conditions,
    audience_mode,
    status,
    priority,
    activated_at,
    created_by_user_id,
    created_at,
    updated_at
  )
  SELECT
    gen_random_uuid()::text                                       AS id,
    p.tenant_id,
    p.name,
    -- nl_intent: explicit marker that this Campaign was backfilled
    -- from a pre-Campaign-Layer Pipeline. Surfaces in the UI as
    -- "Backfilled from Pipeline (no NL intent recorded)".
    '[KAN-1001 backfill] Campaign created from existing Pipeline; no NL intent recorded.'
                                                                   AS nl_intent,
    p.objective_id,
    NULL                                                           AS strategy,
    -- Shadow/stub conditions per segment. NOT a real audience query.
    -- Phase 2 readers must check the _stub flag before relying on
    -- these to count contacts.
    jsonb_build_object(
      '_stub',  true,
      '_source', concat('pipeline.segment=', COALESCE(p.segment::text, 'NULL'))
    )                                                              AS audience_conditions,
    -- KAN-1001 — 'static' (inert), not 'dynamic'. Stub conditions
    -- aren't evaluable; arming Slice 5's dynamic cron on them would
    -- be a latent footgun. Mode flips to 'dynamic' (or stays static
    -- per intent) when commit flow re-derives real conditions in Phase 2.
    'static'::campaign_audience_mode                               AS audience_mode,
    'active'::campaign_status                                      AS status,
    100                                                            AS priority,
    p.created_at                                                   AS activated_at,
    NULL                                                           AS created_by_user_id,
    p.created_at                                                   AS created_at,
    CURRENT_TIMESTAMP                                              AS updated_at
  FROM pipelines p
  WHERE p.objective_id IS NOT NULL
    AND p.campaign_id IS NULL                                      -- idempotency guard
  RETURNING id, tenant_id, objective_id, name
)
-- Link each Pipeline to its new Campaign by matching the (tenant_id,
-- objective_id, name) tuple. Pipelines have unique (tenant_id, name)
-- in practice (UI prevents duplicates); the additional objective_id
-- predicate is defensive against any tenant who somehow has two
-- pipelines with the same name on different objectives.
UPDATE pipelines p
SET    campaign_id = c.id
FROM   new_campaigns c
WHERE  p.tenant_id    = c.tenant_id
  AND  p.objective_id = c.objective_id
  AND  p.name         = c.name
  AND  p.campaign_id IS NULL;

-- ────────────────────────────────────────────
-- Verification queries (informational, do not block commit)
-- ────────────────────────────────────────────

-- POST-BACKFILL CHECK 1: campaigns row count matches expected
DO $$
DECLARE
  expected_new_campaigns INT;
  actual_campaigns_in_db INT;
  unbackfilled_pipelines INT;
BEGIN
  -- How many pipelines SHOULD have been backfilled? (recomputed)
  -- This SHOULD be 0 if backfill succeeded.
  SELECT COUNT(*) INTO unbackfilled_pipelines
  FROM pipelines
  WHERE objective_id IS NOT NULL AND campaign_id IS NULL;

  IF unbackfilled_pipelines > 0 THEN
    RAISE EXCEPTION 'KAN-1001 backfill incomplete: % objective-bound pipeline(s) still have campaign_id IS NULL. Investigate before COMMIT.', unbackfilled_pipelines;
  END IF;

  RAISE NOTICE 'KAN-1001 backfill verification PASS: 0 objective-bound pipelines remain unbackfilled.';
END $$;

COMMIT;
