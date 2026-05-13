-- KAN-896 — Ingestion Cohort 2.1a (upload backend foundation)
--
-- PR 1 of 8 in the Cohort 2 ingestion pipeline. Net-new, pure additive
-- schema: 3 enums + 1 table (ImportJob) + 2 FKs to tenants/users.
--
-- No data backfill required (no existing rows). Tenant.imports[] and
-- User.imports[] are Prisma-side virtual relations only; no SQL change.
--
-- Spurious `DROP INDEX knowledge_chunk_embedding_hnsw_idx` stripped from
-- the prisma migrate diff output (KAN-786/KAN-787 pgvector drift; see
-- memory feedback_prisma_vector_index_silent_drop_drift).

-- CreateEnum
CREATE TYPE "import_mode" AS ENUM ('replace_all', 'update_add');

-- CreateEnum
CREATE TYPE "import_status" AS ENUM ('awaiting_upload', 'uploaded', 'inspecting', 'inspected', 'failed');

-- CreateEnum
CREATE TYPE "import_file_type" AS ENUM ('csv', 'xlsx', 'unknown');

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "file_mime_type" TEXT NOT NULL,
    "gcs_object_path" TEXT NOT NULL,
    "mode" "import_mode" NOT NULL DEFAULT 'update_add',
    "status" "import_status" NOT NULL DEFAULT 'awaiting_upload',
    "detected_file_type" "import_file_type",
    "detected_row_count" INTEGER,
    "detected_column_count" INTEGER,
    "detected_headers" JSONB,
    "sample_rows" JSONB,
    "error_message" TEXT,
    "error_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "upload_confirmed_at" TIMESTAMP(3),
    "inspection_started_at" TIMESTAMP(3),
    "inspection_completed_at" TIMESTAMP(3),

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_jobs_tenant_id_status_idx" ON "import_jobs"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "import_jobs_tenant_id_created_at_idx" ON "import_jobs"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "import_jobs_created_by_user_id_idx" ON "import_jobs"("created_by_user_id");

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
