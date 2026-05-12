-- KAN-879 — CRM Core Schema (Companies + Orders + Contact/Deal extensions)
--
-- Phase 3 of the KAN-879 brief. Lands the data-model foundation for
-- contacts/companies/deals/orders ingestion in a SINGLE atomic migration.
--
-- HAND-EDITED from `prisma migrate diff` output:
--   1. Contact.lifecycle_stage TEXT → enum: rename-then-coerce (preserves rows).
--   2. Contact.source TEXT? → enum: rename-then-coerce (PROD has ~5 rows with
--      legacy 'inbox_email' → 'email_inbox' per Phase 1 audit).
--   3. Deal.status / Deal.closed_at backfilled from currentStage.outcome_type +
--      DealStageHistory.transitioned_at for terminal deals.
--   4. Deal.name backfilled from Contact firstName/lastName (or email) +
--      deal id so existing rows get human-readable names. NEW INSERTs continue
--      to use the column DEFAULT 'Untitled deal'.
--   5. `DROP INDEX knowledge_chunk_embedding_hnsw_idx` stripped (Prisma vector-
--      index silent-drop drift per the KAN-786 → KAN-787 memory entry).
--   6. Unrelated catalog-only drift (services TEXT[] DROP DEFAULT,
--      llm_cost_rollups index rename) split out into a sibling migration
--      `20260512121915_drift_cleanup_services_llm_cost_rollups` so KAN-879
--      stays scoped to CRM core schema only.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. CreateEnum (11 new enums for CRM core)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TYPE "lifecycle_stage" AS ENUM ('lead', 'mql', 'sql', 'customer', 'lost');

CREATE TYPE "contact_source" AS ENUM ('email_inbox', 'web_form', 'meta_ad', 'manual', 'csv_import', 'api', 'hubspot', 'stripe', 'shopify', 'other');

CREATE TYPE "company_lifecycle_stage" AS ENUM ('prospect', 'customer', 'churned', 'partner', 'vendor');

CREATE TYPE "company_size" AS ENUM ('range_1_10', 'range_11_50', 'range_51_200', 'range_201_1000', 'range_1001_5000', 'range_5000_plus');

CREATE TYPE "tax_id_type" AS ENUM ('ein', 'vat', 'gst', 'hst', 'qst', 'abn', 'other');

CREATE TYPE "deal_status" AS ENUM ('open', 'won', 'lost');

CREATE TYPE "deal_lost_reason" AS ENUM ('price', 'timing', 'competitor', 'no_response', 'not_qualified', 'feature_gap', 'other');

CREATE TYPE "order_status" AS ENUM ('pending', 'paid', 'refunded', 'partially_refunded', 'cancelled', 'failed');

CREATE TYPE "payment_method" AS ENUM ('card', 'ach', 'invoice', 'manual', 'other');

CREATE TYPE "payment_provider" AS ENUM ('stripe', 'square', 'shopify', 'manual', 'other');

CREATE TYPE "order_source" AS ENUM ('stripe_webhook', 'shopify_webhook', 'manual', 'api', 'csv_import');

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. AlterTable contacts — additive columns + enum migrations
-- ─────────────────────────────────────────────────────────────────────────────

-- 2a. Add purely additive columns (addresses, companyId/companyName).
ALTER TABLE "contacts"
  ADD COLUMN "address_line_1" TEXT,
  ADD COLUMN "address_line_2" TEXT,
  ADD COLUMN "city" TEXT,
  ADD COLUMN "company_id" TEXT,
  ADD COLUMN "company_name" TEXT,
  ADD COLUMN "country" TEXT,
  ADD COLUMN "postal_code" TEXT,
  ADD COLUMN "region" TEXT;

