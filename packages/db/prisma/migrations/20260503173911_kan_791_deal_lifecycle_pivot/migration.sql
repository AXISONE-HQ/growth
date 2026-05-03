-- KAN-791 — Deal-as-Lifecycle pivot.
-- See docs/prds/phase-1-deal-engagement.md §3 (canonical PRD on main)
-- + docs/memories/feedback_prd_assumed_infrastructure_check_kan_786.md
--
-- KAN-787 workaround applied: stripped spurious
--   DROP INDEX "knowledge_chunks_embedding_hnsw_idx"
-- which Prisma's diff produces because schema.prisma can't represent the
-- pgvector HNSW index. Index is recreated locally post-migration to match
-- prod state.
--
-- Empirical pre-flight verifications (2026-05-03):
--   Contact.microObjectiveProgress drop verified safe — 0 prod contacts
--     had non-default values (pre-flight #4, fresh-proxy query, kill-immediate)
--   deals + engagements + lead_stage_history all 0 rows in prod + local —
--     NOT NULL column adds (current_stage_id / pipeline_id / deal_id) safe
--

-- CreateEnum
CREATE TYPE "stage_outcome_type" AS ENUM ('open', 'terminal_won', 'terminal_lost');

-- DropForeignKey
ALTER TABLE "lead_stage_history" DROP CONSTRAINT "lead_stage_history_decision_id_fkey";

-- DropForeignKey
ALTER TABLE "lead_stage_history" DROP CONSTRAINT "lead_stage_history_from_stage_id_fkey";

-- DropForeignKey
ALTER TABLE "lead_stage_history" DROP CONSTRAINT "lead_stage_history_lead_id_fkey";

-- DropForeignKey
ALTER TABLE "lead_stage_history" DROP CONSTRAINT "lead_stage_history_to_stage_id_fkey";

-- DropIndex
DROP INDEX "deals_tenant_id_status_idx";


-- AlterTable
ALTER TABLE "contacts" DROP COLUMN "micro_objective_progress";

-- AlterTable
ALTER TABLE "deals" DROP COLUMN "closed_at",
DROP COLUMN "status",
ADD COLUMN     "current_stage_id" TEXT NOT NULL,
ADD COLUMN     "entered_stage_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "micro_objective_progress" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "pipeline_id" TEXT NOT NULL,
ALTER COLUMN "value" SET NOT NULL,
ALTER COLUMN "value" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "engagements" ADD COLUMN     "deal_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "stages" ADD COLUMN     "follow_up_cadence" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "outcome_type" "stage_outcome_type" NOT NULL DEFAULT 'open';

-- DropTable
DROP TABLE "lead_stage_history";

-- DropEnum
DROP TYPE "deal_status";

-- CreateTable
CREATE TABLE "deal_stage_history" (
    "id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "from_stage_id" TEXT,
    "to_stage_id" TEXT NOT NULL,
    "transitioned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triggered_by" TEXT NOT NULL,
    "decision_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "deal_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deal_stage_history_deal_id_transitioned_at_idx" ON "deal_stage_history"("deal_id", "transitioned_at");

-- CreateIndex
CREATE INDEX "deal_stage_history_to_stage_id_idx" ON "deal_stage_history"("to_stage_id");

-- CreateIndex
CREATE INDEX "deal_stage_history_decision_id_idx" ON "deal_stage_history"("decision_id");

-- CreateIndex
CREATE INDEX "deals_tenant_id_current_stage_id_idx" ON "deals"("tenant_id", "current_stage_id");

-- CreateIndex
CREATE INDEX "deals_tenant_id_pipeline_id_idx" ON "deals"("tenant_id", "pipeline_id");

-- CreateIndex
CREATE INDEX "engagements_tenant_id_deal_id_occurred_at_idx" ON "engagements"("tenant_id", "deal_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_current_stage_id_fkey" FOREIGN KEY ("current_stage_id") REFERENCES "stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_from_stage_id_fkey" FOREIGN KEY ("from_stage_id") REFERENCES "stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_to_stage_id_fkey" FOREIGN KEY ("to_stage_id") REFERENCES "stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- KAN-791 invariant: at most one isInitial Stage per Pipeline.
-- Prisma's @@unique doesn't natively support partial indexes; raw SQL appended
-- per PRD §3. Required by lazy-bootstrap helper (KAN-793) + Track A consumer.
CREATE UNIQUE INDEX "stages_one_initial_per_pipeline_idx"
  ON "stages" ("pipeline_id") WHERE "is_initial" = true;
