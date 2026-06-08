/**
 * KAN-1140 Phase 1 PR 1 — Plain-text email pre-parser unit tests.
 */
import { describe, it, expect } from "vitest";
import { parsePlainTextEmail } from "../plain-text-email-parser.js";

describe("parsePlainTextEmail — signature stripping", () => {
  it("strips RFC 3676 signature delimiter '-- '", () => {
    const text = `Hi, I'm interested.

Please call me.

--
Alice Buyer
Senior Engineer
Acme Co`;
    const r = parsePlainTextEmail({ text });
    expect(r?.cleanedText).toContain("Please call me");
    expect(r?.cleanedText).not.toContain("Acme Co");
    expect(r?.cleanedText).not.toContain("Senior Engineer");
  });

  it("strips 'Sent from my iPhone' mobile signature", () => {
    const text = `Looking forward to your reply.

Sent from my iPhone`;
    const r = parsePlainTextEmail({ text });
    expect(r?.cleanedText).toContain("Looking forward");
    expect(r?.cleanedText).not.toContain("iPhone");
  });
});

describe("parsePlainTextEmail — quoted reply stripping", () => {
  it("strips 'On <date> wrote:' block", () => {
    const text = `Yes, that works.

On Tue, Jun 8, 2026 at 1:00 PM Alice <alice@x.com> wrote:
> Original message that should be stripped
> with multiple lines`;
    const r = parsePlainTextEmail({ text });
    expect(r?.cleanedText).toContain("Yes, that works");
    expect(r?.cleanedText).not.toContain("Original message");
    expect(r?.cleanedText).not.toContain("multiple lines");
  });

  it("strips '-----Original Message-----' Outlook block", () => {
    const text = `My reply here.

-----Original Message-----
From: Alice
Subject: Old subject
Old body`;
    const r = parsePlainTextEmail({ text });
    expect(r?.cleanedText).toContain("My reply");
    expect(r?.cleanedText).not.toContain("Old body");
  });
});

describe("parsePlainTextEmail — label:value extraction", () => {
  const FORM_TEXT = `Hi,

Please find my details below:

Name: Carol Caller
Email: carol@example.com
Phone: 555-0199
Company: Carol Co
Role: CEO

Looking forward to chatting.`;

  it("extracts Label: value pairs to customFields", () => {
    const r = parsePlainTextEmail({ text: FORM_TEXT });
    expect(r?.customFields.name).toBe("Carol Caller");
    expect(r?.customFields.email).toBe("carol@example.com");
    expect(r?.customFields.phone).toBe("555-0199");
    expect(r?.customFields.company).toBe("Carol Co");
    expect(r?.customFields.role).toBe("CEO");
  });

  it("normalizes 'First Name' → 'first_name' key", () => {
    const text = "First Name: Alice\nLast Name: Buyer";
    const r = parsePlainTextEmail({ text });
    expect(r?.customFields.first_name).toBe("Alice");
    expect(r?.customFields.last_name).toBe("Buyer");
  });

  it("accepts '=' delimiter in addition to ':'", () => {
    const text = "utm_source = partner\nutm_campaign = spring-2026";
    const r = parsePlainTextEmail({ text });
    expect(r?.customFields.utm_source).toBe("partner");
    expect(r?.customFields.utm_campaign).toBe("spring-2026");
  });
});

describe("parsePlainTextEmail — edge cases", () => {
  it("empty input → null", () => {
    expect(parsePlainTextEmail({ text: "" })).toBeNull();
    expect(parsePlainTextEmail({ text: "   " })).toBeNull();
  });

  it("no labels, no signature → returns text unchanged + empty customFields", () => {
    const r = parsePlainTextEmail({ text: "Just a casual sentence." });
    expect(r?.cleanedText).toBe("Just a casual sentence.");
    expect(r?.customFields).toEqual({});
  });
});
