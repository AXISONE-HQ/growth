# feedback_kan_791_dropped_model_residual_references

**Trigger:** KAN-791 schema pivot dropped the `LeadStageHistory` Prisma model but left four cast-loose `(prisma as any).leadStageHistory?.X` references in code/tests. Each survived as a silent no-op via the optional-chain pattern (returns undefined → call doesn't run). The audit-trail invariant for Track A assignments was silently broken on `main` for ~3 hours between PR #93 merge (`765be1b`) and PR #95 commit 0 cleanup (`f273e73`). Sibling regression class to `feedback_cast_loose_prisma_runtime_trap` + `feedback_tx_cast_loose_silent_failure`.

**Empirical anchor:** Discovered during KAN-793 pre-flight on 2026-05-03 while reading `lead-assignment.ts` to wire bootstrap + Deal-write. Would have been undetectable by any CI test (mocks lie, types are loose) until next operational audit. KAN-793 commit 0 cleaned all 4 sites in a single fix-cascade commit.

---

## The 4-step cleanup checklist

Run BEFORE shipping a PR that drops a Prisma model:

### Step 1 — Cast-loose accessor grep

```bash
grep -rn "(prisma as any)\.<modelName>?\." packages apps --include="*.ts"
```

Each match is a runtime side-effect that silently disappears post-drop. The optional chain returns undefined; the chained method call evaluates to undefined; no error thrown. **The most dangerous failure mode** because it leaves no signal until operational behavior breaks.

### Step 2 — Direct delegate access grep

```bash
grep -rn "\.<modelName>\." packages apps --include="*.ts"
```

Finds typed accessors. These produce loud TS errors post-drop (good — CI catches them), but pre-deploy audit catches them earlier than the build job.

### Step 3 — Type import grep

```bash
grep -rn "import.*<ModelName>" packages apps --include="*.ts"
```

Finds test files + type-shape assertions referencing the dropped type. These fail to compile post-drop.

### Step 4 — Test mock grep

```bash
grep -rn "<modelName>:" packages apps --include="*test*"
```

Finds vi.fn() mocks of the dropped delegate. Tests pass against mocks but mocks lie — the real Prisma client doesn't have the delegate. Cleanup may reveal previously-hidden coverage gaps.

---

## KAN-791 leak (4 sites)

| Site | Class | Evidence |
|---|---|---|
| `packages/api/src/services/lead-assignment.ts:491` | Cast-loose `?.create()` | `(prisma as any).leadStageHistory?.create(...)` silently skipped on every Track A assignment from `765be1b` → `014f489`. Audit-trail rows never written. |
| `apps/api/src/router.ts:2923` | Cast-loose `?.count()` | `(ctx.prisma as any).leadStageHistory?.count(...)` returned undefined → `?? 0` → `pipelinesRouter.delete` mutation bypassed audit-trail guard. Destructive deletes succeeded against pipelines that DID have audit-trail transitions. |
| `packages/api/src/services/__tests__/kan-700-schema.test.ts:31, 188-202` | Type import + shape assertion | `LeadStageHistory` type imported from `@prisma/client` (would fail at TS compile post-drop). |
| `packages/api/src/services/__tests__/kan-705-lead-assignment.test.ts:265, 280, 329` | Mocked delegate + asserted call count | `createLeadStageHistory.toHaveBeenCalledTimes(1)` — 27/27 tests green via the mock, but the real call was a silent no-op in production. |

KAN-793 commit 0 (`f273e73`):
- Deleted `(prisma as any).leadStageHistory?.create(...)` block in lead-assignment.ts
- Replaced router.ts:2923 with `(ctx.prisma as any).dealStageHistory?.count(...)` (KAN-791's deal-scoped successor)
- Removed `LeadStageHistory` type import + shape assertion from kan-700-schema.test.ts
- Removed `createLeadStageHistory` mock + assertion from kan-705-lead-assignment.test.ts

Verification: `grep -rn "leadStageHistory\|LeadStageHistory" --include="*.ts" packages apps` returns 3 documentary comments only (cleanup audit trail), zero live code references.

---

## Why the cast-loose pattern exists

The `(prisma as any).<delegate>?.X` pattern is necessary today for some cross-rootDir module access (per `reference_variable_specifier_dynamic_import` — TS6059 cohort hygiene). It's the only way to import from `packages/api/src/services/*` into `apps/api/src/*` without triggering 12+ TS6059 violations. The dynamic-import variant uses the same `as any` cast.

The pattern has the same runtime trap as the static `(prisma as any).delegate?.method()` call: optional chaining + `as any` defeats both compile-time and runtime safety nets. Discipline is to use the cast-loose pattern ONLY where the TS6059 cohort makes it necessary, and to audit cast-loose sites whenever the underlying schema changes.

---

## Discipline going forward — schema-drop PRs

Add the 4 grep commands to the PR template for any schema-drop PR. The 4 greps are mechanical and take <1 minute. Compare cost vs. KAN-791's silent regression:
- ~3 hours of broken-on-main
- KAN-793 commit 0 cleanup overhead (~30 min)
- This memory entry (~30 min)

The discipline is forward-looking — applies to every future Prisma model drop. Each model in `schema.prisma` is a candidate for this checklist.

The class-fix discipline applies (per `feedback_class_fix_not_instance_fix`): when fixing one site, audit for ALL sites of the class. KAN-793 commit 0 fixed all 4 in a single commit, not 4 separate commits.

---

## Cross-references

- [`feedback_cast_loose_prisma_runtime_trap.md`](./feedback_cast_loose_prisma_runtime_trap.md) — original cast-loose silent-failure entry (KAN-702 PR A)
- `feedback_tx_cast_loose_silent_failure` — sibling tx:any swallow case (KAN-750)
- `feedback_class_fix_not_instance_fix` — discipline-at-class-level pattern
- `reference_variable_specifier_dynamic_import` — when cast-loose IS necessary (TS6059 hygiene)
- [`feedback_phase_1_pivot_kan_786_to_kan_791_lifecycle_model.md`](./feedback_phase_1_pivot_kan_786_to_kan_791_lifecycle_model.md) — companion (KAN-791 was the schema pivot that dropped LeadStageHistory)
- KAN-791 (origin), KAN-793 commit 0 (cleanup), KAN-689 (TS6059 cohort that drives the cast-loose necessity)

---

## Status

**Active.** Pattern applies to all future Prisma model drops. Retiring conditions: (a) KAN-689 lands and the variable-specifier dynamic-import pattern can be retired (cast-loose access goes away), or (b) Prisma adds delegate-existence assertion at compile time.
