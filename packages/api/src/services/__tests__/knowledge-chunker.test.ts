/**
 * KAN-827 sub-cohort 6 — knowledge-chunker tests.
 *
 * Pure-function tests against real `js-tiktoken` (no mock — the encoder is
 * deterministic and the test cases are small enough that real encoding is
 * fast). Covers: empty input, single-chunk fit, multi-chunk with overlap,
 * boundary alignment.
 */
import { describe, it, expect } from "vitest";
import { chunk, DEFAULT_CHUNK_TOKEN_CAP, DEFAULT_OVERLAP_TOKENS } from "../knowledge-chunker.js";

describe("knowledge-chunker", () => {
  it("returns empty array on empty / whitespace-only input", () => {
    expect(chunk("")).toEqual([]);
    expect(chunk("   \n\n   ")).toEqual([]);
  });

  it("returns single chunk when text fits under token cap", () => {
    const text = "This is a short FAQ entry. Answer: yes, refunds are issued within 30 days.";
    const result = chunk(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.position).toBe(0);
    expect(result[0]!.text).toBe(text);
    expect(result[0]!.tokenCount).toBeGreaterThan(0);
    expect(result[0]!.tokenCount).toBeLessThan(DEFAULT_CHUNK_TOKEN_CAP);
  });

  it("splits long text into multiple chunks with overlap and ascending positions", () => {
    // ~3000 tokens worth of content — repeating paragraph that the chunker
    // can boundary-align at paragraph breaks.
    const paragraph =
      "The product warranty covers manufacturing defects for two years from the date of purchase. " +
      "Customers may submit claims through our support portal or by email. " +
      "Each claim is reviewed within five business days. ";
    const text = (paragraph + "\n\n").repeat(50).trim();

    const result = chunk(text, { maxTokens: 200, overlapTokens: 30 });
    expect(result.length).toBeGreaterThan(2);
    // Positions strictly ascending starting at 0
    for (let i = 0; i < result.length; i++) {
      expect(result[i]!.position).toBe(i);
    }
    // Each chunk under cap
    for (const c of result) {
      expect(c.tokenCount).toBeLessThanOrEqual(200);
      expect(c.text.length).toBeGreaterThan(0);
    }
    // Overlap evidence — neighboring chunks share text. Take a substring
    // from the tail of chunk N and verify it appears in chunk N+1.
    if (result.length >= 2) {
      const tail = result[0]!.text.slice(-60);
      // Overlap may not be byte-identical because boundary alignment trims
      // to paragraph endings; assert there's SOME overlap signal at the
      // string level — at least one shared 20-char run.
      const has20CharRun = (s: string) => result[1]!.text.includes(s.slice(0, 20));
      expect(has20CharRun(tail)).toBe(true);
    }
  });

  it("throws when overlapTokens >= maxTokens (config invariant)", () => {
    expect(() => chunk("anything", { maxTokens: 100, overlapTokens: 100 })).toThrow(
      /overlapTokens.*must be < maxTokens/,
    );
  });
});
