# feedback_reply_to_universal_at_publish_helper

**Trigger:** When a header / metadata field needs to be set on every outbound message regardless of which upstream module generated it (legacy + Phase 2 + future Phase 3), wire it into the *publish helper* (the chokepoint just before the connector receives the message), not into each upstream module. One wiring covers all current + future callers.

**Empirical anchor (KAN-816 PR #102):** Per-tenant Reply-To routing (`<inboxSlug>@leads.<LEAD_INBOX_DOMAIN>`) is required for ALL outbound email regardless of source module — legacy `message-composer.ts` (KAN-660 path), Phase 2 `message-shaper.ts` (KAN-797a Brain-driven path), future Phase 3 escalation-response paths, etc. Two design choices considered:

- **Option A (rejected):** wire `replyTo` resolution into each upstream module's compose function. Legacy `composeMessage()` resolves Reply-To, Phase 2 `shapeMessage()` resolves Reply-To, every future module duplicates the resolution.
- **Option B (chosen):** add `replyTo?: string` to `OutboundMessageSchema` (passes through publish helper unchanged), and have `publishActionSend(client, { ..., replyTo? })` set the header at the chokepoint. ONE resolution call site.

Plus the helper itself can fall back to `ChannelConnection.metadata.replyTo` when the message-level field is absent — so legacy callers who never opt into per-message Reply-To still get the connection-level default.

---

## The pattern

When designing per-message metadata that *every* outbound caller needs:

1. **Identify the chokepoint** — usually the publish helper or the adapter's `send()` call (whichever has zero call sites that bypass it)
2. **Add the field as optional on the contract type** (`OutboundMessageSchema.replyTo: z.string().email().optional()`) — additive, no breaking change for existing callers
3. **Resolve at the chokepoint OR pass through if pre-resolved** — accept either pattern; resolve only if the caller didn't supply
4. **Provide a connection-level fallback** for callers that don't opt in — preserves legacy behavior, lets new callers override per-message

```ts
// Contract (packages/connector-contracts/src/types.ts)
export const OutboundMessageSchema = z.object({
  // ... existing fields
  replyTo: z.string().email().optional(),
});

// Adapter (apps/connectors/src/adapters/resend/index.ts)
const messageReplyTo = (msg as { replyTo?: string }).replyTo;
const replyTo = messageReplyTo ?? (metadata.replyTo as string | undefined);
// ... if (replyTo) include in Resend send payload
```

---

## Why empirically

**Three forces drove the choice:**

1. **One wiring covers all current + future callers.** Sprint 9 has 2 upstream modules (legacy + Phase 2); Sprint 10+ adds escalation-response paths, opt-out flows, broadcast follow-ups. Each new module would have re-implemented Reply-To resolution under Option A. Under Option B, ANY future module that builds an `OutboundMessage` and calls `publishActionSend` automatically gets Reply-To routing — zero per-module work.

2. **Per-message override > per-connection override** for multi-tenant scenarios. The connection-level `metadata.replyTo` was introduced for a single-tenant simple-mode pattern (one Resend account, one domain). Per-tenant inbox slugs require per-message resolution because the resolution depends on `tenant.inboxSlug` which varies per-message-target. Adding it at the message level (with connection fallback) handles both cases.

3. **Adapter doesn't need to know about tenant lookups.** The adapter's `send()` shouldn't query `prisma.tenant.findUnique` to resolve a Reply-To address — that couples the adapter to the API service's data model. Pre-resolving at the publish helper (where the prisma client is already in scope) keeps the adapter pure.

---

## When to apply

- Any per-message metadata that EVERY outbound caller will need (compliance headers, tracking pixels, per-tenant routing rules)
- Headers/fields that the *adapter* should pass through but not RESOLVE (resolution requires data the adapter doesn't have)
- Behavior that needs to stay consistent across legacy + new code paths during a multi-quarter migration

**When NOT to apply:**

- Per-message metadata only one caller needs (don't pollute the shared contract for one consumer)
- Resolution that genuinely belongs to the upstream module (e.g. message body content — that's the upstream module's job)
- Adapter-specific headers that one provider needs but others don't (those go in adapter-specific message extensions, not the universal contract)

---

## Cross-references

- KAN-816 PR #102 — origin
- `packages/connector-contracts/src/types.ts:72` — `OutboundMessageSchema.replyTo` field
- `apps/connectors/src/adapters/resend/index.ts:154` — adapter falls through message-level → connection-level
- `packages/api/src/services/message-composer.ts:227` — `resolveReplyToForTenant()` helper called by publish helper
- KAN-741 — per-tenant inbox slug system that Reply-To routes to
- KAN-818 — sibling structural fix (LEAD_INBOX_DOMAIN no-default, fail-loud at boot)

---

## Status

**Active.** Future per-message metadata fields should follow this pattern unless a clear reason to localize.
