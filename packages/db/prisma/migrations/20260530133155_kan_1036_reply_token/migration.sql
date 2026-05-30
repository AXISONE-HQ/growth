-- KAN-1036 — additive `reply_token` column for subaddress-anchored reply correlation.
--
-- Replaces the wire-Message-ID-based correlation (Plan A in M3-2.5b), which
-- was empirically falsified — Resend has no API surface that exposes the
-- SES-generated wire Message-ID (β.1 GET, β.2 webhook payload, β.3 sender-
-- set Message-ID all dead per KAN-1036 Phase 1 investigations). The pivot
-- anchors correlation on a value WE mint and control at outbound send time:
-- the per-decision token rides through the Reply-To header as
-- `<inboxSlug>+<replyToken>@<DOMAIN>` and comes back preserved in the
-- recipient's reply To-field via RFC 5233 subaddressing.
--
-- ─── Drift-strip discipline ───────────────────────────────────────────────
-- `prisma migrate diff --script` regenerated two known drift items along
-- with the real changes; stripped per KAN-786 / KAN-787 / KAN-1034 history:
--
--   1. DROP INDEX "knowledge_chunk_embedding_hnsw_idx" — KAN-786, KAN-787.
--      The HNSW index is real and load-bearing; Prisma can't model it
--      (custom pgvector index type). Auto-DROP would silently nuke PROD's
--      vector search; STRIPPED.
--
--   2. RenameIndex tenant_objective_selection_tenant_id_objective_id_…
--      → ALTER INDEX … RENAME TO …. KAN-1034 cosmetic rename; not load-
--      bearing for any code path; STRIPPED to keep the migration purely
--      additive to engagement_email_metadata.
--
-- See KAN-786 / KAN-787 / KAN-1034 comment threads and M3-2.5a's
-- 20260529133848 migration header for the same discipline pattern.

-- AlterTable
ALTER TABLE "engagement_email_metadata" ADD COLUMN     "reply_token" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "engagement_email_metadata_reply_token_idx" ON "engagement_email_metadata"("reply_token");
