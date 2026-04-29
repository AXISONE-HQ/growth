-- KAN-745 PR B — LLM cost rollup table.
--
-- In-process apps/api Pub/Sub subscriber consumes llm.call events from the
-- llm.call topic (KAN-699 emit + KAN-745 PR A augments) and UPSERTs into
-- this table on a per-(tenant, hourBucket, callerTagPrefix, pricingVersion)
-- key. Concurrent-safe via the unique index.
--
-- 6th DDL apply on the v4 deploy-api migrate chain. Routine per
-- feedback_kan_709_v4_structurally_proven (KAN-738/741/742/750/754 corpus).

CREATE TABLE "llm_cost_rollups" (
  "id"                  TEXT NOT NULL,
  "tenant_id"           TEXT NOT NULL,
  "hour_bucket"         TIMESTAMP(3) NOT NULL,
  "caller_tag_prefix"   TEXT NOT NULL,
  "call_count"          INTEGER NOT NULL DEFAULT 0,
  "total_input_tokens"  INTEGER NOT NULL DEFAULT 0,
  "total_output_tokens" INTEGER NOT NULL DEFAULT 0,
  "total_cost_usd"      DOUBLE PRECISION NOT NULL DEFAULT 0,
  "pricing_version"     TEXT NOT NULL,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "llm_cost_rollups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "llm_cost_rollups_tenant_id_hour_bucket_caller_tag_prefix_pri_key"
  ON "llm_cost_rollups"("tenant_id", "hour_bucket", "caller_tag_prefix", "pricing_version");

CREATE INDEX "llm_cost_rollups_tenant_id_idx" ON "llm_cost_rollups"("tenant_id");
CREATE INDEX "llm_cost_rollups_tenant_id_hour_bucket_idx"
  ON "llm_cost_rollups"("tenant_id", "hour_bucket");

ALTER TABLE "llm_cost_rollups"
  ADD CONSTRAINT "llm_cost_rollups_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
