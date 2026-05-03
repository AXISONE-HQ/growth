# feedback_smoke_tenant_config_gaps_block_headline_outcomes

**Trigger:** Production-realistic tenant configuration is its own concern, distinct from MVP code correctness. Fresh tenants don't have all settings populated; safety defaults exist for operational reasons but may not match smoke-test expectations. Discipline: smoke tests must either (a) explicitly set up tenant config before firing OR (b) expect to UPDATE + re-fire. Empirical anchors: Phase 1 close required `default_pipeline` posture UPDATE; Sprint 8 close required `timezone='America/Toronto'` UPDATE. Both times, code was correct; tenant config was the gap.

**Empirical anchor:** Two consecutive close-of-sprint smokes hit the same class of failure mode:

- **Phase 1 close (2026-05-03 21:04 UTC, KAN-793 sprint)**: First smoke failed because tenant `axisone-growth` had `belowThresholdPosture='stay_unassigned'` (the safe default). Brain returned `mode=unassigned`, no Deal created, §2 metric stayed 0/0. Required Option A: 1-row UPDATE setting `belowThresholdPosture='default_pipeline'` + `defaultAssignmentPipelineId='8723e31d-...'`. Second smoke landed cleanly.

- **Sprint 8 close (2026-05-03 23:33 UTC, KAN-815 sprint)**: First smoke failed because tenant `axisone-growth` had no `Tenant.settings.timezone` configured. Send Policy correctly fell back to UTC + 9-21 hardcoded window; current 23:33 UTC was outside; Send Policy correctly returned `defer`. The dispatch chain stopped at the gate. Required Option A: 1-row UPDATE setting `Tenant.settings.timezone='America/Toronto'`. Second smoke at 23:39 UTC computed Toronto-local hour (~7:39 PM) → in window → ALLOW → real outbound email sent (Resend message ID `500f6981-31df-44d7-ab21-e9e1fd0b77d8`).

Pattern: code was correct in BOTH cases. The gap was tenant configuration. Two separate smoke runs in the same session both hit it.

---

## The pattern

Production smoke tests against fresh tenants will encounter safety-default values that block headline outcomes. The defaults exist for legitimate operational reasons (don't auto-route ambiguous leads; don't send outside business hours). But those defaults aren't tuned for smoke-test expectations.

**Smoke test discipline (one of three):**

1. **Pre-smoke tenant config setup**: explicit UPDATE statements in the smoke runbook before firing. Documents the assumed config in the test itself. Sample:
   ```sql
   UPDATE tenants SET below_threshold_posture = 'default_pipeline', ... ;
   UPDATE tenants SET settings = jsonb_set(settings, '{timezone}', '"America/Toronto"');
   ```

2. **Expect-and-document UPDATE iteration**: smoke runner anticipates a config gap on first run, has the UPDATE + re-fire path documented as a normal path. Used in Phase 1 + Sprint 8 closes — both required exactly one UPDATE + re-fire iteration.

