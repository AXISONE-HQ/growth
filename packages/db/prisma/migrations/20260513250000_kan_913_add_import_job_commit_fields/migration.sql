-- CreateEnum
CREATE TYPE "import_commit_status" AS ENUM ('pending', 'running', 'succeeded', 'partial', 'failed');

-- AlterTable
ALTER TABLE "import_jobs" ADD COLUMN     "commit_completed_at" TIMESTAMP(3),
ADD COLUMN     "commit_errors" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "commit_started_at" TIMESTAMP(3),
ADD COLUMN     "commit_status" "import_commit_status" NOT NULL DEFAULT 'pending',
ADD COLUMN     "committed_row_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failed_row_count" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "import_jobs_tenant_id_commit_status_idx" ON "import_jobs"("tenant_id", "commit_status");
