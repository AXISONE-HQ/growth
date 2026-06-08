/**
 * KAN-1140 Phase 1 PR 1 — HTML email pre-parser unit tests.
 */
import { describe, it, expect } from "vitest";
import { parseHtmlEmail, isHtmlPayload } from "../html-email-parser.js";

describe("isHtmlPayload", () => {
  it("HTML doctype → true", () => {
    expect(isHtmlPayload("<!DOCTYPE html><html></html>")).toBe(true);
  });

  it("bare <html> → true", () => {
    expect(isHtmlPayload("<html><body>Hi</body></html>")).toBe(true);
  });

  it("bare <body> → true", () => {
    expect(isHtmlPayload("<body>Hi</body>")).toBe(true);
  });

  it("plain text → false", () => {
    expect(isHtmlPayload("Just text here")).toBe(false);
  });

  it("null/empty → false", () => {
    expect(isHtmlPayload(null)).toBe(false);
    expect(isHtmlPayload("")).toBe(false);
  });
});

describe("parseHtmlEmail — table-based label/value extraction", () => {
  const TABLE_HTML = `
<html><body>
<table>
  <tr><td>Name</td><td>Alice Buyer</td></tr>
  <tr><td>Email</td><td>alice@example.com</td></tr>
  <tr><td>Phone</td><td>555-0142</td></tr>
  <tr><td>Company</td><td>Acme Co</td></tr>
</table>
</body></html>`;

  it("extracts customFields from table rows", () => {
    const r = parseHtmlEmail({ html: TABLE_HTML });
    expect(r?.customFields.name).toBe("Alice Buyer");
    expect(r?.customFields.email).toBe("alice@example.com");
    expect(r?.customFields.phone).toBe("555-0142");
    expect(r?.customFields.company).toBe("Acme Co");
  });

  it("normalizes labels to snake_case", () => {
    const HTML = `
<html><body><table>
  <tr><td>First Name</td><td>Alice</td></tr>
  <tr><td>Email Address</td><td>alice@x.com</td></tr>
</table></body></html>`;
    const r = parseHtmlEmail({ html: HTML });
    expect(r?.customFields.first_name).toBe("Alice");
    expect(r?.customFields.email_address).toBe("alice@x.com");
  });
});

describe("parseHtmlEmail — dl/dt/dd label extraction", () => {
  const DL_HTML = `
<html><body>
<dl>
  <dt>Name</dt><dd>Bob</dd>
  <dt>Email</dt><dd>bob@example.com</dd>
</dl>
</body></html>`;

  it("extracts customFields from <dl> pairs", () => {
    const r = parseHtmlEmail({ html: DL_HTML });
    expect(r?.customFields.name).toBe("Bob");
    expect(r?.customFields.email).toBe("bob@example.com");
  });
});

describe("parseHtmlEmail — body text + script/style stripping", () => {
  it("strips script/style tags before extracting text", () => {
    const HTML = `
<html><head>
  <style>body { color: red; }</style>
  <script>alert('x');</script>
</head>
<body>Hello, please contact me. <script>tracker()</script></body>
</html>`;
    const r = parseHtmlEmail({ html: HTML });
    expect(r?.extractedText).toContain("Hello, please contact me");
    expect(r?.extractedText).not.toContain("alert");
    expect(r?.extractedText).not.toContain("tracker");
    expect(r?.extractedText).not.toContain("color: red");
  });

  it("normalizes whitespace", () => {
    const HTML = "<html><body>Hello\n\n   World   </body></html>";
    const r = parseHtmlEmail({ html: HTML });
    expect(r?.extractedText).toBe("Hello World");
  });
});

describe("parseHtmlEmail — edge cases", () => {
  it("empty input → null", () => {
    expect(parseHtmlEmail({ html: "" })).toBeNull();
  });

  it("malformed HTML → still returns a result (cheerio is permissive)", () => {
    const r = parseHtmlEmail({ html: "<html><body>Unclosed body" });
    expect(r).not.toBeNull();
    expect(r?.extractedText).toContain("Unclosed body");
  });

  it("HTML with no labels → returns empty customFields + just text", () => {
    const r = parseHtmlEmail({ html: "<html><body>Just a casual hello.</body></html>" });
    expect(r?.customFields).toEqual({});
    expect(r?.extractedText).toBe("Just a casual hello.");
  });
});
