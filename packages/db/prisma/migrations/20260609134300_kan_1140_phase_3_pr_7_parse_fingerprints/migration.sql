-- KAN-1140 Phase 3 PR 7 — New-format discovery + learning capture.
--
-- Two new tables: parse_fingerprints (aggregation rows; one per unique
-- (tenant_id, structure_hash, sender_domain_hash) tuple) + parse_fingerprint_samples
-- (bounded LRU samples per fingerprint, ≤5 per fingerprint enforced at
-- write-path in the webhook hook via CTE).
--
-- # Q-ADD-3 lock (Phase 1 trace): raw SQL UPSERT path
--
-- The webhook production hook uses `INSERT ... ON CONFLICT ... DO UPDATE`
-- to atomic-increment occurrence_count. Prisma's upsert can't atomic-
-- increment (read-modify-write race). The UNIQUE constraint on
-- (tenant_id, structure_hash, sender_domain_hash) backs this contract.
--
-- # Storage projection
--
-- parse_fingerprints: ~256 bytes/row × ~1000 unique patterns/tenant = ~256KB/tenant
-- parse_fingerprint_samples: 5 × ~4KB/row = ~20KB/fingerprint × ~1000 = ~20MB/tenant
-- Total: ~20MB/tenant — bounded; matches Tier 2 KAN-1086 storage budget.
--
-- # Index discipline (KAN-1086 "audit_log composite indexes pre-optimize Tier 2" memo)
--
--   - parse_fingerprints (tenant_id, last_seen_at)        → "recent patterns" sort
--   - parse_fingerprints (tenant_id, occurrence_count)    → "most common patterns" sort
--   - parse_fingerprint_samples (fingerprint_id, captured_at) → LRU sample lookup
--
-- # Migration discipline (KAN-1080 lesson + KAN-1140 PR 6 pattern)
--
-- Hand-authored migration SQL since local dev DB is unavailable; CI
-- deploy-api workflow runs `npx prisma migrate deploy` on first
-- post-merge deploy. Shape mirrors recent KAN-1093 / KAN-1140 PR 6
-- migrations.

-- CreateTable
CREATE TABLE "parse_fingerprints" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "structure_hash" TEXT,
    "sender_domain_hash" TEXT NOT NULL,
    "label_token_hash" TEXT,
    "format" TEXT NOT NULL,
    "language" TEXT,
    "vendor" TEXT,
    "format_confidence" TEXT NOT NULL,
    "language_confidence" TEXT,
    "occurrence_count" INTEGER NOT NULL DEFAULT 1,
    "escalation_count" INTEGER NOT NULL DEFAULT 0,
    "reclassify_count" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parse_fingerprints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parse_fingerprint_samples" (
    "id" TEXT NOT NULL,
    "fingerprint_id" TEXT NOT NULL,
    "resend_email_id" TEXT,
    "body_preview" TEXT NOT NULL,
    "sender_domain" TEXT NOT NULL,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parse_fingerprint_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- KAN-1086 memo lock: composite (tenant_id, ...) indexes give sub-ms
-- aggregation queries on heap sizes <128MB shared_buffers.
CREATE UNIQUE INDEX "parse_fingerprints_tenant_id_structure_hash_sender_domain_hash_key" ON "parse_fingerprints"("tenant_id", "structure_hash", "sender_domain_hash");

-- CreateIndex
CREATE INDEX "parse_fingerprints_tenant_id_last_seen_at_idx" ON "parse_fingerprints"("tenant_id", "last_seen_at");

-- CreateIndex
CREATE INDEX "parse_fingerprints_tenant_id_occurrence_count_idx" ON "parse_fingerprints"("tenant_id", "occurrence_count");

-- CreateIndex
CREATE INDEX "parse_fingerprint_samples_fingerprint_id_captured_at_idx" ON "parse_fingerprint_samples"("fingerprint_id", "captured_at");

-- AddForeignKey
ALTER TABLE "parse_fingerprints" ADD CONSTRAINT "parse_fingerprints_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
-- Sample deletion follows fingerprint deletion automatically (CASCADE) so
-- the LRU prune ceremony in the webhook hook doesn't fight orphan rows.
ALTER TABLE "parse_fingerprint_samples" ADD CONSTRAINT "parse_fingerprint_samples_fingerprint_id_fkey" FOREIGN KEY ("fingerprint_id") REFERENCES "parse_fingerprints"("id") ON DELETE CASCADE ON UPDATE CASCADE;
