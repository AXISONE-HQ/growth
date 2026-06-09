-- KAN-1140 Phase 3 PR 8 — Capability announcement state machine.
--
-- Adds 4 columns + 1 index to parse_fingerprints. Pure additive; zero
-- backfill needed (default 'pending' covers all existing rows). Next
-- inbound that UPSERTs a (tenant_id, structure_hash, sender_domain_hash)
-- tuple runs the auto-suggest predicate (Q3 lock: occurrenceCount >= 5
-- AND format_confidence = 'high' OR reclassify_count >= 1) and promotes
-- naturally if threshold met.
--
-- # Q2 lock — codebase-convention pin
--
-- supportStatus is a TEXT column (NOT a Prisma enum type) per the
-- established convention at Action.status (line 847) and DeferredSend.status
-- (line 1963). Value vocabulary documented in the model docstring:
-- `pending | suggested | supported | unsupported`.
--
-- # Q9 lock — backward compatibility
--
-- ALTER TABLE adds support_status with NOT NULL + DEFAULT 'pending'.
-- Postgres applies the default to existing rows in-place (no rewrite on
-- recent versions). The other 3 columns (suggested_at, supported_at,
-- supported_by) are nullable; no default needed.
--
-- # Q8 lock — strict per-tenant isolation
--
-- (tenant_id, support_status) composite index backs the Settings UI
-- status filter (`WHERE tenant_id = ? AND support_status = ?`) AND the
-- auto-suggest predicate's pending-only short-circuit.

-- AlterTable
ALTER TABLE "parse_fingerprints" ADD COLUMN "support_status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "parse_fingerprints" ADD COLUMN "suggested_at" TIMESTAMP(3);
ALTER TABLE "parse_fingerprints" ADD COLUMN "supported_at" TIMESTAMP(3);
ALTER TABLE "parse_fingerprints" ADD COLUMN "supported_by" TEXT;

-- CreateIndex
CREATE INDEX "parse_fingerprints_tenant_id_support_status_idx" ON "parse_fingerprints"("tenant_id", "support_status");
