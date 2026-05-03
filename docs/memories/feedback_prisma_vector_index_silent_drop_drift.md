# feedback_prisma_vector_index_silent_drop_drift

**Trigger:** Every `prisma migrate dev` run in this repo will spuriously generate `DROP INDEX "knowledge_chunks_embedding_hnsw_idx"` in the migration SQL.

**Root cause:** KAN-706 added the HNSW pgvector index via raw SQL appended to its migration. `schema.prisma` doesn't describe the index (Prisma can't represent vector indexes). Prisma's diff sees the index in the DB after migration replay that isn't in `schema.prisma` → generates DROP.

**Empirical anchor:** Caught on KAN-786 Phase 1 migration during sub-cohort (a) audit (2026-05-02). Migration `20260503003022_add_deal_engagement_kan_786/migration.sql` contained a spurious DROP that would have nuked prod's HNSW index on CI deploy. Caught only by manually `cat`-ing migration.sql line-by-line.

**Workaround until [KAN-787](https://axisone-team.atlassian.net/browse/KAN-787) lands:**

1. After every `prisma migrate dev`, `cat <new-migration-dir>/migration.sql`
2. Manually delete any `DROP INDEX "knowledge_chunks_embedding_hnsw_idx"` line + the `-- DropIndex` section header that wraps it
3. After committing the cleaned migration, manually recreate the index locally if you want local to match prod state:
   ```bash
   psql -h localhost -p 5432 -U $(whoami) growth -c \
     "CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw_idx \
      ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);"
   ```
4. Verify via `grep -E "DROP INDEX|RenameIndex" <new-migration-dir>/migration.sql` — should return zero matches before commit

**Pre-commit grep guard (paste into terminal before any migration commit):**
```bash
grep -rE "DROP INDEX \"knowledge_chunks_embedding_hnsw_idx\"|^-- DropIndex" \
  packages/db/prisma/migrations/<new-migration-dir>/migration.sql \
  && echo "DRIFT DETECTED — strip before commit" || echo "CLEAN"
```

**Also see:**
- `feedback_webhook_200_not_end_to_end_proof` (same class — API succeeded, side effect was wrong)
- `feedback_local_postgres_pgvector_parity_gap_kan_706` (related toolchain — pgvector setup recipe)
- `reference_prisma_db_push` (banned — same database-trust class)

**Status:** Active. Remove this entry once [KAN-787](https://axisone-team.atlassian.net/browse/KAN-787) ships a structural fix.