-- 2b. Coerce lifecycle_stage from TEXT (legacy values: 'new', 'active', 'archived',
--     'lead', 'customer') to the new enum. Rename → ADD new column → UPDATE with
--     CASE WHEN → DROP old. Preserves every row; unknown legacy strings fall
--     back to 'lead'.
ALTER TABLE "contacts" RENAME COLUMN "lifecycle_stage" TO "lifecycle_stage_old";
ALTER TABLE "contacts" ADD COLUMN "lifecycle_stage" "lifecycle_stage" NOT NULL DEFAULT 'lead';
UPDATE "contacts" SET "lifecycle_stage" = CASE
    WHEN "lifecycle_stage_old" = 'new'       THEN 'lead'::"lifecycle_stage"
    WHEN "lifecycle_stage_old" = 'active'    THEN 'customer'::"lifecycle_stage"
    WHEN "lifecycle_stage_old" = 'archived'  THEN 'lost'::"lifecycle_stage"
    WHEN "lifecycle_stage_old" = 'lead'      THEN 'lead'::"lifecycle_stage"
    WHEN "lifecycle_stage_old" = 'mql'       THEN 'mql'::"lifecycle_stage"
    WHEN "lifecycle_stage_old" = 'sql'       THEN 'sql'::"lifecycle_stage"
    WHEN "lifecycle_stage_old" = 'qualified' THEN 'sql'::"lifecycle_stage"
    WHEN "lifecycle_stage_old" = 'customer'  THEN 'customer'::"lifecycle_stage"
    WHEN "lifecycle_stage_old" = 'lost'      THEN 'lost'::"lifecycle_stage"
    ELSE 'lead'::"lifecycle_stage"
END;
ALTER TABLE "contacts" DROP COLUMN "lifecycle_stage_old";

-- 2c. Coerce source from TEXT? to contact_source enum. Phase 1 audit: PROD has
--     ~5 rows with source='inbox_email' (now 'email_inbox'). Unknown legacy
--     strings map to 'other'; NULL preserved.
ALTER TABLE "contacts" RENAME COLUMN "source" TO "source_old";
ALTER TABLE "contacts" ADD COLUMN "source" "contact_source";
UPDATE "contacts" SET "source" = CASE
    WHEN "source_old" IS NULL              THEN NULL
    WHEN "source_old" = 'inbox_email'      THEN 'email_inbox'::"contact_source"
    WHEN "source_old" = 'email_inbox'      THEN 'email_inbox'::"contact_source"
    WHEN "source_old" = 'form_fill'        THEN 'web_form'::"contact_source"
    WHEN "source_old" = 'web_form'         THEN 'web_form'::"contact_source"
    WHEN "source_old" = 'meta_ad'          THEN 'meta_ad'::"contact_source"
    WHEN "source_old" = 'meta_lead_ad'     THEN 'meta_ad'::"contact_source"
    WHEN "source_old" = 'meta_lead_ads'    THEN 'meta_ad'::"contact_source"
    WHEN "source_old" = 'manual'           THEN 'manual'::"contact_source"
    WHEN "source_old" = 'csv_import'       THEN 'csv_import'::"contact_source"
    WHEN "source_old" = 'import'           THEN 'csv_import'::"contact_source"
    WHEN "source_old" = 'api'              THEN 'api'::"contact_source"
    WHEN "source_old" = 'lead_api'         THEN 'api'::"contact_source"
    WHEN "source_old" = 'hubspot'          THEN 'hubspot'::"contact_source"
    WHEN "source_old" = 'stripe'           THEN 'stripe'::"contact_source"
    WHEN "source_old" = 'shopify'          THEN 'shopify'::"contact_source"
    ELSE 'other'::"contact_source"
