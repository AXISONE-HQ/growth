# feedback_message_shaper_anti_repetition_engagement_history_pattern

**Trigger:** Anti-repetition for AI-composed messages reads recent outbound Engagement history (channel-scoped, K-most-recent), passes summaries to LLM as "DON'T repeat" context. Producer-consumer contract: producer (KAN-815 wiring) MUST write outbound Engagement metadata.{subject, body/bodyPreview} consistently for consumer (KAN-797a buildShapePrompt) to read. Empirical anchor: KAN-797a buildShapePrompt + 5-engagement default limit + parametrized recentOutboundLimit.

**Empirical anchor:** KAN-797a (PR #99, merged a5c4f6d) message-shaper buildShapePrompt loads `prisma.deal.findUnique({ include: { engagements: { where: { OR: [{ engagementType: { startsWith: 'email_send' } }, ...] }, orderBy: { occurredAt: 'desc' }, take: recentOutboundLimit } } })` and renders subjects + body previews into the prompt's "## Recent outbound to avoid repeating" block. Test #14 verifies all 3 outbound subjects appear in prompt context. Pre-flight surfaced the producer-consumer contract drift risk: when KAN-815 wiring writes outbound Engagements post-dispatch, those metadata fields MUST land with consistent shape (`metadata.subject` for email, `metadata.bodyPreview` or `metadata.body` for body).

---

## The pattern

For AI-composed message generation in a system with persistent engagement history:

```ts
// CONSUMER (message generator):
const recentOutbound = await prisma.engagement.findMany({
  where: {
    contactId,  // or dealId
    engagementType: { startsWith: `${channel}_send` }, // per-channel separation
  },
  orderBy: { occurredAt: 'desc' },
  take: recentOutboundLimit, // default 5
});

const antiRepetitionBlock = recentOutbound
  .map((e, i) => {
    const meta = (e.metadata ?? {}) as Record<string, unknown>;
    const subject = typeof meta.subject === 'string' ? meta.subject : '(no subject)';
    const bodyPreview = typeof meta.bodyPreview === 'string'
      ? meta.bodyPreview.slice(0, 120)
      : typeof meta.body === 'string'
        ? (meta.body as string).slice(0, 120)
        : '(no body preview)';
    return `${i + 1}. ${e.occurredAt.toISOString()} ${e.engagementType}\n   subject: ${subject}\n   body: ${bodyPreview}`;
  })
  .join('\n');

// Pass to LLM with "DON'T repeat themes/openings/closings used in this list"
```

```ts
// PRODUCER (post-dispatch Engagement write — KAN-815 wiring):
await prisma.engagement.create({
  data: {
    tenantId,
    dealId,
    contactId,
    engagementType: `${channel}_send`,  // canonical: email_send / sms_send / meta_messenger_send
    channel,
    signalClass: 'neutral',  // outbound != positive (per engagement-service classifySignal)
    occurredAt: new Date(),
    metadata: {
      subject: shapedMessage.subject,  // REQUIRED for email, omitted for sms/meta_messenger
      bodyPreview: shapedMessage.body.slice(0, 256),  // OR `body: ...` — consumer reads either
      tone: shapedMessage.tone,
      rationale: shapedMessage.rationale,  // why was this message chosen?
      brainConfidence: shapedMessage.brainDecision?.confidence,  // forensic trail
    },
  },
});
```

The contract:
- `engagementType` follows `<channel>_send` convention (lets consumer's `startsWith` filter work)
- `channel` field set to the same value (lets `where.channel` filter work)
- `metadata.subject` populated for email, omitted for sms/meta_messenger
- `metadata.bodyPreview` (preferred, capped) OR `metadata.body` (full) — consumer reads either

---

## Why empirically

**Consumer-producer drift is the highest-risk failure mode.** If KAN-815 producer writes `metadata.text` instead of `metadata.body`, consumer reads "(no body preview)" and LLM gets no anti-repetition signal — silently degrades to "every message looks like the first message." Test coverage at the consumer layer can't catch this because the producer doesn't exist yet.

The producer-consumer contract documented in `message-shaper.ts` source comments + this memory entry is the persistence anchor that survives until KAN-815 ships.

**Defensive consumer reads (sibling discipline to KAN-794 VALID_ACTION_TYPES allowlist):** The consumer's `typeof meta.subject === 'string' ? ... : '(no subject)'` pattern means producer drift produces visible-in-LLM-prompt fallbacks instead of crashes. Operator can spot "(no subject)" in prompt traces and trace back to producer drift.

---

## Per-channel separation

Recent outbound is queried per-channel (not "any outbound"):

```ts
where: {
  OR: [
    { engagementType: { startsWith: 'email_send' } },
    { engagementType: { startsWith: 'sms_send' } },
    { engagementType: { startsWith: 'meta_messenger_send' } },
  ],
}
```

Wait — KAN-797a actually loads ALL channels, not just the target channel. This is intentional: a contact's recent SMS may inform email composition (don't repeat themes across channels). KAN-805 channel-preference learning may refine this later (e.g., "if contact prefers SMS, weight SMS history higher when composing email").

---

## When to apply

- Any AI-composed outbound message generator in a system with persistent engagement history
- Any system where "stop repeating yourself" is a quality bar for LLM output
- Any design where the LLM has no other source of "what have I sent before" memory

**When NOT to apply:**

- One-shot transactional sends (anti-repetition not relevant)
- Systems where engagement history isn't persisted (then the LLM has no signal regardless)
- Systems with embeddings-based similarity (Phase 4+ KAN-805 may replace this heuristic)

---

## Composability with other Phase 2 patterns

- **Pure-module pattern**: KAN-797a is sub-cohort (a) — anti-repetition logic lives in the pure module; producer side lives in KAN-815 wiring
- **Strict-reject parser**: anti-repetition prompt input + LLM JSON output discipline are independent concerns; both ship in the same module
- **Channel-preference learning** (folded into KAN-805): future enhancement may bias what "recent outbound" the consumer considers based on per-contact channel preference patterns

---

## Cross-references

- KAN-797a (origin — message-shaper anti-repetition + pre-flight catch on metadata shape)
- KAN-815 (sub-cohort b — producer-side wiring; this memory entry is the contract anchor)
- KAN-805 (Shared Learning Layer — future enhancement layer)
- KAN-660/661/698/703 (legacy message-composer.ts — sibling generator with different anti-repetition strategy: KAN-698 RAG injection)
- [`feedback_legacy_message_composer_vs_brain_driven_shaper_coexistence.md`](./feedback_legacy_message_composer_vs_brain_driven_shaper_coexistence.md) — companion (legacy vs new generator coexistence)

---

## Status

**Active.** Producer-consumer contract is load-bearing for KAN-815 wiring. Drift risk highest until KAN-815 ships.
