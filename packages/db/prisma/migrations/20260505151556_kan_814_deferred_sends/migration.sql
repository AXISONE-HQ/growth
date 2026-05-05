-- KAN-814 — Deferred outbound queue.
--
-- Persistent storage for sends that Send Policy returns 'defer' on (e.g.,
-- outside tenant send window). A 5-min cron worker re-evaluates Send Policy
-- on pending rows whose defer_until has elapsed. On allow → dispatch +
-- mark dispatched. On still-defer → increment attempts + push defer_until
-- forward. After 12 attempts (~24h) → expired.
--
-- Supersession: a fresh inbound on the same (deal_id, contact_id) marks
-- pending rows cancelled with cancelReason='superseded_by_fresh_inbound'
-- BEFORE Brain re-evaluates, so a stale defer doesn't double-send after
-- the new inbound's outbound already fires.

-- CreateTable
CREATE TABLE "deferred_sends" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "deal_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "defer_until" TIMESTAMP(3) NOT NULL,
    "defer_reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deferred_sends_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — cron worker scan: pending rows whose defer_until has elapsed
CREATE INDEX "deferred_sends_status_defer_until_idx" ON "deferred_sends"("status", "defer_until");

-- CreateIndex — supersession lookup: pending rows for a (tenant, deal, contact) tuple
CREATE INDEX "deferred_sends_tenant_id_deal_id_contact_id_status_idx" ON "deferred_sends"("tenant_id", "deal_id", "contact_id", "status");

-- CreateIndex — tenant-bounded recency queries (audit dashboards, expired-row cleanup)
CREATE INDEX "deferred_sends_tenant_id_created_at_idx" ON "deferred_sends"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "deferred_sends" ADD CONSTRAINT "deferred_sends_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deferred_sends" ADD CONSTRAINT "deferred_sends_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deferred_sends" ADD CONSTRAINT "deferred_sends_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
