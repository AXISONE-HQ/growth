/**
 * KAN-1140 Phase 3 PR 6 — Per-layer confidence-trigger unit tests.
 *
 * Pure function; no mocks. Six cases cover the full truth table for
 * the per-layer-threshold rule (Q1 lock).
 */
import { describe, it, expect } from "vitest";
import { deriveParseConfidenceVerdict } from "../parse-confidence-trigger.js";

describe("deriveParseConfidenceVerdict — per-layer threshold (Q1 lock)", () => {
  it("all high → no escalation", () => {
    const v = deriveParseConfidenceVerdict({
      formatConfidence: "high",
      languageConfidence: "high",
      extractionConfidence: "high",
    });
    expect(v.shouldEscalate).toBe(false);
    expect(v.reasons).toEqual([]);
  });

  it("format=low only → escalate with format reason", () => {
    const v = deriveParseConfidenceVerdict({
      formatConfidence: "low",
      languageConfidence: "high",
      extractionConfidence: "high",
    });
    expect(v.shouldEscalate).toBe(true);
    expect(v.reasons).toEqual(["format detection LOW"]);
  });

  it("language=low only → escalate with language reason", () => {
    const v = deriveParseConfidenceVerdict({
      formatConfidence: "high",
      languageConfidence: "low",
      extractionConfidence: "high",
    });
    expect(v.shouldEscalate).toBe(true);
    expect(v.reasons).toEqual(["language detection LOW"]);
  });

  it("extraction=low only → escalate with Haiku reason", () => {
    const v = deriveParseConfidenceVerdict({
      formatConfidence: "high",
      languageConfidence: "high",
      extractionConfidence: "low",
    });
    expect(v.shouldEscalate).toBe(true);
    expect(v.reasons).toEqual(["Haiku extraction LOW"]);
  });

  it("all three low → escalate with all 3 reasons in deterministic order", () => {
    const v = deriveParseConfidenceVerdict({
      formatConfidence: "low",
      languageConfidence: "low",
      extractionConfidence: "low",
    });
    expect(v.shouldEscalate).toBe(true);
    expect(v.reasons).toEqual([
      "format detection LOW",
      "language detection LOW",
      "Haiku extraction LOW",
    ]);
  });

  it("mixed high/medium/low — any single LOW triggers escalation", () => {
    const v = deriveParseConfidenceVerdict({
      formatConfidence: "medium",
      languageConfidence: "high",
      extractionConfidence: "low",
    });
    expect(v.shouldEscalate).toBe(true);
    expect(v.reasons).toEqual(["Haiku extraction LOW"]);
  });

  it("undefined inputs → no escalation (defensive — webhook may omit on Resend fetch failure)", () => {
    const v = deriveParseConfidenceVerdict({});
    expect(v.shouldEscalate).toBe(false);
    expect(v.reasons).toEqual([]);
    expect(v.breakdown).toEqual({});
  });
});
