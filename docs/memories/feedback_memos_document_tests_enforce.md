---
name: Memos document; tests enforce
description: KAN-1119 fix-forward #1 banked 2026-06-07. A discipline memo records that a bug class exists; it does not prevent the bug class from recurring. The same author who banked the KAN-1111 asymmetric-cast memo repeated the bug class in KAN-1119 one day later. Memos teach the next reader; tests catch the present author. Both are needed.
type: feedback
---

**The pattern**: Bug class X happens. A discipline memo is banked describing X, anti-pattern, forward discipline. The expectation: future code won't have X. The reality: the SAME AUTHOR who banked the memo can ship code with the same bug class within days. Memory does not equal enforcement.

**KAN-1119 instance**: KAN-1111 had banked `feedback_query_raw_sql_must_have_integration_test_exercising_real_postgres.md` after a `::uuid` asymmetric-cast bug shipped + caused PROD 500s. 1 day later, KAN-1119 (different epic, same author) shipped a cascade discipline that *also* had asymmetric-cast bugs in its CTE — caught only because the KAN-1119 PR followed the integration-test discipline from the same memo. The memo did not prevent the bug; the integration test that the memo recommended caught it.

The integration test is the actual enforcement mechanism. The memo is documentation that helps the next reader recognize the bug class — but cannot reach back in time to prevent the present author from making it.

## Anti-pattern

Treating memos as enforcement:

1. "I banked the memo on this bug class; I won't make it again" → memory of memos is unreliable for the same author short-term
2. "The memo is on the index; reviewers will catch the recurrence" → reviewers don't re-read the memo index per PR
3. "The discipline is now codified; I can skip the test" → the memo without the test is documentation without enforcement

The right move: **a memo about a bug class must be paired with an enforcement mechanism**. If the memo recommends "integration test for X", that integration test must exist before the memo is banked.

## Forward discipline

When banking a discipline memo about a bug class:

1. **Identify the enforcement mechanism in the memo body** — integration test, sentinel test, lint rule, type check, CI gate
2. **Verify the enforcement mechanism is in place** before banking — if missing, file a sibling ticket to add it
3. **Periodically audit memos** for memos whose enforcement is missing or has rotted (test deleted, lint rule disabled). Re-arm the enforcement
4. **Reflect in retros**: which memos were banked but didn't prevent recurrence? Those are the highest-priority enforcement-gap candidates

This pattern is the **memo-vs-enforcement gap**. The corollary: **the right memo IS the test scope question** — "what would this test cover" is the right framing because the test is the enforcement; the memo is its README.

## Related patterns / memos

- `feedback_state_machine_extensions_must_enumerate_recovery_paths.md` — sibling pattern (the KAN-1119 instance that surfaced this gap)
- `feedback_query_raw_sql_must_have_integration_test_exercising_real_postgres.md` — the load-bearing enforcement mechanism for this pattern
- `feedback_sentinel_tests_for_backend_behavior_must_exercise_real_backend_not_mock.md` — sibling enforcement discipline
- `feedback_query_raw_unsafe_with_bind_params_is_safe.md` — sibling reframe (memo-vs-truth gap)

## Banked from

- KAN-1119 fix-forward #1 — author of `feedback_query_raw_sql_*` memo (KAN-1111) repeated the bug class 1 day later; integration test caught it
- Session date: 2026-06-07
