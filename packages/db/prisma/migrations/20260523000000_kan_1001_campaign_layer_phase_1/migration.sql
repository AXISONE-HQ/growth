-- KAN-1001 — Campaign Layer Slice 0 Phase 1 (additive only)
--
-- Architect/PO greenlit per the Campaign Layer epic (KAN-996). Two-table
-- model: Campaign owns intent (audience + objective + window + status +
-- priority); Pipeline keeps stage structure + gains a nullable
-- campaign_id back-link.
--
-- Phase 1 is purely additive — NO destructive steps, NO existing-data
-- mutations in THIS file. Readers (lead-assignment Tier 1.5) continue
-- to read Pipeline.objectiveId + Pipeline.segment unchanged. Phase 2
-- (separate ticket, later) cuts routing to Campaign + drops the
-- Pipeline columns.
--
-- Migration is no-op safe at deploy time:
--   - All new tables start empty. CampaignMembership joins existing
--     contacts but creates zero rows in this migration; Slice 3 commit
--     flow + Slice 5 dynamic-mode cron are the writers.
--   - Pipeline.campaign_id starts NULL on every row. The backfill SQL
--     (separate file: backfill.sql in this directory) populates
--     campaign_id + creates one Campaign per objective-bound Pipeline
--     AFTER this migration applies, AFTER PO eyeball of the pre-flight
--     rowcount + sample-render.
--   - ContactObjectiveStack.campaign_id starts NULL on every row;
--     Slice 3 populates it for new stack entries created from Campaign
--     activation. Existing rows continue to work via the un-namespaced
--     priority logic (no reader currently joins through campaign_id).
--   - Indexes added are all on the new columns/tables, no rewrite of
--     existing index pages.
--
-- Reuse insight: audience_conditions JSONB shape = the
-- AudienceConditionsSchema that Slice 1 (KAN-997) shipped in
-- @growth/shared (PAIRS-tested enums after KAN-1000 fix-forward).
-- Text-to-segment / propose write the same JSONB a future manual
-- condition-builder would. Single storage format, single query engine.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Campaign-layer enums (4 new types)
-- ─────────────────────────────────────────────────────────────────────

-- 4 user-facing strategies. The backend StrategyType enum has 6 values
-- (direct/re_engage/trust_build/guided/escalate/wait) but escalate +
-- wait are decision-engine control-flow primitives, not campaign
-- strategies. Slice 2 LLM is constrained to these 4.
CREATE TYPE "campaign_strategy" AS ENUM (
  'direct',
  're_engage',
  'trust_build',
  'guided'
);

CREATE TYPE "campaign_audience_mode" AS ENUM (
  'static',   -- materialize matching contacts once at activation
  'dynamic'   -- re-evaluate on Slice 5 cron, append new admits
);

CREATE TYPE "campaign_status" AS ENUM (
  'draft',
  'active',
  'completed',
  'archived'
);

CREATE TYPE "campaign_member_source" AS ENUM (
  'snapshot',       -- populated at static activation
  'dynamic_admit'   -- appended by Slice 5 cron
);

