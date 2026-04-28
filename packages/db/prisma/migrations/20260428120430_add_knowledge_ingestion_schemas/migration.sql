-- KAN-706 — Knowledge ingestion schemas (Sprint 2.1)
--
-- pgvector enablement MUST come first because knowledge_chunks.embedding uses
-- the vector(1536) type. The extension is bundled with this Cloud SQL Postgres
-- version (verified pre-deploy: pg_available_extensions reports vector v0.8.1
-- without the cloudsql.enable_pgvector flag set).
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "knowledge_source_type" AS ENUM ('url', 'document', 'qa_pair', 'structured_field');

-- CreateEnum
CREATE TYPE "knowledge_source_status" AS ENUM ('pending', 'processing', 'indexed', 'failed', 'stale');

-- CreateTable
CREATE TABLE "knowledge_sources" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "type" "knowledge_source_type" NOT NULL,
    "source_url" TEXT,
    "uploaded_file_ref" TEXT,
    "original_file_name" TEXT,
    "status" "knowledge_source_status" NOT NULL DEFAULT 'pending',
    "last_indexed_at" TIMESTAMP(3),
    "content_hash" TEXT NOT NULL,
    "error_message" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "total_chunks" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "embedding_model" TEXT NOT NULL,
    "embedding_version" TEXT NOT NULL,
    "token_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_ingestions" (
    "id" TEXT NOT NULL,
    "knowledge_source_id" TEXT NOT NULL,
    "status" "knowledge_source_status" NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "urls_discovered" INTEGER NOT NULL DEFAULT 0,
    "urls_indexed" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_ingestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_sources_tenant_id_idx" ON "knowledge_sources"("tenant_id");

-- CreateIndex
CREATE INDEX "knowledge_sources_tenant_id_status_idx" ON "knowledge_sources"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_sources_tenant_id_content_hash_key" ON "knowledge_sources"("tenant_id", "content_hash");

-- CreateIndex
CREATE INDEX "knowledge_chunks_source_id_idx" ON "knowledge_chunks"("source_id");

-- CreateIndex
CREATE INDEX "knowledge_ingestions_knowledge_source_id_idx" ON "knowledge_ingestions"("knowledge_source_id");

-- AddForeignKey
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_ingestions" ADD CONSTRAINT "knowledge_ingestions_knowledge_source_id_fkey" FOREIGN KEY ("knowledge_source_id") REFERENCES "knowledge_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- pgvector HNSW index for cosine similarity retrieval on knowledge_chunks.embedding.
-- HNSW chosen over IVFFlat for: better recall at low k, no need to specify list count
-- pre-build, graceful degradation under sparse data (V1 has 0 rows). Default m=16,
-- ef_construction=64 — tunable later if recall/throughput needs adjustment.
CREATE INDEX "knowledge_chunks_embedding_hnsw_idx"
  ON "knowledge_chunks"
  USING hnsw ("embedding" vector_cosine_ops);
