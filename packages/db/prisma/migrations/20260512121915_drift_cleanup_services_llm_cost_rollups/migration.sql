-- Pre-existing schema-vs-DB drift cleanup. Split out of KAN-879 so the
-- CRM-core migration stays scoped to its ticket.
--
-- Both items are pure CATALOG-only metadata changes (zero data impact, zero
-- query-plan impact, zero application behavior change).
--
-- 1. services.included_items / services.excluded_items — DROP DEFAULT.
--    Origin: KAN-850 (Services first-class). The original migration
--    `20260508220000_kan_xxx_services_first_class` created these NOT NULL
--    TEXT[] columns with `DEFAULT ARRAY[]::TEXT[]`, but the schema.prisma
--    declares them without `@default`. Existing rows are unaffected; future
--    INSERTs must specify these columns explicitly (which all live writers
--    in `packages/api/src/services/services.ts` already do).
--
-- 2. llm_cost_rollups unique index rename — character-truncation drift.
--    Origin: KAN-745 (LLM cost rollups). The original migration declared a
--    64-char index name (`..._pri_key`) that Postgres silently truncated to
--    63 chars. The Prisma client now generates a 63-char target form
--    (`..._pr_key`). Pure rename — no rebuild, no plan invalidation.

ALTER TABLE "services"
  ALTER COLUMN "included_items" DROP DEFAULT,
  ALTER COLUMN "excluded_items" DROP DEFAULT;

ALTER INDEX "llm_cost_rollups_tenant_id_hour_bucket_caller_tag_prefix_pri_ke"
  RENAME TO "llm_cost_rollups_tenant_id_hour_bucket_caller_tag_prefix_pr_key";
