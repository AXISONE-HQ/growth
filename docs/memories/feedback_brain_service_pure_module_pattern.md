# feedback_brain_service_pure_module_pattern

**Trigger:** Cross-cutting services that multiple downstream features will consume should be built as PURE MODULES with zero callers FIRST, then wired into consumers in separate sub-cohorts. Defers all integration risk to dedicated wiring epics. Empirical anchor: Phase 2 epics 1-5 (KAN-794 Brain Service through KAN-798a Send Policy) all shipped sub-cohort (a) "pure module + tests, zero callers" before any downstream wiring.

**Empirical anchor:** Phase 2 architectural design choice driven through 5 consecutive epics on 2026-05-03. KAN-794 Brain Service shipped first (PR #96, merged db06c205) with no callers; KAN-795 pipeline-router consumed Brain decisions transparently when it shipped (PR #97, af68ec8); KAN-796a stage-transition-engine consumed Brain decisions (PR #98, 8fad08c); KAN-797a message-shaper consumed Brain decisions (PR #99, a5c4f6d); KAN-798a send-policy needed no Brain coupling (PR #100, 2e9dabc). Five epics, zero Brain-side changes after the first PR. Each consumer dependency was a code-level integration only — no Brain Service refactor needed because the pure module's API was stable from PR #96.

---

## The pattern

When introducing a cross-cutting service (one that multiple downstream features will consume):

1. **Sub-cohort (a) — pure module first.** Build the service with no callers, no persistence side-effects, no external integrations. Comprehensive tests. Ship to main. Production behavior unchanged.
2. **Sub-cohort (b) — first consumer wiring.** Wire ONE consumer (the highest-priority or most-validated one). Tests verify the integration without modifying the pure module.
3. **Sub-cohort (c+) — additional consumers.** Each new consumer is its own PR, each consuming the same stable pure-module API.

The key invariant: **the pure module's API stops mutating after sub-cohort (a) ships.** All subsequent changes are consumer-side. If a consumer reveals an API gap, it's a deliberate sub-cohort (b+) decision to extend the pure module — not an emergency refactor.

---

## Why empirically

**Sequential consumer integration without Brain churn:**

| Sub-cohort | PR | What changed in Brain Service? |
|---|---|---|
| KAN-794 (a) — Brain pure module | #96 | Created brain-service.ts |
| KAN-795 — pipeline-router consumes Brain pattern | #97 | Nothing |
| KAN-796a — stage-transition-engine consumes Brain | #98 | Nothing |
| KAN-797a — message-shaper consumes Brain | #99 | Nothing |
| KAN-798a — send-policy (orthogonal) | #100 | Nothing |

5 PRs, 0 Brain-side changes after the first. The `BrainDecision` shape locked at PR #96 because it was designed for consumption, not for the test cases of any one specific consumer.

**Counterfactual — what would have happened if Brain shipped wired to its first consumer:**
- The first consumer's needs would have shaped Brain's API (e.g., if pipeline-router shipped first, Brain might have included routing-specific fields).
- Subsequent consumers would push the API in different directions, leading to a Brain API that's an awkward union of all consumers' needs.
- API changes propagate breakage across all consumers in the same PR — every wiring epic also becomes a Brain refactor epic.

The pure-module-first discipline eliminated this entire class of churn.

---

## When to apply

- Any cross-cutting service with multiple downstream consumers (decision engines, evaluators, classifiers, governance layers)
- Any service whose API would otherwise be shaped by the first caller's narrow needs
- Any service where the integration risk is higher than the implementation risk

**When NOT to apply:**

- Single-consumer utilities (no cross-cutting concern; just build it inline at the consumer site)
- Services with deeply coupled persistence requirements where pure-module abstraction creates more complexity than it removes
- Hotfix paths where end-to-end working code is needed in one PR (sub-cohort discipline adds PR count)

---

## Sub-cohort (a) discipline checklist

When opening sub-cohort (a) PR, verify:

- [ ] Zero callers in production code (only tests reference the new module)
- [ ] PR body explicitly states "Production behavior unchanged after merge"
- [ ] Follow-up tickets filed for sub-cohorts (b+) before this PR merges
- [ ] Tests cover the full API surface independent of any caller's specific shape
- [ ] Module exports include "snapshot" / "introspection" types separately from the result types (so future consumers can use partial outputs)

---

## Cross-references

- [`feedback_brain_service_token_returns_not_cost_per_kan_745_alignment.md`](./feedback_brain_service_token_returns_not_cost_per_kan_745_alignment.md) — companion entry on cost-tracking architecture alignment in pure modules
- [`feedback_pipeline_router_short_circuit_on_single_candidate.md`](./feedback_pipeline_router_short_circuit_on_single_candidate.md) — companion (KAN-795 example of consumer adding short-circuit value)
- [`feedback_stage_transition_engine_brain_consumer_pattern.md`](./feedback_stage_transition_engine_brain_consumer_pattern.md) — companion (KAN-796a Brain consumer pattern)
- [`feedback_phase_1_pivot_kan_786_to_kan_791_lifecycle_model.md`](./feedback_phase_1_pivot_kan_786_to_kan_791_lifecycle_model.md) — sibling sub-cohort discipline (Phase 1 pivot preserved sub-cohort a+b AS-IS)
- KAN-794 (origin), KAN-795/796a/797a/798a (consumers), KAN-813/814/815 (sub-cohort b+c follow-ups)

---

## Status

**Active.** Pattern applies to any future cross-cutting service. Will inform Phase 3 (KAN-799 Meta Lead Ads, KAN-800 SMS, KAN-801 Meta Messenger, etc.) — each connector should likely follow the same pure-adapter-then-wire discipline.
