/**
 * KAN-1140 Phase 1 PR 1 — Format detector unit tests.
 *
 * Pure-function tests; no mocks required.
 */
import { describe, it, expect } from "vitest";
import { detectEmailFormat } from "../format-detector.js";

describe("detectEmailFormat — ADF detection", () => {
  it("XML prolog at start of text → adf / high (xml-prolog)", () => {
    const r = detectEmailFormat({
      text: '<?xml version="1.0"?><adf><prospect><customer/></prospect></adf>',
      html: null,
    });
    expect(r.format).toBe("adf");
    expect(r.confidence).toBe("high");
    expect(r.reason).toBe("xml-prolog");
  });

  it("ADF processing instruction → adf / high (adf-processing-instruction)", () => {
    const r = detectEmailFormat({
      text: '<?ADF version="1.0"?><adf></adf>',
      html: null,
    });
    expect(r.format).toBe("adf");
    expect(r.reason).toBe("adf-processing-instruction");
  });

  it("bare <adf> root tag (no prolog) → adf / high (adf-root-tag)", () => {
    const r = detectEmailFormat({
      text: "<adf><prospect></prospect></adf>",
      html: null,
    });
    expect(r.format).toBe("adf");
    expect(r.reason).toBe("adf-root-tag");
  });
});

describe("detectEmailFormat — HTML detection", () => {
  it("html populated, text empty → html / high (html-field-only)", () => {
    const r = detectEmailFormat({
      text: null,
      html: "<html><body>Hello</body></html>",
    });
    expect(r.format).toBe("html");
    expect(r.confidence).toBe("high");
  });

  it("html populated, text whitespace-only → html / high", () => {
    const r = detectEmailFormat({
      text: "   \n  ",
      html: "<html><body>Hi</body></html>",
    });
    expect(r.format).toBe("html");
  });

  it("text contains <html> tag → html-in-text / medium", () => {
    const r = detectEmailFormat({
      text: "<html><body>Caller put HTML in text part</body></html>",
      html: null,
    });
    expect(r.format).toBe("html-in-text");
    expect(r.confidence).toBe("medium");
  });

  it("text contains DOCTYPE html → html-in-text / medium", () => {
    const r = detectEmailFormat({
      text: "<!DOCTYPE html><body>Doctype-flavored HTML</body>",
      html: null,
    });
    expect(r.format).toBe("html-in-text");
  });
});

describe("detectEmailFormat — plain-text fallback", () => {
  it("text with no structured markers → plain-text / high", () => {
    const r = detectEmailFormat({
      text: "Hi, I am interested in your services. Please call me back.",
      html: null,
    });
    expect(r.format).toBe("plain-text");
    expect(r.confidence).toBe("high");
  });

  it("text with label:value lines (no HTML/XML markers) → plain-text / high", () => {
    const r = detectEmailFormat({
      text: "Name: Alice\nEmail: alice@example.com\nPhone: 555-0142",
      html: null,
    });
    expect(r.format).toBe("plain-text");
  });
});

describe("detectEmailFormat — edge cases", () => {
  it("both text and html empty → unknown / low (empty-body)", () => {
    const r = detectEmailFormat({ text: null, html: null });
    expect(r.format).toBe("unknown");
    expect(r.confidence).toBe("low");
  });

  it("both empty strings → unknown / low", () => {
    const r = detectEmailFormat({ text: "", html: "" });
    expect(r.format).toBe("unknown");
  });

  it("text takes precedence over html when both present (ADF marker wins)", () => {
    const r = detectEmailFormat({
      text: '<?xml version="1.0"?><adf></adf>',
      html: "<html><body>Should be ignored when text is ADF</body></html>",
    });
    expect(r.format).toBe("adf");
  });
});
