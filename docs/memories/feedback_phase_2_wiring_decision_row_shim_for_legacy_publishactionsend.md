# feedback_phase_2_wiring_decision_row_shim_for_legacy_publishactionsend

**Trigger:** When integrating a NEW Brain-driven module with legacy infrastructure that requires a foreign-key reference (here: `publishActionSend(client, { decisionId, ... })` requires a real Decision row id), write a real audit-anchor row rather than synthesizing a fake ID. Sibling antipattern: `feedback_kan_811_forensic_row_fk_violation` (KAN-811 documents a sentinel-UUID-that-doesn't-exist FK violation in the Resend inbound webhook). Empirical anchor: KAN-815c Decision row with `strategy_selected='brain_phase_2_v1'` (verified in production at decisionId `adc96280-2256-4850-a398-161d81e8bc3b`).

**Empirical anchor:** KAN-815c pre-flight (2026-05-03) surfaced 5 substantive shape divergences between `publishActionSend(client, { tenantId, contactId, decisionId, toEmail, composed, connectionId })` (legacy KAN-660/661 helper) and the spec's pseudo-call. Three options surfaced: (A) Decision row shim → write a real Decision row before publishActionSend, use its id; (B) Synthetic decisionId via `randomUUID()`; (C) New `publishBrainDispatch` helper alongside legacy. Chose **A** because (i) writes a real audit anchor for "Brain decided X at time T" that KAN-805 Shared Learning Layer will need anyway; (ii) reuses existing `decisions` table (no new contract); (iii) avoids the synthetic-ID antipattern (sibling to KAN-811); (iv) the Decision write fits naturally between Send Policy approval and the Resend dispatch. Production verified: Decision row `adc96280-2256-4850-a398-161d81e8bc3b` written at 23:39:59 UTC with full Brain + Shaper input snapshot; Sprint 8 smoke fired the real outbound email immediately after.

---

## The pattern

When a new module's output needs to integrate with a legacy publish/dispatch helper that requires a foreign-key reference to a row the new module doesn't write:

1. **Identify the FK requirement** in the legacy helper's signature
2. **Write a real audit-anchor row** with the data the new module DOES have, capturing it in fields the legacy schema accepts:
   - `actor` / `strategySelected` / `actionType` for the semantic descriptor
   - `confidence` / `reasoning` for the Brain's decision context
   - `metadata` JSON for everything else (input snapshot, model tier, tokens — for downstream learning consumers)
3. **Use the real row's `id`** as the FK reference at the publish call site
4. **Write in own transaction** (separate from the originating engagement-write tx, so failure isolation per `feedback_phase_2_wiring_post_commit_brain_eval_isolation`)

```ts
// ✅ DO — real audit anchor
const decisionRow = await prisma.decision.create({
  data: {
    tenantId: deal.tenantId,
    contactId: deal.contactId,
    strategySelected: 'brain_phase_2_v1',
    actionType: brainDecision.nextBestAction.type,
    confidence: brainDecision.confidence,
    reasoning: brainDecision.nextBestAction.reasoning,
    metadata: { /* full input snapshot for learning consumers */ },
  },
});
await publishActionSend(client, { decisionId: decisionRow.id, /* ... */ });

// ❌ DON'T — synthetic ID
await publishActionSend(client, { decisionId: randomUUID(), /* ... */ });
//                                           ^^^^^^^^^^^^ FK reference to a row that doesn't exist
```

---

## Why empirically

**Three forces drove the choice:**

1. **Real audit anchor for downstream learning.** KAN-805 Shared Learning Layer (folded to include channel-preference learning per KAN-797a sub-cohort c deferral) will read Decision rows to compute "Brain decided X for Deal Y at time T, here's what happened next." A synthetic decisionId would either NOT have a corresponding row (FK pointing nowhere) or would have a row with different shape (no Brain context captured). The shim writes the right shape from the start.

2. **No FK-violation antipattern.** Sibling memory `feedback_kan_811_forensic_row_fk_violation` documents a sentinel-UUID-that-doesn't-exist (`'00000000-0000-0000-0000-000000000000'`) in the Resend inbound webhook's rejection branch — FK violates 100% of the time, rejection-audit row silently dropped. Writing a real Decision row from the start avoids re-creating that bug class.

3. **Decision row IS the natural place** for "Brain made this call" — the `decisions` table already exists (KAN-39), already has `tenantId`/`contactId`/`actionType`/`confidence`/`reasoning`/`metadata` fields, already has FK relationships to downstream consumers (escalations, dealStageHistory). Reusing it is more honest than introducing a parallel `brain_decisions` table.

**Counterfactual — Option B (synthetic decisionId):**
- Initial saving: 1 fewer Prisma write per dispatch
- Long-term cost: KAN-805 has nothing to read; "what did Brain decide?" requires reconstructing from log timestamps; no FK linkage between dispatch and decision
- Antipattern reinforces FK-pointing-nowhere bug class (sibling to KAN-811)

---

## When to apply

- Any new Brain-driven module integrating with a legacy publish/dispatch helper that requires FK references
- Any new audit-trail emission where the canonical "audit anchor" row is partially redundant with new module's output (write the full row, link from the dispatch)
- Any cross-architecture bridge where the new architecture needs to leave a trail for future consumers (KAN-805-style learning layers, observability dashboards, etc.)

**When NOT to apply:**

- Truly ephemeral dispatches with no downstream consumer (rare — most production systems have at least one consumer that will eventually want the audit trail)
- Cases where the legacy helper accepts a nullable FK or has a separate "fire-and-forget" mode (then no shim needed)

---

## Discipline checklist

When integrating a new Brain-driven module with a legacy FK-requiring publish helper:

- [ ] Identify the FK fields in the legacy helper's signature
- [ ] Confirm the FK target table accepts the new module's data shape (or extend if needed)
- [ ] Write the audit row in its OWN transaction (not nested in the originating tx)
- [ ] Capture full input snapshot in `metadata` JSON for downstream consumers
- [ ] Use the audit row's real `id` at the publish call site
- [ ] Document the shim with a comment referencing this memory entry
- [ ] Verify FK target row IS written before the publish fires (sequencing matters — publish fails or has dangling reference if FK row write fails)

---

## Cross-references

- KAN-815c (origin — Decision row shim with `strategy_selected='brain_phase_2_v1'`)
- KAN-815 PR #101 (merge commit `0b8c697`) — production deployment
- Decision row `adc96280-2256-4850-a398-161d81e8bc3b` — first AI-driven outbound email's audit anchor (production, 2026-05-03 23:39:59 UTC)
- [`feedback_kan_811_forensic_row_fk_violation`](https://axisone-team.atlassian.net/browse/KAN-811) — sibling antipattern (sentinel-UUID FK violation)
- [`feedback_phase_2_wiring_post_commit_brain_eval_isolation.md`](./feedback_phase_2_wiring_post_commit_brain_eval_isolation.md) — companion (own-transaction discipline)
- [`feedback_phase_2_wiring_email_only_mvp_channel_skip_pattern.md`](./feedback_phase_2_wiring_email_only_mvp_channel_skip_pattern.md) — companion (KAN-815c sub-cohort)
- KAN-805 Shared Learning Layer — downstream consumer of these Decision rows
- KAN-816 — Sprint 9 follow-up (outbound Engagement gap due to Resend correlation tags) — sibling concern at the OPPOSITE end of the dispatch chain

---

## Status

**Active.** Pattern applies to all future Brain-driven modules integrating with legacy FK-requiring infrastructure.
