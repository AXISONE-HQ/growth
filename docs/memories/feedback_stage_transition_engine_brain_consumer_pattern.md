# feedback_stage_transition_engine_brain_consumer_pattern

**Trigger:** Pure-module consumers of Brain Service (`feedback_brain_service_pure_module_pattern`) should short-circuit on terminal/no-op state BEFORE invoking Brain — saves the LLM call for cases that actually need a decision. Empirical anchor: KAN-796a stage-transition-engine — terminal-Deal short-circuit at the entry returns `skipped:already_terminal` with NO Brain call.

**Empirical anchor:** KAN-796a (PR #98, merged 8fad08c) pre-flight design choice. Brain Service evaluation costs ~$0.005-$0.05 per call (Sonnet reasoning); a terminal Deal cannot transition; calling Brain just to discover "this Deal is closed" wastes the LLM round-trip. Engine loads Deal + currentStage at entry; if `currentStage.outcomeType !== 'open'`, returns `skipped:already_terminal` with confidence-pre-flight semantics (no `brainDecision` field present). Sibling discipline to KAN-795 pipeline-router 0/1-Pipeline short-circuit.

---

## The pattern

Brain Service consumers should follow this entry-point shape:

```ts
export async function evaluateXForBrainConsumer(prisma, dealId, options) {
  // 1. Load minimal state needed to determine "do we even need Brain?"
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { currentStage: { select: { outcomeType: true } } },
  });
  if (!deal) throw new XConsumerNotFoundError(`Deal not found: ${dealId}`);

  // 2. SHORT-CIRCUIT before Brain call: any state where the consumer's
  //    answer is determined regardless of Brain's decision.
  if (deal.currentStage.outcomeType !== 'open') {
    return { type: 'skipped', reason: 'already_terminal' /* no brainDecision field */ };
  }

  // 3. ONLY NOW call Brain
  const brainDecision = await evaluateDealState(prisma, dealId, options);

  // 4. Apply consumer logic to Brain's decision
  // ...
}
```

The result type intentionally differs between short-circuit (no `brainDecision` present) and post-Brain paths (`brainDecision` always present). Consumers can branch on field presence to distinguish "no Brain call happened" vs "Brain ran and returned X".

---

## Why empirically

**Cost + correctness analysis:**

| Deal state | What can transition? | Brain call needed? | Cost saved per skip |
|---|---|---|---|
| `open` (active) | Yes — Brain decides advance/close/no-op | Yes | n/a |
| `terminal_won` (closed-won) | No — closure is final | No | ~$0.005-$0.05 |
| `terminal_lost` (closed-lost) | No — closure is final | No | ~$0.005-$0.05 |

For any system with a non-trivial fraction of terminal Deals (in steady state, most historical Deals are closed), the short-circuit eliminates Brain calls that could only return `no_action` anyway.

**Correctness bonus:** The short-circuit makes the engine's behavior on terminal Deals deterministic + auditable. Brain's `no_action` for terminal Deals would be the right output but with non-zero confidence variance; the short-circuit returns `confidence=1.0 + reason=already_terminal` deterministically.

---

## When to apply

- Any pure module that consumes Brain Service decisions
- Any decision pipeline where some entity states have determined outcomes regardless of LLM judgment (terminal/closed/archived states are the canonical examples)
- Any system where Brain calls have material per-call cost and a meaningful fraction of inputs are no-op cases

**When NOT to apply:**

- Cases where Brain might surface unexpected non-no-op decisions even on "terminal-looking" states (e.g., zombie-Deal recovery — but that's a different module)
- Cases where the short-circuit check itself requires the same data Brain would load (then there's no cost savings)

---

## Result-type discipline

Make the short-circuit case visually distinct from post-Brain cases:

```ts
export type StageTransitionResult =
  | { type: 'transitioned'; ...; brainDecision: BrainDecision }     // post-Brain
  | { type: 'no_transition'; ...; brainDecision: BrainDecision }   // post-Brain
  | { type: 'skipped'; ...; brainDecision?: BrainDecision };       // pre-Brain on terminal; brainDecision absent
```

Consumers can use `'brainDecision' in result` as a structural check to know whether a Brain call happened.

---

## Composability with other Phase 2 patterns

- **Pure-module pattern**: consumer is itself a pure module per Phase 2 sub-cohort (a) discipline
- **Short-circuit cost-win pattern** (`feedback_pipeline_router_short_circuit_on_single_candidate`): same idea applied to consumer side rather than producer side
- **Token-return alignment**: short-circuit returns no token counts because no LLM call occurred — same graceful-no-LLM degradation as KAN-798a send-policy

---

## Cross-references

- KAN-796a (origin — stage-transition-engine terminal short-circuit)
- KAN-794 — Brain Service producer with its own internal terminal-Deal short-circuit
- KAN-795 — sibling short-circuit pattern (0/1-Pipeline cases)
- [`feedback_brain_service_pure_module_pattern.md`](./feedback_brain_service_pure_module_pattern.md) — companion
- [`feedback_pipeline_router_short_circuit_on_single_candidate.md`](./feedback_pipeline_router_short_circuit_on_single_candidate.md) — companion
- KAN-813 (sub-cohort b — engagement-write wiring), KAN-814 (sub-cohort c — cron evaluator)

---

## Status

**Active.** Pattern will inform Phase 2 sub-cohorts (b)/(c) wiring (KAN-813/814) — the cron evaluator (KAN-814) especially benefits from short-circuiting on terminal Deals to avoid scanning closed Deals.
