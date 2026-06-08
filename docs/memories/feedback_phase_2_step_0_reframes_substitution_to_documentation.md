---
name: Phase 2 Step 0 routinely reveals Phase 1's substitution doesn't apply — reframe to documentation
description: KAN-1132 PR 1 + KAN-1131 PR 2 banked 2026-06-08. When Phase 1 projects "substitute X for Y across N sites," Phase 2 Step 0 enumeration often reveals the substitution's premise doesn't hold at most sites. Reframe disposition: documentation-only PR + ~1 genuine fix instead of N substitutions. Pattern locked across 2 instances this session.
type: feedback
---

**The pattern**: Phase 1 trace projects a mechanical substitution at N sites ("replace `$X` with `$Y` everywhere"). Phase 2 Step 0 enumeration runs against the actual code. Result: only 1-2 sites genuinely need the substitution; the rest are intentional uses of `$X` for non-buggy reasons. Disposition reframes from "substitute at N sites" to "documentation-only PR locking in the audit finding + 1 genuine fix."

This is the **substitute-becomes-documentation reframe**.

**KAN-1132 PR 1 instance**: Phase 1 projected substituting hardcoded `$` symbols with `MoneyDisplay` component at ~12 sites. Step 0 revealed 5 of the projected sites were intentional USD-locked admin/observability displays (LLM cost dashboards, internal billing) where USD precision is correct + tenant-currency aware MoneyDisplay would be wrong. Disposition: docs-only PR with 31 LoC of inline comments locking the USD-lock finding + zero substitutions. PR #297 shipped.

**KAN-1131 PR 2 instance**: Phase 1 projected substituting raw `toLocaleDateString()` with `fmt-date.ts` UTC-locked helper at ~11 sites. Step 0 revealed 14 of 15 sites render `DateTime` instants (not `@db.Date` calendar days); UTC-locking those would over-correct. Only 1 site (`holiday-list.tsx`, the genuine `@db.Date` source) needed the fix. Disposition: docs-only PR with 13 USER-tz intent comments + 1-line fix + helper docstring scope-lock. PR #300 shipped.

Two instances this session locked the pattern. The reframe shape is identical: scope-lock at the helper (forward discipline) + per-site documentation (lock the audit finding) + the ~1 genuine fix.

## Anti-pattern

Treating Phase 1's substitution plan as authoritative:

1. "Phase 1 said substitute at N sites; let me substitute" → most substitutions are wrong; PR pollutes
2. "Step 0 enumeration is overhead before building" → enumeration IS the build savings
3. "We'll fix the wrong substitutions in code review" → reviewers can't catch every mis-applied substitution; the audit must reframe

The right move: **let Phase 2 Step 0 authoritatively reframe disposition**. If only 1 of N sites needs the substitution, the PR shape changes from "substitute everywhere" to "document everywhere + fix the 1 site."

## Forward discipline

When Phase 1 projects a multi-site substitution:

1. **Step 0 enumeration is mandatory before any code edits** — verify the substitution's premise at each candidate site
2. **For each site, classify**: (a) genuine substitution-needed, (b) intentional use of the legacy pattern (documentation candidate), (c) already correct
3. **If majority are (b)**: reframe PR to docs-only + the (a) fixes. Cite the original projection in PR body + explain the reframe
4. **Update the helper / utility's docstring** to scope-lock its use cases (forward-discipline change preventing future mis-application)
5. **Bank a memo entry** if the reframe pattern repeats — the third instance is "pattern" not "anomaly"

This is the **Step-0-reframes-Phase-1** discipline. Sibling to `feedback_step_0_can_surface_empirical_data_realities_reframing_phase_1_locks.md` (the broader Step 0 reframe pattern; this memo is the specific substitution-to-documentation variant).

## Related patterns / memos

- `feedback_step_0_can_surface_empirical_data_realities_reframing_phase_1_locks.md` — sibling pattern (broader Step 0 reframe)
- `feedback_phase_1_can_surface_substrate_already_shipped.md` — sibling pattern (Phase 1's substrate-already-shipped variant)
- `feedback_architectural_audits_must_search_capability_not_field_name.md` — sibling pattern (audits over-scope literal-grep)
- `feedback_phase_1_5_prod_sniff_can_reveal_empty_cognitive_infrastructure.md` — sibling pattern (Phase 1.5 reframes)

## Banked from

- KAN-1132 PR 1 (#297) — USD-lock docs reframe from "substitute MoneyDisplay everywhere"
- KAN-1131 PR 2 (#300) — KAN-943 scope clarification reframe from "fix 11 sites"
- Session date: 2026-06-07/08
