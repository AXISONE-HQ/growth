---
name: KAN-839 close — conversation content visibility
description: Producer-consumer contract gap caught at pre-flight (second instance after KAN-817). Shaper now sees customer's verbatim words via new `## Recent inbound from contact` section. Generalizable pattern for future Shaper-context features.
type: feedback
---

# KAN-839 close — conversation content visibility (Sprint 11-pre EXT-2)

**Shipped 2026-05-05 evening.** PR #111, commit `959eaab`, revision `growth-api-00167-xnn`.

## Empirical anchor

Pre-KAN-839, AI outbound subjects templated against Brain's strategic intent regardless of the customer's specific question. Today's smokes produced "Next Step: Let's Schedule Some Time Together" and "Your Quote Is Ready — Let's Walk Through It Together" REGARDLESS of whether the inbound asked about pricing, scheduling, or anything specific. The Shaper saw Brain's interpretation ("contact engaged positively") but **never the literal text**. KAN-839 closes that visibility gap.

## Producer-consumer contract gap (caught at pre-flight — second instance)

**The ticket's premise was incorrect.** Pre-flight audit revealed: inbound `Engagement.metadata` was storing only `senderEmail` + `subject` — body text was never persisted. Same producer-consumer contract gap as KAN-817 caught for outbound metadata.

**This is a class, not an instance.** First time was KAN-817 (outbound — the Shaper's anti-repetition section needed `subject` + `bodyPreview` written by the producer; ticket assumed it was already there, audit showed it wasn't). KAN-839 hit the same shape on the inbound side.

