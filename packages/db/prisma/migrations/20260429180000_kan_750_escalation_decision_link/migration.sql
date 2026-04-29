-- KAN-750 — Escalation reconciliation: link to Decision + context payload.
--
-- Additive-only. Reconciles the schema mismatch between runFreeform (which
-- silently failed on decisionId/reason/priority/context fields that didn't
-- exist) and runAgentic (canonical shape). Adds decision_id (nullable FK,
-- ON DELETE SET NULL) + context (nullable JSONB) so both paths can write a
-- complete + queryable shape, and the Escalation → Decision join is
-- available for KAN-754 (S4.1 Recommendations UI).
--
-- 4th DDL apply on the v4 deploy-api migrate chain. The chain is structurally
-- proven (KAN-738/741/742, three distinct schema shapes, all attempt=1).
-- This is routine operational use of the proven pattern; not a validation
-- milestone.

ALTER TABLE "escalations"
  ADD COLUMN "decision_id" TEXT,
  ADD COLUMN "context" JSONB;

CREATE INDEX "escalations_decision_id_idx" ON "escalations"("decision_id");

ALTER TABLE "escalations"
  ADD CONSTRAINT "escalations_decision_id_fkey"
  FOREIGN KEY ("decision_id") REFERENCES "decisions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
