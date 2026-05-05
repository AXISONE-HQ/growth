-- ───────────────────────────────────────────────────────────────────────────
-- KAN-826 — Drop legacy KAN-786 Knowledge schema + recreate per Sprint 11a spec
-- ───────────────────────────────────────────────────────────────────────────
--
-- DESTRUCTIVE migration. Path A (architect spec divergence resolution):
-- legacy KAN-706 tables (knowledge_chunks, knowledge_sources,
-- knowledge_ingestions) + 2 enums (knowledge_source_status,
-- knowledge_source_type) DROPPED. Sprint 11a replacement schema CREATED
-- (knowledge_source, knowledge_chunk, knowledge_gap_summary,
-- chunk_effectiveness).
--
-- KAN-786 sub-cohort a/b shipped the legacy tables; sub-cohort c was
-- reverted in KAN-791 first commit; tables never populated. Pre-count
-- guards at the top of this migration enforce the invariant.
--
-- Pre-count guards: if any of the legacy tables hold > 0 rows at apply
-- time, the entire transaction ROLLBACK + aborts with a clear error.
-- This is the destructive-DB protocol in `reference_destructive_db_operation_protocol`:
-- "non-destructive first / per-op auth / backup posture check / no
-- 'additive-only' assumptions". Backup posture (Cloud SQL backups + PITR)
-- verified before this migration runs per `reference_backup_posture_prerequisite`.
--
-- HNSW index per architect spec §1.2 (m=16, ef_construction=64) and
-- partial retrieval index per §1.6 (tenant_id, category WHERE status='ready')
-- added at the bottom — Prisma cannot generate vector indexes natively.
-- Embedding column declared via Unsupported("vector(1536)") in schema
-- so Prisma generates the column with the correct type.

BEGIN;

-- ── Pre-count guards: any legacy row → ROLLBACK ──────────────────────────
DO $$
DECLARE
  chunks_count INTEGER;
  sources_count INTEGER;
  ingestions_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO chunks_count FROM knowledge_chunks;
  SELECT COUNT(*) INTO sources_count FROM knowledge_sources;
  SELECT COUNT(*) INTO ingestions_count FROM knowledge_ingestions;

  IF chunks_count > 0 OR sources_count > 0 OR ingestions_count > 0 THEN
    RAISE EXCEPTION
      'KAN-826 pre-count guard FAILED: legacy KB tables not empty. knowledge_chunks=%, knowledge_sources=%, knowledge_ingestions=%. Path A requires 0 rows in all three. Halt and audit before proceeding.',
      chunks_count, sources_count, ingestions_count;
  END IF;
END
$$;

-- ── Drop legacy FKs first (Prisma's dependency-ordered output) ──────────
ALTER TABLE "knowledge_chunks" DROP CONSTRAINT "knowledge_chunks_source_id_fkey";
ALTER TABLE "knowledge_ingestions" DROP CONSTRAINT "knowledge_ingestions_knowledge_source_id_fkey";
ALTER TABLE "knowledge_sources" DROP CONSTRAINT "knowledge_sources_tenant_id_fkey";

-- ── Drop legacy tables ──────────────────────────────────────────────────
DROP TABLE "knowledge_chunks";
DROP TABLE "knowledge_ingestions";
DROP TABLE "knowledge_sources";

-- ── Drop legacy enum types ──────────────────────────────────────────────
DROP TYPE "knowledge_source_status";
DROP TYPE "knowledge_source_type";

-- ── Sprint 11a replacement schema ────────────────────────────────────────
CREATE TABLE "knowledge_source" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "file_name" TEXT,
    "file_size_bytes" INTEGER,
    "file_checksum" TEXT,
    "raw_content" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "error_detail" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_source_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_chunk" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "chunk_text" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "question_text" TEXT,
    "embedding" vector(1536) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_gap_summary" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "normalized_query" VARCHAR(500) NOT NULL,
    "count_last_7d" INTEGER NOT NULL DEFAULT 0,
    "count_last_30d" INTEGER NOT NULL DEFAULT 0,
    "last_seen" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_gap_summary_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "chunk_effectiveness" (
    "id" TEXT NOT NULL,
    "chunk_id" TEXT NOT NULL,
    "decision_id" TEXT NOT NULL,
    "outcome_status" TEXT NOT NULL,
    "outcome_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chunk_effectiveness_pkey" PRIMARY KEY ("id")
);

-- ── Btree indexes ──────────────────────────────────────────────────────
CREATE INDEX "knowledge_source_tenant_id_status_idx" ON "knowledge_source"("tenant_id", "status");
CREATE INDEX "knowledge_source_tenant_id_category_idx" ON "knowledge_source"("tenant_id", "category");
CREATE INDEX "knowledge_source_file_checksum_idx" ON "knowledge_source"("file_checksum");

CREATE INDEX "knowledge_chunk_source_id_idx" ON "knowledge_chunk"("source_id");
CREATE INDEX "knowledge_chunk_tenant_id_status_category_idx" ON "knowledge_chunk"("tenant_id", "status", "category");

CREATE INDEX "knowledge_gap_summary_tenant_id_count_last_7d_idx" ON "knowledge_gap_summary"("tenant_id", "count_last_7d");
CREATE UNIQUE INDEX "knowledge_gap_summary_tenant_id_normalized_query_key" ON "knowledge_gap_summary"("tenant_id", "normalized_query");

CREATE INDEX "chunk_effectiveness_chunk_id_idx" ON "chunk_effectiveness"("chunk_id");
CREATE INDEX "chunk_effectiveness_decision_id_idx" ON "chunk_effectiveness"("decision_id");

-- ── Foreign keys ───────────────────────────────────────────────────────
ALTER TABLE "knowledge_source" ADD CONSTRAINT "knowledge_source_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_chunk" ADD CONSTRAINT "knowledge_chunk_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "knowledge_source"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_gap_summary" ADD CONSTRAINT "knowledge_gap_summary_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Vector indexes (Architect Spec §1.2 + §1.6) ─────────────────────────
-- HNSW with m=16, ef_construction=64. ~99% recall + 5-15ms p95 query
-- latency at 200K-chunk MVP scale per spec §1.2 rationale. Cosine similarity
-- to match OpenAI text-embedding-3-small distance metric.
CREATE INDEX "knowledge_chunk_embedding_hnsw_idx" ON "knowledge_chunk"
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Partial index on (tenant_id, category) WHERE status = 'ready' per spec §1.6.
-- Drives the retrieval pre-filter — every Brain/Shaper retrieval call hits
-- this exact predicate. Smaller and cheaper than a full index because it
-- excludes soft-deleted chunks (status='deleted') from the index entirely.
CREATE INDEX "knowledge_chunk_tenant_status_partial_idx" ON "knowledge_chunk"
    ("tenant_id", "category")
    WHERE "status" = 'ready';

COMMIT;
