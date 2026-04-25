-- CreateTable
CREATE TABLE "action_outcomes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "decision_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "action_outcomes_tenant_id_decision_id_idx" ON "action_outcomes"("tenant_id", "decision_id");

-- CreateIndex
CREATE INDEX "action_outcomes_tenant_id_contact_id_occurred_at_idx" ON "action_outcomes"("tenant_id", "contact_id", "occurred_at");

-- CreateIndex
CREATE INDEX "action_outcomes_tenant_id_action_status_occurred_at_idx" ON "action_outcomes"("tenant_id", "action", "status", "occurred_at");