3. **Skip gates via per-call options**: invoke the consumer with skip-flags (e.g., `evaluateSendPolicy(prisma, ..., { skipTimeOfDay: true })`). Useful for unit/integration tests but NOT for production smokes (skip-flags wouldn't be set in the inbound chain that production uses).

**Recommend (1) for documented smoke runbooks** — gives the test reproducibility. Recommend (2) for first-time smokes against new tenant configs — surfaces the gaps as you learn what the safety defaults are.

---

## Why empirically

**Three forces drove the recurring gap:**

1. **Safety defaults are opinionated** — `stay_unassigned` is conservative (don't auto-route leads to a wrong Pipeline). UTC is the timezone-agnostic default (don't send at 3am tenant-local). These are correct posture for cold-start tenants. Smoke tests just don't usually want them.

2. **Smoke test inputs aren't tenant-customized** — Fred's test email lands at 7:30 PM ET = 23:30 UTC = outside UTC business hours. The fact that a smoke happens during normal Toronto working hours is irrelevant unless the tenant timezone is configured.

3. **Onboarding wizards eliminate this class** — KAN-807 Onboarding Wizard (in Phase 5 roadmap) will guide tenants through config: pick timezone, pick posture, pick auto-approve profile. Once Onboarding is live, fresh tenants will have full config from day 1, and the "smoke needs UPDATE first" pattern will be retired.

**Counterfactual — bypass via skip flags:**
- Smoke gate is conceptually different from production — adding skip-flags to the inbound code path to "make smoke pass" would weaken production governance
- The UPDATE iteration is honest: smoke discovers the config gap, operator fixes the config, smoke passes. Same path a real tenant would take during onboarding.

---

## When to apply

- Any production smoke against a tenant with default-only config
- Any first-time end-to-end test against a new substrate (Phase 1 close, Sprint 8 close, future Phase 3+ closes)
- Any post-deploy verification where the substrate is new but the test tenant is old

**When NOT to apply:**

- Smoke tests against tenants known to have full config already (rare in early-phase rollout)
- Unit/integration tests (use skip-flags or fixture data; don't mutate prod tenant config in tests)

---

## Discipline checklist for end-of-sprint smokes

- [ ] Identify which tenant config fields the new substrate reads
- [ ] Query the test tenant's current values for those fields
- [ ] Compare against safety defaults — note any that would block headline outcomes
- [ ] Either pre-smoke UPDATE OR document the expected UPDATE iteration in the smoke runbook
- [ ] Authorize each UPDATE per `feedback_destructive_flag_gate` discipline
- [ ] Re-fire smoke + verify

For the canonical Phase 1 + Sprint 8 smoke close pattern: 1 UPDATE + 1 re-fire per smoke. Total ~5 minutes overhead. Smaller than the cost of investigating "why didn't the smoke work."

---

## Tenant config fields known to gate headline outcomes (as of Sprint 8)

| Field | Safety default | Smoke-friendly value | Required by | First surfaced |
|---|---|---|---|---|
| `Tenant.belowThresholdPosture` | `stay_unassigned` | `default_pipeline` (with `defaultAssignmentPipelineId` set) | KAN-705 lead-assignment | Phase 1 close (KAN-793) |
| `Tenant.defaultAssignmentPipelineId` | `NULL` | a real Pipeline id (e.g., `8723e31d-...`) | KAN-705 lead-assignment | Phase 1 close (KAN-793) |
| `Tenant.settings.timezone` | `NULL` (UTC fallback) | tenant-local IANA name (e.g., `'America/Toronto'`) | KAN-798a send-policy | Sprint 8 close (KAN-815) |
| `Tenant.settings.sendPolicy.{startHour, endHour}` | not read in MVP (hardcoded 9-21) | (will land in KAN-815 sub-cohort b OR Onboarding Wizard config) | KAN-798a future expansion | not yet surfaced |

This list will grow as future epics add tenant-readable config fields.

---

## KAN-807 Onboarding Wizard retires this pattern

Once KAN-807 ships guided tenant onboarding, fresh tenants will have all config fields populated through the wizard flow. Smoke tests against onboarding-completed tenants won't need UPDATE iterations. **Pattern retiring condition:** when KAN-807 lands AND the smoke test tenant is re-onboarded through the wizard.

Until then, the UPDATE-and-re-fire pattern is the operational reality.

---

## Cross-references

- KAN-793 Phase 1 close (origin — `belowThresholdPosture` UPDATE pattern)
- KAN-815 Sprint 8 close (Sprint 8 origin — `Tenant.settings.timezone` UPDATE pattern)
- KAN-807 Onboarding Wizard (future epic that retires this pattern)
- `feedback_destructive_flag_gate` — UPDATE authorization discipline applies
- [`feedback_phase_2_wiring_decision_row_shim_for_legacy_publishactionsend.md`](./feedback_phase_2_wiring_decision_row_shim_for_legacy_publishactionsend.md) — Sprint 8 companion
- [`feedback_phase_2_wiring_email_only_mvp_channel_skip_pattern.md`](./feedback_phase_2_wiring_email_only_mvp_channel_skip_pattern.md) — Sprint 8 companion
- [`feedback_phase_2_wiring_post_commit_brain_eval_isolation.md`](./feedback_phase_2_wiring_post_commit_brain_eval_isolation.md) — Sprint 8 companion
- KAN-816 — Sprint 9 follow-up (different gap, also surfaced by Sprint 8 smoke — Resend correlation tags)

---

## Status

**Active.** Pattern applies to all production smokes until KAN-807 Onboarding Wizard ships. Field-known-to-gate-outcomes list grows as new epics add tenant-readable config.
