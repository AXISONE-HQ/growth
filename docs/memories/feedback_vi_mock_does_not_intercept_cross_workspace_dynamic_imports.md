---
name: `vi.mock` does NOT intercept cross-workspace dynamic imports in integration tests
description: KAN-1120 fix-forward #1 banked 2026-06-07. Integration tests that exercise cross-workspace dynamic imports (`apps/api` test importing from `packages/api`) cannot be intercepted by `vi.mock` calls in the test file. Vitest's hoister doesn't reach across workspace boundaries when the import is dynamic. Workaround: explicit `vi.importActual` + manual injection.
type: feedback
---

**The pattern**: An integration test in `apps/api/src/__tests__/integration/` mocks a dependency via `vi.mock('...path...')`. The test runs but the real module loads anyway; assertions fail because the mock didn't intercept. Cause: the import is a cross-workspace dynamic import (e.g., `await import('@growth/api/...')` or variable-specifier loader) and Vitest's static-hoister doesn't reach across the workspace boundary at the dynamic import resolution time.

**KAN-1120 fix-forward #1 instance**: A `faq-entries-embed.test.ts` integration test wanted to mock the `OpenAIEmbeddings` client. The test file had `vi.mock('@growth/api/clients/openai-embeddings.js', () => ...)`. The production code path used `const mod = await import(spec); const { OpenAIEmbeddings } = mod;` where `spec` was a variable — the variable-specifier loader pattern from `reference_variable_specifier_dynamic_import.md` (KAN-689 era). Vitest's hoister couldn't statically analyze the dynamic import; the real module loaded; the mock never fired; the test exercised the real OpenAI client (which then errored on missing API key).

The fix-forward used `vi.importActual` to load the real module on test scopes that needed it, AND a manual injection pattern for the mock scope (pass the mock as a parameter rather than relying on module-level interception).

## Anti-pattern

Assuming `vi.mock` works the same as in unit tests:

1. "I'll mock the cross-workspace dependency the same way I mock local ones" → fails for dynamic imports
2. "The test passes locally with the mock" → may be falsely passing because of `as unknown as` casts; verify the mock is actually invoked
3. "Vitest handles ESM dynamic imports transparently" → it handles SOME of them; not cross-workspace variable-specifier patterns

The right move: **for integration tests crossing workspace boundaries via dynamic imports, design the production code to accept the dependency as a parameter** (dependency injection). The mock becomes a fixture in the test; no `vi.mock` magic needed.

## Forward discipline

When designing an integration test that crosses workspace boundaries:

1. **Identify the dynamic-import patterns** in the code under test (variable-specifier loader, conditional imports)
2. **If the test needs to substitute the imported module**: prefer dependency injection at the function signature over `vi.mock`
3. **If DI isn't practical**: use `vi.importActual` for real-module scopes + a separate parameter-passed mock for the mock scope
4. **Document the constraint in the test file header** so the next reader knows why DI is used over `vi.mock`
5. **Sentinel test**: an integration test that asserts the mock was actually invoked. Without it, "the mock didn't fire" presents as "the test passed" because no failure mode tripped

This is sibling to the **variable-specifier dynamic import pattern** (KAN-689 cohort) and to `feedback_loader_vs_canonical_test_divergence.md`. Both reflect the cost of dynamic imports for cross-workspace testing.

## Related patterns / memos

- `reference_variable_specifier_dynamic_import.md` — the KAN-689 pattern that creates this constraint
- `feedback_loader_vs_canonical_test_divergence.md` — sibling pattern (loader interception masks runtime drift)
- `feedback_query_raw_sql_must_have_integration_test_exercising_real_postgres.md` — sibling discipline (integration tests are the right gate)
- `feedback_prisma_transaction_client_lacks_transaction_method.md` — sibling fix-forward lesson from same KAN-1120 cluster

## Banked from

- KAN-1120 fix-forward #1 — `faq-entries-embed.test.ts` mock-not-intercepted failure
- Session date: 2026-06-07
