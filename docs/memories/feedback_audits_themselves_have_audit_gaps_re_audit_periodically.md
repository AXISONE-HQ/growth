---
name: Audits themselves have audit gaps; re-audit periodically
description: KAN-1120 banked 2026-06-07. The original KAN-1112 raw-SQL audit missed an entire service file (`knowledge-center.ts`, 7 raw-SQL sites). Audits are not exhaustive on the first pass — grep scope, time pressure, or audit-author context can cause real coverage gaps. Re-auditing periodically catches what the first pass missed.
type: feedback
---

**The pattern**: An audit produces a backlog. Some time later, a separate investigation surfaces files / sites / cases that the original audit missed. The miss is not an author error — audits at scope are inherently lossy (grep patterns drop files with unusual shapes, time pressure caps thoroughness, the audit-author's mental model can have blind spots). The right discipline: re-audit periodically, expecting to find gaps.

**KAN-1120 instance**: KAN-1112's original raw-SQL audit produced a backlog of files needing integration tests. KAN-1120 (a different ticket investigating pgvector retrofit) surfaced `knowledge-center.ts` — a service file with 7 raw-SQL sites that the KAN-1112 audit had missed entirely. The miss was likely because the file's raw SQL was inside method bodies wrapped in service-class methods, not at the top-level grep target. The audit's grep pattern didn't reach in; the file slipped through.

The right response was filing a follow-up ticket to extend KAN-1112's backlog with `knowledge-center.ts`'s 7 sites, not retroactively blame the original audit.

## Anti-pattern

Treating audits as exhaustive:

1. "The KAN-1112 audit found everything" → no; first-pass audits routinely miss 5-20% of true positives
2. "If the audit missed it, it must not be important" → false; the miss is a coverage gap, not a relevance signal
3. "We don't need to re-audit; the discipline applies forward" → forward-discipline applies to NEW code; existing code that was missed needs back-fill

The right framing: **first-pass audits are sampling; expect a ~10% miss rate; periodically re-audit**.

## Forward discipline

For any audit-driven backlog:

1. **Acknowledge in the audit's own write-up that the audit may have gaps** — set the expectation
2. **Schedule a periodic re-audit** — quarterly or per-epic-close, not "if we feel like it"
3. **When a separate investigation surfaces a missed case**, file a follow-up ticket extending the original backlog. Don't blame the original audit
4. **Use multiple grep patterns** to widen first-pass coverage. Search for the substance of the discipline, not just the obvious literal
5. **Cross-reference the audit against other audits**: if a file appears in audit X but not audit Y when both should reach it, that's a gap signal

This is the **audits-aren't-exhaustive** discipline. The corollary: **first-pass audits are useful even when imperfect** — the alternative (no audit) is much worse than the imperfect audit + periodic re-audit cadence.

## Related patterns / memos

- `feedback_phase_1_enumeration_as_code_state_truthing.md` — sibling pattern (Phase 1 enumeration as a continuous-audit channel)
- `feedback_grep_based_backlog_grooming_assumes_code_is_live.md` — sibling pattern (audits over-scope OR under-scope)
- `feedback_query_raw_sql_must_have_integration_test_exercising_real_postgres.md` — the discipline that this audit informs

## Banked from

- KAN-1120 (pgvector retrofit) — surfaced `knowledge-center.ts` 7 raw-SQL sites missed by KAN-1112 original audit
- Session date: 2026-06-07
