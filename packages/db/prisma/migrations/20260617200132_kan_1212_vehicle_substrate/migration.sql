-- KAN-1212 — Vehicle Inventory substrate (Slice 1 of KAN-1211 epic).
--
-- # Additive-only contract
--
-- This migration is ADDITIVE: six new enums, one new table, three new indexes
-- (two non-unique + one unique). No existing column/table is modified.
-- Rollback is clean: DROP TABLE vehicles + DROP TYPE * reverses; the Tenant
-- back-relation is pure Prisma-client-side and has no DB-level FK to undo.
--
-- # Memo 45 NULL semantics — vehicles_tenant_id_vin_key
--
-- VIN is nullable for vehicles without recorded VIN (legacy inventory,
-- non-VIN-tracked private sales, pre-1981 vehicles outside ISO 3779 scope).
-- The unique index allows MULTIPLE rows per tenant with vin IS NULL because
-- NULL ≠ NULL under SQL three-valued logic. When VIN is present, it must be
-- unique within the tenant. This is INTENDED. If a future product surface
-- requires "global uniqueness across rows that have a VIN," that's already
-- the behavior; if it requires "exactly one NULL-vin row per tenant," add a
-- partial unique index then (see ProductCategory.parentId precedent at
-- schema.prisma:3819-3821 for the partial-unique pattern).
--
-- # Memo 54 dealerLot deferral
--
-- dealerLot is a free-form TEXT column. Future normalization to a separate
-- DealerLot entity tracked in KAN-1213. Triggers: multi-lot dealer customer
-- OR analytics signal of cardinality ≥3 per tenant OR operator-session
-- duplicate-variation signal. Per Memo 54 empirical-priority discipline —
-- no speculative normalization without measured demand.
--
-- # Index discipline (audit_log_table_pre_optimized_for_tier_2_aggregation memo)
--
-- 2 composite indexes pre-optimize Slice-N list-view patterns:
--   - (tenant_id)         — bulk tenant scans (rare; fallback)
--   - (tenant_id, status) — status-filtered list queries (default excludes archived)
--
-- # Soft-delete pattern
--
-- archived_at nullable timestamp mirrors products.archived_at and
-- campaigns.archived_at. status='archived' is the queryable enum state;
-- archived_at is the timestamp companion. List-view excludes archived by
-- default (M4 archive-only discipline; service layer deferred to Slice 2).
--
-- # Migration discipline (KAN-1080 lesson + KAN-1140 PR 6 pattern + KAN-1213 anchor)
--
-- Hand-authored migration SQL since local dev DB is unavailable; CI
-- deploy-api workflow runs `npx prisma migrate deploy` on first post-merge
-- deploy. Shape mirrors the KAN-1213 product substrate migration at
-- packages/db/prisma/migrations/20260616194949_kan_1213_product_substrate/migration.sql.

-- CreateEnum
CREATE TYPE "vehicle_status" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "body_style" AS ENUM ('suv', 'sedan', 'truck', 'hatchback', 'coupe', 'convertible', 'minivan', 'van', 'wagon');

-- CreateEnum
CREATE TYPE "transmission" AS ENUM ('automatic', 'manual', 'cvt', 'dct');

-- CreateEnum
CREATE TYPE "fuel_type" AS ENUM ('gas', 'diesel', 'hybrid', 'electric', 'plugin_hybrid');

-- CreateEnum
CREATE TYPE "drivetrain" AS ENUM ('fwd', 'rwd', 'awd', 'four_wd');

-- CreateEnum
CREATE TYPE "vehicle_condition" AS ENUM ('new', 'used', 'cpo');

-- CreateTable
CREATE TABLE "vehicles" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "trim" TEXT,
    "vin" TEXT,
    "mileage" INTEGER,
    "body_style" "body_style" NOT NULL,
    "transmission" "transmission" NOT NULL,
    "fuel_type" "fuel_type" NOT NULL,
    "exterior_color" TEXT,
    "interior_color" TEXT,
    "drivetrain" "drivetrain" NOT NULL,
    "condition" "vehicle_condition" NOT NULL,
    "stock_number" TEXT,
    "dealer_lot" TEXT,
    "status" "vehicle_status" NOT NULL DEFAULT 'draft',
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — (tenant_id) bulk scan fallback
CREATE INDEX "vehicles_tenant_id_idx" ON "vehicles"("tenant_id");

-- CreateIndex — (tenant_id, status) status-filtered list queries
CREATE INDEX "vehicles_tenant_id_status_idx" ON "vehicles"("tenant_id", "status");

-- CreateIndex — (tenant_id, vin) unique; NULL ≠ NULL allows multi-VIN-null per
-- tenant per Memo 45 (sql_null_semantics_in_prisma_unique_constraints).
CREATE UNIQUE INDEX "vehicles_tenant_id_vin_key" ON "vehicles"("tenant_id", "vin");

-- AddForeignKey — Cascade mirrors sibling tenant-scoped models (products,
-- campaigns, orders, deals). Vehicle is a tenant-owned asset; tenant deletion
-- (rare) takes the inventory with it.
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
