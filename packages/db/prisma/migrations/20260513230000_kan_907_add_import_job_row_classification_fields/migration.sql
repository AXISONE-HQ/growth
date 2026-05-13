
-- AlterTable
ALTER TABLE "import_jobs" ADD COLUMN     "row_classification_completed_at" TIMESTAMP(3),
ADD COLUMN     "row_classification_confirmed_at" TIMESTAMP(3),
ADD COLUMN     "row_classification_counts" JSONB,
ADD COLUMN     "row_classification_error" TEXT,
ADD COLUMN     "row_classification_error_at" TIMESTAMP(3),
ADD COLUMN     "row_classification_input_tokens" INTEGER,
ADD COLUMN     "row_classification_llm_model" TEXT,
ADD COLUMN     "row_classification_output_tokens" INTEGER,
ADD COLUMN     "row_classification_started_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "import_jobs_tenant_id_row_classification_confirmed_at_idx" ON "import_jobs"("tenant_id", "row_classification_confirmed_at");

