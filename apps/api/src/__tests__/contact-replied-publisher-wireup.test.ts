/**
 * KAN-1037-PR3 — Publisher wire-up structural invariant.
 *
 * The publisher side of the `contact.replied` event lives in
 * `apps/api/src/subscribers/lead-received-push.ts`. Per M3-2.5c Phase 1
 * Finding #1, the publish MUST fire from BOTH call sites where
 * `writeSidecarAndCorrelate` returns an outcome:
 *
 *   - `writeInboundEngagementForExistingDeal` (multi-turn path; reply on
 *     existing open Deal — the primary trigger surface)
 *   - `writePhase1Deal` (first-turn path; new contact replies to a
 *     discovery outbound on a different deal lineage — rare but valid;
 *     B-override rescues correctly per M3-2.5b)
 *
 * The helper `emitContactRepliedIfCorrelated` is invoked from both sites
 * AFTER `emitCorrelationAudit`. Grep-pin this so a future refactor that
 * removes one of the two call sites — or moves the publish ahead of the
 * `$transaction` commit — fails CI loudly.
 *
 * Same structural-pin pattern as `m3-2-5b-doctrine-pins.test.ts` and
 * `escalation-decision-invariant.test.ts`. Cheap, narrow, and prevents
 * a load-bearing wire-up from rotting.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { buildContactRepliedEvent } from "@growth/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBSCRIBER_PATH = resolve(
  __dirname,
  "../subscribers/lead-received-push.ts",
);

function loadSrc(): string {
  return readFileSync(SUBSCRIBER_PATH, "utf8");
}

describe("KAN-1037-PR3 — contact.replied publisher wire-up", () => {
  it("imports CONTACT_REPLIED_TOPIC + buildContactRepliedEvent + ContactRepliedEvent type from @growth/shared", () => {
    const src = loadSrc();
    expect(src).toContain("CONTACT_REPLIED_TOPIC");
    expect(src).toContain("buildContactRepliedEvent");
    expect(src).toContain("ContactRepliedEvent");
    // Single source of truth — pulled from packages/shared, not redeclared.
    expect(src).toMatch(/from\s+['"]@growth\/shared['"]/);
  });

  it("declares emitContactRepliedIfCorrelated helper function", () => {
    const src = loadSrc();
    // Function declaration check — catches accidental rename or removal.
    expect(src).toMatch(/function\s+emitContactRepliedIfCorrelated\s*\(/);
  });

  it("guards the publish on outcome.reason === 'inbound_correlated' (B-override target gate)", () => {
    const src = loadSrc();
    // The publish must NOT fire on no_reply_token / unmatched_reply_token —
    // those branches lack matched.engagement.decisionId, so a published
    // event would carry an invalid decisionId. Per writeSidecarAndCorrelate
    // at L745-789, only 'inbound_correlated' branch has rescued IDs.
    expect(src).toMatch(/outcome\.reason\s*!==\s*['"]inbound_correlated['"]/);
  });

  it("invokes emitContactRepliedIfCorrelated at BOTH call sites (multi-turn + first-turn)", () => {
    const src = loadSrc();
    // Count occurrences — should be exactly 2 invocations (one per path)
    // plus the function declaration itself + any comment refs. The
    // declaration uses `function emitContactRepliedIfCorrelated(`; calls
    // use `emitContactRepliedIfCorrelated({`. Counting the call form
    // isolates wire-up sites from declaration/imports/comments.
    const callMatches = src.match(/emitContactRepliedIfCorrelated\(\{/g) ?? [];
    expect(
      callMatches.length,
      "emitContactRepliedIfCorrelated must be invoked from BOTH " +
        "writeInboundEngagementForExistingDeal (multi-turn path) AND " +
        "writePhase1Deal (first-turn path). Each path needs an independent " +
        "call site so a contact replying on either lineage triggers engine " +
        "re-evaluation per M3-2.5c Phase 1 Finding #1.",
    ).toBe(2);
  });

  it("PR3 publisher contract: buildContactRepliedEvent accepts outboundEngagementId: null (KAN-1044 honest-nullable shape)", () => {
    // PR3 production path: the publisher in lead-received-push.ts passes
    // `outboundEngagementId: null` until KAN-1044 extends CorrelationOutcome
    // to carry the matched outbound's Engagement id cleanly. This test pins
    // the contract surface end-to-end:
    //   - Schema (z.string().uuid().nullable()) accepts null without
    //     throwing on .parse(...) inside buildContactRepliedEvent
    //   - Builder preserves the null value verbatim — no accidental
    //     defaulting back to a placeholder
    //   - The resulting payload that downstream consumers will see has
    //     outboundEngagementId === null, NOT undefined and NOT inboundEng
    //
    // If a future change accidentally defaults this to inboundEngagementId
    // (the placeholder shape the user caught + rejected pre-merge), this
    // assertion fails loudly. Post-KAN-1044, when the publisher starts
    // passing a real UUID, this test can be updated to also exercise the
    // populated path.
    const payload = buildContactRepliedEvent({
      tenantId: "11111111-1111-1111-1111-111111111111",
      contactId: "22222222-2222-2222-2222-222222222222",
      dealId: "33333333-3333-3333-3333-333333333333",
      decisionId: "cl_decision_pr3_null_check",
      inboundEngagementId: "44444444-4444-4444-4444-444444444444",
      outboundEngagementId: null,
      replyText: "Sounds good — Thursday works.",
      replyReceivedAt: "2026-05-31T12:00:00.000Z",
      metadata: {
        senderEmail: "alice@customer.example",
        subjectLine: "Re: Quick question",
        threadDepth: 1,
      },
    });
    expect(payload.outboundEngagementId).toBeNull();
    // Belt-and-suspenders: the inbound id MUST NOT have leaked into the
    // outbound field (the rejected placeholder shape).
    expect(payload.outboundEngagementId).not.toBe(payload.inboundEngagementId);
    // Schema literals still correct post-builder.
    expect(payload.eventType).toBe("contact.replied");
    expect(payload.version).toBe("1.0");
  });

  it("invokes the helper AFTER emitCorrelationAudit (sequencing — audit chain before publish)", () => {
    const src = loadSrc();
    // The publish is fire-and-forget BUT depends on the inbound Engagement
    // row being durable. emitCorrelationAudit fires after the tx commits;
    // emitContactRepliedIfCorrelated must come after it (same post-commit
    // boundary) so the consumer can safely re-query the Engagement row.
    //
    // Both helpers take args.outcome — find each invocation, then assert
    // the publish call site index is strictly greater than the matching
    // audit call site index.
    const auditCallRegex = /emitCorrelationAudit\(\{/g;
    const publishCallRegex = /emitContactRepliedIfCorrelated\(\{/g;
    const auditIndices: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = auditCallRegex.exec(src)) !== null) auditIndices.push(m.index);
    const publishIndices: number[] = [];
    while ((m = publishCallRegex.exec(src)) !== null) publishIndices.push(m.index);
    expect(auditIndices.length).toBe(2);
    expect(publishIndices.length).toBe(2);
    // Each publish index must be strictly greater than the corresponding
    // audit index (they share the same enclosing function scope).
    for (let i = 0; i < 2; i++) {
      expect(
        publishIndices[i],
        `Call site #${i + 1}: emitContactRepliedIfCorrelated must fire AFTER ` +
          `emitCorrelationAudit (both are post-commit best-effort emits; ` +
          `swapping the order would let downstream consumers query for an ` +
          `Engagement row that hasn't been audit-logged yet).`,
      ).toBeGreaterThan(auditIndices[i]);
    }
  });
});

/**
 * KAN-1056 — Phase B PR I structural pins for threadDepth derivation.
 *
 * PR3 shipped `threadDepth: 1` as a hardcode in emitContactRepliedIfCorrelated
 * (lead-received-push.ts:1089 pre-PR I). Phase B's engine prompt rendering
 * needs the true value to drive the depth-keyed sub-section gating + the
 * brain-service.ts:962 ternary. PR I replaces the hardcode with a live
 * `prisma.engagement.count` of prior `email_send` engagements on the matched
 * Deal, falling back to `1` when matchedDealId is null (correlation succeeded
 * by reply_token so ≥1 prior outbound exists).
 *
 * These are SOURCE-shape structural pins (same readFileSync pattern as the
 * existing wire-up block above) — the publisher IIFE isn't directly callable
 * without a major refactor to extract emitContactRepliedIfCorrelated, so we
 * pin the load-bearing query shape against source.
 */
