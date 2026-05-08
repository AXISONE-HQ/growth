-- ───────────────────────────────────────────────────────────────────────────
-- KAN-XXX — Services as first-class entity (Sprint 11b)
-- ───────────────────────────────────────────────────────────────────────────
--
-- Adds Services as a third first-class knowledge entity, parallel to FAQs
-- (KAN-849) and KnowledgeSources (KAN-826). Each Service produces one
-- KnowledgeChunk via a polymorphic `service_id` parent FK on knowledge_chunk.
--
-- The KAN-849 2-way XOR CHECK constraint
-- `(source_id IS NULL) <> (faq_entry_id IS NULL)` is dropped + replaced by a
-- 3-way exactly-one-of constraint atomically inside this migration's
-- transaction. PROD audit (2026-05-08): 13 chunks, 1 source-parented, 12
-- faq-parented, 0 orphan — every existing row will satisfy the new
-- constraint without modification.
--
-- ADDITIVE structurally; the constraint swap weakens validation for zero
-- microseconds (the new constraint is strictly stronger semantically and
-- holds for all existing rows). Backup posture verified before deploy per
-- `reference_backup_posture_prerequisite`.
--
-- Operations:
--   1. CREATE TYPE service_price_unit (Postgres enum)
--   2. CREATE TABLE services (per cohort spec §1)
--   3. ALTER TABLE knowledge_chunk ADD COLUMN service_id (nullable) + FK +
--      INDEX
--   4. DROP existing 2-way XOR CHECK; ADD 3-way exactly-one-of CHECK

BEGIN;

-- ── 1. ServicePriceUnit Postgres enum ────────────────────────────────────
CREATE TYPE "service_price_unit" AS ENUM (
    'PER_HOUR',
    'PER_MONTH',
    'PER_PROJECT',
    'PER_UNIT',
    'FIXED',
    'CUSTOM'
);

-- ── 2. New services table ────────────────────────────────────────────────
CREATE TABLE "services" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price" DECIMAL(10, 2),
    "price_unit" "service_price_unit" NOT NULL,
    "price_custom_label" TEXT,
    "start_date" DATE,
    "end_date" DATE,
    "included_items" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "excluded_items" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error_detail" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "services_tenant_id_deleted_at_idx" ON "services"("tenant_id", "deleted_at");
CREATE INDEX "services_tenant_id_created_at_idx" ON "services"("tenant_id", "created_at");

ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3. knowledge_chunk: add service_id FK + index ────────────────────────
ALTER TABLE "knowledge_chunk" ADD COLUMN "service_id" TEXT;

ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_service_id_fkey"
    FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "knowledge_chunk_service_id_idx" ON "knowledge_chunk"("service_id");

-- ── 4. CHECK swap: drop 2-way XOR, add 3-way exactly-one-of ──────────────
-- The previous KAN-849 constraint enforced source_id XOR faq_entry_id. With
-- a third parent path, we need exactly-one-of-three semantics. Postgres
-- allows DROP + ADD inside the same transaction; the new constraint takes
-- effect at COMMIT, so the table is never live without a constraint at
-- READ-COMMITTED or higher (the standard default).
ALTER TABLE "knowledge_chunk" DROP CONSTRAINT "knowledge_chunk_xor_parent_check";

ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_xor_parent_check"
    CHECK (
        ("source_id" IS NOT NULL)::int +
        ("faq_entry_id" IS NOT NULL)::int +
        ("service_id" IS NOT NULL)::int = 1
    );

COMMIT;
