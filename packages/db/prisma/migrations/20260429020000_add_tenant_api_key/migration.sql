-- KAN-742 — Sprint 3 / S3.8 Lead API tenant API keys.
--
-- Adds tenant_api_keys table for the public POST /api/v1/leads endpoint
-- authentication. Plaintext key shape: axone_live_<32hex>. Server stores:
--   - key_prefix: first 12 hex of the entropy portion (after stripping
--     `axone_live_`) — indexed for O(1) lookup
--   - key_hash:   bcrypt of the remaining 20 hex
-- Plaintext shown ONCE at creation; server NEVER returns it after.
--
-- Additive-only — no destructive ops. v4 RUN-branch 3rd data point on the
-- post-KAN-723 corpus (KAN-738 = 1st, KAN-741 = 2nd).

-- CreateTable: tenant_api_keys
CREATE TABLE "tenant_api_keys" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,

    CONSTRAINT "tenant_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: keyPrefix for O(1) lookup on auth
CREATE INDEX "tenant_api_keys_key_prefix_idx" ON "tenant_api_keys"("key_prefix");

-- CreateIndex: tenant + revoked status for tRPC list query
CREATE INDEX "tenant_api_keys_tenant_id_revoked_at_idx" ON "tenant_api_keys"("tenant_id", "revoked_at");

-- AddForeignKey: tenant_api_keys → tenants
ALTER TABLE "tenant_api_keys" ADD CONSTRAINT "tenant_api_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
