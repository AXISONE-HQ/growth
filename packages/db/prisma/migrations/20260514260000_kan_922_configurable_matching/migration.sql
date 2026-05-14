-- KAN-922 — Cohort 2.5 — Configurable Field Matching.
--
-- ImportJob: 4 nullable String columns capturing per-import match
-- configuration. NULL falls back to the KAN-911 heuristic (email →
-- phone → fuzzy) so existing imports and pre-cohort code paths
-- continue working unchanged.
--
-- import_staging_*: external_ids JSONB mirror columns. Populated by
-- KAN-915's runDuplicateDetection back-fill from sourceRowData ×
-- fieldMappings × externalSourceTag. Inherits the KAN-915 lazy-cache
-- discipline ("DO NOT read upstream of runDuplicateDetection").
--
-- No new indexes. Per Phase 1 §F locked decision, JSON expression
-- indexes deferred to KAN-925 — single-tenant scans under 10K rows
-- remain acceptable; add when a tenant crosses that ceiling.
--
-- Migration safety: 9 ADD COLUMN statements; all acquire
-- AccessExclusiveLock for metadata only (no row rewrites). Instant on
-- Postgres 15+. Confirmed safe per Phase 1 §F.

-- AlterTable
ALTER TABLE "import_jobs"
  ADD COLUMN "dedup_match_field" TEXT,
  ADD COLUMN "external_source_tag" TEXT,
  ADD COLUMN "customer_link_field" TEXT,
  ADD COLUMN "deal_link_field" TEXT;

-- AlterTable
ALTER TABLE "import_staging_contacts"
  ADD COLUMN "external_ids" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "import_staging_companies"
  ADD COLUMN "external_ids" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "import_staging_deals"
  ADD COLUMN "external_ids" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "import_staging_orders"
  ADD COLUMN "external_ids" JSONB NOT NULL DEFAULT '{}';
