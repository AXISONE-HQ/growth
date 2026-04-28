-- KAN-738 — Sprint 3 / S3.1 agentic loop seam.
--
-- Adds:
--   1. tenants.agentic_mode_enabled BOOLEAN NOT NULL DEFAULT false
--      Per-tenant flag controlling shadow vs live agentic dispatch.
--   2. agentic_shadow_decisions table
--      One row per shadow-mode comparison (rules-based + agentic both ran).
--      Live mode does NOT write here — agentic decision goes through the
--      standard decisions table.
--
-- Additive-only (new column with non-null default + new table). No destructive
-- ops. KAN-723 RUN-path anchor — first true DDL apply via the v4 single-step
-- migrate workflow.

-- AlterTable: add agentic_mode_enabled to tenants
ALTER TABLE "tenants" ADD COLUMN "agentic_mode_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: agentic_shadow_decisions
CREATE TABLE "agentic_shadow_decisions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "decision_id" TEXT,
    "agentic_decision_payload" JSONB NOT NULL,
    "rules_decision_payload" JSONB NOT NULL,
    "divergence_flags" TEXT[],
    "agentic_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agentic_shadow_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: tenant + created_at for time-window queries
CREATE INDEX "agentic_shadow_decisions_tenant_id_created_at_idx" ON "agentic_shadow_decisions"("tenant_id", "created_at");

-- CreateIndex: tenant + contact for per-contact divergence history
CREATE INDEX "agentic_shadow_decisions_tenant_id_contact_id_idx" ON "agentic_shadow_decisions"("tenant_id", "contact_id");

-- CreateIndex: tenant + agentic_error for "failed agentic runs in window" queries
CREATE INDEX "agentic_shadow_decisions_tenant_id_agentic_error_idx" ON "agentic_shadow_decisions"("tenant_id", "agentic_error");

-- AddForeignKey: agentic_shadow_decisions → tenants
ALTER TABLE "agentic_shadow_decisions" ADD CONSTRAINT "agentic_shadow_decisions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
