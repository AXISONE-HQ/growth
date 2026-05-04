# feedback_outbound_engagement_co_located_with_action_outcome

**Trigger:** When the consumer of an executed-event needs to write multiple downstream rows that share the same source data (the executed event), co-locate the writes in the same handler in the same transaction. Don't add a SECOND consumer subscription for the SECOND write — that doubles ack/retry semantics and creates a second failure domain for one logical operation.

**Empirical anchor (KAN-816 PR #102):** `action.executed` already had `actionOutcome.create` in `apps/api/src/subscribers/action-executed-push.ts`. The outbound Engagement write needed the same envelope (tenantId, contactId, connectionId, providerMessageId, channel, body) — adding it next to the ActionOutcome write was 30 lines of code. The alternative (separate subscriber → second push subscription on `action.executed` → second IAM grant → second smoke gate) would have multiplied infrastructure surface for no semantic gain.

---

## The pattern

When extending an executed-event consumer with a new downstream side-effect:

```ts
// ✅ DO — co-locate writes in the same handler
async function handleActionExecuted(event: ActionExecutedEvent) {
  await prisma.$transaction(async (tx) => {
    await tx.actionOutcome.create({ data: outcomeFromEvent(event) });
    // KAN-816: outbound Engagement write co-located here. Same envelope,
    // same tx — atomic, single failure domain.
    if (event.channel === 'EMAIL' && event.status === 'sent') {
      await tx.engagement.create({ data: engagementFromEvent(event) });
    }
  });
}

// ❌ DON'T — second subscription with split semantics
// new file: subscribers/action-executed-engagement-push.ts
// new sub: action.executed.outbound-engagement-write
// new IAM grant, new smoke gate, new failure domain for the same data
```

---

## Why empirically

**Three forces drove the choice:**

1. **One source-of-truth event.** ActionOutcome and Engagement are both *projections* of the executed event onto different read models — there's no scenario where one should write but not the other for the same successful send. Splitting the writes opens drift (one succeeds, the other doesn't, KAN-805 learning consumer reads inconsistent state).

2. **Transactional atomicity is free here.** Both rows live in the same Postgres database; a `$transaction` wrap costs one round-trip and gives all-or-nothing semantics. A second subscriber path costs at least one round-trip plus Pub/Sub ack overhead plus a separate retry policy.

3. **Single audit/observability surface.** Logs for "what happened to action X" all live in one handler. Engagement-write failures + ActionOutcome-write failures share a single dashboard row, single error signal. Splitting fragments observability.

**Counterfactual — second subscriber:**
- Initial saving: zero (the new write is 30 lines either way)
- Long-term cost: 2× IAM grants, 2× smoke gates, 2× retry policies, 2× dashboards, drift between the two if either fails partially
- Sibling antipattern visible in `apps/api/src/subscribers/`: 4 subscribers each doing one thing, each with its own audience/IAM/route — adding a 5th for one shared write would have set the wrong precedent

---

## When to apply

- Adding a downstream write that's a strict projection of an already-consumed event onto a different read model
- Adding a side-effect that should fire if-and-only-if the existing handler's primary write succeeds
- Any case where the two writes share a single failure domain by intent (atomic from the user's perspective)

**When NOT to apply:**

- The new side-effect has different retry semantics (e.g. the original needs at-least-once, the new one needs at-most-once or a different retry policy)
- The new side-effect has different IAM/tenant scoping (the original is system-level, the new one is tenant-level with different SA permissions)
- The new side-effect is genuinely independent and could fire even if the original failed (rare in practice — usually a sign the events should be split upstream, not split at the consumer)

---

## Cross-references

- KAN-816 PR #102 (merge commit `73599f9`) — origin
- `apps/api/src/subscribers/action-executed-push.ts` — production handler with the co-located write
- `feedback_phase_2_wiring_decision_row_shim_for_legacy_publishactionsend.md` — sibling pattern (real audit anchor row vs synthetic ID)
- `feedback_kan_816_three_gap_discovery_via_preflight.md` — sibling (the discovery that surfaced this need)
- KAN-805 Shared Learning Layer — downstream consumer that benefits from atomic writes

---

## Status

**Active.** Apply for any new executed-event downstream write going forward.
