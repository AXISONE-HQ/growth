---
name: Grep-based backlog grooming assumes code is live
description: KAN-1112/1118 banked 2026-06-07. Backlog scoped by grep ("find all $queryRaw* calls, add integration tests for each") assumes every match is live code. Some matches are in dead routers / dead services. The backlog over-scopes work that doesn't need to be done — the dead code should be deleted instead.
type: feedback
---

**The pattern**: A discipline gap is identified ("we need integration tests for every `$queryRaw*` call"). A grep audit produces a backlog ("17 sites; 17 integration test tickets"). Some of those sites are in dead code — files with no live caller — that the grep audit didn't verify. The backlog over-scopes; some tickets resolve as "delete the dead code" instead of "add the integration test."

**KAN-1112 → KAN-1118 instance**: KAN-1112 established the integration-test discipline for raw SQL. The original retrofit backlog was scoped via `grep -rn "$queryRaw" packages/api apps/api`. KAN-1116 + KAN-1118 surfaced two dead routers (`product-catalog.ts` + `data-quality-dashboard.ts`) inside the backlog — both with `$queryRaw*` usages, both with zero callers. The right resolution was deletion (PRs #292 + #295), not integration test addition.

The grep audit's signal is "this file has a `$queryRaw` call." The audit cannot answer "is this file live?". Both questions must be answered before the backlog is finalized.

## Anti-pattern

Treating grep audits as authoritative backlogs:

1. "17 grep matches → 17 backlog tickets" → some are dead code; over-scopes
2. "We'll figure out which ones are live when we get to each ticket" → defers the dead-code finding to per-ticket effort
3. "The discipline applies to every match" → discipline applies to live code; dead code should be deleted, not tested

The right move: **caller-check every grep match BEFORE finalizing the backlog**. The backlog should be sorted into (a) live → discipline-required, (b) dead → delete.

## Forward discipline

When scoping a backlog from a grep audit:

1. **Run the grep audit** to produce the candidate list
2. **For each candidate, grep for callers** (imports, tRPC procedure names, URLs, etc.) — confirm live vs dead BEFORE adding to the backlog
3. **Split the backlog into (a) live: apply-the-discipline + (b) dead: delete-PR**
4. **Reconcile the backlog totals**: "audit found 17; 14 live + 3 dead → 14 discipline tickets + 1 cleanup PR for 3 deletions"
5. **Document the live/dead split in the parent epic** — the deletion work is real work; budget for it

This is the **grep-vs-liveness gap**. Sibling to `feedback_dead_code_with_latent_schema_bugs_delete_dont_fix.md` and `feedback_audits_themselves_have_audit_gaps_re_audit_periodically.md`.

## Related patterns / memos

- `feedback_dead_code_with_latent_schema_bugs_delete_dont_fix.md` — sibling pattern (the delete-not-fix discipline that this audits FOR)
- `feedback_phase_1_enumeration_as_code_state_truthing.md` — sibling pattern (enumeration over grep)
- `feedback_dead_code_hides_typecheck_errors_in_baseline.md` — sibling pattern (deletion improves baseline)
- `feedback_audits_themselves_have_audit_gaps_re_audit_periodically.md` — sibling pattern (audits miss things)

## Banked from

- KAN-1112 / KAN-1116 / KAN-1118 — original integration-test backlog over-scoped to 3 dead routers; deletion PRs landed instead
- Session date: 2026-06-07
