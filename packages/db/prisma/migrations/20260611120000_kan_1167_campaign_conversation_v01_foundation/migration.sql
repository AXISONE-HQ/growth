-- KAN-1167 — Campaign-as-Conversation v0.1 foundation.
--
-- Pure additive migration. No drops, no destructive ALTERs, no data
-- manipulation. Backfill (Always-On Campaign per tenant + Pipeline.campaign_id
-- assignment for orphans) is a SEPARATE script run post-deploy
-- (packages/db/scripts/backfill-kan-1167-always-on-and-pipelines.ts), not
-- folded into the migration itself (Memo 32 family: keeps migration recoverable).
--
-- # Identifier convention — snake_case per existing schema @map directives
--
-- All table + column identifiers below use snake_case because the Prisma
-- schema uses @@map / @map to project the (camelCase) Prisma model + field
-- names onto (snake_case) Postgres identifiers. Matches the convention
-- established in sibling migrations (e.g. 20260609184740_kan_1140_phase_3_pr_9a_parse_rules).
--
-- # Three structural changes
--
-- 1. Campaign table — 13 new nullable columns + 1 non-null-with-default + 1 new index
--    Outcome-goal fields (goal_*) — populated by setGoal procedure (PR 1) and
--    feasibility analyzer (PR 2+).
--    AI counsel snapshots (feasibility_analysis, proposed_plan, committed_plan,
--    override_history) — populated by PR 2 (analyzer) + PR 6 (overrides).
--    Drift state (last_confidence_*, drift_threshold) — populated by PR 7 cron.
--    is_always_on — per-tenant catch-all marker (Q1 lock); index for lookup.
--    conversation_thread_id — chat thread linkage (PR 3).
--
-- 2. Pipeline table — 2 new nullable columns (motion + projected_contribution)
--    for multi-Pipeline orchestration (PR 5).
--
-- 3. campaign_conversation_turns table — NEW. Persisted chat thread per
--    Campaign (PR 3 renders). Cascade on Campaign delete; indexed for
--    chronological lookup.
--
-- # No Pipeline.campaign_id schema change
--
-- Pipeline.campaign_id is already nullable (KAN-1001 Slice 0). Application-level
-- guards in pipelinesRouter.create + update enforce required-ness post-backfill
-- (closes Q-ADD-PIPELINE-FK-NULLABLE-WINDOW from Phase 1 trace).

-- AlterTable — Campaign (13 new columns)
ALTER TABLE "campaigns" ADD COLUMN "goal_type" TEXT,
ADD COLUMN "goal_target" INTEGER,
ADD COLUMN "goal_product_id" TEXT,
ADD COLUMN "goal_description" TEXT,
ADD COLUMN "feasibility_analysis" JSONB,
ADD COLUMN "proposed_plan" JSONB,
ADD COLUMN "committed_plan" JSONB,
ADD COLUMN "override_history" JSONB,
ADD COLUMN "last_confidence_check" TIMESTAMP(3),
ADD COLUMN "last_confidence_value" DOUBLE PRECISION,
ADD COLUMN "drift_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.20,
ADD COLUMN "is_always_on" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "conversation_thread_id" TEXT;

-- AlterTable — Pipeline (2 new columns for multi-motion orchestration)
ALTER TABLE "pipelines" ADD COLUMN "motion" TEXT,
ADD COLUMN "projected_contribution" INTEGER;

-- CreateTable — campaign_conversation_turns
CREATE TABLE "campaign_conversation_turns" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "turn_type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "proposal_snapshot" JSONB,
    "data_request" JSONB,
    "data_ingestion_event" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_conversation_turns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — Campaign efficient Always-On lookup per tenant
CREATE INDEX "campaigns_tenant_id_is_always_on_idx" ON "campaigns"("tenant_id", "is_always_on");

-- CreateIndex — campaign_conversation_turns chronological lookup
CREATE INDEX "campaign_conversation_turns_campaign_id_created_at_idx" ON "campaign_conversation_turns"("campaign_id", "created_at");

-- CreateIndex — campaign_conversation_turns tenant-scoped chronological lookup
CREATE INDEX "campaign_conversation_turns_tenant_id_created_at_idx" ON "campaign_conversation_turns"("tenant_id", "created_at");

-- AddForeignKey — campaign_conversation_turns → campaigns (CASCADE)
-- Cascade is correct here: when a Campaign is deleted, its conversation turns
-- have no standalone meaning. (Soft archive via Campaign.archivedAt does NOT
-- delete the row, so conversation history is preserved on archive — only hard
-- delete cascades.)
ALTER TABLE "campaign_conversation_turns" ADD CONSTRAINT "campaign_conversation_turns_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