END;
ALTER TABLE "contacts" DROP COLUMN "source_old";

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. AlterTable deals — additive columns + status/closed_at backfill
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "deals"
  ADD COLUMN "ai_context"            JSONB             NOT NULL DEFAULT '{}',
  ADD COLUMN "assigned_agent_id"     TEXT,
  ADD COLUMN "closed_at"             TIMESTAMP(3),
  ADD COLUMN "company_id"            TEXT,
  ADD COLUMN "custom_fields"         JSONB             NOT NULL DEFAULT '{}',
  ADD COLUMN "expected_close_date"   DATE,
  ADD COLUMN "external_ids"          JSONB             NOT NULL DEFAULT '{}',
  ADD COLUMN "lost_reason"           "deal_lost_reason",
  ADD COLUMN "lost_reason_detail"    TEXT,
  ADD COLUMN "name"                  TEXT              NOT NULL DEFAULT 'Untitled deal',
  ADD COLUMN "owner_id"              TEXT,
  ADD COLUMN "probability"           INTEGER,
  ADD COLUMN "products"              JSONB             NOT NULL DEFAULT '[]',
  ADD COLUMN "status"                "deal_status"     NOT NULL DEFAULT 'open',
  ADD COLUMN "won_product_summary"   TEXT;

-- 3a. Backfill deal.status + deal.closed_at from currentStage.outcome_type +
--     DealStageHistory.transitioned_at. KAN-791 dropped Deal.closedAt and made
--     closure derivable from DealStageHistory; this re-materializes that.
UPDATE "deals" AS d
SET
    "status"    = CASE s."outcome_type"
                    WHEN 'terminal_won'  THEN 'won'::"deal_status"
                    WHEN 'terminal_lost' THEN 'lost'::"deal_status"
                    ELSE 'open'::"deal_status"
                END,
    "closed_at" = CASE
                    WHEN s."outcome_type" IN ('terminal_won', 'terminal_lost') THEN (
                        SELECT MAX(dsh."transitioned_at")
                        FROM "deal_stage_history" dsh
                        WHERE dsh."deal_id" = d."id"
                          AND dsh."to_stage_id" = d."current_stage_id"
                    )
                    ELSE NULL
                END
FROM "stages" s
WHERE s."id" = d."current_stage_id";

-- 3b. Backfill deal.name from the linked Contact (firstName+lastName, or
--     firstName, or lastName, or email — first non-empty wins) plus a short
--     deal-id suffix. New rows post-migration get the column DEFAULT
--     'Untitled deal'; downstream UI is expected to overwrite via the brain-
--     driven naming pipeline (KAN-797a successors).
UPDATE "deals" AS d
SET "name" = CASE
    WHEN c."first_name" IS NOT NULL AND c."first_name" <> ''
     AND c."last_name"  IS NOT NULL AND c."last_name"  <> ''
        THEN c."first_name" || ' ' || c."last_name" || ' — ' || d."id"
    WHEN c."first_name" IS NOT NULL AND c."first_name" <> ''
        THEN c."first_name" || ' — ' || d."id"
    WHEN c."last_name"  IS NOT NULL AND c."last_name"  <> ''
        THEN c."last_name"  || ' — ' || d."id"
    WHEN c."email"      IS NOT NULL AND c."email"      <> ''
        THEN c."email"      || ' — ' || d."id"
    ELSE 'Untitled deal — ' || d."id"
END
FROM "contacts" c
WHERE c."id" = d."contact_id";

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. CreateTable companies
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "domain" TEXT,
    "website" TEXT,
    "industry" TEXT,
    "size_range" "company_size",
    "annual_revenue" DECIMAL(15,2),
    "phone" TEXT,
    "email" TEXT,
    "description" TEXT,
    "lifecycle_stage" "company_lifecycle_stage" NOT NULL DEFAULT 'prospect',
    "billing_address_line_1" TEXT,
    "billing_address_line_2" TEXT,
    "billing_city" TEXT,
    "billing_region" TEXT,
    "billing_postal_code" TEXT,
    "billing_country" TEXT,
    "mailing_address_line_1" TEXT,
    "mailing_address_line_2" TEXT,
    "mailing_city" TEXT,
    "mailing_region" TEXT,
    "mailing_postal_code" TEXT,
    "mailing_country" TEXT,
    "tax_id" TEXT,
    "tax_id_type" "tax_id_type",
    "business_registration_number" TEXT,
    "incorporation_jurisdiction" TEXT,
    "is_tax_exempt" BOOLEAN NOT NULL DEFAULT false,
    "tax_exemption_certificate" TEXT,
    "owner_id" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "linkedin_url" TEXT,
    "external_ids" JSONB NOT NULL DEFAULT '{}',
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "ai_context" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. CreateTable orders
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "company_id" TEXT,
    "deal_id" TEXT,
    "order_number" TEXT NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'pending',
    "total_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "grand_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "line_items" JSONB NOT NULL DEFAULT '[]',
    "placed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "payment_method" "payment_method",
    "payment_provider" "payment_provider",
    "provider_order_id" TEXT,
    "provider_data" JSONB,
    "source" "order_source" NOT NULL DEFAULT 'manual',
    "attribution_first_source" TEXT,
    "attribution_last_source" TEXT,
    "customer_notes" TEXT,
    "internal_notes" TEXT,
    "external_ids" JSONB NOT NULL DEFAULT '{}',
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "ai_context" JSONB NOT NULL DEFAULT '{}',
    "correlation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. CreateIndex (companies + orders + contacts + deals)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX "companies_tenant_id_name_idx"            ON "companies"("tenant_id", "name");
