/**
 * KAN-1140 Phase 1 PR 4 — Stub vendor handler tests (Tally / Typeform / Webflow).
 *
 * Each stub asserts:
 *   - `detect()` returns false unconditionally (handler never fires via registry)
 *   - `extract()` throws — defensive; should be unreachable via registry's
 *     first-match-wins iteration since detect() returns false
 *   - `name` is the expected vendor identifier
 */
import { describe, it, expect } from "vitest";
import { tallyHandler } from "../vendor-handlers/tally-handler.js";
import { typeformHandler } from "../vendor-handlers/typeform-handler.js";
import { webflowHandler } from "../vendor-handlers/webflow-handler.js";

const STUB_PAYLOAD = {
  fromHeader: "noreply@example.com",
  subject: "Test",
  text: "body",
  replyTo: [],
};

describe.each([
  ["tally", tallyHandler],
  ["typeform", typeformHandler],
  ["webflow", webflowHandler],
])("%s handler stub", (name, handler) => {
  it(`has name "${name}"`, () => {
    expect(handler.name).toBe(name);
  });

  it("detect() returns false unconditionally", () => {
    expect(handler.detect(STUB_PAYLOAD)).toBe(false);
  });

  it("extract() throws with KAN-1140 PR 4 stub message", () => {
    expect(() => handler.extract(STUB_PAYLOAD)).toThrow(/not implemented/i);
    expect(() => handler.extract(STUB_PAYLOAD)).toThrow(/KAN-1140 Phase 1 PR 4/);
  });
});
