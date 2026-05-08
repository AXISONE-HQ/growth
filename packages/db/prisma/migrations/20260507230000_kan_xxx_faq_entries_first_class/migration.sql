-- ───────────────────────────────────────────────────────────────────────────
-- KAN-XXX — FAQ as first-class entity (Sprint 11b)
-- ───────────────────────────────────────────────────────────────────────────
--
-- Supersedes KAN-841 (FAQ-via-KnowledgeSource multi-pair contract). FAQ
-- entries become first-class rows with their own table + dedicated UI; one
-- chunk per entry via a polymorphic parent FK on knowledge_chunk.
--
-- ADDITIVE ONLY — no DROP, no DESTRUCTIVE ALTER. Pre-flight verified
-- (2026-05-07) that COUNT(*) FROM knowledge_source WHERE source_type='faq'
-- AND status != 'deleted' = 0 GLOBALLY, so no row-level migration is needed
-- for legacy FAQ-via-source rows; the create-side validation tightens in the
-- API layer (drops 'faq' from sourceType allow-list) without affecting any
-- live data.
--
-- Operations:
--   1. CREATE TABLE faq_entries (per spec §2 of the cohort brief)
--   2. ALTER TABLE knowledge_chunk: ADD COLUMN faq_entry_id (nullable),
--      ALTER source_id DROP NOT NULL
--   3. ADD FK + INDEX for faq_entry_id
--   4. ADD CHECK constraint: exactly one of source_id or faq_entry_id is set
--      per row (XOR via `(source_id IS NULL) <> (faq_entry_id IS NULL)`)
--
-- All operations run inside a single transaction so a failure rolls back
-- cleanly. Backup posture (Cloud SQL backups + PITR) is verified before
-- any DB-touching deploy per `reference_backup_posture_prerequisite`.

BEGIN;

-- ── 1. New faq_entries table ─────────────────────────────────────────────
CREATE TABLE "faq_entries" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error_detail" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faq_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "faq_entries_tenant_id_deleted_at_idx" ON "faq_entries"("tenant_id", "deleted_at");
CREATE INDEX "faq_entries_tenant_id_created_at_idx" ON "faq_entries"("tenant_id", "created_at");

ALTER TABLE "faq_entries" ADD CONSTRAINT "faq_entries_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 2. knowledge_chunk: add faq_entry_id, drop source_id NOT NULL ────────
ALTER TABLE "knowledge_chunk" ADD COLUMN "faq_entry_id" TEXT;
ALTER TABLE "knowledge_chunk" ALTER COLUMN "source_id" DROP NOT NULL;

-- ── 3. FK + index for the new parent path ────────────────────────────────
ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_faq_entry_id_fkey"
    FOREIGN KEY ("faq_entry_id") REFERENCES "faq_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "knowledge_chunk_faq_entry_id_idx" ON "knowledge_chunk"("faq_entry_id");

-- ── 4. CHECK: exactly one parent FK is set per chunk row ─────────────────
-- (`(a IS NULL) <> (b IS NULL)` is the XOR — both null = false, both
-- non-null = false, exactly one set = true. Prisma can't generate this; raw
-- SQL preserves the invariant at the DB layer regardless of app drift.)
ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_xor_parent_check"
    CHECK (("source_id" IS NULL) <> ("faq_entry_id" IS NULL));

COMMIT;
