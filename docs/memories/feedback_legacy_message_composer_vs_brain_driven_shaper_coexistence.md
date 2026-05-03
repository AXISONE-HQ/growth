# feedback_legacy_message_composer_vs_brain_driven_shaper_coexistence

**Trigger:** When refactoring would break a live production path, build a SIBLING module with distinct naming + cross-reference comment + folded-in deferred-convergence ticket. Don't refactor live code. Empirical anchor: KAN-797a message-shaper.ts (Brain-driven, multi-channel, Sonnet, anti-repetition) coexists with legacy message-composer.ts (action.decided-driven, email-only, Haiku, RAG). Distinct names (shapeMessage / ShapedMessage vs composeMessage / ComposedMessage) avoid namespace collision. Convergence deferred to Phase 5+ cleanup.

**Empirical anchor:** KAN-797a pre-flight (2026-05-03) discovered `packages/api/src/services/message-composer.ts` already exists at 403 LoC with live production caller (`apps/api/src/subscribers/action-decided-push.ts:31`). The discovery surfaced a pattern collision: spec wanted to export `composeMessage` + `ComposedMessage`, both already exported from message-composer.ts. Three architectural paths surfaced (replace wholesale / sit alongside / refactor + extract); chose **Path B — sit alongside with distinct names**. Result: `shapeMessage(prisma, dealId, options)` returns `ShapedMessage`. Zero collisions. Live production send path untouched. Convergence deferred to Phase 5+ via no separate ticket (the question is "when does Brain replace the action.decided event flow" — that decision lives in the architectural roadmap, not as a follow-up ticket).

---

## The pattern

When a new module conflicts with an existing module's exports + the existing module is in live production use:

1. **Don't refactor wholesale.** The cost of breaking the live path (production incident, multi-day rollback, lost trust) far exceeds the cost of namespace fragmentation.
2. **Don't refactor + extract.** Shared-helper extraction creates a thin shim with two divergent wrappers — same complexity, less clarity. The extracted helper has to satisfy both calling conventions, which usually means it satisfies neither cleanly.
3. **Build sibling.** Distinct file name, distinct function name, distinct type name. Zero namespace collision means zero import-graph friction.
4. **Document the relationship.** Top-of-file cross-reference comment in the new module pointing at the legacy module. Future readers see the relationship without spelunking.
5. **Defer convergence.** File no follow-up ticket if convergence is genuinely "decision lives elsewhere" (e.g., depends on retiring the consumer of the legacy module). Or file as a Phase 5+ cleanup if there's a target retirement date.

---

## Why empirically

**Convergence is a future architectural decision, not a present refactor.** The legacy `message-composer.ts` serves the OLD action.decided event flow. The NEW `message-shaper.ts` serves the Brain-driven flow. Convergence depends on:

- Does Brain replace Decision rows as the canonical decision source? (Open question — depends on Phase 5+ KAN-810+ work)
- Does the Resend connector contract change? (Possible — KAN-803 generic webhook may unify connector layer)
- Do tenants need both flows simultaneously during a transition? (Likely — gradual rollout)

These questions don't have answers today. Filing a "converge KAN-797a and KAN-660" ticket today would be premature — there's no architectural decision to make yet, just a recognition that someday these may merge.

**Distinct naming is the load-bearing insight.** The risk of message-composer existing wasn't behavior overlap (both compose messages — fine, multiple modules can do similar things). It was namespace overlap (both export `composeMessage` and `ComposedMessage`). Path B's distinct names (`shapeMessage` / `ShapedMessage`) eliminates the entire collision class. Imports work everywhere without aliasing. Cross-module references are unambiguous.

**Counterfactual — Path A (replace wholesale):**

- Delete message-composer.ts → break action-decided-push.ts caller
- Re-implement KAN-660 send path with new module → re-implement KAN-661 Resend integration + KAN-698 RAG knowledge injection + KAN-703 pipeline-aware context
- Estimated 5-10 days of work + production incident risk
- Zero added value today (current production path works fine)

**Counterfactual — Path C (refactor + extract):**

- Pull LLM-call-and-parse core into shared helper
- message-composer wraps it for action.decided + email + Haiku + RAG
- message-shaper wraps it for Brain + multi-channel + Sonnet + anti-repetition
- Two wrappers with different option shapes, different defaults, different error handling
- Shared helper becomes a thin pass-through; the two wrappers contain all the actual logic
- Same complexity as Path B but with cross-module coupling

**Path B chosen because:** it's the lowest-disruption, most-honest architectural choice. The two modules are different concerns; calling them by the same name was the original mistake.

---

## Top-of-file cross-reference template

```ts
/**
 * KAN-XXX — [new module name].
 *
 * [new module]: composes outbound messages for the NEW Brain-driven action flow.
 * Multi-channel, Sonnet-tier, anti-repetition, pure-return.
 *
 * SIBLING but DISTINCT from [legacy module name] ([legacy path]), which serves
 * the LEGACY [legacy event flow]: [legacy characteristics]. [legacy module] is
 * the canonical live send path today; [new module] is forward-investment for
 * [new architecture epic].
 *
 * Convergence question (extend [legacy] with [new feature] OR retire [legacy]
 * in favor of [new]) is deferred — [Phase X+ cleanup] decision pending.
 */
```

This template ensures future readers understand:
- The two modules serve different flows
- The legacy module is the live path (don't accidentally retire it)
- Convergence is a known future question, not an oversight

---

## When to apply

- Any new module whose exports would collide with an existing module's exports
- Any new feature that would otherwise require modifying live production code paths
- Any architectural transition where both old and new flows need to coexist during a gradual rollout

**When NOT to apply:**

- True replacement scenarios where the old module is dead code (then delete it cleanly per `feedback_kan_791_dropped_model_residual_references` — cast-loose cleanup checklist)
- Cases where namespace fragmentation would actively confuse readers (rare — distinct names usually clarify, not confuse)
- Cases where the new module truly subsumes the old module's responsibilities AND the old module has no live callers (then refactor)

---

## Sibling pattern application

This is the third application of pre-flight existing-code discovery in Phase 2 (after KAN-795 aiAssignmentFallback, KAN-796a threshold-gate orthogonality). The pattern of "PRD framing collapses architectural distinctions; pre-flight verification recovers precision" (per `feedback_kan_796_threshold_gate_orthogonality_clarification`) applies here too.

KAN-797a's particular variant: even when the relationship IS subsumes/replaces (not orthogonal like threshold-gate), the answer can still be "build sibling, don't refactor live code."

---

## Cross-references

- KAN-797a (origin — message-shaper Path B coexistence with message-composer)
- KAN-795 — sibling pattern (aiAssignmentFallback discovery, but Option C refactor was right there)
- KAN-796a — sibling pattern (threshold-gate orthogonality, no refactor needed)
- KAN-660/661/698/703 (legacy message-composer ecosystem)
- [`feedback_kan_796_threshold_gate_orthogonality_clarification.md`](./feedback_kan_796_threshold_gate_orthogonality_clarification.md) — companion pre-flight discipline
- [`feedback_message_shaper_anti_repetition_engagement_history_pattern.md`](./feedback_message_shaper_anti_repetition_engagement_history_pattern.md) — companion (KAN-797a-specific producer-consumer contract)

---

## Status

**Active.** Pattern applies whenever a new module's exports collide with an existing module's exports OR when refactoring live code carries production-incident risk. Phase 5+ may revisit message-composer / message-shaper convergence.
