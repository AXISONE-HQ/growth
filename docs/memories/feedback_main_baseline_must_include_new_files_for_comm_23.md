---
name: comm -23 baseline must use git stash --include-untracked, not git checkout -- <path>
description: KAN-1098 fixup 2026-06-05. `git checkout main -- <path>` is a NO-OP for files untracked on main. New PR files persist through the "baseline" run, contaminating the baseline with PR errors, masking comm -23 delta to 0-new when actual delta exists.
type: feedback
---

**KAN-1098 baseline contamination 2026-06-05**: I ran the comm -23 zero-new gate for apps/api after KAN-1098 edits. Used `git checkout main -- apps/api packages/api` to "reset" working tree to main for the baseline tsc run. comm -23 reported 0 new errors.

CI Build job then failed with 2 NEW errors in my NEW test file `apps/api/src/__tests__/kan-1098-composer-scenario-integration.test.ts`. My local baseline had the test file PRESENT (because checkout doesn't remove untracked files) — so the test file's errors were captured in BOTH the PR errors AND the "main baseline" errors. comm -23 saw the errors in both lists and reported them as not-new.

## The discipline rule

For comm -23 zero-new gate, true main baseline requires **removing PR untracked files**:

```bash
# WRONG — leaves PR-added files in working tree
git checkout main -- apps/api packages/api
npx tsc --noEmit -p apps/api 2>&1 | grep 'error TS' | sort -u > main_errors.txt
git checkout HEAD -- apps/api packages/api

# RIGHT — true main reset
git stash --include-untracked
npx tsc --noEmit -p apps/api 2>&1 | grep 'error TS' | sort -u > main_errors.txt
git stash pop
```

`git stash --include-untracked` saves AND removes new files; `git stash pop` restores. The baseline run sees the working tree exactly as main would.

## Why the contamination is invisible

Both lists contain the same errors with the same line/column/file. comm -23 looks for lines in `pr_errors` that are NOT in `main_errors`. Identical entries on both sides → comm -23 says "0 new" — even though the entries shouldn't be in main at all.

The bug exists if and only if the PR adds NEW source files that themselves emit errors. Modified files don't trigger this because the "baseline" sees the unmodified main version of the same file.

## The fixed protocol

When checking comm -23 zero-new on a PR with new source files:

1. `git status` — note which files are new (untracked or recently-added)
2. Compute PR errors: `npx tsc --noEmit -p <project> 2>&1 | grep error | sort -u > pr.txt`
3. `git stash --include-untracked` — reset working tree fully
4. Compute baseline: `npx tsc --noEmit -p <project> 2>&1 | grep error | sort -u > main.txt`
5. `git stash pop` — restore PR state
6. `comm -23 pr.txt main.txt | wc -l` — TRUE delta count

## Anti-pattern (what we did in KAN-1098)

Step 2's `checkout main -- <path>` was incomplete. The test file (added in PR, untracked on main) persisted through step 3's baseline run. comm -23 missed the 2 TS6059 errors. CI Build caught them post-push. Cost: 1 extra CI iteration + 1 fixup commit.

## Sibling memo

- `feedback_comm23_counting_basis_pin` — raw line count vs sort -u class count distinction
- `feedback_comm23_guard_chronically_red_build` — chronically-red Build IS the gate-substitute when comm -23 is true

## Forward discipline

When integrating the comm -23 gate into pre-push local CI scripts, the canonical baseline reset is `git stash --include-untracked`. Document the gotcha in the script's header so future maintainers don't regress to `checkout -- <path>`.

Bounded ~10-second addition to local CI gate workflow. Prevents the false-zero-new escape.
