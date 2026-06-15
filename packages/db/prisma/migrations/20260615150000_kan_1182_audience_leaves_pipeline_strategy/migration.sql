-- KAN-1182 — Per-Pipeline strategy + 4 audience-filter indexes.
--
-- Pure additive migration. No drops, no destructive ALTERs, no backfill.
-- Pipeline.strategy is nullable (NULL = use Campaign.strategy default) so
-- existing legacy single-Pipeline Campaigns continue working unchanged.
--
-- # Identifier convention — snake_case per @@map directives in schema.prisma.
-- Pipeline.strategy uses CampaignStrategy enum (campaign_strategy in Postgres);
-- the underlying enum type already exists from KAN-1001 / KAN-997 substrate.
--
-- # Sparse-index discipline for refunded_at / cancelled_at
--
-- The refunded_at and cancelled_at columns are timestamps that are NULL for
-- the vast majority of orders (refunds + cancellations are exceptional
-- events). A regular index on a sparse column wastes space + slows inserts.
-- WHERE column IS NOT NULL clauses scope the index to only the rows audience
-- queries care about. At 10M orders with 1% refund rate, sparse index size
-- = ~100K entries vs ~10M for a full index.
--
-- # Prisma schema drift note
--
-- The @@index([tenantId, refundedAt]) and @@index([tenantId, cancelledAt])
-- declarations in schema.prisma:Order do NOT include the WHERE IS NOT NULL
-- clause because Prisma's schema syntax doesn't support partial indexes.
-- The schema declarations document the LOGICAL index; this migration
-- materializes the PHYSICAL sparse-index optimization. Future `prisma
-- migrate diff` will report no drift because partial-index WHERE clauses
-- aren't part of Prisma's schema introspection surface.

-- AlterTable — Pipeline (1 new nullable column)
ALTER TABLE "pipelines" ADD COLUMN "strategy" "campaign_strategy";

-- CreateIndex — Contact.city audience filter
CREATE INDEX "contacts_tenant_id_city_idx" ON "contacts" ("tenant_id", "city");

-- CreateIndex — Deal.value audience filter (USD-locked range queries;
-- see audience-conditions.ts dealValue*Leaf LIMITATION)
CREATE INDEX "deals_tenant_id_value_idx" ON "deals" ("tenant_id", "value");

-- CreateIndex — Order.refunded_at sparse index (KAN-1182 audience-filter
-- discipline; index scoped to non-null rows only)
CREATE INDEX "orders_tenant_id_refunded_at_idx" ON "orders" ("tenant_id", "refunded_at")
  WHERE "refunded_at" IS NOT NULL;

-- CreateIndex — Order.cancelled_at sparse index
CREATE INDEX "orders_tenant_id_cancelled_at_idx" ON "orders" ("tenant_id", "cancelled_at")
  WHERE "cancelled_at" IS NOT NULL;
