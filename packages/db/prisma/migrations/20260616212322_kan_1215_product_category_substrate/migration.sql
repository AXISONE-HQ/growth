-- KAN-1215 — ProductCategory substrate (Slice 1 PR 3 of KAN-1212 epic).
--
-- # Additive-only contract
--
-- This migration is ADDITIVE: one new table, three indexes, one unique
-- constraint, two FKs (one self-referencing). No existing column/table is
-- modified. Rollback is clean (DROP TABLE product_categories reverses; the
-- back-relations on Product and Tenant are Prisma-client-side only with no
-- DB-level reference).
--
-- # SQL NULL semantics in @@unique (Memo 45 — FIRST INSTANCE)
--
-- `UNIQUE (tenant_id, parent_id, name)` with nullable `parent_id` is the FIRST
-- such pattern in the codebase. SQL standard: NULL ≠ NULL in unique
-- constraints. Operational semantic:
--
--   ✓ ALLOWED:  Two root categories named "Imports" per tenant
--               (each has parent_id IS NULL; NULL ≠ NULL → both permitted)
--   ✓ ALLOWED:  Same name under different non-NULL parents
--   ✗ REJECTED: Two categories with same name under same non-NULL parent
--
-- KAN-1215 INTENTIONALLY does NOT add a partial unique index for global
-- uniqueness across roots. If a future tenant UX surfaces "duplicate root
-- name" as a bug, file a fix-forward to add:
--
--   CREATE UNIQUE INDEX product_categories_tenant_root_name_unique
--     ON product_categories (tenant_id, name)
--     WHERE parent_id IS NULL;
--
-- See model header in schema.prisma for full doctrine + Memo 45 memo
-- reference.
--
-- # Index discipline (Q-ADD C9)
--
-- 3 indexes pre-optimize the Slice-N list-view aggregation patterns:
--
--   - (tenant_id)              — bulk tenant scans (rare; fallback)
--   - (tenant_id, parent_id)   — tree traversal (listChildren by parent)
--   - (tenant_id, status)      — list-view archived-filter (matches Product:8348)
--
-- # SetNull self-FK (Q-ADD C1)
--
-- ON DELETE SET NULL on the self-parent FK — children become root-level when
-- their parent is deleted. Contact.currentPipelineId (schema.prisma:374)
-- precedent. Tree integrity preserved without operator-confusing cascade
-- destruction.
--
-- # Migration discipline (KAN-1080 lesson + KAN-1213/1214 precedent)
--
-- Hand-authored migration SQL since local dev DB is unavailable; CI
-- deploy-api workflow runs `npx prisma migrate deploy` on first post-merge
-- deploy. Shape mirrors KAN-1213/1214 substrate migrations.

-- CreateTable
CREATE TABLE "product_categories" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "product_status" NOT NULL DEFAULT 'draft',
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — (tenant_id) bulk scan fallback
CREATE INDEX "product_categories_tenant_id_idx" ON "product_categories"("tenant_id");

-- CreateIndex — (tenant_id, parent_id) tree traversal (listChildren by parent)
CREATE INDEX "product_categories_tenant_id_parent_id_idx" ON "product_categories"("tenant_id", "parent_id");

-- CreateIndex — (tenant_id, status) list-view archived-filter
CREATE INDEX "product_categories_tenant_id_status_idx" ON "product_categories"("tenant_id", "status");

-- CreateUnique — Memo 45 NULL semantic: see migration header + schema model header
CREATE UNIQUE INDEX "product_categories_tenant_id_parent_id_name_key" ON "product_categories"("tenant_id", "parent_id", "name");

-- AddForeignKey — Cascade from Tenant (catalog dies with tenant). Mirrors
-- KAN-1213 / KAN-1214 tenant FK pattern.
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey — SetNull on self-parent. Children become root-level on
-- parent delete (Q-ADD C1 verdict; Contact.currentPipelineId:374 precedent).
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
