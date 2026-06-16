-- KAN-1214 — ProductVariant substrate (Slice 1 PR 2 of KAN-1212 epic).
--
-- # Additive-only contract
--
-- This migration is ADDITIVE: one new table, two new indexes, two FKs. No
-- existing column/table is modified. Rollback is clean (DROP TABLE
-- product_variants reverses; the Product.variants and Tenant.productVariants
-- back-relations are Prisma-client-side only with no DB-level reference).
--
-- # Differential-semantic doctrine (Memo 43)
--
-- `price DECIMAL(12,2)` on product_variants is IDENTICAL SQL shape to
-- `price` on products (KAN-1213). But the application-layer semantic of NULL
-- differs by model:
--   - products.price IS NULL        — "no price set; unpriced"
--   - product_variants.price IS NULL — "inherit from parent products.price at runtime"
-- Service-layer KAN-1216 implements the resolution rule
-- `COALESCE(variant.price, product.price, NULL)`. See model header in
-- schema.prisma for full doctrine + memo reference.
--
-- # SKU explicitly NOT shipped (Memo 39 + Q-ADD B4)
--
-- ProductVariant deliberately omits a `sku` column. Zero codebase anchor for
-- SKU across 67 models. Only references in repo are zombie tRPC procedures
-- (apps/api/src/router.ts:3099,3119) being retired in KAN-1218 atomically
-- with canonical UI. See KAN-1218 scope addendum (Jira comment 11735).
--
-- # No @@unique on attributes Json (Memo 39 + Q-ADD B8)
--
-- Postgres supports jsonb equality but no codebase model uses
-- `@@unique([..., jsonColumn])` across 67 models. KAN-1216 CRUD enforces
-- variant attribute dedup at service layer via Zod parse + content-hash
-- check at write time.
--
-- # Index discipline (Q-ADD B7)
--
-- Two lone indexes for Slice 1 — no composites until KAN-1216 CRUD surface
-- stabilizes query patterns:
--
--   - (product_id) — FK-lookup primary access (listVariants by product;
--     campaign_memberships precedent for parent-FK lone-index)
--   - (tenant_id)  — denormalized hot-path tenant-scoped list queries;
--     matches KAN-1213 products' (tenant_id) fallback pattern
--
-- # Migration discipline (KAN-1080 lesson + KAN-1213 precedent)
--
-- Hand-authored migration SQL since local dev DB is unavailable; CI
-- deploy-api workflow runs `npx prisma migrate deploy` on first post-merge
-- deploy. Shape mirrors KAN-1213 product_substrate migration exactly.

-- CreateTable
CREATE TABLE "product_variants" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "price" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — (product_id) FK-lookup primary access (listVariants by product)
CREATE INDEX "product_variants_product_id_idx" ON "product_variants"("product_id");

-- CreateIndex — (tenant_id) denormalized hot-path tenant-scoped list queries
CREATE INDEX "product_variants_tenant_id_idx" ON "product_variants"("tenant_id");

-- AddForeignKey — Cascade from parent Product (variants die with parent)
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey — Cascade from Tenant (catalog dies with tenant). Mirrors
-- KAN-1213 products.tenant_id_fkey and campaign_memberships dual-parent-FK pattern.
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
