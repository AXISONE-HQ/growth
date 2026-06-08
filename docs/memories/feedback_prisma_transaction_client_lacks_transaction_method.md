---
name: Prisma `TransactionClient` does not expose `$transaction`
description: KAN-1120 fix-forward #2 banked 2026-06-07. The `tx` parameter passed into `prisma.$transaction(async (tx) => ...)` is a `Prisma.TransactionClient`, which does NOT have `$transaction` itself. Using `as unknown as PrismaClient` casts hides this at typecheck. If you nest `tx.$transaction(...)` inside, runtime throws "TransactionClient.$transaction is not a function."
type: feedback
---

**The pattern**: Prisma's `$transaction` callback yields a `TransactionClient`, which is a subset of `PrismaClient`'s methods (no `$transaction`, no `$connect`, etc.). Test helpers often cast `tx as unknown as PrismaClient` for ergonomic reasons. The cast hides the missing-method constraint at typecheck; code that calls `prisma.$transaction(...)` inside the helper body passes static check but throws at runtime.

**KAN-1120 fix-forward #2 instance**: The integration test `setup.ts` had a `withRollback` helper:

```ts
export async function withRollback<T>(fn: (tx: PrismaClient) => Promise<T>) {
  await prisma.$transaction(async (tx) => {
    result = await fn(tx as unknown as PrismaClient);  // CAST
    throw ROLLBACK_SENTINEL;
  });
}
```

A test inside `fn` tried `await tx.$transaction(...)` (calling the inner-client's `$transaction`, which it doesn't have). The `as unknown as PrismaClient` cast at the helper boundary masked the constraint; the inner `tx.$transaction(...)` typechecked but threw at runtime: `TypeError: tx.$transaction is not a function`.

The fix: use `tx.$executeRaw` / `tx.$queryRaw` for raw SQL inside the transaction — those ARE available. If a test genuinely needs a nested transaction, refactor to use `prisma.$transaction(...)` at the outer scope, not via `tx`.

## Anti-pattern

Treating `tx` as a full `PrismaClient`:

1. `tx as unknown as PrismaClient` — the cast is ergonomic for ORM ops, but masks the API-surface gap
2. "I'll just nest `tx.$transaction(...)` inside" → throws at runtime
3. "The typecheck passed so the API is correct" → typecheck is correct given the cast; the cast was wrong

The right move: **be explicit about TransactionClient's reduced surface**. If a helper takes `tx`, type it as `Prisma.TransactionClient`, not as `PrismaClient`.

## Forward discipline

When working with Prisma transactions:

1. **Type the tx parameter correctly**: `(tx: Prisma.TransactionClient) => Promise<T>` — not `PrismaClient`
2. **Do NOT cast `tx as unknown as PrismaClient`** for ergonomic reasons — accept that the API surface is reduced
3. **For nested transactions**: refactor to outer scope; Prisma doesn't support savepoints / nested transactions natively (use SAVEPOINT explicitly via raw SQL if absolutely needed)
4. **Audit existing `as unknown as PrismaClient` casts** in test setup / helper files — each is a potential API-surface gap

This is sibling to the **`as any` cast masks typecheck signal** discipline. `as unknown as PrismaClient` is the "more careful but equally dangerous" cousin.

## Related patterns / memos

- `feedback_as_any_casts_mask_typecheck_signal_remove_during_wireup.md` — sibling pattern (casts hide signal)
- `feedback_as_any_cast_can_be_vestigial_test_remove_before_assuming_cascade.md` — sibling pattern (cast may be unneeded)
- `feedback_vi_mock_does_not_intercept_cross_workspace_dynamic_imports.md` — sibling KAN-1120 fix-forward lesson

## Banked from

- KAN-1120 fix-forward #2 — `withRollback` cast hid `tx.$transaction` runtime failure
- Session date: 2026-06-07
