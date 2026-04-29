-- KAN-741 — Sprint 3 / S3.11 Lead Inbox schema.
--
-- Adds:
--   1. tenants.inbox_slug TEXT UNIQUE NULLABLE
--      Per-tenant slug forming the inbox address. Default null; admin
--      regenerates via tRPC mutation. Unique prevents cross-tenant collision.
--   2. tenants.inbox_dkim_strict BOOLEAN NOT NULL DEFAULT true
--      Per-tenant DKIM enforcement override. True = reject DKIM=fail AND
--      DKIM=none. False = accept DKIM=none (lenient mode for legacy mail).
--   3. lead_inbox_events table
--      Audit + idempotency row per inbound webhook hit. resend_email_id
--      unique constraint is the long-window dedup key (Redis is short-window).
--
-- Additive-only — no destructive ops. v4 RUN-branch second data point on
-- the post-KAN-723 corpus (KAN-738's migration was the first).

-- AlterTable: add inbox_slug to tenants
ALTER TABLE "tenants" ADD COLUMN "inbox_slug" TEXT;
CREATE UNIQUE INDEX "tenants_inbox_slug_key" ON "tenants"("inbox_slug");

-- AlterTable: add inbox_dkim_strict to tenants
ALTER TABLE "tenants" ADD COLUMN "inbox_dkim_strict" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable: lead_inbox_events
CREATE TABLE "lead_inbox_events" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "inbox_address" TEXT NOT NULL,
    "resend_email_id" TEXT,
    "from_address" TEXT NOT NULL,
    "subject" TEXT,
    "body_preview" TEXT,
    "attachment_count" INTEGER NOT NULL DEFAULT 0,
    "spf_pass" BOOLEAN NOT NULL,
    "dkim_pass" BOOLEAN NOT NULL,
    "status" TEXT NOT NULL,
    "rejection_reason" TEXT,
    "created_contact_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_inbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique on resend_email_id for permanent dedup
CREATE UNIQUE INDEX "lead_inbox_events_resend_email_id_key" ON "lead_inbox_events"("resend_email_id");

-- CreateIndex: tenant + created_at for time-window queries
CREATE INDEX "lead_inbox_events_tenant_id_created_at_idx" ON "lead_inbox_events"("tenant_id", "created_at");

-- CreateIndex: tenant + status for "all rejected emails in window" queries
CREATE INDEX "lead_inbox_events_tenant_id_status_idx" ON "lead_inbox_events"("tenant_id", "status");

-- AddForeignKey: lead_inbox_events → tenants
ALTER TABLE "lead_inbox_events" ADD CONSTRAINT "lead_inbox_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
