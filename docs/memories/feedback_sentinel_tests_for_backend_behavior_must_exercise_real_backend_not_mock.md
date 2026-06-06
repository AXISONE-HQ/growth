---
name: Sentinel tests for backend behavior must exercise real backend (not mock response shape)
description: KAN-1089 → KAN-1111 → KAN-1115 banked 2026-06-06. 3rd recurrence broadens the original raw-SQL memo. When a sentinel test asserts behavior the backend MUST produce (gap firing, aggregation correctness, branching logic), the test must exercise the actual backend code path. Mocking the response shape bypasses what's being tested.
type: feedback
---

**The pattern**: A sentinel test is named after a backend behavior (e.g., "Test #6: empty-state still surfaces gaps when blueprintId=null AND gaps exist"). The test mocks the adapter response:

```typescript
dashboardGetBrainLayersMock.mockResolvedValue({
  blueprint: { isActive: null, ... },
  gaps: [{ id: 'deal_pricing_missing', message: '...', severity: 'warning' }],
});
```

The mock returns the desired shape directly. The UI renders the gap. The test passes. But the test never exercised the **backend code path** that was supposed to produce that shape. The backend logic could be entirely broken (e.g., gap evaluation skipped during empty-state branch) and the test would still pass.

**Three recurrences in this codebase**:

| Ticket | Bug | Pattern |
| --- | --- | --- |
| KAN-1089 (1st) | Raw SQL alias-based GROUP BY → 42803 SQL error | Mock $queryRaw returned `[{...}]`; mocked SQL string contained alias; real Postgres rejected |
| KAN-1111 (2nd) | Raw SQL ::uuid cast → 42883 type-cast error | Same as above; mocked test passed; PROD threw |
| KAN-1115 (3rd) | Empty-state-skip-eval branching bug | Adapter mock returned `{ gaps: [...] }`; actual backend handler put gap eval BELOW empty-state early return |

The 1st two were raw-SQL specific (banked at `feedback_query_raw_sql_must_have_integration_test_exercising_real_postgres.md`). The 3rd shows the pattern is **broader than raw SQL** — any backend behavior assertion needs to exercise actual backend code.

## Forward discipline

**Rule of thumb**: If the test name describes WHAT the backend does (gap firing, aggregation correctness, branching logic, projection shape), the test must call backend code, not mock its output.

When writing a sentinel test:

1. **Identify what's being asserted** — UI rendering OR backend behavior?
2. **For UI rendering tests**: mocking the adapter response is fine — tests render branches, accessibility, click handlers, etc.
3. **For backend behavior tests**: mock at the **data shape** level (Prisma return values, external API responses), NOT the **response shape** level (adapter return). Exercise the actual handler logic.

**Extraction pattern**: extract the handler body into a testable function:

```typescript
// apps/api/src/services/<feature>-impl.ts
export interface FooPrismaSurface {
  model1: { findUnique: (args: unknown) => Promise<...>; };
  model2: { count: (args: unknown) => Promise<number>; };
}
export async function fooImpl(prisma: FooPrismaSurface, args: ...): Promise<FooResponse> { ... }

// apps/api/src/router.ts
foo: protectedProcedure.query(async ({ ctx }) => {
  const { fooImpl } = await import('./services/foo-impl.js');
  return fooImpl(ctx.prisma, ctx.tenantId);
}),

// apps/api/src/__tests__/foo-impl.test.ts
import { fooImpl } from '../services/foo-impl.js';
const mockPrisma = { model1: { findUnique: async () => ({ ... }) }, ... };
const result = await fooImpl(mockPrisma, 'tenant-id');
expect(result.gaps[0].id).toBe('expected_gap_id');
```

The test exercises the actual handler logic; only the data layer is mocked. KAN-1112 will infrastructure-ize this pattern across the codebase (real Postgres or embedded Postgres for full integration coverage).

## Related patterns / memos

- `feedback_query_raw_sql_must_have_integration_test_exercising_real_postgres.md` — narrow case (raw SQL specific); this memo is the broader pattern
- `feedback_typecheck_chronically_red_masks_cascade_errors_unmask_on_fix.md` — cascade discipline (some behavior bugs cascade from masked TS errors)
- KAN-1112 (filed) — integration test infrastructure

## Banked from

- KAN-1089 (1st recurrence; raw SQL)
- KAN-1111 (2nd recurrence; raw SQL)
- KAN-1115 (3rd recurrence; branching logic — broader pattern)
- Session date: 2026-06-06
