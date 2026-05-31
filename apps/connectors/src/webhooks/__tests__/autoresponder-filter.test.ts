/**
 * KAN-1037-PR2 — `detectAutoresponder` unit suite.
 *
 * Pure-function coverage: each signal class (RFC 3834 headers, MS-XAUTORESPONSE
 * variants, sender local-part denylist, EN/FR subject patterns, EN/FR body
 * patterns) gets a positive test + the canonical false-negative-tolerance
 * passthrough test for genuine replies.
 *
 * Header-key assumption: input map is lowercased at the source
 * (apps/connectors/src/adapters/resend/inbound-fetch.ts:86-90). Tests use
 * lowercase keys to match the actual fetched shape.
 */
import { describe, it, expect } from "vitest";
import { detectAutoresponder } from "../autoresponder-filter.js";

function input(
  overrides: Partial<Parameters<typeof detectAutoresponder>[0]> = {},
): Parameters<typeof detectAutoresponder>[0] {
  return {
    headers: {},
    fromAddress: "alice@customer-co.com",
    subject: "Re: Quick question about your inquiry",
    bodyText: "Sounds good, let's set up a call this week. Thanks!",
    ...overrides,
  };
}

describe("KAN-1037-PR2 — detectAutoresponder", () => {
  // ── Header signals (highest confidence) ───────────────────────────

  it("filters Auto-Submitted: auto-replied (RFC 3834 §5)", () => {
    const result = detectAutoresponder(input({ headers: { "auto-submitted": "auto-replied" } }));
    expect(result).toEqual({ filtered: true, reason: "header:auto-submitted=auto-replied" });
  });

  it("filters Auto-Submitted: auto-generated; param=value (structured field, picks the type token)", () => {
    const result = detectAutoresponder(
      input({ headers: { "auto-submitted": "auto-generated; type=vacation" } }),
    );
    expect(result).toEqual({ filtered: true, reason: "header:auto-submitted=auto-generated" });
  });

  it("PASSES Auto-Submitted: no (the RFC-blessed not-an-auto-reply marker)", () => {
    const result = detectAutoresponder(input({ headers: { "auto-submitted": "no" } }));
    expect(result).toEqual({ filtered: false });
  });

  it("filters Precedence: bulk (legacy list/mailer-daemon marker)", () => {
    const result = detectAutoresponder(input({ headers: { precedence: "bulk" } }));
    expect(result).toEqual({ filtered: true, reason: "header:precedence=bulk" });
  });

  it("filters X-Autoresponder header presence regardless of value", () => {
    const result = detectAutoresponder(input({ headers: { "x-autoresponder": "true" } }));
    expect(result).toEqual({ filtered: true, reason: "header:x-autoresponder-present" });
  });

  it("filters X-Auto-Response-Suppress (MS-XAUTORESPONSE)", () => {
    const result = detectAutoresponder(input({ headers: { "x-auto-response-suppress": "DR" } }));
    expect(result).toEqual({ filtered: true, reason: "header:x-auto-response-suppress-present" });
  });

  // ── Sender local-part denylist ────────────────────────────────────

  it("filters noreply@... sender local-part", () => {
    const result = detectAutoresponder(input({ fromAddress: "noreply@somecompany.com" }));
    expect(result).toEqual({ filtered: true, reason: "sender-local-part:noreply" });
  });

  it("filters mailer-daemon@... sender local-part (Postfix/Sendmail bounce convention)", () => {
    const result = detectAutoresponder(input({ fromAddress: "MAILER-DAEMON@mail.example.com" }));
    expect(result).toEqual({ filtered: true, reason: "sender-local-part:mailer-daemon" });
  });

  it("filters postmaster@... sender local-part", () => {
    const result = detectAutoresponder(input({ fromAddress: "postmaster@example.com" }));
    expect(result).toEqual({ filtered: true, reason: "sender-local-part:postmaster" });
  });

  // ── Subject regex (EN + FR) ───────────────────────────────────────

  it("filters EN subject: Out of Office Reply", () => {
    const result = detectAutoresponder(input({ subject: "Out of Office Reply" }));
    expect(result).toEqual({ filtered: true, reason: "subject-pattern" });
  });

  it("filters EN subject: Re: Automatic reply: Your message... (responder-quoted)", () => {
    const result = detectAutoresponder(input({ subject: "Re: Automatic reply: Your message" }));
    expect(result).toEqual({ filtered: true, reason: "subject-pattern" });
  });

  it("filters FR subject: Absence du bureau", () => {
    const result = detectAutoresponder(input({ subject: "Absence du bureau" }));
    expect(result).toEqual({ filtered: true, reason: "subject-pattern" });
  });

  it("filters FR subject: Réponse automatique", () => {
    const result = detectAutoresponder(input({ subject: "Réponse automatique" }));
    expect(result).toEqual({ filtered: true, reason: "subject-pattern" });
  });

  // ── Body patterns (EN + FR) ───────────────────────────────────────

  it("filters EN body: I am currently out of the office until Friday", () => {
    const result = detectAutoresponder(
      input({ bodyText: "Hello,\n\nI am currently out of the office until Friday." }),
    );
    expect(result).toEqual({ filtered: true, reason: "body-pattern:en-out-of-office" });
  });

  it("filters FR body: Je suis actuellement absent du bureau", () => {
    const result = detectAutoresponder(
      input({ bodyText: "Bonjour, je suis actuellement absente du bureau." }),
    );
    expect(result).toEqual({ filtered: true, reason: "body-pattern:fr-absent" });
  });

  // ── Passthrough — genuine reply ───────────────────────────────────

  it("PASSES a genuine reply with no autoresponder markers (the canonical happy path)", () => {
    const result = detectAutoresponder(
      input({
        headers: { "message-id": "<abc@gmail.com>", "in-reply-to": "<prev@axisone.ca>" },
        fromAddress: "alice@customer-co.com",
        subject: "Re: Quick question about pricing",
        bodyText: "Hi! Yes, the timing works. Let's chat Thursday at 2pm ET. — Alice",
      }),
    );
    expect(result).toEqual({ filtered: false });
  });

  it("PASSES a reply that incidentally mentions vacation (substantive context, not OOO)", () => {
    // False-positive guard: BODY_PATTERNS are anchored to specific verb phrases
    // so substantive replies mentioning vacation context don't fire.
    const result = detectAutoresponder(
      input({
        bodyText: "Let's grab coffee after my vacation next month — perfect timing.",
      }),
    );
    expect(result).toEqual({ filtered: false });
  });

  it("PASSES an empty-headers inbound (Resend Receiving API unreachable) with genuine subject/body", () => {
    // Fail-open posture: empty headers map = filter falls through to non-
    // header signals; benign inbound still passes.
    const result = detectAutoresponder(input({ headers: {} }));
    expect(result).toEqual({ filtered: false });
  });
});
