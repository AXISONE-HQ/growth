# feedback_phase_2_wiring_post_commit_brain_eval_isolation

**Trigger:** Brain re-eval (or any Phase-N+1 wiring layer) that runs AFTER an inbound transaction commits MUST be in a separate try/catch wrapper. Brain failures must NOT block the inbound engagement commit, AND must NOT cause Pub/Sub redelivery (which would double-write the inbound). Empirical anchor: KAN-815a `phase-2-wiring-error` log isolation + verified by Test #8 (Brain throws → response still 200, engagement committed).

**Empirical anchor:** KAN-815a pre-flight + design (2026-05-03). Inbound engagement transaction (Phase 1, KAN-793) commits Contact + Deal + DealStageHistory + Engagement in a single Prisma transaction. KAN-815a Brain re-eval runs AFTER this commit — Brain reads the just-written Engagement as input. If Brain (or any downstream consumer in 815b/c) fails, the inbound is already durable; failing the response would trigger Pub/Sub retry → double-write the same inbound (correlationId UNIQUE catches the Deal duplicate, but the symptom is unnecessary retry traffic + log noise + audit-trail confusion).

Sprint 8 smoke verified the isolation pattern operationally: both smoke runs had Brain succeed, but the wrapper's `.catch()` is the safety net for the case where Brain throws — engagement still committed, response still 200, no Pub/Sub retry.

---

## The pattern

```ts
// PHASE 1 — inbound engagement-write transaction (commits durably)
const dealId = await writePhase1Deal(event, contact.tenantId, assignment);
//                                     ^^^^^^^^^^^^^ Contact + Deal + DealStageHistory + Engagement
//                                     all written in single prisma.$transaction

// PHASE 2 — wiring trigger AFTER commit, isolated via .catch()
if (dealId) {
  await wirePhase2Consumers(dealId, event.eventId).catch((err) => {
    console.warn(
      `[handler] phase-2-wiring-error dealId=${dealId} eventId=${event.eventId} err=${(err as Error)?.message ?? String(err)}`,
    );
    // Don't rethrow. Phase 2 failure must not propagate.
  });
}

return c.text('ok', 200);
```

Three discipline elements:

1. **Phase 2 wiring runs AFTER the engagement transaction commits** — Brain reads the just-written state, so the transaction must be committed before Brain reads. Within-tx Brain calls would either read uncommitted state (incorrect) or hold the transaction open during the LLM round-trip (terrible — multi-second tx hold time, lock contention).

2. **`.catch()` at the call site, not `try/catch` inside `wirePhase2Consumers`** — the `.catch()` pattern guarantees no exception escapes from the Phase 2 wiring path. Inner try/catch can be forgotten (sub-cohort b/c may add new throw paths that bypass the inner catch).

3. **Return 200 unconditionally if engagement committed** — Pub/Sub retry semantics: 200 means "ack, don't retry." Phase 2 failure is real, but it's NOT the inbound's failure — the inbound succeeded. Logging the failure separately preserves the audit trail without triggering retry.

---

## Why empirically

**Two failure modes the isolation prevents:**

### Failure mode 1 — Pub/Sub double-write storm

Without isolation: Brain throws → handler propagates the error → response is 500 → Pub/Sub retries the inbound → handler runs again → engagement transaction's `correlationId` UNIQUE catches the duplicate (idempotency works) BUT the operator sees N retry attempts in logs, can't distinguish "brain failed once" from "brain failed N times," and Pub/Sub eventually DLQs the message after retries exhaust.

With isolation: Brain throws → `.catch()` logs the failure → response is 200 → Pub/Sub acks → engagement is durable → Brain failure visible as exactly one log line. Operator can re-fire Brain manually if needed (via a separate trigger), without re-running the inbound.

### Failure mode 2 — Inbound rollback on Phase 2 error

Without isolation: if Phase 2 wiring is INSIDE the engagement transaction (anti-pattern), Brain throw rolls back the engagement write. The inbound contact + deal + engagement disappear. Pub/Sub retries → same Brain failure → same rollback. Inbound never lands. Lead lost.