-- ─────────────────────────────────────────────────────────────────────
-- 2. campaigns table
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "campaigns" (
  "id"                                  TEXT                       NOT NULL,
  "tenant_id"                           TEXT                       NOT NULL,
  "name"                                TEXT                       NOT NULL,
  "nl_intent"                           TEXT,
  "objective_id"                        TEXT                       NOT NULL,
  "strategy"                            "campaign_strategy",
  "audience_conditions"                 JSONB                      NOT NULL,
  "audience_mode"                       "campaign_audience_mode"   NOT NULL DEFAULT 'static',
  "audience_evaluated_at"               TIMESTAMP(3),
  "audience_snapshot_count"             INTEGER,
  "historical_value_usd_at_activation"  DECIMAL(14, 2),
  "window_start"                        TIMESTAMP(3),
  "window_end"                          TIMESTAMP(3),
  "status"                              "campaign_status"          NOT NULL DEFAULT 'draft',
  "priority"                            INTEGER                    NOT NULL DEFAULT 100,
  "activated_at"                        TIMESTAMP(3),
  "completed_at"                        TIMESTAMP(3),
  "archived_at"                         TIMESTAMP(3),
  "created_by_user_id"                  TEXT,
  "created_at"                          TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                          TIMESTAMP(3)               NOT NULL,

  CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "campaigns_tenant_id_status_idx"
  ON "campaigns" ("tenant_id", "status");

CREATE INDEX "campaigns_tenant_id_objective_id_idx"
  ON "campaigns" ("tenant_id", "objective_id");

-- Slice 5 dynamic-mode cron filter (pick active+dynamic campaigns due
-- for re-eval; cheap composite index).
CREATE INDEX "campaigns_tenant_id_status_audience_mode_idx"
  ON "campaigns" ("tenant_id", "status", "audience_mode");

ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict — you can't drop an Objective with live Campaigns hanging
-- off it. Mirrors TenantObjectiveSelection.objective relation posture.
ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_objective_id_fkey"
    FOREIGN KEY ("objective_id") REFERENCES "objectives"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────
-- 3. campaign_membership table
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "campaign_membership" (
  "id"            TEXT                      NOT NULL,
  "tenant_id"     TEXT                      NOT NULL,
  "campaign_id"   TEXT                      NOT NULL,
  "contact_id"    TEXT                      NOT NULL,
  "source"        "campaign_member_source"  NOT NULL,
  "joined_at"     TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "exited_at"     TIMESTAMP(3),
  "exit_reason"   TEXT,

  CONSTRAINT "campaign_membership_pkey" PRIMARY KEY ("id")
);

-- One row per (campaign, contact). Re-admit after exit reuses the
-- row + updates exitedAt/exitReason rather than creating a duplicate.
CREATE UNIQUE INDEX "campaign_membership_campaign_id_contact_id_key"
  ON "campaign_membership" ("campaign_id", "contact_id");

CREATE INDEX "campaign_membership_tenant_id_campaign_id_idx"
  ON "campaign_membership" ("tenant_id", "campaign_id");

CREATE INDEX "campaign_membership_tenant_id_contact_id_idx"
  ON "campaign_membership" ("tenant_id", "contact_id");

ALTER TABLE "campaign_membership"
  ADD CONSTRAINT "campaign_membership_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "campaign_membership"
  ADD CONSTRAINT "campaign_membership_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "campaign_membership"
  ADD CONSTRAINT "campaign_membership_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Pipeline.campaign_id (nullable, additive)
-- ─────────────────────────────────────────────────────────────────────

-- Backfill (separate file) populates this for every objective-bound
-- Pipeline. Phase 2 (separate ticket) makes it the primary objective-
-- resolution path + drops Pipeline.objective_id / objective_type /
-- segment columns. Until then: dual-read, no reader churn.
ALTER TABLE "pipelines"
  ADD COLUMN "campaign_id" TEXT;

ALTER TABLE "pipelines"
  ADD CONSTRAINT "pipelines_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "pipelines_campaign_id_idx"
  ON "pipelines" ("campaign_id");

-- ─────────────────────────────────────────────────────────────────────
-- 5. ContactObjectiveStack.campaign_id (nullable, additive)
-- ─────────────────────────────────────────────────────────────────────

-- Slice 3 commit flow populates this for new stack entries created from
-- a Campaign activation. Existing rows stay NULL — they predate Campaign
-- and continue working via the un-namespaced priority logic. No reader
-- currently joins through campaign_id; that lands in Slice 3+.
ALTER TABLE "contact_objective_stack"
  ADD COLUMN "campaign_id" TEXT;

ALTER TABLE "contact_objective_stack"
  ADD CONSTRAINT "contact_objective_stack_campaign_id_fkey"
    FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "contact_objective_stack_tenant_id_campaign_id_priority_idx"
  ON "contact_objective_stack" ("tenant_id", "campaign_id", "priority");
