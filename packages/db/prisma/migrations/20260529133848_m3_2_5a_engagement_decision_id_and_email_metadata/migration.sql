-- M3-2.5a Inbound Reply Correlation — outbound substrate.
--
-- Additive only. Closes the silent feature gap from M3-1: engine-emitted
-- Decisions don't write Engagement rows because dealId isn't in metadata
-- (action-executed-push.ts:146 guard skips). M3-2.5a fixes the dealId
-- thread (engine-side helper) AND adds:
--
--   1. engagements.decision_id top-level FK + index — was buried in
--      Engagement.metadata Json pre-slice. Promoting to a real FK
--      column unlocks Decision→Engagement queries + the M3-2.5b inbound
--      correlation lookup.
--   2. engagement_email_metadata sidecar (1:1 FK to Engagement, email
--      engagements only) — provider, providerMessageId, in_reply_to,
--      references_array. Tenant scope flows transitively via
--      engagement_id → engagement.tenant_id (sibling pattern:
--      AccountProfile children). NOT added to TENANT_SCOPED_MODELS in
--      the tenant middleware for the same reason.
--
-- Migrate-diff drift hygiene (per feedback_prisma_vector_index_silent_drop_drift
-- + KAN-786/787 + KAN-1034):
--   - DROP INDEX "knowledge_chunk_embedding_hnsw_idx" — STRIPPED. Recurrent
--     drift Prisma regenerates on every diff; CI apply would nuke the HNSW
--     vector index + break Brain RAG. Same strip as M3-1a's migration.
--   - RenameIndex "tenant_objective_selection_*" — STRIPPED. Orthogonal
--     drift tracked under KAN-1034; not in this slice's scope. Same
--     strip as M3-1a's migration.
-- Eyeballed clean before commit.

-- AlterTable — engagements.decision_id top-level FK
ALTER TABLE "engagements" ADD COLUMN "decision_id" TEXT;

-- CreateTable — engagement_email_metadata sidecar (1:1 with engagements)
CREATE TABLE "engagement_email_metadata" (
    "engagement_id"       TEXT NOT NULL,
    "provider"            TEXT NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "in_reply_to"         TEXT,
    "references_array"    TEXT[],
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "engagement_email_metadata_pkey" PRIMARY KEY ("engagement_id")
);

-- CreateIndex
CREATE INDEX "engagement_email_metadata_in_reply_to_idx" ON "engagement_email_metadata"("in_reply_to");

-- CreateIndex — global UNIQUE (provider, provider_message_id); providers' wire
-- IDs are globally unique within their namespace, so cross-tenant collision
-- is structurally impossible. M3-2.5b correlation lookup hits this for O(1)
-- sidecar resolution.
CREATE UNIQUE INDEX "engagement_email_metadata_provider_provider_message_id_key" ON "engagement_email_metadata"("provider", "provider_message_id");

-- CreateIndex — engagements (tenant_id, decision_id) for Decision→Engagement queries
CREATE INDEX "engagements_tenant_id_decision_id_idx" ON "engagements"("tenant_id", "decision_id");

-- AddForeignKey — engagements.decision_id with SET NULL (Engagement is an
-- audit record of what happened; survives Decision purge)
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey — sidecar CASCADE on engagement delete (lockstep lifecycle)
ALTER TABLE "engagement_email_metadata" ADD CONSTRAINT "engagement_email_metadata_engagement_id_fkey" FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
