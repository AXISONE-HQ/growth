---
name: `as any` casts mask typecheck signal; remove during wire-up
description: KAN-1108 banked 2026-06-06. `as any` casts often masked TS6059 cross-rootDir issues OR new Prisma delegate types that hadn't propagated yet. Many casts outlive their original justification. Test-remove before assuming cascade — often the cast is vestigial.
type: feedback
---

**The pattern**: A codebase accumulates `as any` casts as defensive workarounds for:

1. Cross-rootDir TS6059 violations (KAN-689 cohort pattern)
2. New Prisma delegate types that hadn't propagated through the schema regeneration
3. Loose typing on JSON-shaped fields

Over time, the original justification often resolves (Prisma types catch up, KAN-689 epic lands, JSON fields get Zod schemas). But the casts remain — silently masking real type errors that could have been caught.

**KAN-1108 instance**: `apps/api/src/router.ts:4283` had:

```typescript
const pipelines: any[] = (await (ctx.prisma as any).pipeline?.findMany({...})) ?? [];
```

The comment block at L4322 documented the rationale: "Cast-loose `(prisma as any)` accessors on the new Prisma delegates keep the new types out of the apps/api TS6059 graph (same pattern as KAN-700 / KAN-703 / KAN-704 / KAN-705)."

Phase 1 prediction: 2-5 LoC cascade when cast is removed. Empirical result: **0 cascade**. The Prisma types had caught up since KAN-700/703/704/705 were originally shipped.

## Forward discipline

When wiring a new panel that touches a cast-loose Prisma call:

1. **Test-remove the cast FIRST** — try `(ctx.prisma).pipeline.findMany({...})` (no cast)
2. **Run tsc** to count the cascade
3. If cascade is **0 LoC** → cast was vestigial; remove permanently
4. If cascade is **1-5 LoC** → absorb the cascade in current PR (per `feedback_typecheck_chronically_red_masks_cascade_errors_unmask_on_fix.md`)
5. If cascade is **>10 LoC** → file follow-up; reinstate the cast with refreshed comment

This is cheap insurance against latent type-safety regressions. Don't trust documented cast rationale without empirically testing if the rationale still applies.

## Related patterns / memos

- `feedback_as_any_cast_can_be_vestigial_test_remove_before_assuming_cascade.md` — sibling memo (test-remove discipline)
- `feedback_typecheck_chronically_red_masks_cascade_errors_unmask_on_fix.md` — cascade absorption discipline
- `feedback_cc_prompt_cross_rootdir_imports_must_be_pattern_conformant.md` — KAN-689 cohort pattern context

## Banked from

- KAN-1108 (Pipeline Health) — predicted 2-5 LoC cascade; actual 0
- Session date: 2026-06-06