describe("KAN-1056 — threadDepth derivation publisher pins", () => {
  it("emitContactRepliedIfCorrelated calls prisma.engagement.count for threadDepth derivation", () => {
    const src = loadSrc();
    // The publisher must perform a live count against engagements. A revert
    // to the PR3 hardcode (or any future refactor that drops the count)
    // fails this pin loudly.
    expect(
      src,
      "emitContactRepliedIfCorrelated must call prisma.engagement.count to " +
        "derive threadDepth — see KAN-1056 + Phase B Phase 1 trace Q1+Q2.",
    ).toMatch(/prisma\.engagement\.count\(\s*\{/);
  });

  it("count query filters on engagementType: 'email_send' (matches outbound write at action-executed-push.ts)", () => {
    const src = loadSrc();
    // Outbound engagements get engagementType derived from channel:
    // `${event.channel.toLowerCase()}_send`. Email outbounds → 'email_send'.
    // The count must filter on this literal so it doesn't double-count
    // the just-written 'email_received' inbound row.
    expect(src).toMatch(/engagementType:\s*['"]email_send['"]/);
  });

  it("count query uses temporal cutoff occurredAt: { lt: ... event.receivedAt ... } (Q2 lock)", () => {
    const src = loadSrc();
    // Q2 lock: defensive against concurrent send races (engine fires +
    // dispatches an outbound while a contact's reply is in flight). The
    // cutoff anchors at event.receivedAt — already in scope at L1083.
    expect(src).toMatch(/occurredAt:\s*\{\s*lt:[\s\S]{0,80}event\.receivedAt/);
  });

  it("publisher derives threadDepth conditionally on matchedDealId (Q1 null-fallback lock)", () => {
    const src = loadSrc();
    // Q1 lock: matchedDealId is nullable per writeSidecarAndCorrelate
    // L791-796. When null, threadDepth falls back to 1 (correlation
    // succeeded by reply_token → ≥1 prior outbound exists). The pin
    // looks for the ternary shape `args.outcome.matchedDealId ?` before
    // the await prisma.engagement.count call inside the IIFE.
    expect(
      src,
      "Publisher must conditionally derive threadDepth from matchedDealId " +
        "with a fallback to 1 when null — Q1 Phase B Phase 1 trace lock.",
    ).toMatch(
      /args\.outcome\.matchedDealId\s*\?[\s\S]{0,400}prisma\.engagement\.count/,
    );
  });

  it("publisher no longer hardcodes threadDepth: 1 (the PR3-era pre-PR-I shape is gone)", () => {
    const src = loadSrc();
    // Regression sentinel. The literal `threadDepth: 1,` only appears in
    // the file as a comment if at all — never as an object property value
    // on the metadata literal passed to buildContactRepliedEvent. A revert
    // to the hardcode would re-introduce the assignment shape.
    //
    // We narrow to "inside the buildContactRepliedEvent metadata block"
    // by looking for the literal in the same line shape as the pre-PR I
    // hardcode would emit: `\n          threadDepth: 1,` (12-space indent
    // matching the IIFE's metadata literal at L1086-1090 pre-PR I).
    expect(src).not.toMatch(/\n {10}threadDepth:\s*1,/);
  });

  it("threadDepth lives on the metadata literal as a bare property (shorthand binding to derived value)", () => {
    const src = loadSrc();
    // Post-PR-I shape: the metadata block reads `threadDepth,` (shorthand
    // binding to the const declared above the buildContactRepliedEvent
    // call). Pin this so a future refactor that re-introduces an inline
    // expression or hardcode fails the test.
    expect(src).toMatch(/\n {10}threadDepth,/);
  });
});
