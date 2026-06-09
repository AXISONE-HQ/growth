-- KAN-1140 Phase 3 PR 9a — Tenant-configurable parsing rules (SUBSTRATE).
--
-- Adds two new tables (`parse_rules` + `parse_rule_versions`) + indexes.
-- Pure additive; no backfill. Migration is a no-op for existing rows.
--
-- # Q-ADD-4 lock — nullable composite scope discriminator
--
-- parse_rules.fingerprint_id (nullable FK) + format (nullable text) +
-- vendor (nullable text) form the cascade scope. Lookup is a single SQL
-- query: `WHERE (fingerprint_id = $1 OR fingerprint_id IS NULL) AND
-- (format = $2 OR format IS NULL) AND (vendor = $3 OR vendor IS NULL)`.
-- Application-layer specificity sort selects the most-specific match
-- per field.
--
-- # Q7 lock — hybrid versioning
--
-- parse_rule_versions.rule_id is @unique — exactly ONE snapshot per rule.
-- Updates upsert into this table BEFORE writing the new body to parse_rules.
-- Restore promotes the snapshot back to parse_rules and re-snapshots the
-- displaced body (the displaced becomes the new previous).
--
-- # FK cascade semantics
--
-- - parse_rules.fingerprint_id → parse_fingerprints.id ON DELETE SET NULL:
--   fingerprint delete preserves the rule with broader cascade scope.
-- - parse_rules.tenant_id → tenants.id ON DELETE RESTRICT (no row);
--   matches existing parse_fingerprints tenant FK pattern.
-- - parse_rule_versions.rule_id → parse_rules.id ON DELETE CASCADE:
--   rule delete drops the single retained snapshot; audit log retains
--   full history.
--
-- # Index design
--
-- - (tenant_id, fingerprint_id) — fingerprint-scoped cascade lookup
-- - (tenant_id, format, vendor) — format/vendor-scoped cascade lookup
-- - (tenant_id) on parse_rule_versions — tenant-scoped list queries

-- CreateTable
CREATE TABLE "parse_rules" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "fingerprint_id" TEXT,
    "format" TEXT,
    "vendor" TEXT,
    "body" JSONB NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_by" TEXT NOT NULL,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parse_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parse_rule_versions" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "archived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_by" TEXT NOT NULL,

    CONSTRAINT "parse_rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "parse_rules_tenant_id_fingerprint_id_idx" ON "parse_rules"("tenant_id", "fingerprint_id");

-- CreateIndex
CREATE INDEX "parse_rules_tenant_id_format_vendor_idx" ON "parse_rules"("tenant_id", "format", "vendor");

-- CreateIndex
CREATE UNIQUE INDEX "parse_rule_versions_rule_id_key" ON "parse_rule_versions"("rule_id");

-- CreateIndex
CREATE INDEX "parse_rule_versions_tenant_id_idx" ON "parse_rule_versions"("tenant_id");

-- AddForeignKey
ALTER TABLE "parse_rules" ADD CONSTRAINT "parse_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parse_rules" ADD CONSTRAINT "parse_rules_fingerprint_id_fkey" FOREIGN KEY ("fingerprint_id") REFERENCES "parse_fingerprints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parse_rule_versions" ADD CONSTRAINT "parse_rule_versions_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "parse_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
