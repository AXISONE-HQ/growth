# feedback_prd_path_systematic_error_apps_vs_packages

**Trigger:** PRD §4 spec for KAN-786 Phase 1 referenced every domain service at `apps/api/src/services/...` but actual repo layout has them at `packages/api/src/services/...`. Three orthogonal mistakes in the same section: wrong file path (apps/api vs packages/api), wrong import path (@growth/db vs @prisma/client), and wrong service shape (class vs module functions). Caught during sub-cohort (b) audit before any code was written.

**Empirical anchor:** Sub-cohort (b) execution on 2026-05-03. Pre-flight ground-truthing of `apps/api/src/services/` revealed only 5 utility files (api-idempotency, api-key-auth, api-rate-limit, knowledge-ingest-publisher, redis-client) — clearly not where domain services live. `find ./packages/api ./apps/api -name "threshold-gate.ts" -o -name "agentic-tools.ts"` confirmed all 4 services PRD §4 referenced actually live at `packages/api/src/services/`. Single 30-second `find` would have caught this at PRD-write time.

PRD §4 had ALL of:
- Wrong file path: `apps/api/src/services/threshold-gate.ts` (doesn't exist) vs `packages/api/src/services/threshold-gate.ts` (actual)
- Wrong import path: `from '@growth/db'` (alias not wired per CLAUDE.md gotcha #2) vs `from '@prisma/client'` (canonical pattern in apps/api/src/router.ts:4)
- Wrong service shape: `class EngagementService` (not used elsewhere in directory) vs module-scoped exported functions taking `prisma` as first arg (sibling convention in agentic-tools.ts, threshold-gate.ts)

Three mistakes individually plausible; collectively a flag the PRD wasn't ground-truthed against actual repo state.

---

## Pattern

PRD authors specifying file paths or import patterns must run `ls`/`grep`/`find` against actual repo layout **before committing the spec**. "Where do siblings of this thing live?" is a cheap empirical check that prevents a class of spec-vs-reality drift that compounds across sub-cohorts.

If PRD §4 had been wrong but only on PR review, reviewers might have caught one of the three errors. With three orthogonal errors, reviewers either miss one (cohort-shrinking erodes) or kick the PRD back through multiple round-trips. Ground-truthing at write time is cheaper than either.

---

## Discipline going forward — PRD authors

Before specifying any "create file X" or "edit file Y" instruction, verify the path empirically:

```bash
# "Where do existing services live?"
find apps packages -type f -name "*.ts" -path "*/services/*" \
  | grep -v node_modules | grep -v dist | head -10

# "Does this specific path I'm about to spec exist?"
ls apps/api/src/services/threshold-gate.ts 2>&1 \
  || ls packages/api/src/services/threshold-gate.ts 2>&1
```

Before specifying any import path, grep for an existing usage:

```bash
# "Is @growth/db actually imported anywhere?"
grep -rn "from ['\"]\@growth/db" apps/ packages/ --include='*.ts' | head -3
# Returns zero → wrong alias

# "What's the canonical Prisma import pattern?"
grep -rn "from ['\"]\@prisma/client" apps/api/src/ --include='*.ts' | head -3
# Returns multiple hits → use this
```

Before specifying a service shape (class vs functions), examine 2-3 sibling implementations:

```bash
# "How are existing services in this directory structured?"
head -30 packages/api/src/services/agentic-tools.ts
head -30 packages/api/src/services/threshold-gate.ts
head -30 packages/api/src/services/behavioral-learner.ts
# Match what they do — don't introduce the first class-based service
# in a directory of module-scoped functions
```

---

## Discipline going forward — PRD reviewers

When reviewing PRDs that list file paths, sample 1-2 paths and confirm they exist (or are creatable in the expected directory). 2-minute sanity check vs. the cost of cross-sub-cohort drift compounding (sub-cohorts (c) and (d) would have hit the same bug if not corrected at (b)).

Same applies to import paths — `grep` for the import alias once before approving the PRD; if it returns nothing, the alias isn't wired.

---

## Empirical detail

KAN-786 PRD §4 path errors discovered + corrected in commit `15723a0` on `docs/phase-1-prd` (PR #91). The amendment was reviewed alongside sub-cohort (b) work — same window-of-freshness pattern as the other in-flight PRD edits.

PRD §4 had the agentic-tools.ts path correct (1/4) and threshold-gate / behavioral-learner / engagement-service paths wrong (3/4). Mixed correctness suggests the author may have ground-truthed one path then assumed the rest by analogy — explicitly running `find` for each sibling would have surfaced the mismatch.

---

## Cross-references

- `docs/prds/phase-1-deal-engagement.md` — §4 amended in commit `15723a0`
- [KAN-786](https://axisone-team.atlassian.net/browse/KAN-786) — Phase 1 implementation ticket
- [`feedback_local_postgres_pgvector_parity_gap_kan_706.md`](./feedback_local_postgres_pgvector_parity_gap_kan_706.md) — sibling memory entry (5-layer recipe)
- [`feedback_prisma_vector_index_silent_drop_drift.md`](./feedback_prisma_vector_index_silent_drop_drift.md) — sibling memory entry (KAN-787)
- CLAUDE.md gotcha #2 — `@growth/api` alias is broken; same class as `@growth/db` mistake

---

## Status

**Active.** Pattern applies to all future PRDs in this repo. Retiring conditions: (a) team standardizes on a different code-organization convention that makes path-spec drift impossible (e.g., enforced barrel exports), or (b) automated PRD lint that grep-checks every code-fenced path against the repo before merge.
