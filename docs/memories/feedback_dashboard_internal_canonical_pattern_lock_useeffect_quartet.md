---
name: Dashboard-internal canonical data-fetching pattern lock (useEffect quartet)
description: KAN-1107 Finding A banked 2026-06-06. Cross-cutting codebase data-fetching idiom divergence (useEffect quartet vs useQuery) is real maintenance debt. Dashboard-scoped canonical pattern lock until codebase-wide consolidation worth doing. Pattern lock = predictability for dashboard contributors; defer codebase consolidation as separate scope.
type: feedback
---

**The pattern**: Codebases that grew across multiple stylistic eras have multiple data-fetching idioms coexisting. For instance, `apps/web/src/`:

- `/dashboard/page.tsx` uses `useState + useEffect + useCallback` quartet (KAN-1102/1103 precedent)
- `/pipelines/page.tsx` uses `useQuery` (React Query; KAN-968 era)
- Other pages may use yet other patterns

Each new PR has to choose which idiom to follow. Inconsistent choices accumulate as maintenance debt.

**KAN-1107 lock**: Dashboard panels (Decision Feed, Agent Actions, Pipeline Health, Focus Contact, Sub-objective Gap, Brain Layers) all use the **useEffect quartet** for internal consistency. The pattern is:

```typescript
const [data, setData] = useState<T | null>(null);
const [loading, setLoading] = useState<boolean>(true);
const [error, setError] = useState<string | null>(null);

const reload = useCallback(async () => {
  try {
    setError(null);
    const result = await api.method();
    setData(result);
  } catch (e) {
    setError((e as Error).message);
    setData(null);
  } finally {
    setLoading(false);
  }
}, []);

useEffect(() => {
  void reload();
  const interval = setInterval(() => void reload(), POLL_MS);
  const onFocus = () => void reload();
  window.addEventListener('focus', onFocus);
  return () => {
    clearInterval(interval);
    window.removeEventListener('focus', onFocus);
  };
}, [reload]);
```

Every dashboard panel follows this shape. Tests assert the loading/empty/error/populated state branches.

## Forward discipline

When adding a new panel to the dashboard:

1. **Lock to the useEffect quartet** for internal consistency
2. **Do NOT introduce useQuery / SWR** without raising the codebase consolidation question as a separate scope decision
3. Reference this memo in the build prompt's Phase 1 design trace section

When adding a new page elsewhere in `apps/web/`:

1. **Mirror the existing convention** for the surrounding pages
2. If the surrounding pages are inconsistent (multiple idioms), defer to the **closest sibling page** (e.g., `/contacts/[id]` page → match `/contacts/page.tsx` style)

Codebase-wide consolidation is a separate epic — likely not worth doing without operator-facing benefit. The dashboard-scoped lock contains the divergence to manageable areas.

## Related patterns / memos

- `feedback_phase_1_must_verify_codebase_data_fetching_idiom.md` — Phase 1 must verify actual codebase pattern (not assume)
- `feedback_phase_1_loc_estimates_undercount_state_handling.md` — state-branch handling adds LoC

## Banked from

- KAN-1107 (Decision Feed + Agent Actions) — Finding A "useEffect vs useQuery divergence"
- Session date: 2026-06-06
