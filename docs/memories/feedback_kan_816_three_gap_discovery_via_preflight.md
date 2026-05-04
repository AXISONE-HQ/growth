# feedback_kan_816_three_gap_discovery_via_preflight

**Trigger:** When a Jira ticket names ONE symptom ("X missing"), the actual gap surface area is usually broader. Run a pre-flight audit on the dispatch chain BEFORE touching code — listing every site that touches the affected data — and the ticket scope expands accordingly. Don't write the PR against the ticket title.

**Empirical anchor (KAN-816, Sprint 9):** Ticket title was *"Outbound Engagement gap fix"* — capturing the symptom Fred noticed (no Engagement row written when AI sent the Sprint 8 email). Pre-flight audit of `action.executed` consumer → outbound write path → Resend adapter surfaced **3 distinct fixes**, all of which had to land together for the multi-turn customer-reply loop to close:

1. **Outbound Engagement write missing** (the named symptom) — `action-executed-push.ts` had ActionOutcome write but no co-located Engagement write
2. **Resend correlation tags incomplete** — adapter only sent `tenant_id` + `action_id` + `connection_id` + `mode`; `decision_id` and `contact_id` weren't on the wire, so consumer couldn't correlate webhook → action chain (caused "missing correlation tags" warning that blocked `action.executed` publish — the ROOT cause of #1's symptom)
3. **Reply-To header missing** — Sprint 8 outbound went out without Reply-To, so customer replies routed to `hello@growth.axisone.ca` (catch-all) instead of `<inboxSlug>@leads.axisone.ca` (per-tenant inbox); KAN-741 inbound webhook never received them

PR #102 covered all three. Had we PR'd to ticket title only, the customer-reply loop would still be broken post-merge.

---

## The pattern

Before writing a PR for a ticket whose scope is "fix gap X":

1. **Trace the dispatch chain end-to-end** — every Pub/Sub topic, every consumer, every external API call, every DB write
2. **For the affected data, list every site that reads/writes it** — `grep` the field names + `grep` the entity name across services
3. **Run the failing path manually** to surface every adjacent error (here: Resend webhook log inspection revealed the missing-tags warning that wasn't in the ticket)
4. **Compare ticket scope vs surfaced gaps** — if surfaced > ticket, expand ticket scope and PR description before writing code
5. **Bundle the cohort into one PR** — multiple gaps in one chain are usually atomic for the headline outcome (here: any one alone leaves the loop broken)

---

## When to apply

- Any ticket of form "X missing" / "Y not happening" — symptom-driven titles often hide chain-of-cause gaps
- Any ticket that touches a multi-service async dispatch chain (Pub/Sub, webhooks, external APIs)
- Any ticket where the user's empirical observation was downstream of where the fix actually needs to land

**When NOT to apply:**

- Truly localized fixes (single-file null-check, single-test addition) — pre-flight is overhead for these
- Tickets with scope already expanded by prior diagnostic (the audit was done up-front in the ticket itself)

---

## Cross-references

- KAN-816 — origin (3-gap discovery)
- PR #102 (merge commit `73599f9`) — bundle that covered all 3 fixes
- Fix-forward `3a9351c` on main — 2 KAN-816 regression tests missed in the original PR (sibling pattern: post-merge audit catches what pre-merge audit missed)
- `feedback_smoke_tenant_config_gaps_block_headline_outcomes.md` — companion (smoke gate as a discovery surface for config gaps)

---

## Status

**Active.** Apply pre-flight chain-trace as standard discipline for any ticket on the multi-service dispatch chain.
