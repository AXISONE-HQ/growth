/**
 * KAN-954 — Formspree email parser unit tests.
 *
 * Built against the verbatim D2 specimen fetched 2026-05-20 from the
 * Resend Receiving API (see fixtures/formspree-2026-05-20.ts). This
 * fixture IS the ground truth — if Formspree's format changes, re-fetch
 * a fresh specimen and update the fixture rather than hand-editing
 * expected values.
 */
import { describe, it, expect } from "vitest";
import {
  parseFormspreeEmail,
  isFormspreeSource,
} from "../formspree-email.js";
import { FORMSPREE_SPECIMEN_2026_05_20 } from "./fixtures/formspree-2026-05-20.js";

describe("isFormspreeSource — detection signal", () => {
  it("matches the bare noreply@formspree.io", () => {
    expect(isFormspreeSource("noreply@formspree.io")).toBe(true);
  });

  it("matches the display-name form '\"Formspree\" <noreply@formspree.io>'", () => {
    expect(isFormspreeSource(FORMSPREE_SPECIMEN_2026_05_20.fromHeader)).toBe(true);
  });

  it("matches subdomain email.formspree.io", () => {
    expect(isFormspreeSource("bounces@email.formspree.io")).toBe(true);
  });

  it("does NOT match formspree.io-lookalike domains", () => {
    expect(isFormspreeSource("noreply@formspree.io.evil.com")).toBe(false);
    expect(isFormspreeSource("noreply@notformspree.io")).toBe(false);
  });

  it("does NOT match unrelated senders", () => {
    expect(isFormspreeSource("fred@mkze.vc")).toBe(false);
    expect(isFormspreeSource("alice@customer.example")).toBe(false);
  });
});

describe("parseFormspreeEmail — happy path against the D2 specimen", () => {
  const result = parseFormspreeEmail({
    fromHeader: FORMSPREE_SPECIMEN_2026_05_20.fromHeader,
    subject: FORMSPREE_SPECIMEN_2026_05_20.subject,
    text: FORMSPREE_SPECIMEN_2026_05_20.text,
    replyTo: [...FORMSPREE_SPECIMEN_2026_05_20.replyTo],
  });

  it("returns a non-null result", () => {
    expect(result).not.toBeNull();
  });

  it("senderEmail = reply_to[0] (the real submitter, NOT noreply@formspree.io)", () => {
    expect(result?.senderEmail).toBe("cowork-pipeline-test@e2etest.co");
  });

  it("splits the name into firstName + lastName", () => {
    expect(result?.firstName).toBe("Cowork");
    expect(result?.lastName).toBe("Pipeline Test");
  });

  it("extracts companyName from the body", () => {
    expect(result?.companyName).toBe("E2E Test Co");
  });

  it("captures every form field in customFields", () => {
    expect(result?.customFields).toMatchObject({
      formSource: "growth-landing-v1",
      leadType: "early_access_request",
      name: "Cowork Pipeline Test",
      email: "cowork-pipeline-test@e2etest.co",
      company: "E2E Test Co",
      role: "Founder / CEO",
      monthlyLeadVolume: "100-500",
    });
  });

  it("preserves biggestPain verbatim including HTML entities", () => {
    expect(result?.customFields.biggestPain).toContain("COWORK E2E PIPELINE TEST");
    expect(result?.customFields.biggestPain).toContain("Formspree -&gt; leads.axisone.ca");
  });

  it("hoists formSource + leadType for event metadata", () => {
    expect(result?.formSource).toBe("growth-landing-v1");
    expect(result?.leadType).toBe("early_access_request");
  });

  it("dealNameSeed = 'Early-access — {company}' (the headline outcome)", () => {
    expect(result?.dealNameSeed).toBe("Early-access — E2E Test Co");
  });
});

describe("parseFormspreeEmail — graceful degradation", () => {
  it("falls back to body 'email:' line when replyTo is empty", () => {
    const result = parseFormspreeEmail({
      fromHeader: "noreply@formspree.io",
      subject: "Growth landing — new early-access lead",
      text: FORMSPREE_SPECIMEN_2026_05_20.text,
      replyTo: [], // no reply-to from upstream
    });
    expect(result?.senderEmail).toBe("cowork-pipeline-test@e2etest.co");
  });

  it("dealNameSeed degrades to 'Early-access — {name}' when company is missing", () => {
    const noCompanyBody = FORMSPREE_SPECIMEN_2026_05_20.text.replace(
      /company:\nE2E Test Co\n/,
      "",
    );
    const result = parseFormspreeEmail({
      fromHeader: "noreply@formspree.io",
      subject: null,
      text: noCompanyBody,
      replyTo: ["test@example.com"],
    });
    expect(result?.companyName).toBeNull();
    expect(result?.dealNameSeed).toBe("Early-access — Cowork Pipeline Test");
  });

  it("dealNameSeed degrades to 'Early-access lead' when both company and name are missing", () => {
    const result = parseFormspreeEmail({
      fromHeader: "noreply@formspree.io",
      subject: null,
      text: `Hey there,

Someone just submitted your form on formspree.io/. Here's what they had to say:


email:
anon@example.com


biggestPain:
something

Submitted now`,
      replyTo: ["anon@example.com"],
    });
    expect(result?.dealNameSeed).toBe("Early-access lead");
  });

  it("returns null when From is not Formspree (no-op for direct inbound)", () => {
    const result = parseFormspreeEmail({
      fromHeader: "fred@mkze.vc",
      subject: "Hi",
      text: "Just a regular email",
      replyTo: [],
    });
    expect(result).toBeNull();
  });

  it("returns null when text body is missing (can't extract fields, mis-attribution preferred over wrong attribution)", () => {
    const result = parseFormspreeEmail({
      fromHeader: "noreply@formspree.io",
      subject: "Growth landing — new early-access lead",
      text: null,
      replyTo: ["test@example.com"],
    });
    expect(result).toBeNull();
  });

  it("returns null when no senderEmail can be derived (no reply-to AND no body 'email:' line)", () => {
    const result = parseFormspreeEmail({
      fromHeader: "noreply@formspree.io",
      subject: null,
      text: `Hey there,

Someone just submitted your form on formspree.io/. Here's what they had to say:


name:
Anonymous

Submitted now`,
      replyTo: [],
    });
    expect(result).toBeNull();
  });

  it("returns null on a malformed body (no recognizable Label:Value structure)", () => {
    const result = parseFormspreeEmail({
      fromHeader: "noreply@formspree.io",
      subject: "Growth landing — new early-access lead",
      text: "Random garbage that doesn't look like a Formspree submission at all.",
      replyTo: [], // no reply-to either → can't recover
    });
    expect(result).toBeNull();
  });
});