With isolation: engagement transaction commits BEFORE Phase 2 starts. Even if Brain blows up the entire universe, the inbound is durable.

---

## What "Phase N+1 wiring" means here

This pattern generalizes beyond just Brain re-eval. Any time a new layer is added that runs against just-written state from an existing layer:

- Phase 2 Brain re-eval after Phase 1 engagement-write (KAN-815, this entry)
- KAN-805 Shared Learning Layer reading Decision rows + Engagement history (future)
- KAN-806 Cost observability aggregating per-tenant LLM spend (future — already async via Pub/Sub, so isolation is structural)
- Hypothetical Phase 4 webhook fanout to tenant-configured external systems

The discipline: **the new layer's reads happen AFTER the old layer's writes commit; the new layer's failures don't propagate back to the old layer's response.**

---

## When to apply

- Any wiring trigger that runs against just-committed state
- Any new layer added to a handler that already has a stable response semantic (200 = ack, 5xx = retry)
- Any LLM call (or other slow external call) that would otherwise hold a transaction open
- Any consumer that the producer's correctness shouldn't depend on

**When NOT to apply:**

- Cases where the new layer's failure SHOULD trigger Pub/Sub retry (rare — usually the inbound succeeding is the load-bearing thing)
- Cases where the new layer is genuinely transactional with the old layer (then it's part of the same transaction, not a separate phase)

---

## Test coverage discipline

KAN-815 Test #8 (`Brain throws → Phase 2 wiring caught (response still 200, engagement-write committed)`) is the canonical regression test for this pattern. Mock Brain to reject; assert (a) response status === 200, (b) Phase 1 mocks (dealCreate, etc.) called once (engagement committed), (c) Phase 2 downstream mocks (stage-transition, shape) NOT called (failure isolated).

```ts
it("Brain throws → Phase 2 wiring caught (response still 200, engagement-write committed)", async () => {
  setupHappyPathMocks();
  evaluateDealStateMock.mockReset();
  evaluateDealStateMock.mockRejectedValueOnce(new Error("Brain Service unavailable"));

  const res = await postEnvelope(buildPushEnvelope());

  expect(res.status).toBe(200);                  // Pub/Sub ack
  expect(dealCreateMock).toHaveBeenCalledOnce(); // Phase 1 write happened
  expect(evaluateDealStateMock).toHaveBeenCalledOnce();  // Brain attempted
  expect(evaluateStageTransitionMock).not.toHaveBeenCalled();  // Phase 2 downstream isolated
  expect(shapeMessageMock).not.toHaveBeenCalled();
});
```

---

## Cross-references

- KAN-815a (origin — `wirePhase2Consumers().catch()` wrapper) + Test #8
- KAN-815 PR #101 (merge commit `0b8c697`) — production deployment
- KAN-793 (Phase 1 inbound transaction shape this isolates from)
- [`feedback_phase_2_wiring_decision_row_shim_for_legacy_publishactionsend.md`](./feedback_phase_2_wiring_decision_row_shim_for_legacy_publishactionsend.md) — companion (Decision row write also in own transaction)
- [`feedback_phase_2_wiring_email_only_mvp_channel_skip_pattern.md`](./feedback_phase_2_wiring_email_only_mvp_channel_skip_pattern.md) — companion (KAN-815c)
- `feedback_webhook_200_not_end_to_end_proof` — sibling discipline (200 OK isn't end-to-end success; here we go further: 200 OK is correct even on Phase 2 failure as long as Phase 1 succeeded)
- `feedback_kan_741_resend_payload_shape_mismatch` — historical example of the OPPOSITE failure (where Phase 1 SHOULD have failed loudly but didn't)

---

## Status

**Active.** Pattern applies to all future Phase N+1 wiring trigger work. KAN-805 / KAN-806 / KAN-807 + Phase 4-5 epics will all add layers atop existing handlers; same isolation discipline applies.
