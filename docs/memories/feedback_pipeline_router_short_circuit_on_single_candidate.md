# feedback_pipeline_router_short_circuit_on_single_candidate

**Trigger:** When a service has both deterministic short-circuit cases and LLM-driven full-evaluation cases, the cost wins live in the SHORT-CIRCUIT, not in the tier downshift. Build short-circuits at the entry; preserve high-quality tier (Sonnet) for the cases where evaluation is actually needed. Empirical anchor: KAN-795 pipeline-router 0/1-Pipeline short-circuit (skips LLM entirely for current production tenant) + reasoning tier preserved for multi-Pipeline cases.

**Empirical anchor:** KAN-795 pre-flight (2026-05-03) surfaced two design pressures: (1) cost minimization for the Sprint 7+ scale plan where multi-Pipeline tenants would emerge via KAN-807 Onboarding Wizard, (2) routing-decision quality concerns (wrong routing cascades to every downstream Stage/objective). Initial spec considered cheap-tier (Haiku) downshift as the cost lever. Pre-flight + analysis showed: current production state is 1 tenant / 1 Pipeline → ALL routing decisions hit the 1-Pipeline short-circuit → zero LLM calls regardless of tier. Tier downshift would have produced zero cost win for current state and degraded quality for future multi-Pipeline cases. Real cost lever = the short-circuit. Sonnet preserved for the consequential 2+ Pipeline path.

---

## The pattern

For services with mixed deterministic + LLM-driven evaluation:

```ts
export async function someClassifier(prisma, input, options) {
  const candidates = await loadCandidates(prisma, input);

  // Short-circuit 1: 0 candidates → deterministic answer
  if (candidates.length === 0) {
    return { decision: 'no_candidates', confidence: 1.0, llmTokens: 0 };
  }

  // Short-circuit 2: 1 candidate → deterministic answer (the answer is "the only option")
  if (candidates.length === 1) {
    return { decision: 'route', target: candidates[0].id, confidence: 1.0, llmTokens: 0 };
  }

  // Full evaluation: 2+ candidates → LLM call (high tier — wrong answer cascades)
  return await llmDrivenEvaluate(prisma, input, candidates, { tier: 'reasoning' });
}
```

The short-circuits return `confidence=1.0` (deterministic) and `llmTokens=0` (no LLM call). The full-evaluation path uses the higher-quality tier because that's where decision quality matters.

---

## Why empirically

**Cost analysis at Sprint 7 production state:**

| Tenant config | Routing decisions/day | Current cost | Cost if cheap-tier | Cost if short-circuit |
|---|---|---|---|---|
| 1 Pipeline (current) | ~10 | 0 (already short-circuit) | 0 | 0 |
| 5 Pipelines (Sprint 8+) | ~50 | $0.05 (Sonnet) | $0.005 (Haiku) | $0.05 (Sonnet) |
| 50 Pipelines (Phase 5+) | ~500 | $0.50 (Sonnet) | $0.05 (Haiku) | $0.50 (Sonnet) |

The "cost win" of cheap-tier downshift would land only at the 5+ Pipeline tier, AND it pays for itself in routing-quality regression: a wrong route (Sonnet would have caught) cascades to Stage assignments that don't fit the Pipeline objective, mis-shaped messages, etc. Per `feedback_model_pricing_refresh_discipline`, Sonnet for consequential.

The 0/1-Pipeline short-circuit is a categorical cost win (any number × 0 is still 0) and adds no quality risk because there IS no decision to make in those cases.

---

## When to apply

- Classifiers / routers / matchers where some inputs have deterministic answers (single candidate, empty candidate set, exact-match rules)
- Decision services where the "high cardinality" cases benefit from LLM reasoning AND the "low cardinality" cases don't need it
- Any module where you're tempted to downshift tier for cost — first check whether short-circuiting some inputs would deliver the same cost win without the quality regression

**When NOT to apply:**

- Cases where every input genuinely benefits from LLM evaluation (rare — usually there's a deterministic special case)
- Hot paths where the short-circuit check itself adds latency (unlikely — counting candidates is O(1) amortized)

---

## Composability with other Phase 2 patterns

- **Pure-module pattern**: short-circuits make the module faster + cheaper without changing the API surface
- **Token-return alignment**: short-circuit cases naturally return `llmTokens: 0`, which downstream consumers and llm-cost-aggregator both interpret correctly (no async cost event emitted because no LLM call happened)
- **Brain Service consumer pattern** (`feedback_stage_transition_engine_brain_consumer_pattern`): KAN-796a applies the same idea — terminal-Deal short-circuit at the entry, no Brain call

---

## Cross-references

- KAN-795 (origin — pipeline-router 0/1-Pipeline short-circuits)
- KAN-796a — sibling pattern (terminal-Deal short-circuit)
- KAN-794 — sibling pattern (terminal-Stage short-circuit in Brain Service)
- [`feedback_brain_service_pure_module_pattern.md`](./feedback_brain_service_pure_module_pattern.md) — companion
- [`feedback_brain_service_token_returns_not_cost_per_kan_745_alignment.md`](./feedback_brain_service_token_returns_not_cost_per_kan_745_alignment.md) — companion
- `feedback_model_pricing_refresh_discipline` — Sonnet-for-consequential posture

---

## Status

**Active.** Pattern will inform Phase 3 connectors (e.g., Meta Lead Ads classification — short-circuit on exact-match form-field mappings before LLM-driven semantic mapping).
