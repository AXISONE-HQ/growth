-- KAN-852 — Account Page Cohort 1: schema + API foundation.
--
-- Adds 5 new tables (account_profile + 4 children) and extends the existing
-- blueprints table with legal_defaults JSONB. Backfills existing Blueprint
-- rows with canonical CASL/CAN-SPAM minimums so the seed Generic Blueprint
-- has the new column populated immediately on apply.
--
-- The 4 child tables (social_profile, observed_holiday, industry_disclosure,
-- account_field_detection) intentionally have NO direct tenant_id column —
-- tenant scope flows transitively through account_profile_id → AccountProfile
-- via FK + JOIN. This mirrors the chunk_effectiveness precedent and is
-- enforced architecturally by NOT adding them to TENANT_SCOPED_MODELS in
-- packages/db/src/middleware/tenant.ts.
--
-- IMPORTANT — KAN-787 hygiene: the Prisma diff that produced this migration
-- ALSO suggested `DROP INDEX "knowledge_chunk_embedding_hnsw_idx";` and
-- `ALTER TABLE "services" ... DROP DEFAULT`. Both stripped. The HNSW drop
-- is the canonical pgvector drift trap (Prisma can't introspect pgvector
-- index syntax, so every diff regenerates a spurious DROP). The services
-- DROP DEFAULTs are KAN-850 introspection drift — the columns DO have
-- ARRAY[]::text[] defaults in PROD; this migration must NOT remove them.

-- AlterTable: add legal_defaults to existing blueprints
ALTER TABLE "blueprints" ADD COLUMN "legal_defaults" JSONB;

-- Backfill canonical CASL/CAN-SPAM minimums for existing Blueprint rows.
-- Keyed by ISO 639-1 language code. CASL applies in Quebec — French
-- (`fr`) is required at MVP per spec §2 decision 4.
--
-- The Generic B2B/B2C Blueprint (only seed today) gets both `en` and `fr`;
-- future vertical-specific Blueprints (Real Estate, Automotive, Financial)
-- populate their own jurisdiction-specific overrides.
--
-- The router resolves at read time:
--   blueprint.legalDefaults[accountProfile.defaultLanguage] ?? .en
--
-- TODO (Cohort 4 / pre-launch): legal review of both language blocks
-- pending counsel sign-off. Current text is the minimum CAN-SPAM/CASL
-- compliant placeholder. The `[Business Name]` and `[Physical Mailing
-- Address]` macros are substituted per-tenant by the email composer
-- (Cohort 4/5 wires the substitution).
UPDATE "blueprints"
SET "legal_defaults" = jsonb_build_object(
  'en', jsonb_build_object(
    'optOutLanguage', 'Reply STOP to unsubscribe.',
    'emailFooterDisclosure',
      E'You received this email because you opted in or have an existing relationship with us. ' ||
      E'To stop receiving these emails, click the unsubscribe link in this message. ' ||
      E'[Business Name] · [Physical Mailing Address]'
  ),
  'fr', jsonb_build_object(
    'optOutLanguage', E'Répondez STOP pour vous désabonner.',
    'emailFooterDisclosure',
      E'Vous recevez ce courriel parce que vous vous êtes inscrit ou que vous avez une relation existante avec nous. ' ||
      E'Pour cesser de recevoir ces courriels, cliquez sur le lien de désabonnement dans ce message. ' ||
      E'[Business Name] · [Physical Mailing Address]'
  )
)
WHERE "legal_defaults" IS NULL;

