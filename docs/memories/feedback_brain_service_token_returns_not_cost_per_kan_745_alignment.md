# feedback_brain_service_token_returns_not_cost_per_kan_745_alignment

**Trigger:** When an architecture has async cost-tracking infrastructure (per `feedback_model_pricing_refresh_discipline` + KAN-745 llm.call topic), DON'T return $USD cost inline from new LLM consumers. Return raw token counts (more useful for prompt-budget planning anyway); cost flows through the existing topic. Single source of truth for MODEL_PRICING; no denorm cost field to drift.

**Empirical anchor:** KAN-794 Brain Service (PR #96) pre-flight surfaced this — PRD pseudocode said `BrainDecision.llmCostUsd: number` but llm-client.complete() doesn't return cost inline. KAN-745 architecture emits cost asynchronously via the llm.call Pub/Sub topic → llm-cost-aggregator partitions per-tenant. Three options surfaced (return tokens / return literal 0 / compute locally from MODEL_PRICING); chose **tokens** to preserve KAN-745 single-source posture. Pattern then propagated through KAN-795 PipelineRoutingDecision, KAN-796a StageTransitionResult.brainDecision (inherits via Brain), KAN-797a ShapedMessage — all four consequential consumers return `llmInputTokens` + `llmOutputTokens` instead of `llmCostUsd`. KAN-798a (send-policy) breaks the pattern in a good way: pure module with no LLM call, so no token field at all.

---

## The pattern

For any new LLM caller in a system with KAN-745-style async cost tracking:

```ts
// ✅ DO
export interface MyDecision {
  // ... domain fields ...
  modelTier: 'cheap' | 'reasoning';
  /**
   * KAN-745 architecture: llm-client emits cost asynchronously via llm.call
   * topic → llm-cost-aggregator. Returns raw token counts so consumers can
   * compute cost themselves (via MODEL_PRICING) or join the async rollup.
   * See feedback_model_pricing_refresh_discipline.
   */
  llmInputTokens: number;
  llmOutputTokens: number;
}

// ❌ DON'T
export interface MyDecision {
  llmCostUsd: number; // duplicates MODEL_PRICING; creates drift surface
}
```

---

## Why empirically

**Three forces drove the choice:**

1. **MODEL_PRICING is a single quarterly-refresh constant** (per `feedback_model_pricing_refresh_discipline`). Returning $USD inline would mean every LLM caller imports MODEL_PRICING — when prices change, every caller's cost values drift unless they all bump their MODEL_PRICING_VERSION usage in lockstep.

2. **llm-client.complete() doesn't return cost inline** by design. It emits the llm.call event with tokens + tier; llm-cost-aggregator subscribes + computes cost using the canonical MODEL_PRICING. Returning cost inline at the consumer site would mean either (a) duplicating the cost computation or (b) blocking on the aggregator's reply (which doesn't exist — it's fire-and-forget).

3. **Tokens are more useful at the consumer site than $USD.** Phase 2 consumers care about prompt-budget planning ("can I batch-evaluate 100 deals on cheap tier within token cap?") more than per-decision $USD. Per-tenant $USD rollups live downstream in the aggregator.

**Counterfactual — what would have happened if BrainDecision returned llmCostUsd:**

- Each KAN-794 consumer (KAN-795/796/797) would have its own cost field, each computing $USD differently.
- MODEL_PRICING refresh (per quarterly discipline) would require coordinating updates across 5+ consumer modules.
- llm-cost-aggregator's per-tenant rollup might disagree with consumer-local sums (different MODEL_PRICING_VERSION snapshots in flight). Reconciliation queries become a debug nightmare.

The token-return pattern eliminates this entire class of cost-drift bugs.

---

## When to apply

- Any new LLM consumer in a codebase with KAN-745-style async cost tracking
- Any classifier/decision/composer module that surfaces LLM call results to callers
- Any pure module designed for sub-cohort discipline (per `feedback_brain_service_pure_module_pattern`) — token returns make the module independent of cost-tracking infrastructure changes

**When NOT to apply:**

- Standalone scripts or one-off tools where you genuinely need $USD inline for budget gating before the call returns (rare)
- Systems without async cost aggregation (then inline cost is the only signal you have)

---

## Composability with other Phase 2 patterns

- **Pure-module pattern** (`feedback_brain_service_pure_module_pattern`): token returns keep the module independent of cost-tracking infra evolution
- **Sub-cohort discipline**: when sub-cohort (b) wiring lands, it can compute cost locally OR query the aggregator OR ignore — flexibility preserved
- **No-LLM compliance layer** (`feedback_send_policy_pure_code_no_llm_for_compliance_layer`): KAN-798a doesn't return tokens because there's no LLM call — pattern degrades gracefully

---

## Cross-references

- [`feedback_brain_service_pure_module_pattern.md`](./feedback_brain_service_pure_module_pattern.md) — companion pattern
- KAN-794 (origin — BrainDecision), KAN-795/796a/797a (sibling adopters), KAN-798a (graceful pattern absence)
- KAN-745 PR A — MODEL_PRICING constant + llm.call topic emission architecture
- `feedback_model_pricing_refresh_discipline` — the underlying single-source-of-truth posture this pattern preserves

---

## Status

**Active.** Pattern applies to any future LLM consumer. Phase 3+ epics (KAN-799 Meta Lead Ads classification, etc.) will use the same token-return discipline.