CREATE INDEX "companies_tenant_id_domain_idx"          ON "companies"("tenant_id", "domain");
CREATE INDEX "companies_tenant_id_lifecycle_stage_idx" ON "companies"("tenant_id", "lifecycle_stage");
CREATE INDEX "companies_tenant_id_owner_id_idx"        ON "companies"("tenant_id", "owner_id");

CREATE UNIQUE INDEX "orders_correlation_id_key"                ON "orders"("correlation_id");
CREATE INDEX        "orders_tenant_id_contact_id_idx"          ON "orders"("tenant_id", "contact_id");
CREATE INDEX        "orders_tenant_id_company_id_placed_at_idx" ON "orders"("tenant_id", "company_id", "placed_at" DESC);
CREATE INDEX        "orders_tenant_id_deal_id_idx"             ON "orders"("tenant_id", "deal_id");
CREATE INDEX        "orders_tenant_id_status_idx"              ON "orders"("tenant_id", "status");
CREATE INDEX        "orders_tenant_id_placed_at_idx"           ON "orders"("tenant_id", "placed_at" DESC);
CREATE UNIQUE INDEX "orders_tenant_id_order_number_key"        ON "orders"("tenant_id", "order_number");

CREATE INDEX "contacts_tenant_id_lifecycle_stage_idx" ON "contacts"("tenant_id", "lifecycle_stage");
CREATE INDEX "contacts_tenant_id_source_idx"          ON "contacts"("tenant_id", "source");
CREATE INDEX "contacts_tenant_id_company_id_idx"      ON "contacts"("tenant_id", "company_id");
CREATE INDEX "contacts_tenant_id_country_region_idx"  ON "contacts"("tenant_id", "country", "region");

CREATE INDEX "deals_tenant_id_status_idx"               ON "deals"("tenant_id", "status");
CREATE INDEX "deals_tenant_id_company_id_status_idx"    ON "deals"("tenant_id", "company_id", "status");
CREATE INDEX "deals_tenant_id_expected_close_date_idx"  ON "deals"("tenant_id", "expected_close_date");

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. AddForeignKey
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "contacts"  ADD CONSTRAINT "contacts_company_id_fkey"  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deals"     ADD CONSTRAINT "deals_company_id_fkey"     FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "companies" ADD CONSTRAINT "companies_tenant_id_fkey"  FOREIGN KEY ("tenant_id")  REFERENCES "tenants"("id")   ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders"    ADD CONSTRAINT "orders_tenant_id_fkey"     FOREIGN KEY ("tenant_id")  REFERENCES "tenants"("id")   ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders"    ADD CONSTRAINT "orders_contact_id_fkey"    FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders"    ADD CONSTRAINT "orders_company_id_fkey"    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders"    ADD CONSTRAINT "orders_deal_id_fkey"       FOREIGN KEY ("deal_id")    REFERENCES "deals"("id")     ON DELETE SET NULL ON UPDATE CASCADE;
