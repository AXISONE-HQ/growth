-- CreateEnum
CREATE TYPE "lead_assignment_posture" AS ENUM ('stay_unassigned', 'default_pipeline', 'escalate_to_human');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "ai_assignment_confidence_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
ADD COLUMN     "below_threshold_posture" "lead_assignment_posture" NOT NULL DEFAULT 'stay_unassigned',
ADD COLUMN     "default_assignment_pipeline_id" TEXT;

-- CreateTable
CREATE TABLE "assignment_rules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "pipeline_id" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignment_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assignment_rules_tenant_id_is_active_priority_idx" ON "assignment_rules"("tenant_id", "is_active", "priority");

-- CreateIndex
CREATE INDEX "assignment_rules_pipeline_id_idx" ON "assignment_rules"("pipeline_id");

-- AddForeignKey
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_rules" ADD CONSTRAINT "assignment_rules_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
