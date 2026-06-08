---
name: Architectural audits must search capability, not just expected field name
description: KAN-1131 banked 2026-06-08. An audit searching for `Tenant.timezone` (literal field name) missed `AccountProfile.timeZone` (the actual implementation). The capability existed; the audit's grep didn't reach it because the field name + table differed from expectation. Capability-question audits beat literal-grep audits.
type: feedback
---

**The pattern**: An architectural audit asks "does the platform have capability X?" and implements the search as `grep -rn "expectedFieldName"`. The grep doesn't reach implementations that use a different field name OR live on a different table. The audit concludes "capability X doesn't exist" even when it does. Capability-question audits ("how does the platform handle timezone?") avoid this gap.

**KAN-1131 instance**: The original architectural audit asked "does the platform have a tenant timezone field?" and searched for `Tenant.timezone`. The grep returned no match → conclusion: "no, the platform is timezone-naive." Reality: `AccountProfile.timeZone` (sibling table, camelCase variant) shipped months earlier as part of KAN-852 Cohort 1. The capability existed; the audit's literal-grep didn't reach it.

A capability-question audit ("how does the platform read a tenant's timezone today?") would have walked the code paths and found `send-policy.ts:377` calling `Intl.DateTimeFormat({ timeZone: settingsTz })` — surfacing both the JSON read path AND the typed read path. The capability question reveals the implementation; the literal-grep doesn't.

## Anti-pattern

Treating "does X exist" as a literal-grep question:

1. "I'll search for the field name I expect" → misses sibling implementations with different names
2. "If it existed, my grep would have found it" → false; grep matches literals, not capabilities
3. "The negative result is authoritative" → negative grep results are evidence of absent literals, not absent capabilities

The right framing: **architectural audits ask "how does the platform handle X today" + walk the code paths**. The walk surfaces all implementations, not just the ones with the expected name.

## Forward discipline

When auditing for a capability:

1. **Rephrase the audit question** from "does field X exist" to "how does the platform handle capability Y"
2. **Walk the code paths**: start at a known user-visible behavior (e.g., "where does the platform render tenant-local time?") and trace upstream
3. **Use semantic-relevant grep patterns**, not just the expected name: `Intl.DateTimeFormat`, `timezone`, `timeZone`, `\.tz\.`, etc.
4. **Verify negative results** by reading 1-2 related files end-to-end; if the capability would be in this file, but isn't, that's stronger evidence
5. **Cross-reference with PRD / epic history** — the capability may have shipped under a sibling epic with a different naming convention

This is sibling to `feedback_phase_1_can_surface_substrate_already_shipped.md`. The literal-grep gap is the precursor to "substrate is already shipped but missed by the original framing."

## Related patterns / memos

- `feedback_phase_1_can_surface_substrate_already_shipped.md` — sibling pattern (consequence of literal-grep gap)
- `feedback_phase_1_enumeration_as_code_state_truthing.md` — sibling pattern (enumeration corrects literal-grep miss)
- `feedback_grep_based_backlog_grooming_assumes_code_is_live.md` — sibling pattern (grep audits have multiple failure modes)

## Banked from

- KAN-1131 (architectural audit for tenant timezone) — Tenant.timezone literal-grep missed AccountProfile.timeZone implementation
- Session date: 2026-06-07
