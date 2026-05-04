# feedback_multi_turn_ai_conversation_proven_in_production

**Trigger:** Sprint 9 close milestone — multi-turn AI conversation works end-to-end in production. Customer email → AI reply → customer reply → AI reply, with full Brain-driven decisions, per-tenant Reply-To routing, and outbound Engagement persistence on each turn. ~30s per turn, ~90s for two-turn smoke.

**Empirical anchor (2026-05-03, post-PR #102 + Fix 1 deploy):**

- **Turn 1:** customer email → Phase 2 dispatch chain → AI reply
  - Deal: `cmorl38gn0002m7wb6b754zcr`
  - Decision: `888f6a81-1a30-470e-97ef-eba0b58af31c` (`strategy_selected='brain_phase_2_v1'`)
  - Outbound Engagement written via KAN-816 co-located write
  - Reply-To: `<inboxSlug>@leads.axisone.ca` (per Fix 1 env update)

- **Turn 2:** customer reply (to Turn 1 AI email's Reply-To) → KAN-741 inbound webhook → assignment to existing Deal → Phase 2 re-eval → second AI reply
  - Deal: `cmorl4vgz000cm7wb0flgvuph` (new — Sprint 10's KAN-817 will fold these into single Deal via subject+body anti-repetition)
  - Decision: `48c171b7-2382-4795-9ea5-0d6d8f7ad323`
  - Same Reply-To routing, same Phase 2 path

- **End-to-end:** ~90s for both turns, sub-30s per turn (Brain LLM call dominant)

---

## What this proves structurally

1. **Phase 2 substrate works in production.** Brain → Pipeline Router → Stage Transition Engine → Message Shaper → Send Policy → Resend, end-to-end, with real tenant data, real LLM calls, real outbound email, real customer reply. Not a smoke against fixtures.

2. **KAN-741 inbound webhook works.** Customer's Reply-To-routed reply was correctly assigned to the existing tenant via inbox-slug parsing; SES → Resend → Pub/Sub → consumer → Lead → Deal → Phase 2 re-eval all chained correctly.

3. **KAN-816 outbound Engagement write closes the loop.** Anti-repetition is now possible (each turn has a persisted Engagement row with body preview); KAN-797a Message Shaper's anti-repetition input read from `engagement.history` is now populated.

4. **Per-tenant Reply-To routing works post-Fix-1.** The customer-reply path requires `<inboxSlug>@leads.axisone.ca` as the From-side header on the AI's email; Fix 1 (env update on growth-api) made this work in production. KAN-818 / Fix 2b removes the silent .app fallback that caused the original Reply-To bug.

---

## What this proves operationally

- **Sprint 9 SHIPPED with multi-turn proof.** Originally chartered as "outbound Engagement gap fix"; closes with the full multi-turn customer-reply loop demonstrated end-to-end.
- **Pre-flight discipline (3-gap discovery via audit) was load-bearing.** Without the pre-flight, ticket would have shipped with only the named gap fixed; the loop would still have been broken on first multi-turn smoke.
- **Smoke-discovery class held.** First multi-turn smoke discovered the LEAD_INBOX_DOMAIN .app/.ca typo. Sprint 9 close-gate caught what unit tests + pre-merge env audits couldn't.

---

## Carry-forward

- **KAN-817 (Sprint 10):** subject+body in Engagement.metadata for content-aware anti-repetition. Currently `bodyPreview` is the anti-repetition signal; subject is dropped. Fold into Sprint 10 Message Shaper enhancement.
- **KAN-818 (Sprint 10):** admin UI inbox-address display verification post-Fix-2b deploy. Once PR #103 merges, smoke that tenant settings UI shows `<slug>@leads.axisone.ca`.
- **KAN-819 (Sprint 10 candidate):** Resend delivery-webhook still emits "missing tags" warning at 19:20:09 + 19:21:28 — separate from action-send-push path that IS working. Investigate or close as benign.

---

## Cross-references

- KAN-816 PR #102 (merge commit `73599f9`) — outbound Engagement gap + Reply-To wiring
- Fix-forward `3a9351c` on main — KAN-816 regression tests
- Fix 1 (gcloud env update on growth-api) — `gcloud run services update growth-api --update-env-vars LEAD_INBOX_DOMAIN=leads.axisone.ca` → revision `growth-api-00157-fst`
- Fix 2b PR #103 — structural fix (no-default at boot) — pending merge
- KAN-815 PR #101 — Phase 2 dispatch wiring (Sprint 8)
- `feedback_kan_816_three_gap_discovery_via_preflight.md` — sibling
- `feedback_outbound_engagement_co_located_with_action_outcome.md` — sibling
- `feedback_reply_to_universal_at_publish_helper.md` — sibling
- `feedback_env_var_default_fall_through_silent_typo.md` — sibling

---

## Status

**Headline outcome.** Sprint 9 close. Phase 2 substrate is now production-load-bearing for the customer-reply loop.
