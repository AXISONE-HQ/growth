-- KAN-959 — Objective Framework Foundation (slice 1 of N)
--
-- Pre-flight verification before applying:
--   contact_states row count = 0 (verified 2026-05-21)
--   objectives row count = 0 (no collisions with catalog seed)
--   pipelines = 1 row (KAN-702 Verify Pipeline, fixture; excluded from backfill)
--
-- Single migration, multiple phases:
--   1. Create new enums (entity_scope, objective_source, contact_objective_stack_status)
--   2. Add ContactObjectiveStack table + indexes + FKs
--   3. Extend Objective with entity_scope + source columns
--   4. Add Pipeline.objective_id FK column
--   5. Add MicroObjective.objective_id FK column
--   6. SAFETY-CHECK + DROP contact_states (gated — aborts if non-empty)
--   7. Seed 8 catalog Objective rows per tenant (idempotent via NOT EXISTS)
--
-- Acceptance bound: pipelines created via pipelines.create AFTER deploy persist
-- a non-null objective_id. The fixture pipeline (KAN-702) stays NULL per
-- Phase 1 strict-fixture decision (separate cleanup ticket Fred to authorize).

-- ─────────────────────────────────────────────────────────────────────
-- 1. New enums
-- ─────────────────────────────────────────────────────────────────────

CREATE TYPE "objective_entity_scope" AS ENUM ('contact', 'order', 'company', 'deal');

CREATE TYPE "objective_source" AS ENUM (
  'blueprint_generic',
  'blueprint_industry',
  'ai_proposed_from_data',
  'human_authored'
);

CREATE TYPE "contact_objective_stack_status" AS ENUM (
  'active',
  'paused',
  'blocked',
  'achieved',
  'abandoned',
  'superseded'
);

-- ─────────────────────────────────────────────────────────────────────
-- 2. ContactObjectiveStack table
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "contact_objective_stack" (
  "id"                TEXT                              NOT NULL,
  "tenant_id"         TEXT                              NOT NULL,
  "contact_id"        TEXT                              NOT NULL,
  "objective_id"      TEXT                              NOT NULL,
  "priority"          INTEGER                           NOT NULL,
  "status"            "contact_objective_stack_status"  NOT NULL DEFAULT 'active',
  "sub_objectives"    JSONB                             NOT NULL DEFAULT '[]',
  "strategy_current"  TEXT,
  "confidence_score"  DOUBLE PRECISION,
  "achieved_at"       TIMESTAMP(3),
  "blocked_reason"    TEXT,
  "blocked_since_at"  TIMESTAMP(3),
  "activated_at"      TIMESTAMP(3)                      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_evaluated_at" TIMESTAMP(3)                      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"        TIMESTAMP(3)                      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3)                      NOT NULL,

  CONSTRAINT "contact_objective_stack_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contact_objective_stack_contact_id_objective_id_key"
  ON "contact_objective_stack" ("contact_id", "objective_id");

CREATE INDEX "contact_objective_stack_tenant_id_contact_id_priority_idx"
  ON "contact_objective_stack" ("tenant_id", "contact_id", "priority");

CREATE INDEX "contact_objective_stack_tenant_id_status_idx"
  ON "contact_objective_stack" ("tenant_id", "status");

ALTER TABLE "contact_objective_stack"
  ADD CONSTRAINT "contact_objective_stack_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "contact_objective_stack"
  ADD CONSTRAINT "contact_objective_stack_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "contact_objective_stack"
  ADD CONSTRAINT "contact_objective_stack_objective_id_fkey"
  FOREIGN KEY ("objective_id") REFERENCES "objectives" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Objective extensions: entity_scope + source
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE "objectives" ADD COLUMN "entity_scope" "objective_entity_scope";
ALTER TABLE "objectives" ADD COLUMN "source"       "objective_source";

CREATE INDEX "objectives_tenant_id_entity_scope_idx"
  ON "objectives" ("tenant_id", "entity_scope");

-- ─────────────────────────────────────────────────────────────────────
-- 4. Pipeline.objective_id FK
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE "pipelines" ADD COLUMN "objective_id" TEXT;

ALTER TABLE "pipelines"
  ADD CONSTRAINT "pipelines_objective_id_fkey"
  FOREIGN KEY ("objective_id") REFERENCES "objectives" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "pipelines_objective_id_idx" ON "pipelines" ("objective_id");

-- ─────────────────────────────────────────────────────────────────────
-- 5. MicroObjective.objective_id FK (reverse-relation)
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE "micro_objectives" ADD COLUMN "objective_id" TEXT;

ALTER TABLE "micro_objectives"
  ADD CONSTRAINT "micro_objectives_objective_id_fkey"
  FOREIGN KEY ("objective_id") REFERENCES "objectives" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "micro_objectives_objective_id_idx" ON "micro_objectives" ("objective_id");

-- ─────────────────────────────────────────────────────────────────────
-- 6. SAFETY-CHECK + DROP contact_states
--    Aborts the migration if any row exists (anomaly between Phase 1 verification
--    and migration apply — must be reconciled manually, not silently dropped).
-- ─────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  cs_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO cs_count FROM contact_states;
  IF cs_count > 0 THEN
    RAISE EXCEPTION
      'KAN-959 abort: contact_states has % row(s). Drop refused. Phase 1 pre-flight verified empty; if rows appeared since, reconcile manually before applying.',
      cs_count;
  END IF;
END $$;

DROP TABLE "contact_states";

-- ─────────────────────────────────────────────────────────────────────
-- 7. Seed catalog Objective rows
--    8 objectives per tenant, entity_scope='contact', source='blueprint_generic'.
--    Idempotent — skips rows already present (matching on tenant_id + type).
--    Iterates over every tenant to keep multi-tenant-portable; for the current
--    single-tenant PROD this inserts 8 rows for AxisOne.
-- ─────────────────────────────────────────────────────────────────────

INSERT INTO "objectives"
  ("id", "tenant_id", "name", "type", "success_condition", "sub_objectives",
   "blueprint_id", "entity_scope", "source", "is_active", "created_at", "updated_at")
SELECT
  gen_random_uuid(), t."id", v.name, v.type, '{}'::jsonb, '[]'::jsonb,
  NULL, 'contact'::"objective_entity_scope", 'blueprint_generic'::"objective_source",
  true, NOW(), NOW()
FROM "tenants" t
CROSS JOIN (VALUES
  ('Book an appointment',           'book_appointment'),
  ('Sell online',                   'sell_online'),
  ('Enrich a lead',                 'enrich_lead'),
  ('Warm up a lead',                'warm_up'),
  ('Reactivate a contact',          'reactivate'),
  ('Retain a customer',             'retain_customer'),
  ('Upsell a customer',             'upsell'),
  ('Recover a failed payment',      'recover_failed_payment')
) AS v(name, type)
WHERE NOT EXISTS (
  SELECT 1 FROM "objectives" o
  WHERE o."tenant_id" = t."id" AND o."type" = v.type
);
