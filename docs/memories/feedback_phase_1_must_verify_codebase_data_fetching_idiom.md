---
name: Phase 1 PRD framing must verify actual codebase data-fetching idiom (not assume)
description: KAN-1107 Finding A banked 2026-06-06. Phase 1 PRD framing names specific hook libraries (useQuery / useEffect / SWR / Apollo) without verifying what the codebase actually uses. Real codebases often have multiple idioms coexisting (e.g., useEffect quartet on dashboard pages, useQuery on kanban pages). Phase 1 must verify the target file's actual pattern + lock to dashboard-internal consistency.
type: feedback
---

**The pattern**: PRD authors (PO + designers + engineers) describe data-fetching as "the component fetches X" without specifying HOW. Phase 1 design traces inherit this ambiguity. When the build prompt assumes the wrong idiom (e.g., assumes useQuery when the file uses useEffect), the engineer either:

1. Builds with the wrong idiom + breaks consistency with siblings, OR
2. Discovers the mismatch at build time + reworks (waste)

**KAN-1107 instance**: Phase 1 design trace assumed `useQuery` (React Query) for Decision Feed + Agent Actions panels. Build-time discovery: `apps/web/src/app/dashboard/page.tsx` uses `useState + useEffect + useCallback` quartet (KAN-1102/1103 precedent). The `/pipelines` page DOES use `useQuery`. Two idioms coexist in the codebase.

Decision: lock to **dashboard-internal consistency** (useEffect quartet matches KAN-1102/1103 prior PRs on the same page). Codebase-wide consolidation deferred as a separate maintenance ticket.

## Forward discipline

Phase 1 design traces must include an explicit **data-fetching idiom verification step**:

```bash
# Read the target file + sibling files to identify the pattern
grep -n "useQuery\|useEffect.*setInterval\|useSWR" <target-file> <sibling-files>
```

Surface the finding in the upfront findings section. If two idioms coexist:
- **Lock to local consistency** (match the target file's existing pattern OR the sibling pattern that visually-groups with the new panel)
- **Defer codebase-wide consolidation** to a separate ticket; do not scope-expand the current PR

## Related patterns / memos

- `feedback_dashboard_internal_canonical_pattern_lock_useeffect_quartet.md` — dashboard-scoped canonical pattern lock
- `feedback_phase_1_loc_estimates_undercount_state_handling.md` — Phase 1 estimates routinely undercount

## Banked from

- KAN-1107 (Decision Feed + Agent Actions) — Finding A "data-fetching idiom divergence"
- Session date: 2026-06-06
