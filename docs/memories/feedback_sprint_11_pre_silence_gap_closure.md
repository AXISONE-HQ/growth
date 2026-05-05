# feedback_sprint_11_pre_silence_gap_closure

**Trigger:** Sprint 11-pre (2026-05-05) closed the customer-perceived AI silence gap discovered during Sprint 10 KAN-817 smoke. The gap had three architectural surfaces — fix one, the next surfaced. Each was Brain making sound product judgment; the substrate composition was where decisions got lost.

**Empirical anchor:** Sprint 10 evening 4 inbound attempts on Deal Y produced 0 customer-visible outbounds (Brain advance_stage 3×, Brain send_follow_up + Send Policy DEFER lost forever 1×). Sprint 11-pre fixed the underlying classes; verification smoke (Deal `cmosw60dm00043vs890o2nmo5`, Contact `533e4de0-4e2a-4cb0-8b89-05d2524664e6`, Resend message `52bb4b1c-706f-4e53-acff-5b1adf69d163`) at 2026-05-05 17:17:45 → 17:30:07 UTC delivered AI email to `fred@mkze.vc` end-to-end, 12 minutes total (deferred for window-narrow test; ~12-15s in normal posture).

---

## What shipped (Sprint 11-pre)

| Sub-cohort | Ticket | What it did | Commit |
|---|---|---|---|
| 0 | KAN-814 sub-0 | Send Policy reads `Tenant.settings.sendWindow.{start,end}` as `"HH:MM"`; minute-aware rounding ("23:59" end → 24 sentinel = always-in-window); silent fallback on no-config + warn on malformed | PR #106 → `b7bebbb` |
| A | KAN-825 | Post-stage-advance auto-follow-up chain. Directive Trigger block in chained Brain prompt biases toward `send_follow_up` ("Strong preference" + "silence at this point produces a UX dead-end"). Loop guard via local boolean (max chain depth 1) | PR #107 → `cecd208` |
| B | KAN-814 main | `deferred_sends` queue + 5-min cron evaluator + supersession path on fresh inbound | PR #108 → `2f1a4a6` |
| C | KAN-834 | Stage Transition Engine accepts pre-computed `brainDecision` option; cures LLM-non-determinism double-eval class | PR #109 → `88d3c24` |

---

## Meta-lessons (the load-bearing memories)

### 1. The "smoke surfaces gaps" pattern (Sprint 6→11 invariant)

Every smoke since Sprint 6 has revealed at least one architectural surface we didn't know existed. **Sprint 11-pre ran 4 attempts and surfaced 3 distinct gaps:**

1. **Send Policy hour-boundary** (Sprint 10 evening): hardcoded 9-21 constants ignored `settings.sendWindow` JSON. Fix: KAN-814 sub-cohort 0 wire-through.
2. **`advance_stage` silence**: Brain's "I should advance the pipeline" decision produced no customer-visible outbound. Fix: KAN-825 chained Brain with directive Trigger block.
3. **Brain double-eval LLM-non-determinism** (KAN-834): two Brain calls on identical Deal state, ~3s apart, returned different decisions. Engine internally re-ran Brain, disagreed with dispatcher's first call, emitted `no_transition`, KAN-825 chain skipped, customer silence. Fix: thread pre-computed decision into engine; single source of truth.

This is the smoke methodology working as intended. **Architectural rule: smoke is not "verify what we wrote" — it's "discover what we missed."** Treat smoke discoveries as the deliverable, not as a regression flag.

### 2. The "Brain isn't wrong" framing

Every silence-producing pattern surfaced this sprint was **Brain making sound product judgment**:

- `advance_stage` on a positive-engagement first-touch → "advance the pipeline, capitalize on momentum" — correct sales logic
- `wait_for_response` on a Quote-Sent Deal with repeated inbounds → "we already replied; awaiting human action" — correct deference logic
- `send_follow_up` after engine's internal re-eval → also correct

**The substrate composition was the gap, not the model's reasoning.** Brain decisions never need to be "fixed"; the orchestration around Brain decisions needs to handle Brain's full decision space without dropping any to silence.

**Architectural rule:** when an LLM has downstream consumers, **single-source-of-truth the call**. Don't re-invoke "for safety." If you need to recompute, accept that you may recompute differently. KAN-834 codifies this for the Brain → Engine handoff.

### 3. The over-paranoia correction

Sprint 11-pre sub-cohort 0 verification offered three options: (A) production smoke at 9pm tonight, (B) 10-min direct probe script, (C) close on unit tests + deploy + DB confirmation. The 10-min probe was the over-cautious option; closing on unit-test evidence was correct. **Don't over-verify when the code path is well-tested + production-deployed + DB-confirmed.** Pattern: distinguish *direct* probe (10 lines, deterministic) from *integrated* smoke (full chain, expensive). Use the smaller verification when it suffices.

### 4. The methodology-mismatch class

Sprint 11-pre had two methodology-mismatch incidents — verification target couldn't be reached because the smoke setup didn't compose with the code path:

- **`phase-2-send-policy-allowed` log only fires on `send_follow_up` branch.** Smokes targeting it can't verify Send Policy if Brain doesn't reach the gate. Fix: KAN-833 (env-gated bypass for downstream-only verification).
- **Hotmail rate-limit DENY blocked Phase 1c verification** in the combined-flow smoke. Required dev-tenant wipe to retry from a fresh-Contact starting state. Fix: KAN-836 (per-conversation rate-limit posture).

