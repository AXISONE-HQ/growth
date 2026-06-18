-- KAN-1219 — Full-inventory crawler substrate (Slice 5 of KAN-1211 epic).
--
-- # Additive-only contract
--
-- ADDITIVE: 1 new enum + 1 new table + 2 indexes. No existing column/table
-- modified. Rollback: DROP TABLE crawl_jobs + DROP TYPE crawl_job_status.
--
-- # Status state machine (Memo 42 affordance-honesty)
--
-- pending → running → {completed, completed_with_errors, cancelled, failed}
--
-- completed_with_errors is distinct from completed: some URLs extracted
-- successfully, some failed. Operator UI surfaces both counters; the affordance
-- carries honest semantics (the inverse — collapsing both into completed —
-- would hide the failure tail that operators must triage).
--
-- # Index discipline (audit_log_pre_optimized memo)
--
-- 2 composite indexes:
--   - (tenant_id)         — operator-list of recent crawls for tenant
--   - (tenant_id, status) — concurrent-prevention check (Q4 — second
--                           startCrawl while status='running' rejects)
--
-- # error_samples cap
--
-- Array<{url, errorVariant, message}>, first 50 entries only. failed_count
-- carries the exact total; sampling bounds memory + payload size in PROD.
--
-- # Migration discipline (KAN-1080 lesson + KAN-1213/1212 precedent)
--
-- Hand-authored migration SQL (local dev DB unavailable). CI deploy-api
-- workflow runs `npx prisma migrate deploy` on first post-merge deploy.

-- CreateEnum
CREATE TYPE "crawl_job_status" AS ENUM ('pending', 'running', 'completed', 'completed_with_errors', 'cancelled', 'failed');

-- CreateTable
CREATE TABLE "crawl_jobs" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "listing_url" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "status" "crawl_job_status" NOT NULL DEFAULT 'pending',
    "discovered_count" INTEGER NOT NULL DEFAULT 0,
    "extracted_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_vin_duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "error_samples" JSONB,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crawl_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — (tenant_id) bulk scan fallback
CREATE INDEX "crawl_jobs_tenant_id_idx" ON "crawl_jobs"("tenant_id");

-- CreateIndex — (tenant_id, status) concurrent-prevention + list filtering
CREATE INDEX "crawl_jobs_tenant_id_status_idx" ON "crawl_jobs"("tenant_id", "status");

-- AddForeignKey — Cascade mirrors sibling tenant-scoped models (vehicles,
-- products, campaigns). Crawl job is a tenant-owned operational entity.
ALTER TABLE "crawl_jobs" ADD CONSTRAINT "crawl_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
