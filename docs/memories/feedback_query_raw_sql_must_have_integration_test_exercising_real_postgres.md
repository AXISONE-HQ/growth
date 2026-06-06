---
name: $queryRaw must have integration test exercising real Postgres (not mocked)
description: KAN-1089 → KAN-1111 → KAN-1115 cluster banked 2026-06-06. When $queryRaw / $executeRaw is added to a NEW procedure, the PR MUST include at least 1 integration test against real Postgres. Mocking $queryRaw at the unit-test level masks SQL syntax errors + type-cast mismatches that surface only at PROD smoke.
type: feedback
---

**The pattern**: Raw SQL added via `$queryRaw` (or `$executeRaw`) is opaque to TypeScript validation. Unit tests typically mock the Prisma client at the response level:

```typescript
vi.mocked(prisma.$queryRaw).mockResolvedValue([{ id: '...', value: 100 }]);
```

The mock validates the test code asserts the right response shape — but it does NOT validate the SQL string is syntactically correct, type-compatible, or runnable against real Postgres. CI passes. PROD throws.

**Three recurrences in this codebase**:

| Ticket | Bug |
| --- | --- |
| KAN-1089 (1st) | Tier 2 aggregators — alias-based GROUP BY → 42803 SQL error; every endpoint 500'd |
| KAN-1111 (2nd) | pipelines.list Q2 — `::uuid` cast on text column → 42883 type-cast error; Pipeline Health broken |
| KAN-1115 (3rd) | dashboard.getBrainLayers — empty-state-skip-eval branching bug (caught at PROD smoke) |

The 3rd recurrence is broader than raw SQL — it's any backend behavior asserted by a sentinel that doesn't exercise the actual backend code path. See `feedback_sentinel_tests_for_backend_behavior_must_exercise_real_backend_not_mock.md` for the broader pattern.

## Forward discipline (hard rule)

When a PR adds `$queryRaw` (or `$executeRaw`) to a procedure:

1. **The PR MUST include at least 1 integration test** that exercises the actual SQL against real Postgres
2. **Options for "real Postgres"** (KAN-1112 will infrastructure-ize):
    - Local docker-compose Postgres
    - Cloud SQL Proxy session in CI workflow
    - Embedded Postgres library (e.g., `pglite`) — verify behavioral parity with prod
    - PROD read-replica with `WHERE 1=0` filter (syntax validation only; no data)
3. **Sentinel test rationale**: assert the actual SQL executes without error against a real database; assert the projection shape matches the TypeScript return type

Until KAN-1112 lands, ad-hoc backend-level tests (mock the Prisma client at the DATA shape level, not the response shape) serve as a stopgap — see `feedback_sentinel_tests_for_backend_behavior_must_exercise_real_backend_not_mock.md` for the testing technique.

## Related patterns / memos

- `feedback_sentinel_tests_for_backend_behavior_must_exercise_real_backend_not_mock.md` — broader pattern (any backend behavior, not just raw SQL)
- `feedback_typecheck_chronically_red_masks_cascade_errors_unmask_on_fix.md` — cascade discipline (raw SQL cascade not caught by tsc)
- KAN-1112 (filed) — integration test infrastructure

## Banked from

- KAN-1089 (1st recurrence) — alias-based GROUP BY
- KAN-1111 (2nd recurrence) — `::uuid` type-cast
- KAN-1115 (3rd recurrence) — branching logic (broader pattern)
- Session date: 2026-06-06
