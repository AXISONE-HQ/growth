-- KAN-936 — Formalize Deal.ownerId + Company.ownerId → User FK relations.
--
-- Pre-flight check (run 2026-05-20 against PROD) confirmed:
--   - 0 dangling owner_id values in deals
--   - 0 dangling owner_id values in companies
--   - 0 rows with non-null owner_id in either table
-- So the ADD CONSTRAINT applies against an effectively empty (NULL-only)
-- column. Zero risk of FK violation on apply.
--
-- Migration shape: 2× ADD CONSTRAINT statements. Non-destructive (no data
-- modification). Each acquires ShareRowExclusiveLock on the child table
-- briefly to add the constraint metadata + validate existing rows (all
-- NULL → instant validation).
--
-- ON DELETE SET NULL: when a User row is deleted, dependent Deal/Company
-- rows have their owner_id cleared (matches Prisma's default behavior for
-- optional `@relation` declarations). Prevents cascade-delete of business
-- data when a user leaves.
--
-- ON UPDATE CASCADE: standard Prisma behavior; safe because user.id is a
-- stable UUID @default(uuid()) that doesn't change in practice.

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "companies" ADD CONSTRAINT "companies_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
