---
name: Composite chronological view = server-side UNION pattern (instead of schema migration)
description: KAN-1107 Finding B banked 2026-06-06. When the operator needs a "chronological feed of decisions + escalations" without a source discriminator column, server-side UNION pattern (parallel queries + chronological merge + `kind` discriminator) is cleaner than schema migration. Avoids adding a column the engine doesn't need; delivers the same UX.
type: feedback
---

**The pattern**: A dashboard panel calls for a "chronological feed" that mixes two distinct row types (e.g., Decisions + Escalations). The natural design impulse is to add a `source` column to one of the models OR add a `kind` discriminator field to satisfy "what type is this row".

But the engine logic doesn't NEED the discriminator — it only matters for the UI. Server-side UNION delivers the same UX without the schema change.

**KAN-1107 Finding B**: Phase 1 PRD framed Decision Feed as "AI vs Human" rows. Schema verification: `Decision.source` doesn't exist; `Decision` rows are all AI-engine emissions. "Human" entries are actually `Escalation` rows (a different model).

**Solution**: NEW `decisionsRouter.feed` endpoint with chronological UNION:

```typescript
const [decisions, escalations] = await Promise.all([
  ctx.prisma.decision.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: N, include: {...} }),
  ctx.prisma.escalation.findMany({ where: { tenantId, status: 'open' }, orderBy: { createdAt: 'desc' }, take: N, include: {...} }),
]);
const items = [
  ...decisions.map((d) => ({ kind: 'decision' as const, ...projection })),
  ...escalations.map((e) => ({ kind: 'escalation' as const, ...projection })),
].sort((a, b) => b.createdAt - a.createdAt).slice(0, N);
return { items, total: decisions.length + escalations.length };
```

UI consumes the `kind` discriminator to render different badges + chip styles.

## Forward discipline

When a dashboard panel calls for a composite view (chronological feed, leaderboard, etc.) mixing rows from N different models:

1. **Verify the schema first** — does any model already have a discriminator column?
2. If not, **prefer server-side UNION** over schema migration. The discriminator is added at projection time, not at INSERT time.
3. **Sentinel test the UNION shape** — assert items carry the `kind` field; regression catches accidental shape change.
4. **File schema migration as separate ticket** if the discriminator is needed for engine logic (not just UI).

## Related patterns / memos

- `feedback_step_0_can_surface_empirical_data_realities_reframing_phase_1_locks.md` — Phase 1 schema verification surfaces design reframes
- `feedback_phase_1_loc_estimates_undercount_state_handling.md` — UNION pattern keeps PR scope small

## Banked from

- KAN-1107 (Decision Feed + Agent Actions) — Finding B Decision.source doesn't exist → UNION with Escalation
- Session date: 2026-06-06
