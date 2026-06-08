/**
 * KAN-1140 Phase 1 PR 4 — Formspree VendorHandler adapter tests.
 *
 * Tests the handler wrapper. The legacy `isFormspreeSource` /
 * `parseFormspreeEmail` exports continue to be tested via
 * `formspree-email.test.ts`; this file tests the new handler shape.
 */
import { describe, it, expect } from "vitest";
import { formspreeHandler } from "../formspree-email.js";
import { FORMSPREE_SPECIMEN_2026_05_20 } from "./fixtures/formspree-2026-05-20.js";

describe("formspreeHandler — name + detect", () => {
  it('name is "formspree"', () => {
    expect(formspreeHandler.name).toBe("formspree");
  });

  it("detect() returns true for Formspree-shaped From", () => {
    expect(
      formspreeHandler.detect({
        fromHeader: FORMSPREE_SPECIMEN_2026_05_20.fromHeader,
        subject: FORMSPREE_SPECIMEN_2026_05_20.subject,
        text: FORMSPREE_SPECIMEN_2026_05_20.text,
      }),
    ).toBe(true);
  });

  it("detect() returns false for non-Formspree From", () => {
    expect(
      formspreeHandler.detect({
        fromHeader: "alice@customer.example",
        subject: "Direct inquiry",
        text: "Hi team, ...",
      }),
    ).toBe(false);
  });
});

describe("formspreeHandler — extract", () => {
  it("returns VendorExtraction shape against the D2 specimen", () => {
    const result = formspreeHandler.extract({
      fromHeader: FORMSPREE_SPECIMEN_2026_05_20.fromHeader,
      subject: FORMSPREE_SPECIMEN_2026_05_20.subject,
      text: FORMSPREE_SPECIMEN_2026_05_20.text,
      replyTo: [...FORMSPREE_SPECIMEN_2026_05_20.replyTo],
    });
    expect(result).not.toBeNull();
    expect(result?.vendor).toBe("formspree");
    // Formspree-native: senderEmail comes from reply_to[0] (the real submitter)
    expect(result?.senderEmail).toBe(FORMSPREE_SPECIMEN_2026_05_20.replyTo[0]?.toLowerCase());
    // KAN-954-era fields propagated through the handler shape
    expect(result?.formSource).toBeTruthy();
    expect(result?.leadType).toBeTruthy();
    expect(result?.dealName).toBeTruthy();
    expect(result?.customFields).toBeTruthy();
  });

  it("returns null when From-domain is not Formspree (detect short-circuits)", () => {
    const result = formspreeHandler.extract({
      fromHeader: "alice@customer.example",
      subject: "Direct inquiry",
      text: "Hi team",
      replyTo: [],
    });
    expect(result).toBeNull();
  });

  it("returns null on Formspree From with no text body", () => {
    const result = formspreeHandler.extract({
      fromHeader: "noreply@formspree.io",
      subject: "Form submission",
      text: null,
      replyTo: ["alice@customer.example"],
    });
    expect(result).toBeNull();
  });
});
