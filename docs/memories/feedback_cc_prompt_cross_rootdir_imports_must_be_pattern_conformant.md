---
name: CC prompt code examples must follow KAN-689 cross-rootDir variable-specifier pattern verbatim
description: KAN-1098 2026-06-05. CC build prompts that show apps/api → packages/api imports MUST use the variable-specifier loader pattern verbatim. Illustrative `@/` shorthand, literal-string `await import('...')`, AND `typeof import('literal')` type-position references ALL trigger TS6059.
type: feedback
---

**KAN-1098 prompt-pattern correction 2026-06-05 — second instance + extended scope**:

First instance (CC caught pre-build): Fred's build prompt showed `await import('@/services/scenario-resolution-context')` shorthand at file 5. CC pattern-corrected to variable-specifier `const spec = '...'; await import(spec)` before writing code. No defect shipped.

Second instance (CI caught post-push): Fred's build prompt for the sentinel test file used literal-string `await import('../../../../packages/api/src/services/message-shaper.js')`. CC took this literally → CI Build job flagged 2 TS6059 errors. Fix-forward fixup commit converted to variable-specifier pattern.

## The discipline rule (extended)

Whenever a CC build prompt or design trace shows an apps/api → packages/api import — in **production code, test files, type-side imports, or runtime-side imports** — it MUST use the variable-specifier loader pattern verbatim:

```ts
const spec = '../../../../packages/api/src/services/<helper>.js';
const { exportName } = await import(spec);
```

NOT any of these illustrative-but-broken forms:

❌ `import { x } from '@/services/<helper>'` — alias path, doesn't resolve cross-rootDir
❌ `await import('../../../../packages/api/src/services/<helper>.js')` — literal-string dynamic import; tsc TS6059
❌ `(await import(spec)) as { x: typeof import('../../../../packages/api/src/services/<helper>.js').x }` — `typeof import('literal')` ALSO drags into rootDir → tsc TS6059

## Empirical finding (the typeof-import sub-rule)

`typeof import('literal')` in a type position appears to be type-only and emission-free. Intuition: it shouldn't trigger rootDir constraint since no code is emitted. **Empirical reality (KAN-1098 fixup)**: tsc resolves the type-side import dependency through the rootDir check too. The `typeof import('literal-string')` form drags the referenced module into the typecheck graph just like a value-level static import.

The only working form is plain variable-specifier dynamic import WITHOUT cast:

```ts
const spec = '../../../../packages/api/src/services/<helper>.js';
const { exportName } = await import(spec);
// `exportName` is `any` here; runtime behavior identical to static import
```

Cost: destructured symbols are `any`. Acceptable when assertions are runtime-shape (substring `.toContain(...)`, structural-prop checks) rather than type-driven.

If type-safety is load-bearing on the test side, the alternative is:

- Move test into `packages/api/src/services/__tests__/` (no cross-rootDir constraint)
- OR declare a local module-interface mirror (lockstep-mirror discipline per `feedback_subscriber_local_type_mirror_naming_asymmetry`) and inline-type the destructure

## Why the shorthand is dangerous

When CC pattern-corrects in advance, no defect ships. When CC takes the shorthand literally (because the prompt explicitly says "use this form"), a TS6059 escapes to CI. The pattern-correction step is brittle — depends on CC's awareness of context. Pattern-verbatim prompts remove the brittleness.

## Sibling memos

- `reference_variable_specifier_dynamic_import` — the canonical KAN-689 pattern
- `feedback_subscriber_local_type_mirror_naming_asymmetry` — lockstep type-mirror at module-interface declarations
- `feedback_loader_vs_canonical_test_divergence` — vi.mock at loader resolved path

## Forward discipline

When drafting CC build prompts that touch cross-rootDir bridges:

1. Verify every example code block uses the variable-specifier loader pattern verbatim
2. Apply to ALL surface types: production code, test files, type-position references
3. Never use `@/` alias for cross-rootDir paths
4. Never use literal-string `await import('cross-rootDir-path')`
5. Never use `typeof import('literal-cross-rootDir-path')` even in type-only positions

Fred banked a self-discipline observation alongside: "CC prompt code examples should follow the established pattern, not the simpler illustrative form — even when the prompt is meant to convey intent." This memo locks the discipline in CC's recall surface.
