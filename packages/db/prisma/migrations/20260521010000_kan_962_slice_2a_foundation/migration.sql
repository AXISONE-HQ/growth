-- KAN-962 — Slice 2a foundation (PR A, additive only)
--
-- Three additive constructs (no destructive steps):
--   1. PipelineSegment enum + Pipeline.segment nullable column
--   2. TenantObjectiveSelection table — tenant-level prioritized declaration
--   3. CustomerLifecycleEvent table — append-only audit (writer in PR B)
--
-- Migration is no-op safe at deploy time:
--   - Existing pipelines stay segment=NULL (the KAN-702 fixture and any
--     hand-rolled rows). Tier 1.5 routing in PR B filters on segment=new_leads,
--     so legacy NULLs never match the primary-objective short-circuit and the
--     existing pipeline path continues to work for the no-declaration case.
--   - TenantObjectiveSelection starts empty. Nothing reads it until PR B's
--     routing tier 1.5 + UI ship; until then, every read returns zero rows
--     and falls through to the existing tiers.
--   - CustomerLifecycleEvent starts empty. The PR B writer hook is the only
--     code path that touches it.

-- ─────────────────────────────────────────────────────────────────────
-- 1. PipelineSegment enum + Pipeline.segment column
-- ─────────────────────────────────────────────────────────────────────

CREATE TYPE "pipeline_segment" AS ENUM (
  'new_leads',
  'winback',
  'closed_lost_recovery',
  'cancelled_orders_recovery',
  'inactive_customers_reengagement',
  'other'
);

ALTER TABLE "pipelines" ADD COLUMN "segment" "pipeline_segment";

CREATE INDEX "pipelines_tenant_id_objective_id_segment_idx"
  ON "pipelines" ("tenant_id", "objective_id", "segment");

-- ─────────────────────────────────────────────────────────────────────
-- 2. TenantObjectiveSelection
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "tenant_objective_selection" (
  "id"            TEXT                      NOT NULL,
  "tenant_id"     TEXT                      NOT NULL,
  "objective_id"  TEXT                      NOT NULL,
  "entity_scope"  "objective_entity_scope"  NOT NULL,
  "priority"      INTEGER                   NOT NULL,
  "status"        TEXT                      NOT NULL DEFAULT 'selected',
  "adopted_at"    TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"    TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3)              NOT NULL,

  CONSTRAINT "tenant_objective_selection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_objective_selection_tenant_id_objective_id_entity_scope_key"
  ON "tenant_objective_selection" ("tenant_id", "objective_id", "entity_scope");

CREATE INDEX "tenant_objective_selection_tenant_id_entity_scope_priority_idx"
  ON "tenant_objective_selection" ("tenant_id", "entity_scope", "priority");

CREATE INDEX "tenant_objective_selection_tenant_id_status_idx"
  ON "tenant_objective_selection" ("tenant_id", "status");

ALTER TABLE "tenant_objective_selection"
  ADD CONSTRAINT "tenant_objective_selection_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_objective_selection"
  ADD CONSTRAINT "tenant_objective_selection_objective_id_fkey"
  FOREIGN KEY ("objective_id") REFERENCES "objectives" ("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────
-- 3. CustomerLifecycleEvent
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "customer_lifecycle_event" (
  "id"           TEXT          NOT NULL,
  "tenant_id"    TEXT          NOT NULL,
  "contact_id"   TEXT          NOT NULL,
  "customer_id"  TEXT,
  "event_type"   TEXT          NOT NULL,
  "from_status"  TEXT,
  "to_status"    TEXT,
  "source"       TEXT          NOT NULL,
  "metadata"     JSONB         NOT NULL DEFAULT '{}',
  "recorded_at"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "customer_lifecycle_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_lifecycle_event_tenant_id_contact_id_recorded_at_idx"
  ON "customer_lifecycle_event" ("tenant_id", "contact_id", "recorded_at");

CREATE INDEX "customer_lifecycle_event_tenant_id_event_type_recorded_at_idx"
  ON "customer_lifecycle_event" ("tenant_id", "event_type", "recorded_at");

ALTER TABLE "customer_lifecycle_event"
  ADD CONSTRAINT "customer_lifecycle_event_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "customer_lifecycle_event"
  ADD CONSTRAINT "customer_lifecycle_event_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