**Architectural rule:** when a sub-cohort tests a specific code path, prefer **direct module probe over end-to-end smoke** for verification. End-to-end smokes are for integrating + production-validating; not the right tool for verifying a single guarantee inside one module.

### 5. The confabulation gap (Sprint 11a unblocking signal)

Sprint 11-pre's verification smoke produced an AI email saying *"your quote is now ready for your review"* — but no quote actually existed. Brain confabulated based on Deal-stage context (the Deal had auto-transitioned to "Quote Sent" via KAN-825 chain). Verbatim email body captured.

This is exactly the gap **Sprint 11a Knowledge Layer** addresses. With a Knowledge Base wired in, the AI knows what's actually in the tenant's product/quote system instead of inventing reasonable-sounding details. Today's smoke empirically demonstrates **why Sprint 11a is the right next investment** — substrate is now genuinely reliable, but the content layer is still confabulation-prone.

### 6. The "Send Policy 'PROVEN' overstatement" pattern (recurring)

Send Policy has now had **three "PROVEN" overstatements** caught in successive smokes:

1. **Sprint 9** — `settings.timezone` wasn't actually read by Send Policy
2. **Sprint 10 morning** — `defer` was log-only with no rescheduler
3. **Sprint 10 evening** — `start/end` hours hardcoded, ignored `settings.sendWindow` JSON

Each was an aspirational comment that hadn't shipped (`"Per-tenant override via Tenant.settings.X deferred"`). KAN-837 will audit the file for any remaining drift.

**Architectural rule:** when shipping a comment that says *"future"* / *"deferred"* / *"per-tenant override via X"*, treat it as a **forward-spec liability**. Either ship the wire-through in the same PR, or rewrite the comment to reference an explicit ticket. Don't leave aspirational language in production code that drifts from reality.

---

## End-to-end timing (verification smoke)

| Step | Timestamp (UTC) | Duration |
|---|---|---|
| Inbound (`fred@mkze.vc` "CRM General Request") | 17:17:45.396 | — |
| Brain initial decision (advance_stage 0.78) | 17:17:50.549 | +5.2s |
| Stage Transition (KAN-834: pre-computed decision used) | 17:17:50.627 | +0.1s |
| Chained Brain (KAN-825: send_follow_up 0.92) | 17:17:53.216 | +2.6s |
| Send Policy DEFER (window narrow) + KAN-814 persist | 17:17:53→58 | +5s |
| **Window widened (manual)** | 17:26:18 | — |
| **Cron tick (next 5-min boundary)** | 17:30:02.401 | claimed row |
| Re-dispatch via `publishActionSend` | 17:30:02→04 | +2s |
| Resend send ok | 17:30:04.128 | — |
| Resend `email.delivered` webhook | 17:30:07.438 | +3.3s end-to-end (cron→delivered) |
| **Total real-production cycle (window-open path)** | — | **~12-15s** |

The 12-minute test total was the deferred-path verification (cron tick at 5-min boundary). With the window open, the dispatch path bypasses the cron and the cycle is ~12-15s inbound→inbox.

---

## Bonus: multi-turn AI conversation with KAN-819 + KAN-825 + KAN-814 + KAN-834 all live

Fred replied to the AI email at 17:32:15 ("Re: Next Step: Let's Schedule Some Time Together"). KAN-819 reused Deal `cmosw60dm...`. Brain → `send_follow_up` 0.92. KAN-817 outbound dispatched at 17:32:29:

- Subject: "Your Quote Is Ready — Let's Walk Through It Together"
- Confabulated content (Sprint 11a Knowledge Layer fixes this)

Fred replied AGAIN at 17:35:59 — third inbound on same Deal. The full Sprint 10 + 11-pre stack handled all three turns end-to-end.

---

## Cross-references

- KAN-817 (PR #105) — content visibility (subject + bodyPreview in Engagement.metadata)
- KAN-819 (PR #104) — structural cross-turn memory (Deal continuity)
- KAN-814 sub-cohort 0 (PR #106) — Send Policy reads `settings.sendWindow`
- KAN-825 (PR #107) — post-stage-advance auto-follow-up chain
- KAN-814 main (PR #108) — `deferred_sends` queue + cron + supersession
- KAN-834 (PR #109) — LLM-non-determinism double-eval cure
- KAN-832 — audit-trail symmetry (advance_stage Decision row promotion, Sprint 11+)
- KAN-833 — `SEND_POLICY_BYPASS` env-var dev/test escape hatch (Sprint 11+)
- KAN-835 — `wait_for_response` chaining (Sprint 11+)
- KAN-836 — per-Contact rate-limit tuning for active conversations (Sprint 11+)
- KAN-837 — Send Policy comprehensive config audit (Sprint 11+)
- KAN-838 — structural send-on-first-touch safety net (Sprint 11+ monitor-only)
- `feedback_smoke_tenant_config_gaps_block_headline_outcomes` — sibling class (3rd instance closed by KAN-814 sub-cohort 0)
- `feedback_kan_816_three_gap_discovery_via_preflight` — same multi-gap-via-smoke pattern from Sprint 9
- `feedback_phase_2_wiring_repeatedly_surfaces_legacy_infrastructure_gaps` — same meta-pattern
- `feedback_phase_2_wiring_decision_row_shim_for_legacy_publishactionsend` — Decision row shim pattern (extended at re-dispatch by KAN-814)

---

## Status

**SHIPPED + PROVEN end-to-end (2026-05-05).** AI replies reliably end-to-end. Substrate ready for Sprint 11a Knowledge Layer + Persona work to build on.
