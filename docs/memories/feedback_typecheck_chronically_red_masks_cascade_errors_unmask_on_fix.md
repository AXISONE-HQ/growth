---
name: Chronically-red typecheck masks cascade errors that unmask on fix
description: KAN-1104 + KAN-1115 banked 2026-06-06. When chronically-red workspaces hide TS errors via batch rejection, fixing one error class can expose previously-masked cascading errors. Surface the cascade + decide absorb-vs-followup per per-ticket discipline.
type: feedback
---

**The pattern**: A "fix one error" PR mechanically corrects a literal bug (e.g., `tenant_id` → `tenantId` snake_case fix). The fix UNMASKS a second-tier error that was hidden by the first-tier rejection. The cascade reveals additional bugs in the same procedure (or sibling procedures) that need decision.

**Two recurrences in 2 days**:

1. **KAN-1104**: snake_case fix at `dashboard.getStats.objective.count` unmasked TS2353 cascade — `Objective.status` field doesn't exist on the schema. The original code referenced `status: "completed"` which the snake_case rejection had masked. Required `status: "completed"` → `isActive: true` Option C absorption.

2. **KAN-1115**: branching logic fix-forward extracted handler logic from inline to `services/brain-layers-impl.ts`. Test coverage at the new module surfaced the placement bug (gap rule #1 evaluation skipped during empty-state branch) that was undetectable at the prior mocked-response-shape sentinel level.

## Anti-pattern

Treating the cascade as "out of scope" and shipping the snake_case fix without the cascade absorption. Per KAN-1080 / `feedback_fix_exposes_next_error.md`, when fixing one error class exposes another, the right call is usually **absorb the cascade if the fix is minimal** (1-5 LoC) OR **file a separate ticket** if the cascade requires deeper architectural change.

## Forward discipline

After any mechanical fix in a chronically-red workspace:

1. Re-run tsc + capture the diff
2. **comm -23** baselines (PR errors vs main baseline) to surface new errors introduced by the fix
3. For each new error: decide **absorb** (if minimal LoC) vs **file follow-up** (if architectural)
4. Audit before merging — never ship without surfacing the cascade

The cascade absorption discipline traces back to `feedback_fix_exposes_next_error.md` (banked earlier). This memo reinforces with 2026-06-06 recurrences in the Dashboard v2 epic context.

## Related patterns / memos

- `feedback_fix_exposes_next_error.md` — original cascade discipline memo
- `feedback_prisma_field_convention_per_model_must_verify_before_panel_wireup.md` — original Prisma field issue
- `feedback_sentinel_tests_for_backend_behavior_must_exercise_real_backend_not_mock.md` — discipline upgrade for behavior-asserting tests

## Banked from

- KAN-1104 fix-forward (Objective.status cascade)
- KAN-1115 fix-forward (gap eval branching)
- Session date: 2026-06-06
