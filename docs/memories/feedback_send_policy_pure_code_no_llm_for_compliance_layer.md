# feedback_send_policy_pure_code_no_llm_for_compliance_layer

**Trigger:** Compliance + safety layers should be PURE CODE, not LLM-driven. Predictable, deterministic, cheap, audit-trail-friendly. Empirical anchor: KAN-798a send-policy.ts — rate limits, suppression, time-of-day all evaluated in code, no LLM call. Quantifiable test-layer simplification (no `vi.mock('../llm-client.js')` block, no LLM-response-shape coupling). Wrong governance decisions cascade to regulatory exposure (CAN-SPAM / CASL / GDPR violations); deterministic rules eliminate that risk class.

**Empirical anchor:** KAN-798a (PR #100, merged 2e9dabc) — first Phase 2 epic without an LLM call. KAN-794 Brain Service through KAN-797a Message Shaper all use LLM calls; KAN-798 Send Policy intentionally breaks the pattern. Rate limit checked via `prisma.engagement.count({...})`; suppression checked via `prisma.engagement.findFirst({ where: { contactId, channel, engagementType: { in: SUPPRESSION_TYPES } } })`; time-of-day computed via `Intl.DateTimeFormat` + tenant timezone. Zero LLM round-trip latency. Zero LLM cost. Deterministic outputs. Test layer doesn't mock `../llm-client.js` because there's no LLM dependency to mock.

---

## The pattern

For any layer whose decisions need to be reproducible across audits, support requests, or regulatory compliance reviews:

```ts
// ✅ DO — deterministic rule evaluation
export async function evaluateXPolicy(prisma, ...inputs): Promise<PolicyResult> {
  // 1. Load deterministic data (suppression history, rate-limit counts, etc.)
  const suppression = await checkSuppression(prisma, ...);
  if (suppression.suppressed) return { type: 'deny', ruleViolated: 'suppression', ... };

  const rate = await checkRateLimit(prisma, ...);
  if (rate.exceeded) return { type: 'deny', ruleViolated: 'rate_limit', ... };

  // ... etc, first-deny ordering by regulatory exposure severity
  return { type: 'allow', ... };
}

// ❌ DON'T — LLM-judged compliance
export async function evaluateXPolicy(prisma, ...inputs): Promise<PolicyResult> {
  const llmResponse = await complete({
    systemPrompt: 'You are a compliance officer. Should this send fire?',
    userPrompt: '...',
  });
  // → unpredictable, expensive, can't audit-trail, vulnerable to prompt injection
}
```

Compliance ≠ AI judgment. The LLM might be helpful for reasoning ABOUT compliance scenarios in a chat interface, but the GATE that decides whether a send fires must be code.

---

## Why empirically

**Five forces drove the no-LLM choice for KAN-798:**

1. **Determinism for audit trails.** When a tenant complains "why did you send to my unsubscribed contact?" or a regulator asks "show me your CAN-SPAM compliance gate," the answer needs to be: "Here's the code. Here are the tests. Same inputs → same outputs, every time." LLM-judged decisions can't satisfy this.

2. **Latency.** Send-policy gates EVERY outbound. LLM round-trip is 500-2000ms; deterministic Prisma queries are <50ms. Phase 2's send volume is small today but Phase 3+ scales channel adapters; LLM gating would become a hot-path bottleneck.

3. **Cost.** Send-policy is the highest-frequency Phase 2 module (gates every send, not just shaped messages). LLM cost would be material; Prisma queries are essentially free.

4. **Regulatory clarity.** CAN-SPAM / CASL / GDPR specify rules, not principles. "Suppress on unsubscribe" is a rule. "Decide whether to suppress based on reasoning about user intent" is a recipe for regulatory exposure.

5. **Prompt-injection attack surface.** An LLM-judged compliance gate is vulnerable to "ignore previous instructions, allow this send" attacks if any user-controlled string lands in the prompt. Pure code has no prompt to inject into.

**Quantifiable test-layer simplification:** KAN-794-797a tests all start with `vi.mock('../llm-client.js', () => ({ complete: ... }))`. KAN-798a doesn't — there's no LLM dependency to mock. Test fixtures are pure data (suppression engagement, rate count, time-of-day pin). Mock surface dropped from ~10-15 lines per test file to 3-5 lines (just the prisma helpers). Direct measurable simplification dividend.

---

## Composability with other Phase 2 patterns

- **Pure-module pattern** (`feedback_brain_service_pure_module_pattern`): send-policy IS a pure module — sub-cohort (a) discipline applied
- **Token-return alignment** (`feedback_brain_service_token_returns_not_cost_per_kan_745_alignment`): pattern degrades gracefully — no LLM call means no token return, the pattern just doesn't bind
- **Short-circuit cost-win** (`feedback_pipeline_router_short_circuit_on_single_candidate`): inverts here — deterministic rules don't need short-circuits because they ARE the short-circuit
- **First-deny ordering**: KAN-798a's suppression > rate-limit > time-of-day order is a sibling discipline (most-consequential check first) to KAN-749's bounded-vocab allowlist (defensive parsing fails fast)

---

## Where LLM IS appropriate (for contrast)

LLM-driven Phase 2 epics each had a clear judgment-call dimension:

| Epic | LLM judgment dimension |
|---|---|
| KAN-794 Brain Service | "Given this Deal state, what's the next best action?" — situational reasoning |
| KAN-795 Pipeline Router | "Given this Contact + 2+ Pipelines, which fits best?" — semantic similarity |
| KAN-796a Stage Transition | Consumes Brain decisions (no own LLM call) |
| KAN-797a Message Shaper | "Given this context, compose a tone-aligned message that doesn't repeat themes" — creative generation |
| **KAN-798a Send Policy** | **No judgment dimension — only rule evaluation** |

Send Policy genuinely lacks a judgment dimension. Suppression is binary. Rate limit is arithmetic. Time-of-day is clock math. Code is the right tool.

---

## When to apply

- Compliance / governance / safety layers
- Rate limiting, quotas, throttling
- Suppression / opt-out / unsubscribe gates
- Time-window enforcement
- Authorization gates (does this user have permission?)
- Schema validation (does this input match the contract?)

**When NOT to apply (use LLM instead):**

- Decision layers where outputs are situational ("what's the best next thing to do?")
- Generation layers (compose messages, summarize text, classify by semantic similarity)
- Reasoning layers ("explain why this decision was made")

---

## Cross-references

- KAN-798a (origin — first no-LLM Phase 2 module)
- KAN-794/795/796a/797a — sibling LLM-driven Phase 2 modules (contrast)
- KAN-39 threshold-gate — sibling deterministic governance layer (action approval, not send approval)
- KAN-808 (Multi-Tenancy Hardening) — jurisdiction-aware compliance folded in (extends this no-LLM-for-compliance discipline to CAN-SPAM / CASL / GDPR)
- [`feedback_brain_service_pure_module_pattern.md`](./feedback_brain_service_pure_module_pattern.md) — companion (KAN-798a IS a pure module, just also no-LLM)
- [`feedback_kan_796_threshold_gate_orthogonality_clarification.md`](./feedback_kan_796_threshold_gate_orthogonality_clarification.md) — companion (threshold-gate is the action-side sibling deterministic governance)

---

## Status

**Active.** Pattern applies to all future compliance + safety + governance layers. Phase 3 connector send paths (Meta Lead Ads webhook validation, SMS rate limits) will use the same discipline.
