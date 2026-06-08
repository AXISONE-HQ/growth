---
name: Phase 1 enumeration as code-state-truthing
description: KAN-1109/1116/1119 banked 2026-06-06/07. Phase 1 enumeration's primary value is not "list the files to change" — it's truthing the actual code state. Surfaces dead code + live latent bugs simultaneously, even when the original ticket framing assumed only one or the other.
type: feedback
---

**The pattern**: Phase 1 enumeration is framed as "enumerate the files this change will touch" — but its real value is empirically truthing what exists in the codebase right now. Two orthogonal findings emerge from the same enumeration pass:

- **Dead code** — files with no live callers (delete candidates per `feedback_dead_code_with_latent_schema_bugs_delete_dont_fix.md`)
- **Live latent bugs** — files with active callers but unaddressed bug shapes (fix candidates)

Both surface from the same pass because the enumeration verifies *every* node in the dependency graph, not just the expected ones.

**KAN-1109 cluster instance**: The Prisma snake_case → camelCase sweep was scoped from a grep audit. Phase 1 enumeration of each candidate revealed:
- 4 sites were live (KAN-1106 fix-forward batch) → fix
- 1 site (KAN-1109 objectives.create/update) was dead → delete
- 1 sibling site (KAN-1116 product-catalog) had a different bug class (phantom table) + was dead → delete
- 1 sibling site (KAN-1118 data-quality-dashboard) had no obvious bug but was dead post-refactor → delete

Without per-site enumeration, the original grep audit would have either (a) applied mechanical fixes to all 4 dead candidates or (b) missed the dead-code finding entirely. Phase 1 enumeration recovered both signals from one pass.

**KAN-1119 instance** (sibling): deferred-send-evaluator Phase 1 enumeration verified the cron CTE claim path — surfaced both the live cascade missing-recovery-paths (fix → integration test) AND a sibling state-machine extension untouched (no action needed). Same enumeration pass produced both signals.

## Anti-pattern

Treating Phase 1 enumeration as a planning artifact only:

1. "I already know what files I'm going to change" → skips enumeration, misses dead code adjacent to live changes
2. "The grep audit told me which files" → grep result is a candidate list, not the truth state
3. "Enumeration is overhead before I write code" → skipping enumeration is how dead code accumulates indefinitely

The right move: **treat Phase 1 enumeration as a free codebase audit pass**. Every Phase 1 trace surfaces 1-3 collateral findings about adjacent state.

## Forward discipline

When running Phase 1 enumeration for any non-trivial change:

1. **Verify each candidate file's caller graph**, not just the modified file
2. **Note collateral findings explicitly** in the Phase 1 surface — "while enumerating, I also found X dead + Y latent in Z"
3. **File side-tickets** for the collateral findings if they're out-of-scope for the current PR. Don't bury them
4. **Use enumeration to refine framing**: "the ticket said 11 files; enumeration finds 7 live + 4 dead → scope is 7 fixes + 1 cleanup PR"

This is the **Phase 1 as truthing** discipline. It pays off by producing a smaller PR + a follow-up cleanup ticket instead of a larger PR that preserves dead code.

## Related patterns / memos

- `feedback_dead_code_with_latent_schema_bugs_delete_dont_fix.md` — sibling pattern (delete dead, don't fix)
- `feedback_audits_themselves_have_audit_gaps_re_audit_periodically.md` — sibling pattern (audits miss things; periodic re-audit needed)
- `feedback_grep_based_backlog_grooming_assumes_code_is_live.md` — sibling pattern (grep audits over-scope)
- `feedback_step_0_can_surface_empirical_data_realities_reframing_phase_1_locks.md` — sibling pattern (Step 0 surfaces empirical reality)

## Banked from

- KAN-1109 / KAN-1116 / KAN-1118 dead code cohort — Phase 1 enumeration discipline produced 3 deletion PRs vs 3 mechanical fixes
- KAN-1119 — deferred-send cascade enumeration produced live fix + integration test guard
- Session date: 2026-06-06/07
