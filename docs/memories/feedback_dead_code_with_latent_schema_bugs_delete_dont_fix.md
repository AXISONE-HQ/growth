---
name: Dead code with latent schema bugs — delete, don't fix
description: KAN-1109/1116/1118 banked 2026-06-06/07. When grep-driven fix sweeps reveal that the broken code is dead (no caller), the right move is delete, not fix. The schema bug becomes evidence that the code has been unused since the schema changed; if it were live, it would have errored in PROD.
type: feedback
---

**The pattern**: A typecheck / Prisma convention / grep-based audit surfaces a file with mechanical errors (snake_case → camelCase Prisma fields, references to dropped models, broken imports). The instinct is to mechanically apply the fix. Pause first: grep for callers. If zero callers exist, the code is dead — and the unfixed bug is *evidence* that it has been dead since the schema changed. Delete it instead.

**KAN-1109 instance**: KAN-1106 fix-forward swept 4 sibling tRPC procedures with Prisma snake_case → camelCase mismatches. KAN-1109 was about to be the 5th in the batch: `objectives.create` + `objectives.update` referenced fields the schema no longer had. Caller grep returned zero — no UI consumer, no service consumer, no test consumer. The procedures had been broken since the schema migration; nobody had noticed because nobody calls them. Delete (PR #291) instead of fix.

**KAN-1116 instance** (sibling): `product-catalog.ts` (1097 LoC) referenced a `productCatalog` table that doesn't exist in the schema. 21 dormant SQL-injection vectors via `$queryRawUnsafe` with operator-supplied filter strings. Caller grep: zero. Delete (PR #292).

**KAN-1118 instance** (sibling): `data-quality-dashboard.ts` (785 LoC) — entire router, zero UI consumers post-Dashboard-v2-refactor. Delete (PR #295).

## Anti-pattern

Treating every mechanical error as a fix opportunity:

1. "I can apply the snake_case → camelCase rename in 5 minutes" → fix lands, code remains dead, codebase grows
2. "The grep audit said it's broken; let me batch the fix" → batched fixes preserve dead code at scale
3. "It's part of the typecheck baseline; I'll just clean it up" → typecheck baseline grows; cascade errors hidden inside dead code

The right move: **caller-check before fix-application**. If zero callers, the bug is *informational evidence* of deadness, not a reason to fix.

## Forward discipline

When a mechanical fix sweep surfaces a file with errors:

1. **Grep for callers BEFORE applying the fix** — search apps/ + packages/ for imports, tRPC procedure names, table names
2. **If zero callers**: file a delete-PR instead of a fix-PR. Cite the schema bug as evidence of deadness ("the code has been broken since `<commit>` migration; nobody noticed → nobody calls it")
3. **If callers exist**: standard fix-forward
4. **In doubt about live vs dead**: surface to operator with the caller grep result + ship-prep recommendation. Don't unilaterally delete production-suspect code

This is the **delete-don't-fix discipline** — sibling to the deferred-cleanup discipline. It surfaces deadness via the natural evidence trail (schema drift) rather than requiring an independent audit pass.

## Related patterns / memos

- `feedback_dead_code_hides_typecheck_errors_in_baseline.md` — sibling pattern (deleting dead code improves baseline)
- `feedback_grep_based_backlog_grooming_assumes_code_is_live.md` — sibling pattern (grep audits over-scope dead code)
- `feedback_phase_1_enumeration_as_code_state_truthing.md` — sibling pattern (enumeration surfaces dead + latent bugs together)
- `feedback_query_raw_unsafe_with_bind_params_is_safe.md` — sibling pattern (KAN-1116 SQLi framing — dormant means unreachable, not safe)

## Banked from

- KAN-1109 (objectives.create/update dead) — caller grep → zero → delete PR #291
- KAN-1116 (product-catalog.ts dead) — 1097 LoC + 21 dormant SQLi → delete PR #292
- KAN-1118 (data-quality-dashboard.ts dead) — 785 LoC post-Dashboard-v2 → delete PR #295
- Session date: 2026-06-06/07 (Cluster IV-B + dead code cohort)