**Why this is forward-monitoring valuable:** when a feature adds a downstream consumer of `Engagement.metadata` (the Shaper's prompt rendering is the canonical consumer; future tickets adding to Brain context or other prompt-touching layers will be similar), the producer-side write contract MUST be audited before declaring the spec complete.

**Generalizable pattern for the audit-first protocol:**

> Before implementing any change that ADDS a Shaper/Brain prompt-context section reading from Engagement.metadata, the pre-flight audit checklist MUST include:
> 1. Identify the producer (where `logEngagement` is called for the relevant engagement type)
> 2. Verify the field the consumer will read is actually written there (grep `metadata: {`)
> 3. If absent, scope the producer-side write into the same PR (avoid "split into KAN-839 + KAN-840" anti-pattern — consumer ships dead code if producer hasn't shipped first)

**Why:** producer-consumer split into two PRs creates an asymmetric window where one side is shipped but does nothing observable. KAN-839's pre-flight caught this and merged both sides atomically.

**How to apply:** when reviewing any PR that touches `buildShapePrompt` (or future `buildBrainPrompt` / `buildKnowledgePrompt`), grep for the new metadata field name across both Shaper code AND `lead-received-push.ts` / `action-executed-push.ts` write sites; if either side is missing, halt and audit.

## Architectural choices made

1. **DB-load in Shaper, not thread-through** (Option A in pre-flight). Universally works across initial inbound + KAN-825 chain + KAN-835 chain + KAN-814 cron re-dispatch because the Engagement row IS the source-of-truth. The in-memory `event` payload is not in scope for cron-deferred sends. Threading `event.subject` + `event.body` through wirePhase2Consumers + dispatchPhase2Send + ShapeMessageOptions would have been ~3 functions of plumbing AND incomplete (cron path needs DB load anyway).

2. **Section placement after Brain-suggested intent, before Channel + tone.** Customer voice + Brain analysis adjacent. Counter-argument considered (LLM primacy effects might favor placing inbound earlier); deferred to empirical measurement.

3. **Hardcoded 1-row inbound load.** No `recentInboundLimit` option. Internal-only change; inline mirror at `lead-received-push.ts:238-268` unaffected. Multi-inbound history can be a follow-up if long-thread visibility ever matters.

4. **Render cap matches DB cap.** 2000 chars on producer write, 2000 chars on consumer render. Single binding constraint; eliminates surprise where Shaper expects more content than DB has.

## Smoke result — structural pass + substantive partial-pass

**Inbound (Fred 2026-05-05 20:58:42 UTC):** subject `"Crm question"`, body **empty**, from `frederic.binette@hotmail.com`. Fresh Contact `96974a18-…`, fresh Deal `cmot425bc-…`.

**Engagement metadata DB audit (`cmot425ee0006109ofuvrb8gj`):**

```json
{
  "subject": "Crm question",
  "bodyPreview": null,
  "senderEmail": "frederic.binette@hotmail.com",
  "extractionConfidence": "medium"
}
```

`bodyPreview` field IS present (producer-side contract working). Value is `null` because Fred's actual inbound had no body content. The new Shaper section rendered the **subject-only fallback**: `(subject only — body empty)\nSubject: Crm question`.

**Brain reasoning verbatim (Decision `af69fa41-…`, action_type=send_follow_up, confidence 0.82):**

> *"A positive email was just received today, indicating strong engagement. The deal is brand new in the 'New' stage with the objective to book an appointment, so a timely follow-up to capitalize on this positive signal and move toward scheduling is the best next action."*

**Brain has zero reference to anything specific** because there was no body to reference. Reply went generic-schedule because (a) no Knowledge Layer to ground answers and (b) pipeline objective biases toward booking. **Both gaps are Sprint 11a's substrate.**

**Token bump confirms structural rendering:** `shaperInputTokens=503` vs typical ~460 baseline = +43 tokens consistent with the new section rendered into the prompt. Section IS being rendered; the body just happened to be empty.

## Pass / fail call + substantive prove pending

* **Structural pass:** producer-consumer contract symmetric, new section renders, dispatch path uniform across 4 entry points.
* **Substantive partial-pass:** the smoke didn't exercise the body-present render path because Fred's actual inbound had empty body. Non-empty-body render proven only via unit tests (sentinel-token pin).
* **Substantive prove pending:** next smoke with non-empty body, OR organic next inbound with body content, will produce body-rendered evidence.

## Section-order revisit + KAN-840 deferred

Counter-argument on section placement (LLM primacy effects might favor placing inbound BEFORE Brain intent) was discussed at greenlight. The smoke didn't discriminate (empty body left the render structurally identical to the pre-KAN-839 baseline modulo a placeholder block). The order question moves to empirical measurement on the first non-empty-body inbound after deploy, with **KAN-840 (orientation polish) filed but deferred per Fred's call** until Sprint 11a Knowledge Layer can ground replies. Sprint 11a is the substantive win; orientation polish is post-Knowledge-Layer once we can measure whether content-grounded replies still drift toward generic-schedule templates.

## Why this matters as Sprint 11a empirical anchor

The smoke surfaced two distinct gaps:

1. **Content visibility** — closed today by KAN-839. Customer's words now reach the Shaper.
2. **Content groundedness** — open. Even with the words visible, the AI deflected to "let's schedule" because it had nothing factual to ground a substantive reply on. Sprint 11a Knowledge Layer is the cure.

**Same AI-CRM question (or similar specific-question shape) will be the first Sprint 11a smoke target.** When KAN-826 → KAN-828 ship, an inbound asking a specific question should produce a reply that references actual company knowledge rather than booking-template language.

## Why: producer-side write was load-bearing for the consumer-side feature

Both the Shaper read and the bodyPreview write had to ship in the same PR. If the read had shipped first (without the write), production would have rendered `(subject only — body empty)` on every inbound forever — the consumer would have been wired to a producer that wasn't producing. KAN-840 split would have been the wrong call here; the audit-first protocol caught it pre-implementation.

## How to apply

* When extending `buildShapePrompt` (or future `buildBrainPrompt` / `buildKnowledgePrompt`) to read a new field from Engagement.metadata, audit the producer-side `logEngagement` call sites in the same pre-flight pass.
* If the field isn't being written, scope the producer-side write into the same PR. Do NOT file a separate ticket for the write side unless there's a strong reason (e.g., the write is a separable observability concern that doesn't gate the read).
* The PR's test plan must include a producer-side test pinning the field write, AND a consumer-side sentinel-token test pinning the read.
* Render cap and DB cap must match — single source of truth; no surprise truncation.

## Sentinel-token pattern (extension to KAN-817 Group 4)

KAN-839 added a sentinel-token pin for the inbound bodyPreview field (sibling to KAN-817's outbound subject + bodyPreview pins). Pattern is now load-bearing:

* `KAN-839-pin-subject-token-qrs456` — verbatim in subject
* `KAN-839-pin-body-token-tuv789` — verbatim in body

If anyone renames `bodyPreview` to `body_text` or `headline` on either producer or consumer, the test breaks loud. Same shape KAN-817 established for outbound, KAN-825 + KAN-835 for trigger contexts.

## Memory dependencies

* Sibling: `feedback_message_shaper_anti_repetition_engagement_history_pattern.md` (KAN-797a — established the producer-consumer contract for outbound)
* Sibling: `feedback_kan_815c_decision_row_shim.md` (Phase 2 wiring — established the Decision row write contract)
* Generalizes: pre-flight audit-first protocol for all future Shaper/Brain prompt-context extensions
