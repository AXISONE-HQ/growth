/**
 * KAN-911 — string-matching utility tests (lib for import-dedup).
 *
 * Pure functions, no Prisma / network deps. Coverage:
 *   normalize        — NFD strip, lowercase, non-alphanum-to-space, collapse
 *   fuzzyEqual       — threshold 0.15 (similarity ≥ 0.85)
 *   fuzzyScore       — 0-100 raw score (caller applies cap)
 *   normalizePhone   — digits-only
 *   phonesMatch      — NANP 11/10 equivalence
 *   bucketKey        — first letter, '_' for empty
 */
import { describe, it, expect } from "vitest";
import {
  normalize,
  fuzzyEqual,
  fuzzyScore,
  normalizePhone,
  phonesMatch,
  bucketKey,
} from "../lib/string-matching.js";

describe("normalize", () => {
  it("lowercases + strips diacritics + collapses whitespace", () => {
    expect(normalize("Café  Au LAIT")).toBe("cafe au lait");
  });
  it("returns '' for null/undefined", () => {
    expect(normalize(null)).toBe("");
    expect(normalize(undefined)).toBe("");
  });
  it("normalizes punctuation to spaces", () => {
    expect(normalize("Mr.O'Hara")).toBe("mr o hara");
    expect(normalize("Acme, Inc.")).toBe("acme inc");
  });
});

describe("fuzzyEqual", () => {
  it("returns true for exact match after normalize", () => {
    expect(fuzzyEqual("Acme Corp", "ACME corp")).toBe(true);
  });
  it("returns true for 1-char typo over a 9-char string", () => {
    // "MacDonald" vs "McDonald" — distance 1 over 9 chars = 0.111
    // (below the 0.15 threshold). Short strings + typos don't fuzzy-match.
    expect(fuzzyEqual("MacDonald", "McDonald")).toBe(true);
  });
  it("returns false for clearly different strings", () => {
    expect(fuzzyEqual("Acme Corp", "Zulu Industries")).toBe(false);
  });
  it("returns false for empty inputs", () => {
    expect(fuzzyEqual("", "anything")).toBe(false);
    expect(fuzzyEqual(null, "anything")).toBe(false);
  });
});

describe("fuzzyScore", () => {
  it("returns 100 on exact match (post-normalize)", () => {
    expect(fuzzyScore("Acme", "ACME ")).toBe(100);
  });
  it("returns 0 on empty input", () => {
    expect(fuzzyScore(null, "x")).toBe(0);
  });
  it("returns intermediate score on typos", () => {
    const score = fuzzyScore("Smith", "Smyth");
    expect(score).toBeGreaterThan(75);
    expect(score).toBeLessThan(100);
  });
});

describe("normalizePhone", () => {
  it("strips non-digit characters", () => {
    expect(normalizePhone("+1 (415) 555-0142")).toBe("14155550142");
    expect(normalizePhone("(415) 555-0142")).toBe("4155550142");
  });
  it("returns '' for null/undefined", () => {
    expect(normalizePhone(null)).toBe("");
    expect(normalizePhone(undefined)).toBe("");
  });
});

describe("phonesMatch", () => {
  it("matches exact digits", () => {
    expect(phonesMatch("4155550142", "415-555-0142")).toBe(true);
  });
  it("matches NANP 11-digit ↔ 10-digit", () => {
    expect(phonesMatch("+1 415 555 0142", "415 555 0142")).toBe(true);
    expect(phonesMatch("4155550142", "14155550142")).toBe(true);
  });
  it("does NOT match different numbers", () => {
    expect(phonesMatch("4155550142", "4155550143")).toBe(false);
  });
  it("does NOT match empty input", () => {
    expect(phonesMatch(null, "4155550142")).toBe(false);
    expect(phonesMatch("", "4155550142")).toBe(false);
  });
});

describe("bucketKey", () => {
  it("returns first letter of normalized name", () => {
    expect(bucketKey("Acme Corp")).toBe("a");
    expect(bucketKey("ZULU Inc")).toBe("z");
    expect(bucketKey("123 Street")).toBe("1");
  });
  it("returns '_' for empty / null", () => {
    expect(bucketKey(null)).toBe("_");
    expect(bucketKey("")).toBe("_");
    expect(bucketKey("   ")).toBe("_");
  });
});
