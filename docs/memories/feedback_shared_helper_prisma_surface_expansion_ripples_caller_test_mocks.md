---
name: Shared helper Prisma surface expansion ripples caller test mocks
description: KAN-1098 2026-06-05. When a shared resolver helper expands its prisma surface, test-mock updates ripple across ALL caller tests — not just the helper's own test. Sentinel test covered helper happy path; the regression surface was in pre-existing tests where the helper now runs but their prisma mocks predate the surface expansion.
type: feedback
---

**KAN-1098 CI fix-cascade 2026-06-05**: `scenario-resolution-context.ts` helper expanded the prisma touch surface for both `action-decided-push.ts` (composer path) and `lead-received-push.ts` (autonomy path):

- new `prisma.tenant.findUnique` (persona resolver)
- new `prisma.engagement.groupBy` (trigger derivation)
- new `prisma.contactSubObjectiveGapState.findMany` (phase derivation)
- new `prisma.deal.findUnique` Step 0 (autonomy-path tenantId/contactId capture)

Local sentinel test mocked the full surface → GREEN. CI ran sibling tests for the affected subscribers whose prisma mocks did NOT anticipate the new surface → 2 failures:

1. `kan-1005-m2-2-action-decided-send-policy-gate.test.ts` — `auditLogCreateMock.not.toHaveBeenCalled()` failed because persona resolver hit `undefined.findUnique` → wrote `blueprint_persona.resolve_failed` audit row
2. `lead-received-push.test.ts:1169` — `dealFindUniqueMock.toHaveBeenCalledOnce()` failed because the new Step 0 deal-find added a 2nd call

## The discipline rule

When a shared resolver helper expands its prisma surface, audit ALL caller-side tests during Phase 1 design trace (NOT just the helper's own test surface):

1. Identify every production file that imports the helper (`grep -rn helperName apps/ packages/ --include='*.ts'`)
2. For each importer, find the sibling test files (typically `<importer-basename>.test.ts` + related integration tests)
3. For each such test file, check whether:
   - It mocks prisma directly via `vi.mock('../prisma.js', ...)` OR equivalent
   - The mocked prisma stubs match the helper's new touch surface
   - Exact-count assertions exist on the mocks the helper now exercises (`toHaveBeenCalledOnce`, `not.toHaveBeenCalled`, `toHaveBeenCalledTimes(N)`)

If any of those land → include the test-mock updates in the SAME PR as the helper change. Don't wait for CI to surface the cascade.

## Anti-pattern (what we did in KAN-1098)

Phase 1 lock chose Q1 helper-extraction option (a) — clean cross-call-site abstraction. The build added prisma touches inside the helper without auditing how those touches would ripple through sibling subscriber tests. CI surfaced the cascade after merge attempt; fix-forward added test-mock updates to the same PR via 2 fixup commits.

## Class-fix discipline (what we DID right)

After CI surfaced the 2 visible failures, Phase 2.5 audit grep'd ALL test files matching `action-decided-push|lead-received-push|dispatchPhase2Send` (9 candidates) and confirmed:
- 5 were structural source-grep tests (no prisma mocks) → safe
- 2 mocked `wirePhase2Consumers` or `evaluateDealState` to short-circuit BEFORE the helper invocation → safe
- 0 had hidden mask risk

Sentinel discipline prevented expanded fix-forward scope. The 2 visibly-failed tests were the only fix sites.

## Sibling memos (the test-mock-cascade family)

- `feedback_subscriber_local_type_mirror_naming_asymmetry` — type-mirror lockstep at the local module-interface declaration
- `feedback_loader_vs_canonical_test_divergence` — vi.mock of loader path fakes exports the real module lacks
- `feedback_packages_api_js_artifacts_load_bearing_for_vitest_mocks` — vitest resolution via compiled .js artifacts

## Forward discipline

Add to Phase 1 anchor checklist when extracting a shared helper:

```
Anchor N (REQUIRED for shared-helper extraction):
- [ ] Helper prisma touch surface enumerated: tenant.X, engagement.Y, contactZ.findMany, ...
- [ ] Caller files enumerated via grep
- [ ] For each caller, sibling test files identified
- [ ] For each sibling test, prisma mock matches helper's new surface? Y/N
- [ ] If N: include test-mock updates in the SAME PR (don't punt to fix-forward)
```

Bounded ~5-min addition to Phase 1. Prevents the CI fix-cascade cost.
