---
name: `as any` cast can be vestigial — test-remove before assuming cascade
description: KAN-1108 banked 2026-06-06. When an `as any` cast is documented as TS-graph-bypass (e.g., KAN-689 cohort, KAN-700 cohort), test-remove BEFORE assuming cascade. The cast often outlives its TS reason — Prisma types catch up, KAN-689 epic lands, JSON shapes get Zod schemas.
type: feedback
---

**The pattern**: An `as any` cast in production code carries a comment explaining its purpose (e.g., "cross-rootDir bypass per KAN-700 / KAN-703 / KAN-704 / KAN-705"). The comment makes the cast feel **load-bearing** — removing it would re-introduce the TS6059 violations.

But TypeScript evolves. Prisma client types regenerate. Schemas get extended. Codebase context shifts. The cast may have become **vestigial** — the original justification no longer applies.

**KAN-1108 instance**: Phase 1 risk register predicted 2-5 LoC cascade from removing `(ctx.prisma as any).pipeline?.findMany(...)` cast in `pipelines.list`. The cast comment named KAN-700/703/704/705 as the cohort. Empirical test-remove:

```typescript
const pipelines = await ctx.prisma.pipeline.findMany({...});
```

Result: **0 cascade**. apps/api tsc count unchanged. The Prisma types had caught up since KAN-700/703/704/705 originally shipped.

## Forward discipline

When wiring a new panel or extending a procedure that touches an `as any`-cast Prisma call:

1. **Test-remove the cast FIRST** — just delete the `as any`
2. **Run tsc** to count the cascade
3. If cascade is **0 LoC** → cast was vestigial; remove permanently + update the comment to "cast removed in KAN-XXXX after empirical test"
4. If cascade is **1-5 LoC** → absorb in current PR
5. If cascade is **>10 LoC** → file follow-up; restore the cast with refreshed comment AND empirical TS error count as anchor

**Document the empirical result** in the PR description — future readers learn the cast is no longer load-bearing.

## Related patterns / memos

- `feedback_as_any_casts_mask_typecheck_signal_remove_during_wireup.md` — sibling memo (broader anti-pattern)
- `feedback_typecheck_chronically_red_masks_cascade_errors_unmask_on_fix.md` — cascade absorption discipline
- `feedback_cc_prompt_cross_rootdir_imports_must_be_pattern_conformant.md` — KAN-689 cohort context

## Banked from

- KAN-1108 (Pipeline Health) — predicted 2-5 LoC cascade; actual 0
- Session date: 2026-06-06
