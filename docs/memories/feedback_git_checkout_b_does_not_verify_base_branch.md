---
name: git checkout -b does not verify intended base branch
description: KAN-1100 PR #279 anomaly 2026-06-05. `git checkout -b <new>` creates from current HEAD without verifying intended base. `git pull origin main` returns "Already up to date" even when current branch is NOT main (it only checks the current branch's upstream). Squash-merged PR can inadvertently bundle unrelated content from a prior branch.
type: feedback
---

**KAN-1100 PR #279 procedural anomaly 2026-06-05**: After landing PR #278 (memo-only docs branch), I executed:

```bash
git checkout main
git pull origin main           # "Already up to date"
git checkout -b feat/kan-1100-cognitive-metrics-settings-tab
```

I read "Already up to date" as confirmation I was on main. But the previous step `git checkout main` either failed silently or I was reading the wrong state — my actual HEAD was at `d6ee338` (the memo branch commit), NOT at `a541665` (main HEAD at the time, post-KAN-1098 merge).

The new branch was created FROM `d6ee338`, bringing the 6 memo files with it as a base. When PR #279 was squash-merged, the squash bundled those memo files into the KAN-1100 commit. PR #278 became redundant (content already shipped via #279); closed as superseded.

Functionally: no impact. All files correct, all on main. Procedurally: one squash bundles two semantically distinct changes; PR #279 commit message doesn't mention memos.

## The discipline rule

Before `git checkout -b <new-branch>`, verify HEAD matches the intended base:

```bash
git status                    # confirm current branch + clean tree
git rev-parse HEAD            # confirm current commit
git rev-parse origin/main     # confirm main HEAD
# HEAD must match origin/main if you intend to base from main
```

OR force the base explicitly regardless of current branch state:

```bash
git checkout -b feat/kan-XXXX origin/main
```

This form bypasses "current HEAD" ambiguity — the new branch is created from `origin/main` no matter what you're currently on.

## Why `git pull` doesn't help

`git pull origin main` (or any form) only updates the **current branch's upstream**. If your current branch is `docs/kan-1098-session-memos` and you `git pull origin main`, git pulls `origin/main` and merges it INTO your current branch (or fails on diverged history) — it does NOT switch you to main.

"Already up to date" can mean either:
- You ARE on main, and main is up to date — OR
- You're on a different branch whose upstream is in sync (no fetch-time delta against `origin/main`)

The message is ambiguous about which case applies.

## Recovery posture

When discovered POST-merge:
- **Accept the bundle + post forensic comments** on the squash PR explaining the contents. Cleanup cost (revert commit + re-ship via separate PR) typically exceeds the procedural cost of the bundle (one squash with mixed content).
- **Close the redundant secondary PR** with a transparent comment pointing to the squash commit that absorbed its content.
- **Bank a discipline memo** (this file) to prevent recurrence.

When discovered PRE-merge:
- `git rebase --onto origin/main <wrong-base> <new-branch>` to re-anchor the branch on the intended base
- Verify the rebase removed the unintended commits via `git log origin/main..HEAD`
- Force-push (`-f` or `--force-with-lease`) to update the PR branch — note: only safe before review begins; force-push after review is its own discipline boundary

## Sibling memos

- `feedback_main_baseline_must_include_new_files_for_comm_23` — `git checkout main -- <path>` is a no-op for untracked files; uses `git stash --include-untracked` instead. Same family: git surface idioms that look correct but silently don't do what you expect.
- `feedback_dry_run_infra` — verify state before destructive operations; this memo extends the pattern to branch-base verification before branching operations.

## Forward discipline checklist (one-line)

```bash
git rev-parse HEAD origin/main && echo "match? compare above" && git checkout -b feat/<ticket> origin/main
```

If the two SHAs match → you're on main; `git checkout -b` defaults to current HEAD (main); safe.
If they differ → use the explicit `origin/main` form to force the base regardless of current state.

Bounded ~3-second addition to PR-branching workflow. Prevents bundle-mix at squash-merge time.
