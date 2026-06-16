-- KAN-1213 — Product Catalog Module substrate (Slice 1 of KAN-1212 epic).
--
-- # Additive-only contract
--
-- This migration is ADDITIVE: one new enum, one new table, four new indexes.
-- No existing column/table is modified. Rollback is clean (DROP TABLE
-- products + DROP TYPE product_status reverses; the Tenant back-relation is
-- pure Prisma-client-side and has no DB-level FK reference to undo).
--
-- # Money column discipline (codebase_precedent_over_external_convention memo)
--
-- price + currency mirror deals.value (Decimal(12,2)) and orders.{total_amount,
-- tax_amount, discount_amount, grand_total}. Avoids per-entity money fork;
-- multi-currency convergence (KAN-1132 deferred) happens at the trio
-- simultaneously, NOT here in Slice 1. SPO Phase 1 pre-leaned Int cents
-- (Stripe convention); CC empirical inventory across 4 sibling money columns
-- refuted; codebase precedent wins.
--
-- # Index discipline (audit_log_table_pre_optimized_for_tier_2_aggregation memo)
--
-- 4 composite indexes land queries pre-optimized for the Slice-N list-view
-- aggregation patterns:
--
--   - (tenant_id)               — bulk tenant scans (rare; fallback)
--   - (tenant_id, status)       — status-filtered list queries (Slice 2/3)
--   - (tenant_id, name)         — name search/sort (alphabetical, prefix-LIKE)
--   - (tenant_id, external_url) — scrape-UX dedup (KAN-1223 consumer)
--
-- # Soft-delete pattern
--
-- archived_at nullable timestamp mirrors campaigns.archived_at and
-- orders.deleted_at. status='archived' is the queryable enum state;
-- archived_at is the timestamp companion. list-view excludes archived by
-- default (Q-ADD-11 lock; deferred to KAN-1216 service module).
--
-- # FK upgrade deferral (KAN-1225)
--
-- campaigns.goal_product_id (added in KAN-1167) is a soft pointer with NO
-- DB-level FK constraint to products(id). Intentional — KAN-1167 deferred
-- the FK so the Product model could land in its own slice (this one).
-- KAN-1225 upgrades that pointer to a real FK once the catalog has
-- stabilized through KAN-1216 (full CRUD) + KAN-1223 (scrape UX).
--
-- # Migration discipline (KAN-1080 lesson + KAN-1140 PR 6 pattern + KAN-1182 anchor)
--
-- Hand-authored migration SQL since local dev DB is unavailable; CI
-- deploy-api workflow runs `npx prisma migrate deploy` on first post-merge
-- deploy. Shape mirrors recent KAN-1167 / KAN-1182 / KAN-1200 migrations.

-- CreateEnum
CREATE TYPE "product_status" AS ENUM ('draft', 'active', 'archived');

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "product_status" NOT NULL DEFAULT 'draft',
    "price" DECIMAL(12,2),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "external_url" TEXT,
    "primary_image_url" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — (tenant_id) bulk scan fallback
CREATE INDEX "products_tenant_id_idx" ON "products"("tenant_id");

-- CreateIndex — (tenant_id, status) status-filtered list queries
CREATE INDEX "products_tenant_id_status_idx" ON "products"("tenant_id", "status");

-- CreateIndex — (tenant_id, name) alphabetical sort + prefix search
CREATE INDEX "products_tenant_id_name_idx" ON "products"("tenant_id", "name");

-- CreateIndex — (tenant_id, external_url) scrape-UX dedup (KAN-1223 consumer)
CREATE INDEX "products_tenant_id_external_url_idx" ON "products"("tenant_id", "external_url");

-- AddForeignKey — Cascade mirrors sibling tenant-scoped models (campaigns,
-- orders, deals). Product is a tenant-owned asset; tenant deletion (rare)
-- takes the catalog with it.
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
