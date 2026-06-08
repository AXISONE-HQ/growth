---
name: Dead code hides typecheck errors in baseline
description: KAN-1109/1116/1118 banked 2026-06-07. The typecheck baseline (138 errors in packages/api) included errors INSIDE dead code (broken Prisma fields in unused routers, phantom-table references). Deleting dead code IMPROVES the baseline because file-internal errors disappear. The corollary: a chronically-red baseline likely contains hidden dead-code waste.
type: feedback
---

**The pattern**: A workspace has a chronically-red typecheck baseline (e.g., 138 errors). Some fraction of those errors live INSIDE files that have no callers. Deleting the dead files reduces the baseline by N errors at once — and the substitute-gate `comm -23` check stays cleaner because the cohort of errors that's been "expected" is actually a mix of (a) real cascade pain + (b) hidden dead-code waste.

**KAN-1116/1118 instance**: `product-catalog.ts` (1097 LoC) contained ~12 typecheck errors that lived inside the file (broken Prisma fields, phantom table types). `data-quality-dashboard.ts` (785 LoC) contained another ~8 errors. Deleting both removed ~20 errors from the packages/api baseline (~138 → ~118 if measured before/after both PRs). The errors had been "expected" because they appeared in every Build run; they were dead code, not cascade pain.

This is why the substitute-gate `comm -23` discipline matters: it gates new PRs on ZERO-NEW errors, but the baseline itself can shrink when dead code is removed.

## Anti-pattern

Treating the baseline as immutable:

1. "138 errors is the baseline; new PRs must zero-new against it" → true short-term; baseline can SHRINK on dead-code deletion
2. "We accept this baseline because fixing it would be too much work" → some fraction is dead-code waste, not cascade pain
3. "The baseline is the cost of the legacy" → some of it is the cost of the legacy; some is just trash

The right move: **periodically grep the baseline error file list for caller-less files**. Dead-code cleanup is a 1-PR baseline improvement.

## Forward discipline

For each chronically-red baseline:

1. **Capture the baseline error list** (e.g., `npm run typecheck 2>&1 | grep "error TS" | sort -u > baseline.txt`)
2. **For each unique file path in the baseline**, grep for callers in apps/ + packages/. Caller-less = delete candidate
3. **File a dead-code deletion PR** for each caller-less file; baseline shrinks per delete
4. **Re-measure baseline** after each delete-PR; the delta = hidden dead-code waste recovered
5. **The substitute-gate discipline remains intact** — dead-code deletes are "negative-delta" against baseline, which always passes `comm -23` (PR removes errors from main)

This is the **dead-code shrinks baseline** discipline. Sibling to `feedback_dead_code_with_latent_schema_bugs_delete_dont_fix.md` (the per-file deletion discipline) and `feedback_grep_based_backlog_grooming_assumes_code_is_live.md` (the grep-vs-liveness gap).

## Related patterns / memos

- `feedback_dead_code_with_latent_schema_bugs_delete_dont_fix.md` — sibling pattern (per-file delete discipline)
- `feedback_typecheck_chronically_red_masks_cascade_errors_unmask_on_fix.md` — sibling pattern (chronically-red mask)
- `feedback_grep_based_backlog_grooming_assumes_code_is_live.md` — sibling pattern (grep over-scopes)
- `feedback_comm23_guard_chronically_red_build` — substitute-gate discipline this leverages

## Banked from

- KAN-1109 / KAN-1116 / KAN-1118 — three deletion PRs each shrank the packages/api typecheck baseline by ~5-12 errors per delete
- Session date: 2026-06-07