-- CreateTable: account_profile (tenant-scoped 1:1)
CREATE TABLE "account_profile" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "display_name" TEXT,
    "logo_url" TEXT,
    "logo_variants" JSONB,
    "website_url" TEXT,
    "one_line_description" VARCHAR(200),
    "industry" TEXT,
    "primary_phone" TEXT,
    "support_phone" TEXT,
    "primary_email" TEXT,
    "support_email" TEXT,
    "physical_address" TEXT,
    "mailing_address" TEXT,
    "mailing_same_as_physical" BOOLEAN NOT NULL DEFAULT true,
    "address_street" TEXT,
    "address_city" TEXT,
    "address_region" TEXT,
    "address_postal" TEXT,
    "address_country" TEXT,
    "service_area_type" TEXT NOT NULL DEFAULT 'local',
    "service_area_radius_km" INTEGER,
    "service_area_regions" JSONB,
    "time_zone" TEXT NOT NULL DEFAULT 'America/Toronto',
    "weekly_hours" JSONB NOT NULL DEFAULT '{}',
    "after_hours_behavior" TEXT NOT NULL DEFAULT 'send_anyway',
    "default_currency" TEXT NOT NULL DEFAULT 'USD',
    "additional_currencies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accepted_payment_methods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deposit_required" BOOLEAN NOT NULL DEFAULT false,
    "deposit_type" TEXT,
    "deposit_value" DECIMAL(10,2),
    "refund_window_days" INTEGER,
    "tax_id" TEXT,
    "business_reg_number" TEXT,
    "jurisdiction" TEXT,
    "opt_out_language" TEXT,
    "email_footer_disclosure" TEXT,
    "default_language" TEXT NOT NULL DEFAULT 'en',
    "supported_languages" TEXT[] DEFAULT ARRAY['en']::TEXT[],
    "last_detect_at" TIMESTAMP(3),
    "last_detect_source" TEXT,
    "detect_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable: social_profile (FK-transitive tenant scope via account_profile_id)
CREATE TABLE "social_profile" (
    "id" TEXT NOT NULL,
    "account_profile_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "handle" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "social_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable: observed_holiday (FK-transitive tenant scope)
CREATE TABLE "observed_holiday" (
    "id" TEXT NOT NULL,
    "account_profile_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "recurring" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "observed_holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable: industry_disclosure (FK-transitive tenant scope)
CREATE TABLE "industry_disclosure" (
    "id" TEXT NOT NULL,
    "account_profile_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "applies_to_channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "industry_disclosure_pkey" PRIMARY KEY ("id")
);

-- CreateTable: account_field_detection (FK-transitive tenant scope)
-- Worker writes (Cohort 5), UI consumes (Cohort 6); schema lands now to keep
-- the migration set atomic.
CREATE TABLE "account_field_detection" (
    "id" TEXT NOT NULL,
    "account_profile_id" TEXT NOT NULL,
    "field_path" TEXT NOT NULL,
    "proposed_value" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "source_url" TEXT,
    "source_snippet" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "decided_at" TIMESTAMP(3),
    "decided_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_field_detection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_profile_tenant_id_key" ON "account_profile"("tenant_id");
CREATE INDEX "account_profile_tenant_id_idx" ON "account_profile"("tenant_id");
CREATE INDEX "social_profile_account_profile_id_idx" ON "social_profile"("account_profile_id");
CREATE INDEX "observed_holiday_account_profile_id_date_idx" ON "observed_holiday"("account_profile_id", "date");
CREATE INDEX "industry_disclosure_account_profile_id_idx" ON "industry_disclosure"("account_profile_id");
CREATE INDEX "account_field_detection_account_profile_id_field_path_idx" ON "account_field_detection"("account_profile_id", "field_path");
CREATE INDEX "account_field_detection_account_profile_id_status_idx" ON "account_field_detection"("account_profile_id", "status");

-- AddForeignKey
ALTER TABLE "account_profile" ADD CONSTRAINT "account_profile_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "social_profile" ADD CONSTRAINT "social_profile_account_profile_id_fkey" FOREIGN KEY ("account_profile_id") REFERENCES "account_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "observed_holiday" ADD CONSTRAINT "observed_holiday_account_profile_id_fkey" FOREIGN KEY ("account_profile_id") REFERENCES "account_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "industry_disclosure" ADD CONSTRAINT "industry_disclosure_account_profile_id_fkey" FOREIGN KEY ("account_profile_id") REFERENCES "account_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "account_field_detection" ADD CONSTRAINT "account_field_detection_account_profile_id_fkey" FOREIGN KEY ("account_profile_id") REFERENCES "account_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
