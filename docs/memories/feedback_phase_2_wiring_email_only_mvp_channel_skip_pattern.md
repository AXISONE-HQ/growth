# feedback_phase_2_wiring_email_only_mvp_channel_skip_pattern

**Trigger:** When a multi-channel message-producer's consumers are partially built (e.g., email yes, SMS/Messenger pending Phase 3 connector epics), branch on channel + log-and-skip the unbuilt cases with a clear "not yet supported" log line referencing the future epic. Don't error, don't silently drop, don't wait for the connectors. Empirical anchor: KAN-815c `phase-2-dispatch-channel-not-yet-supported` log line + KAN-800/801 references.

**Empirical anchor:** KAN-815c pre-flight (2026-05-03) — message-shaper.ts produces 3-channel output (`email`, `sms`, `meta_messenger`), but the legacy KAN-660/661 dispatch infrastructure is email-only. Phase 3 connector epics (KAN-800 SMS, KAN-801 Meta Messenger) will wire the missing channels. KAN-815c MVP shipped email-only with explicit channel-skip log for the others. Verified in tests #12 (sms output → no dispatch) and operationally available for production debugging.

---

## The pattern

```ts
// CONSUMER (KAN-815c dispatch consumer)
if (shaped.message.channel !== 'email') {
  console.log(
    `[lead-received-push] phase-2-dispatch-channel-not-yet-supported dealId=${dealId} eventId=${eventId} channel=${shaped.message.channel} — KAN-800/801 will wire these channels`,
  );
  return;
}
// proceed with email-only dispatch path
```

Three discipline elements:

1. **Branch BEFORE expensive operations** — channel skip happens before policy check, ChannelConnection lookup, Decision row write. Saves overhead on outputs that can't dispatch anyway.
2. **Explicit log with channel name + future-epic reference** — operators searching logs for "why did this dispatch silently disappear?" get an immediate answer + a ticket link to track.
3. **Return early, not throw** — non-email shaped output is a *valid* shaped output today; the producer (message-shaper) can't know the consumer's channel scope. Skip is the correct semantics, not error.

---

## Why empirically

**Producer-consumer asymmetry is normal during multi-phase build-outs.** Phase 2 substrate built ALL channels into message-shaper because the prompt + LLM cost is the same for any channel. Phase 3 connectors will ship per-channel — SMS via Twilio (already partially wired in `apps/connectors/src/adapters/twilio/`), Meta Messenger via the future KAN-803 connector. Until each connector ships, the Phase 2 producer correctly emits multi-channel output but the dispatch consumer can only act on one channel.

**Counterfactual: silent drop** — if KAN-815c just skipped non-email without logging, operators would see "Brain decided send_follow_up, message-shaper produced output, but no email arrived" and have no signal that the channel was the issue. Debug time wasted on Resend deliverability investigations.

**Counterfactual: throw** — would propagate a non-error condition as an error. KAN-815c's outer `.catch()` wrapper would treat it as Phase 2 wiring failure (per `feedback_phase_2_wiring_post_commit_brain_eval_isolation`), but the inbound was already committed. Logs would show false-positive errors for valid Brain decisions.

**Counterfactual: wait for connectors** — would mean Phase 2 substrate ships incomplete (no dispatch wiring) until ALL channels are ready. KAN-800/801/803 are separate epics on the Phase 3 roadmap; blocking Phase 2 ship on them defeats the sub-cohort discipline (`feedback_brain_service_pure_module_pattern`).

The log-and-skip pattern is the right shape: ship the consumer with the channel scope it can support today, document the gap explicitly in operational telemetry, file (or reference) the future epic.

---

## When to apply

- Multi-output producer + partial consumer scope (any pattern where producer emits N variants and consumer can only handle K < N)
- Any Phase-N substrate that consumers from Phase-N+1 will extend (channel coverage is one example; field coverage in normalizers is another — KAN-792 normalizer emits intent fields that some downstream consumers don't yet read)
- Any feature flag / gradual rollout where the unbuilt cases need observable handling rather than silent drop

**When NOT to apply:**

- Cases where the producer's output is genuinely *invalid* (shape error, validation failure) — those are errors, not channel-skip
- Cases where the unbuilt consumer would land within the same PR (then just build it, don't ship a skip)
- Cases where waiting is operationally cheap (rare — usually waiting blocks downstream value)

---

## Discipline checklist

When implementing a partial-consumer that skips unbuilt cases:

- [ ] Branch BEFORE expensive operations (DB writes, LLM calls, external API calls)
- [ ] Explicit log line with: caller context (dealId, eventId), the unbuilt case name (channel, field, etc.), and a reference to the future epic that will land it
- [ ] Return early — don't throw, don't continue with degraded output
- [ ] Test coverage for the skip path (assert no DB writes / no API calls / log emitted with right shape)
- [ ] PR body documents the skip + the future epic that closes it

---

## Sample log line shape (production-tested, KAN-815c)

```
[lead-received-push] phase-2-dispatch-channel-not-yet-supported dealId=cmoqXXX eventId=evt_YYY channel=sms — KAN-800/801 will wire these channels
```

The `— KAN-XXX/YYY will wire these channels` suffix is load-bearing for operator context. Without it, a future operator might not know whether the gap is intentional or an oversight.

---

## Cross-references

- KAN-815c (origin — channel-skip pattern in dispatchPhase2Send)
- KAN-797a message-shaper.ts (producer of the multi-channel output)
- KAN-800 SMS connector (future channel-1 wiring)
- KAN-801 Meta Messenger connector (future channel-2 wiring)
- KAN-803 Generic Webhook (alternate channel surface)
- [`feedback_phase_2_wiring_decision_row_shim_for_legacy_publishactionsend.md`](./feedback_phase_2_wiring_decision_row_shim_for_legacy_publishactionsend.md) — companion (KAN-815c sub-cohort)
- [`feedback_phase_2_wiring_post_commit_brain_eval_isolation.md`](./feedback_phase_2_wiring_post_commit_brain_eval_isolation.md) — companion
- [`feedback_brain_service_pure_module_pattern.md`](./feedback_brain_service_pure_module_pattern.md) — sub-cohort discipline that enables shipping partial consumers

---

## Status

**Active.** Pattern applies to any Phase 2/3 transition where producer ships ahead of full consumer coverage. KAN-800/801 work will eventually retire the channel-skip branches by wiring full coverage.
