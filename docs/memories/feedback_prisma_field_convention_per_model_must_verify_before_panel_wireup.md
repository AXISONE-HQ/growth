---
name: Prisma per-model field convention must be verified before panel wire-up
description: KAN-1104 → KAN-1106 → KAN-1109 cluster banked 2026-06-06. Per-model Prisma field-naming conventions can diverge across the codebase (some models declare camelCase fields with @map snake_case; some procedures use the snake_case literal in queries by mistake). Verify each query against the model's actual Prisma client API before wiring a new panel.
type: feedback
---

**The pattern**: A panel wire-up exposes a latent Prisma query bug that was tolerated at typecheck (via baseline-tolerated errors on chronically-red workspaces) but throws at runtime when actually called. The bug is a per-model field-naming-convention mismatch: the schema declares `tenantId @map("tenant_id")` (camelCase Prisma field + snake_case SQL column), but the procedure uses `tenant_id` literally in `where` clauses, throwing `PrismaClientValidationError` at runtime.

**Three recurrences in 2 days**:

| Ticket | Procedure | Surface |
| --- | --- | --- |
| KAN-1104 | `dashboard.getStats` | KPI strip wire-up exposed 5 calls failing on `tenant_id` snake_case |
| KAN-1106 | 4 sibling procedures (decisions/actions/brain) | Class-fix batch fixed 11 LoC across decisions.list, decisions.getById, actions.list, brainRouter.getSnapshot |
| KAN-1109 (expected) | `objectives.create/update` | Predicted cascade: title vs name + Objective.status doesn't exist (filed pre-emptively for KAN-1106 deferral) |

## Anti-pattern

The original code was likely written when Prisma's snake_case + camelCase mapping was less clear, OR was copy-pasted from a different model's procedure without verifying the schema. Typecheck tolerated it because the chronically-red apps/api Build job masked the TS errors in baseline-tolerated state. PROD threw at runtime.

## Forward discipline

For any PR that wires a new dashboard panel OR adds a new Prisma procedure:

1. **Read the Prisma model declaration** in `packages/db/prisma/schema.prisma` for every model the procedure touches
2. **Verify the field convention**: Prisma client API uses the `field` name (camelCase by convention), NOT the `@map("snake_case")` SQL column name
3. **Cross-check the query**: every `where`, `select`, `orderBy`, `data` field must use the Prisma client form (camelCase), not the SQL form

If the procedure uses snake_case in any clause, fix it BEFORE wiring the panel. The wire-up surfaces latent bugs at PROD smoke; cleaner to fix at build time.

## Related patterns / memos

- `feedback_typecheck_chronically_red_masks_cascade_errors_unmask_on_fix.md` — chronically-red Build masks cascade errors
- `feedback_main_baseline_must_include_new_files_for_comm_23.md` — comm -23 baseline must include new files

## Banked from

- KAN-1104 fix-forward — `dashboard.getStats` 5 procedures all failing on snake_case
- KAN-1106 — 4-procedure batch fix
- KAN-1109 (filed) — objectives.create/update predicted cascade
- Session date: 2026-06-06
