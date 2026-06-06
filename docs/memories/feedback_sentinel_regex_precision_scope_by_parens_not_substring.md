---
name: Sentinel regex precision — scope by parens (not free substring)
description: KAN-1107 fix-forward banked 2026-06-06. When a sentinel regex matches a literal substring across line boundaries, false positives accumulate as the codebase grows. Scope regex to syntactically-meaningful constructs (parenthesized args, single-line patterns) rather than free substring matches.
type: feedback
---

**The pattern**: A sentinel test uses a regex to catch broken patterns (e.g., "no procedure should reference the dead `claimed_at` field"). The regex is written loosely:

```js
expect(text).not.toMatch(/escalation\.(findMany|findFirst|update)[\s\S]*?claimed_at/);
```

This matches `escalation.findMany` followed by `claimed_at` anywhere later in the file text — INCLUDING in comments. As the codebase grows, legitimate new code triggers false positives when it sits BEFORE a pre-existing comment that mentions the dead field literally.

**KAN-1107 instance**: My new `decisions.feed` endpoint at L1509 included `prisma.escalation.findMany(...)` for the UNION pattern. The KAN-754 retirement comment at L1642 contained the phrase "fields like `claimed_at`, `dismissed_at`" — archaeological documentation. The regex matched `escalation.findMany` at L1509 → found `claimed_at` at L1642 (comment) → fired false positive at CI.

**Fix**: tighten regex to scope by parens:

```js
expect(text).not.toMatch(/escalation\.(findMany|findFirst|update)\([^)]*claimed_at/);
```

Now the regex requires `claimed_at` to appear INSIDE the function call's arg block (between `(` and `)`). Comments outside the call don't match. True positive (broken-field references in code) still catches.

## Anti-pattern

Writing sentinel regexes with `[\s\S]*?` or `.*?` lazy matchers across line boundaries. They feel "thorough" but produce false positives that grow over time. The looser the match, the harder the regex is to maintain.

## Forward discipline

When writing a sentinel regex:

1. **Scope the regex to a syntactically-meaningful construct** — function call args `\([^)]*\)`, single line (no `[\s\S]`), specific selectors
2. **Avoid cross-line lazy matchers** — they catch comments + adjacent unrelated patterns
3. **Document the intent** in the test file comment — what is the regex catching vs ignoring?
4. **Add a comment inside the regex's `expect(...).not.toMatch(...)` block** — future readers should understand WHY this regex looks the way it does

## Related patterns / memos

- `feedback_sentinel_tests_for_backend_behavior_must_exercise_real_backend_not_mock.md` — sentinel test discipline upgrade

## Banked from

- KAN-1107 fix-forward — KAN-754 sentinel tightened (false-positive on legitimate `decisions.feed` addition)
- Session date: 2026-06-06
