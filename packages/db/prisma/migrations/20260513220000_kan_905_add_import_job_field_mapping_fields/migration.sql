
-- AlterTable
ALTER TABLE "import_jobs" ADD COLUMN     "field_mapping_completed_at" TIMESTAMP(3),
ADD COLUMN     "field_mapping_confidence" INTEGER,
ADD COLUMN     "field_mapping_confirmed_at" TIMESTAMP(3),
ADD COLUMN     "field_mapping_error" TEXT,
ADD COLUMN     "field_mapping_error_at" TIMESTAMP(3),
ADD COLUMN     "field_mapping_input_tokens" INTEGER,
ADD COLUMN     "field_mapping_llm_model" TEXT,
ADD COLUMN     "field_mapping_output_tokens" INTEGER,
ADD COLUMN     "field_mapping_reasoning" TEXT,
ADD COLUMN     "field_mapping_started_at" TIMESTAMP(3),
ADD COLUMN     "field_mappings" JSONB;

-- CreateIndex
CREATE INDEX "import_jobs_tenant_id_field_mapping_confirmed_at_idx" ON "import_jobs"("tenant_id", "field_mapping_confirmed_at");

