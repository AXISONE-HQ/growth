-- KAN-940 + KAN-946 — Add `deleted_at` soft-delete columns to `deals` + `orders`.
--
-- Soft-delete symmetry across canonical CRUD entities: Company already has
-- `deleted_at` (KAN-879); Contact ships with the `lifecycleStage` model and
-- doesn't soft-delete; Deal + Order are added here. Together, the canonical
-- entities now share consistent soft-delete semantics for manual-CRUD
-- updates (triple-guard: id + tenantId + deletedAt IS NULL).
--
-- Migration safety:
-- - Both ADD COLUMN statements add a NULLABLE TIMESTAMP(3) — non-destructive
-- - AccessExclusiveLock acquired for metadata only; no row rewrites
-- - Instant on Postgres 15+; existing rows get deleted_at = NULL by default
-- - No backfill needed (NULL = "not soft-deleted" semantically)
--
-- Service-side updates (in this PR):
-- - listDeals / listOrders: add `where: { deletedAt: null }` to default filter
-- - getDealById / getOrderById: keep returning tombstones (audit-trail
--   parity with getCompanyById)
-- - updateDeal / updateOrder: triple-guard (id + tenantId + deletedAt: null)
--   in the findFirst existence check
--
-- No index added — matches Company's pattern (Company doesn't index
-- deletedAt either). If list-filter perf becomes a concern, the
-- `@@index([tenantId, deletedAt])` pattern from KnowledgeChunk/KnowledgeSource
-- is the precedent.

-- AlterTable
ALTER TABLE "deals" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "deleted_at" TIMESTAMP(3);
