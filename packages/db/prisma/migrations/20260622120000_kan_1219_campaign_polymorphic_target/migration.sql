-- KAN-1219 Slice G1 — Campaign polymorphic target substrate.
--
-- # Why
--
-- Today Campaign references its target product via the scalar `goal_product_id`
-- (soft pointer; no FK declared per KAN-1167 PR 1). With the Vehicle entity
-- now top-level (KAN-1211 closed), operators need to author campaigns that
-- target Vehicles (e.g. "campaign for the 4 SUVs we just took on trade").
--
-- This migration adds the polymorphic discriminator the orchestrator + chat
-- UI will consume:
--   - target_entity_type  TEXT NULL — 'product' | 'vehicle' (CHECK-constrained)
--   - target_entity_ids   TEXT[] DEFAULT '{}' NOT NULL — array of soft pointers
--
-- Both columns are soft-pointer scalar/array (Memo 39 codebase-precedent —
-- mirrors the existing `goal_product_id` soft-pointer pattern; FK upgrade is
-- deferred to KAN-1225). The array shape supports Q5 "specific VINs at
-- confirm" semantics (multi-target campaigns target N VINs / N products) at
-- substrate cost ~0 (Postgres TEXT[] is well-indexed via GIN if needed in
-- future; defer GIN per Memo 54 empirical-priority).
--
-- # Q4 backfill — one-shot inside migration
--
-- All existing rows with `goal_product_id IS NOT NULL` get backfilled:
--   target_entity_type = 'product'
--   target_entity_ids  = ARRAY[goal_product_id]
-- The legacy `goal_product_id` column is kept (DEPRECATED) for 1-sprint
-- deprecation window. Slice G2 will surface only `target_entity_*` in app
-- code; the column drops in a follow-up migration once dual-read is removed.
--
-- # Zero-downtime profile
--
-- ALTER TABLE ADD COLUMN with a literal default (NULL for the enum scalar
-- and `'{}'` for the TEXT[]) is metadata-only on PG 11+ — no table rewrite.
-- The UPDATE backfill scans `campaigns`; at the dev/staging scale (<1k rows)
-- this is sub-second.
--
-- # Doctrine anchors
--
-- - Memo 39 codebase-precedent — soft-pointer scalar pattern reused
-- - Memo 54 empirical-priority — 1-sprint goalProductId deprecation; no FK
--   upgrade in this slice (KAN-1225 owns that)
-- - Memo 56 #11 substrate-extension-on-existing-paths — discriminator added
--   to existing Campaign entity, not new entity
-- - Migration discipline per KAN-1080 + KAN-1219 precedent: hand-authored SQL;
--   CI deploy-api applies via `npx prisma migrate deploy` on first post-merge.

-- AddColumn
ALTER TABLE "campaigns"
  ADD COLUMN "target_entity_type" TEXT;

ALTER TABLE "campaigns"
  ADD COLUMN "target_entity_ids" TEXT[] NOT NULL DEFAULT '{}';

-- CheckConstraint — discriminator domain. NULL is allowed during the
-- deprecation window so legacy unconfirmed-draft campaigns (no target yet)
-- aren't forced into a value.
ALTER TABLE "campaigns"
  ADD CONSTRAINT "campaigns_target_entity_type_check"
  CHECK ("target_entity_type" IN ('product', 'vehicle') OR "target_entity_type" IS NULL);

-- Backfill — one-shot. Any campaign with goal_product_id but no target
-- discriminator inherits 'product' + a single-element ids array.
UPDATE "campaigns"
   SET "target_entity_type" = 'product',
       "target_entity_ids"  = ARRAY["goal_product_id"]
 WHERE "goal_product_id" IS NOT NULL
   AND "target_entity_type" IS NULL;

-- Index — operators filtering "vehicle campaigns" / "product campaigns" on
-- the listing surface; cheap to add now alongside the discriminator.
CREATE INDEX "campaigns_tenant_id_target_entity_type_idx"
  ON "campaigns" ("tenant_id", "target_entity_type");
