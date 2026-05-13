-- CreateEnum
CREATE TYPE "detected_entity_type" AS ENUM ('contacts', 'companies', 'deals', 'orders', 'mixed', 'unknown');


-- AlterTable
ALTER TABLE "import_jobs" ADD COLUMN     "detected_entity_type" "detected_entity_type",
ADD COLUMN     "detection_completed_at" TIMESTAMP(3),
ADD COLUMN     "detection_confidence" INTEGER,
ADD COLUMN     "detection_error" TEXT,
ADD COLUMN     "detection_error_at" TIMESTAMP(3),
ADD COLUMN     "detection_input_tokens" INTEGER,
ADD COLUMN     "detection_llm_model" TEXT,
ADD COLUMN     "detection_output_tokens" INTEGER,
ADD COLUMN     "detection_reasoning" TEXT,
ADD COLUMN     "detection_started_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "import_jobs_tenant_id_detected_entity_type_idx" ON "import_jobs"("tenant_id", "detected_entity_type");

