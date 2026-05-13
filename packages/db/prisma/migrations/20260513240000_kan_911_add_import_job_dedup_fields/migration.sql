
-- AlterTable
ALTER TABLE "import_jobs" ADD COLUMN     "dedup_candidates_count" INTEGER,
ADD COLUMN     "dedup_completed_at" TIMESTAMP(3),
ADD COLUMN     "dedup_confirmed_at" TIMESTAMP(3),
ADD COLUMN     "dedup_counts" JSONB,
ADD COLUMN     "dedup_error" TEXT,
ADD COLUMN     "dedup_error_at" TIMESTAMP(3),
ADD COLUMN     "dedup_started_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "import_jobs_tenant_id_dedup_confirmed_at_idx" ON "import_jobs"("tenant_id", "dedup_confirmed_at");

