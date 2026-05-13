-- CreateEnum
CREATE TYPE "staging_status" AS ENUM ('pending', 'mapping_error', 'dedup_error', 'ready', 'committed', 'skipped');


-- CreateTable
CREATE TABLE "import_staging_contacts" (
    "id" TEXT NOT NULL,
    "import_job_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_row_index" INTEGER NOT NULL,
    "source_row_data" JSONB NOT NULL,
    "staging_status" "staging_status" NOT NULL DEFAULT 'pending',
    "match_decision" JSONB,
    "mapping_error" TEXT,
    "dedup_error" TEXT,
    "target_contact_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "company_name" TEXT,
    "lifecycle_stage" "lifecycle_stage",
    "source" "contact_source",

    CONSTRAINT "import_staging_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_staging_companies" (
    "id" TEXT NOT NULL,
    "import_job_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_row_index" INTEGER NOT NULL,
    "source_row_data" JSONB NOT NULL,
    "staging_status" "staging_status" NOT NULL DEFAULT 'pending',
    "match_decision" JSONB,
    "mapping_error" TEXT,
    "dedup_error" TEXT,
    "target_company_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "name" TEXT,
    "domain" TEXT,
    "industry" TEXT,
    "billing_city" TEXT,
    "billing_country" TEXT,

    CONSTRAINT "import_staging_companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_staging_deals" (
    "id" TEXT NOT NULL,
    "import_job_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_row_index" INTEGER NOT NULL,
    "source_row_data" JSONB NOT NULL,
    "staging_status" "staging_status" NOT NULL DEFAULT 'pending',
    "match_decision" JSONB,
    "mapping_error" TEXT,
    "dedup_error" TEXT,
    "target_deal_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "name" TEXT,
    "value" DECIMAL(12,2),
    "currency" VARCHAR(3),
    "status" "deal_status",
    "expected_close_date" DATE,
    "contact_email" TEXT,
    "company_name" TEXT,
    "pipeline_name" TEXT,
    "stage_name" TEXT,

    CONSTRAINT "import_staging_deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_staging_orders" (
    "id" TEXT NOT NULL,
    "import_job_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_row_index" INTEGER NOT NULL,
    "source_row_data" JSONB NOT NULL,
    "staging_status" "staging_status" NOT NULL DEFAULT 'pending',
    "match_decision" JSONB,
    "mapping_error" TEXT,
    "dedup_error" TEXT,
    "target_order_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "order_number" TEXT,
    "provider_order_id" TEXT,
    "status" "order_status",
    "grand_total" DECIMAL(12,2),
    "currency" VARCHAR(3),
    "placed_at" TIMESTAMP(3),
    "contact_email" TEXT,
    "company_name" TEXT,

    CONSTRAINT "import_staging_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_staging_contacts_import_job_id_staging_status_idx" ON "import_staging_contacts"("import_job_id", "staging_status");

-- CreateIndex
CREATE INDEX "import_staging_contacts_tenant_id_email_idx" ON "import_staging_contacts"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "import_staging_contacts_tenant_id_phone_idx" ON "import_staging_contacts"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "import_staging_contacts_target_contact_id_idx" ON "import_staging_contacts"("target_contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_staging_contacts_import_job_id_source_row_index_key" ON "import_staging_contacts"("import_job_id", "source_row_index");

-- CreateIndex
CREATE INDEX "import_staging_companies_import_job_id_staging_status_idx" ON "import_staging_companies"("import_job_id", "staging_status");

-- CreateIndex
CREATE INDEX "import_staging_companies_tenant_id_domain_idx" ON "import_staging_companies"("tenant_id", "domain");

-- CreateIndex
CREATE INDEX "import_staging_companies_tenant_id_name_idx" ON "import_staging_companies"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "import_staging_companies_target_company_id_idx" ON "import_staging_companies"("target_company_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_staging_companies_import_job_id_source_row_index_key" ON "import_staging_companies"("import_job_id", "source_row_index");

-- CreateIndex
CREATE INDEX "import_staging_deals_import_job_id_staging_status_idx" ON "import_staging_deals"("import_job_id", "staging_status");

-- CreateIndex
CREATE INDEX "import_staging_deals_tenant_id_contact_email_idx" ON "import_staging_deals"("tenant_id", "contact_email");

-- CreateIndex
CREATE INDEX "import_staging_deals_tenant_id_name_idx" ON "import_staging_deals"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "import_staging_deals_target_deal_id_idx" ON "import_staging_deals"("target_deal_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_staging_deals_import_job_id_source_row_index_key" ON "import_staging_deals"("import_job_id", "source_row_index");

-- CreateIndex
CREATE INDEX "import_staging_orders_import_job_id_staging_status_idx" ON "import_staging_orders"("import_job_id", "staging_status");

-- CreateIndex
CREATE INDEX "import_staging_orders_tenant_id_order_number_idx" ON "import_staging_orders"("tenant_id", "order_number");

-- CreateIndex
CREATE INDEX "import_staging_orders_tenant_id_provider_order_id_idx" ON "import_staging_orders"("tenant_id", "provider_order_id");

-- CreateIndex
CREATE INDEX "import_staging_orders_target_order_id_idx" ON "import_staging_orders"("target_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_staging_orders_import_job_id_source_row_index_key" ON "import_staging_orders"("import_job_id", "source_row_index");

-- AddForeignKey
ALTER TABLE "import_staging_contacts" ADD CONSTRAINT "import_staging_contacts_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_staging_contacts" ADD CONSTRAINT "import_staging_contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_staging_companies" ADD CONSTRAINT "import_staging_companies_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_staging_companies" ADD CONSTRAINT "import_staging_companies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_staging_deals" ADD CONSTRAINT "import_staging_deals_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_staging_deals" ADD CONSTRAINT "import_staging_deals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_staging_orders" ADD CONSTRAINT "import_staging_orders_import_job_id_fkey" FOREIGN KEY ("import_job_id") REFERENCES "import_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_staging_orders" ADD CONSTRAINT "import_staging_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

