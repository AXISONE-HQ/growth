# feedback_phase_2_wiring_repeatedly_surfaces_legacy_infrastructure_gaps

**Trigger:** Phase 2 modules (Brain → Pipeline Router → Stage Transition Engine → Message Shaper → Send Policy) keep surfacing GAPS in the legacy infrastructure they're being wired against — gaps the legacy code didn't notice because it never exercised the affected paths. Plan for "wiring a Phase 2 module" to cost ~20-40% extra for legacy-side fixes the original tickets didn't scope.

**Empirical anchor (Sprint 7 → Sprint 9, 3 distinct instances):**

1. **KAN-795 → aiAssignmentFallback gap** (Sprint 7). Pipeline Router needed pipeline candidates loaded for a Deal. Legacy lead-assignment flow had `aiAssignmentFallback=true` on KAN-705 push-subscribers, which meant pipelineId was sometimes left null. Phase 2 surfaced this as a routing precondition violation; the fix had to land in the lead-assignment module, not the Pipeline Router.

2. **KAN-797 → message-composer.ts module purity gap** (Sprint 7-8). Message Shaper's tests needed message-composer.ts importable in isolation. Legacy module had transitive imports pulling in Pub/Sub publisher, prisma client, and observability — all needed mocking just to test the new shaper. Refactor split message-composer into a pure-module + side-effect-emitting wrapper. (Tracked in `feedback_brain_service_pure_module_pattern.md`.)

3. **KAN-816 → publishActionSend shape gap + LEAD_INBOX_DOMAIN env-var gap** (Sprint 9). Phase 2 dispatch wiring (KAN-815) needed `publishActionSend(client, { decisionId, ... })` to accept Brain-driven decisions. Legacy helper assumed Decision rows always existed (they did, from the old strategy-selector path). Phase 2 didn't write Decision rows → required the Decision Row Shim pattern (`feedback_phase_2_wiring_decision_row_shim_for_legacy_publishactionsend.md`). And the legacy `LEAD_INBOX_DOMAIN ?? 'leads.axisone.app'` fallback — never exercised pre-Phase-2 because no module set Reply-To — silently produced wrong-TLD addresses the moment Phase 2 started consuming the helper.

---

## The meta-pattern

**Phase 2 wiring is a stress test for legacy code paths that never had production traffic on them.** Each Phase 2 module exercises infrastructure (publishers, helpers, env-var-driven config) that legacy modules either didn't call OR called only in a narrow happy-path. The gap surface is:

- **Code paths that existed but were dormant** (helper signatures with optional fields no caller ever set)
- **Defaults that were placeholder-grade** (env-var fallbacks that worked for dev but were typos / wrong TLDs / wrong domains for prod)
- **Module purity assumptions** (legacy modules importing transitively for side effects, fine for the single legacy caller, broken for any module that wants to test in isolation)
- **FK shape assumptions** (legacy publish helpers assuming caller wrote certain rows first, which Phase 2 callers don't)

Plan for a 20-40% scope overrun on Phase 2 wiring tickets — and budget time for the legacy fix in the same sprint as the wiring (deferring it strands the wiring half-shipped).

---

## When to apply

- Estimating Phase 2 ticket scope: add 20-40% buffer for "legacy-side fixes surfaced by wiring"
- Reviewing a Phase 2 wiring PR: check whether the PR also touches files OUTSIDE the new Phase 2 module — that's where the legacy gap lives
- Sprint planning: pair Phase 2 wiring tickets with their likely-adjacent legacy fixes; don't promise both in separate sprints

**When the meta-pattern stops:**

- When all 5 Phase 2 modules are wired and traffic-on (current state: KAN-815 closed, multi-turn proven). Future modules added to the chain will surface fewer gaps because the legacy paths have been re-exercised.
- When a Phase 3 module (escalation-response, broadcast follow-up) starts wiring against the chain — expect the meta-pattern to recur, but at lower amplitude (the legacy paths have been hardened by the Phase 2 sweep)

---

## Cross-references

- KAN-795 PR #97 — Sprint 7 instance (aiAssignmentFallback)
- KAN-797a PR #99 — Sprint 7 instance (message-composer purity)
- KAN-816 PR #102 — Sprint 9 instance (publishActionSend shape + LEAD_INBOX_DOMAIN)
- `feedback_phase_2_wiring_decision_row_shim_for_legacy_publishactionsend.md` — sibling pattern
- `feedback_phase_2_wiring_email_only_mvp_channel_skip_pattern.md` — sibling pattern
- `feedback_phase_2_wiring_post_commit_brain_eval_isolation.md` — sibling pattern
- `feedback_brain_service_pure_module_pattern.md` — KAN-797 instance documented standalone

---

## Status

**Active.** Lower amplitude going into Sprint 10+ but still load-bearing for any future module wiring against the existing chain.
