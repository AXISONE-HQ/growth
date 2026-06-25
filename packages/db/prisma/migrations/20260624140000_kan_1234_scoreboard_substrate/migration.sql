-- KAN-1234 Phase A — Decision Scoreboard substrate.
--
-- # Why
--
-- The Decision Scoreboard (KAN-1234) shows the operator a realistic projection
-- (reachable contacts × closing rate × time factor) BEFORE they click Generate
-- Action Plan, closing the Doctrine #5 gap ("system always knows what's
-- missing"). Two substrate columns land here:
--
--   tenants.industry        — vertical key driving the industry-default closing
--                             rate until the tenant has ≥3 measured outcomes.
--                             Normalized: 'used_auto' | 'new_auto' | 'saas_b2b'
--                             | 'real_estate' | 'ecommerce' | 'unknown'.
--                             NOT NULL DEFAULT 'unknown' (every existing tenant
--                             backfills to the 5% generic baseline; no app
--                             change required for the default to be correct).
--
--   campaigns.actual_outcome — measured campaign result, written by KAN-1234
--                             Phase B (NOT Phase A). Shipped DARK here per Memo
--                             56 #13 substrate-staging so Phase B needs no
--                             schema change / retroactive backfill. Phase A's
--                             computeProjection only READS it (IS NOT NULL →
--                             tenant closing-rate source; else industry).
--                             Shape: { unitsAchieved, goalHit, measuredAt }.
--
-- Both are additive + nullable-or-defaulted → safe online ALTER (no rewrite of
-- existing rows beyond the constant default, no FK, no lock-heavy index).

ALTER TABLE "tenants" ADD COLUMN "industry" TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE "campaigns" ADD COLUMN "actual_outcome" JSONB;
