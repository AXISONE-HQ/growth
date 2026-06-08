---
name: `$queryRawUnsafe` with bind params is SAFE — the name lies
description: KAN-1118 banked 2026-06-07. `$queryRawUnsafe('SELECT ... WHERE id = $1', userId)` is exactly as safe as parameterized SQL via the Postgres bind protocol. The "Unsafe" in the Prisma API name refers to "the query string is a raw string" (no Prisma template-tag escaping), NOT to "the runtime is vulnerable to SQLi." 21 dormant "SQLi vectors" in dead `product-catalog.ts` were actually 0 SQLi vectors — every match used `$N` bind params.
type: feedback
---

**The pattern**: A security audit greps `$queryRawUnsafe` and flags every match as a SQLi vector. The name suggests danger; the audit treats every call as a vulnerability. The truth: Postgres bind protocol applies independent of whether the API surface is called `$queryRaw` (template tag) or `$queryRawUnsafe` (string + params). What's "unsafe" is the *interpolation of operator-controlled strings into the query body*, not the use of `$queryRawUnsafe` itself.

The vulnerable pattern is `$queryRawUnsafe(\`SELECT * FROM t WHERE name = '${userInput}'\`)` (string concat into the query body). The SAFE pattern is `$queryRawUnsafe('SELECT * FROM t WHERE name = $1', userInput)` (the value goes through Postgres bind protocol). Both compile; only the first is a SQLi vector.

**KAN-1118 instance**: The audit of `product-catalog.ts` initially flagged "21 dormant SQLi vectors" because the file had 21 `$queryRawUnsafe` calls. Code review showed every call used `$1, $2, ...` bind params. Real SQLi count: 0. The file was deleted anyway because it was dead (no callers); the security framing in the PR title was corrected to "21 raw SQL sites" not "21 SQLi vectors."

## Anti-pattern

Treating Prisma API names as security signals:

1. `"$queryRawUnsafe matches = SQLi vectors"` → false; bind params are safe
2. `"$queryRaw is always safe"` → also false; template-tag injection is possible via string-built fragments
3. `"Prisma API safety is encoded in the name"` → encoding is at the call-site, not the API name

The right framing: **SQLi vulnerability is at the interpolation pattern, not the Prisma API name**. `$queryRawUnsafe(query, ...params)` with `$N` bind params is exactly as safe as `$queryRaw\`\`` template tags — both go through the Postgres bind protocol.

## Forward discipline

When auditing raw SQL for security:

1. **Distinguish bind params (`$N`) from string interpolation (`${...}`)** — they are not the same
2. **Look at the call-site pattern**, not the Prisma API name. `$queryRawUnsafe('... WHERE x = $1', x)` is safe; `$queryRaw\`... WHERE x = ${rawString}\`` may not be
3. **Real SQLi vectors look like**: `query += " AND " + userInput` or `\`...\${userInput}...\`` template strings building the query body
4. **Code review must read the calls, not the imports** — `import { ... } from '@prisma/client'` tells you nothing about safety

This memo prevents over-scoping security work + clarifies the actual threat model for future reviewers.

## Related patterns / memos

- `feedback_query_raw_sql_must_have_integration_test_exercising_real_postgres.md` — sibling pattern (raw SQL needs integration tests for syntax, not just safety)
- `feedback_grep_based_backlog_grooming_assumes_code_is_live.md` — sibling pattern (security grep over-scopes too)
- `feedback_dead_code_with_latent_schema_bugs_delete_dont_fix.md` — sibling pattern (KAN-1116 product-catalog was dead anyway)

## Banked from

- KAN-1118 / KAN-1116 — "21 dormant SQLi vectors" was actually 0 real vectors; corrected framing during PR review
- Session date: 2026-06-07
