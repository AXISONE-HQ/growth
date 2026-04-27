/*
  Warnings:

  - You are about to drop the column `audience_conditions` on the `pipelines` table. All the data in the column will be lost.
  - You are about to drop the column `color` on the `pipelines` table. All the data in the column will be lost.
  - You are about to drop the column `sales_target` on the `pipelines` table. All the data in the column will be lost.
  - You are about to drop the column `source_type` on the `pipelines` table. All the data in the column will be lost.
  - You are about to drop the column `stages` on the `pipelines` table. All the data in the column will be lost.
  - You are about to drop the `pipeline_cards` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `objective_type` to the `pipelines` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "objective_type" AS ENUM ('warm_up_lead', 'book_appointment', 'buy_online', 'send_quote');

-- CreateEnum
CREATE TYPE "target_metric" AS ENUM ('appointments_booked', 'orders_placed', 'quotes_sent', 'replies_received', 'leads_qualified', 'revenue_dollars');

-- CreateEnum
CREATE TYPE "target_period" AS ENUM ('weekly', 'monthly', 'quarterly');

-- CreateEnum
CREATE TYPE "validator_type" AS ENUM ('tone', 'accuracy', 'hallucination', 'compliance', 'injection');

-- CreateEnum
CREATE TYPE "guardrail_severity" AS ENUM ('block', 'regenerate', 'warn', 'pass');

-- CreateEnum
CREATE TYPE "knowledge_category" AS ENUM ('company_info', 'products', 'warranty', 'shipping', 'financing', 'faqs');

-- DropForeignKey
ALTER TABLE "pipeline_cards" DROP CONSTRAINT "pipeline_cards_contact_id_fkey";

-- DropForeignKey
ALTER TABLE "pipeline_cards" DROP CONSTRAINT "pipeline_cards_pipeline_id_fkey";

-- DropForeignKey
ALTER TABLE "pipelines" DROP CONSTRAINT "pipelines_tenant_id_fkey";

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "current_pipeline_id" TEXT,
ADD COLUMN     "current_stage_id" TEXT,
ADD COLUMN     "entered_stage_at" TIMESTAMP(3),
ADD COLUMN     "micro_objective_progress" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "pipelines" DROP COLUMN "audience_conditions",
DROP COLUMN "color",
DROP COLUMN "sales_target",
DROP COLUMN "source_type",
DROP COLUMN "stages",
ADD COLUMN     "objective_description" TEXT,
ADD COLUMN     "objective_type" "objective_type" NOT NULL,
ADD COLUMN     "order" INTEGER NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE "pipeline_cards";

-- CreateTable
CREATE TABLE "stages" (
    "id" TEXT NOT NULL,
    "pipeline_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "is_initial" BOOLEAN NOT NULL DEFAULT false,
    "is_terminal" BOOLEAN NOT NULL DEFAULT false,
    "entry_actions" JSONB NOT NULL DEFAULT '[]',
    "transition_rules" JSONB NOT NULL DEFAULT '[]',
    "auto_approve_matrix" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "micro_objectives" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "completion_criteria" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "micro_objectives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_micro_objectives" (
    "pipeline_id" TEXT NOT NULL,
    "micro_objective_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "pipeline_micro_objectives_pkey" PRIMARY KEY ("pipeline_id","micro_objective_id")
);

-- CreateTable
CREATE TABLE "targets" (
    "id" TEXT NOT NULL,
    "pipeline_id" TEXT NOT NULL,
    "metric" "target_metric" NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "period" "target_period" NOT NULL,
    "current_progress" DECIMAL(14,2),
    "projection" DECIMAL(14,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardrails" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "pipeline_id" TEXT,
    "validator_type" "validator_type" NOT NULL,
    "severity_override" "guardrail_severity",
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guardrails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_filters" (
    "id" TEXT NOT NULL,
    "pipeline_id" TEXT NOT NULL,
    "knowledge_category" "knowledge_category" NOT NULL,
    "include_rule" JSONB NOT NULL DEFAULT '{}',
    "exclude_rule" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_filters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_stage_history" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "from_stage_id" TEXT,
    "to_stage_id" TEXT NOT NULL,
    "reason" TEXT,
    "decision_id" TEXT,
    "transitioned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_stage_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stages_pipeline_id_idx" ON "stages"("pipeline_id");

-- CreateIndex
CREATE INDEX "stages_pipeline_id_order_idx" ON "stages"("pipeline_id", "order");

-- CreateIndex
CREATE INDEX "micro_objectives_tenant_id_idx" ON "micro_objectives"("tenant_id");

-- CreateIndex
CREATE INDEX "micro_objectives_is_default_idx" ON "micro_objectives"("is_default");

-- CreateIndex
CREATE INDEX "pipeline_micro_objectives_micro_objective_id_idx" ON "pipeline_micro_objectives"("micro_objective_id");

-- CreateIndex
CREATE INDEX "targets_pipeline_id_idx" ON "targets"("pipeline_id");

-- CreateIndex
CREATE UNIQUE INDEX "targets_pipeline_id_metric_period_key" ON "targets"("pipeline_id", "metric", "period");

-- CreateIndex
CREATE INDEX "guardrails_tenant_id_idx" ON "guardrails"("tenant_id");

-- CreateIndex
CREATE INDEX "guardrails_tenant_id_pipeline_id_idx" ON "guardrails"("tenant_id", "pipeline_id");

-- CreateIndex
CREATE UNIQUE INDEX "guardrails_tenant_id_pipeline_id_validator_type_key" ON "guardrails"("tenant_id", "pipeline_id", "validator_type");

-- CreateIndex
CREATE INDEX "knowledge_filters_pipeline_id_idx" ON "knowledge_filters"("pipeline_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_filters_pipeline_id_knowledge_category_key" ON "knowledge_filters"("pipeline_id", "knowledge_category");

-- CreateIndex
CREATE INDEX "lead_stage_history_lead_id_idx" ON "lead_stage_history"("lead_id");

-- CreateIndex
CREATE INDEX "lead_stage_history_lead_id_transitioned_at_idx" ON "lead_stage_history"("lead_id", "transitioned_at");

-- CreateIndex
CREATE INDEX "lead_stage_history_to_stage_id_idx" ON "lead_stage_history"("to_stage_id");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_current_pipeline_id_idx" ON "contacts"("tenant_id", "current_pipeline_id");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_current_stage_id_idx" ON "contacts"("tenant_id", "current_stage_id");

-- CreateIndex
CREATE INDEX "pipelines_tenant_id_is_active_idx" ON "pipelines"("tenant_id", "is_active");

-- CreateIndex
CREATE INDEX "pipelines_tenant_id_objective_type_idx" ON "pipelines"("tenant_id", "objective_type");

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_current_pipeline_id_fkey" FOREIGN KEY ("current_pipeline_id") REFERENCES "pipelines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_current_stage_id_fkey" FOREIGN KEY ("current_stage_id") REFERENCES "stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stages" ADD CONSTRAINT "stages_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "micro_objectives" ADD CONSTRAINT "micro_objectives_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_micro_objectives" ADD CONSTRAINT "pipeline_micro_objectives_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_micro_objectives" ADD CONSTRAINT "pipeline_micro_objectives_micro_objective_id_fkey" FOREIGN KEY ("micro_objective_id") REFERENCES "micro_objectives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "targets" ADD CONSTRAINT "targets_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardrails" ADD CONSTRAINT "guardrails_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardrails" ADD CONSTRAINT "guardrails_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_filters" ADD CONSTRAINT "knowledge_filters_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_from_stage_id_fkey" FOREIGN KEY ("from_stage_id") REFERENCES "stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_to_stage_id_fkey" FOREIGN KEY ("to_stage_id") REFERENCES "stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_stage_history" ADD CONSTRAINT "lead_stage_history_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
