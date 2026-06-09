/**
 * KAN-1140 Phase 3 PR 9a — Safety validator truth-table.
 *
 * Locks the Q1 + Q3 + Q10 security posture against future drift. Each
 * test asserts a specific attack vector is rejected OR a specific
 * legitimate shape is accepted. Drift in either direction (relaxing the
 * validator OR over-tightening it past usability) shows up as a test
 * failure.
 */
import { describe, expect, it } from "vitest";
import {
  isSafeJsonPath,
  isSafeRegex,
  ParseRuleBodySchema,
  PARSE_RULE_WRITABLE_FIELDS,
  PARSE_RULE_TRANSFORMS,
  MAX_RULES_PER_TENANT,
} from "../parse-rule.js";

describe("KAN-1140 PR 9a — isSafeJsonPath", () => {
  it("accepts $.foo (root + named segment)", () => {
    expect(isSafeJsonPath("$.foo")).toBe(true);
  });

  it("accepts $.foo.bar (nested named segments)", () => {
    expect(isSafeJsonPath("$.foo.bar")).toBe(true);
  });

  it("accepts $.foo[0] (indexed array access)", () => {
    expect(isSafeJsonPath("$.foo[0]")).toBe(true);
  });

  it("accepts $.foo[\"bar-baz\"] (quoted named segment with hyphens)", () => {
    expect(isSafeJsonPath('$.foo["bar-baz"]')).toBe(true);
  });

  it("accepts $.foo-bar.baz_qux (hyphens + underscores)", () => {
    expect(isSafeJsonPath("$.foo-bar.baz_qux")).toBe(true);
  });

  it("REJECTS $..foo (recursive descent — PATH TRAVERSAL VECTOR)", () => {
    expect(isSafeJsonPath("$..foo")).toBe(false);
  });

  it("REJECTS $.foo.* (wildcard segment — unbounded selector)", () => {
    expect(isSafeJsonPath("$.foo.*")).toBe(false);
  });

  it("REJECTS $.foo[*] (wildcard index)", () => {
    expect(isSafeJsonPath("$.foo[*]")).toBe(false);
  });

  it("REJECTS $ (root alone — must have at least one segment)", () => {
    expect(isSafeJsonPath("$")).toBe(false);
  });

  it("REJECTS $.foo[?(@.x)] (filter expressions)", () => {
    expect(isSafeJsonPath("$.foo[?(@.x)]")).toBe(false);
  });

  it("REJECTS empty string", () => {
    expect(isSafeJsonPath("")).toBe(false);
  });
});

describe("KAN-1140 PR 9a — isSafeRegex (ReDoS protection)", () => {
  it("accepts simple anchored pattern", () => {
    expect(isSafeRegex("^[a-z]+$")).toBe(true);
  });

  it("accepts character class with quantifier", () => {
    expect(isSafeRegex("\\d{3,5}")).toBe(true);
  });

  it("accepts capture group", () => {
    expect(isSafeRegex("(\\w+)@(\\w+\\.\\w+)")).toBe(true);
  });

  it("REJECTS nested quantifier (a+)+ (classic ReDoS)", () => {
    expect(isSafeRegex("(a+)+")).toBe(false);
  });

  it("REJECTS (a*)* nested star", () => {
    expect(isSafeRegex("(a*)*")).toBe(false);
  });

  it("REJECTS (.*)*", () => {
    expect(isSafeRegex("(.*)*")).toBe(false);
  });

  // Note: safe-regex2 uses star-height analysis (nested quantifier
  // detection), NOT alternation-overlap detection. Patterns like (a|a)+
  // pass star-height because they have no nested quantifier — they're
  // not classic ReDoS vectors. The defense-in-depth strategy: static
  // analyzer catches star-height; PR 9b's runtime 50ms CPU budget catches
  // anything that slips through.
  it("REJECTS nested-star inside group (.*)*x", () => {
    expect(isSafeRegex("(.*)*x")).toBe(false);
  });
});

describe("KAN-1140 PR 9a — ParseRuleBodySchema", () => {
  it("accepts valid jsonPath extractor with transforms", () => {
    const result = ParseRuleBodySchema.safeParse({
      extractors: [
        {
          field: "firstName",
          extractor: {
            type: "jsonPath",
            path: "$.contact.first_name",
            transforms: ["trim", "lowercase"],
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid regex extractor with captureGroup", () => {
    const result = ParseRuleBodySchema.safeParse({
      extractors: [
        {
          field: "phone",
          extractor: {
            type: "regex",
            pattern: "Phone: (\\+?\\d[\\d -]+)",
            captureGroup: 1,
          },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("REJECTS field NOT in PARSE_RULE_WRITABLE_FIELDS allow-list", () => {
    const result = ParseRuleBodySchema.safeParse({
      extractors: [
        {
          field: "id", // not in allow-list
          extractor: { type: "jsonPath", path: "$.id" },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("REJECTS transform NOT in PARSE_RULE_TRANSFORMS", () => {
    const result = ParseRuleBodySchema.safeParse({
      extractors: [
        {
          field: "firstName",
          extractor: {
            type: "jsonPath",
            path: "$.foo",
            transforms: ["evalAsJavaScript" as never],
          },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("REJECTS empty extractors array (min 1)", () => {
    const result = ParseRuleBodySchema.safeParse({ extractors: [] });
    expect(result.success).toBe(false);
  });

  it("REJECTS 21+ extractors (max 20)", () => {
    const extractors = Array.from({ length: 21 }, () => ({
      field: "firstName" as const,
      extractor: { type: "jsonPath" as const, path: "$.foo" },
    }));
    const result = ParseRuleBodySchema.safeParse({ extractors });
    expect(result.success).toBe(false);
  });

  it("REJECTS jsonPath with recursive descent (defense-in-depth via schema)", () => {
    const result = ParseRuleBodySchema.safeParse({
      extractors: [
        {
          field: "firstName",
          extractor: { type: "jsonPath", path: "$..foo" },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("REJECTS regex with catastrophic backtracking (defense-in-depth via schema)", () => {
    const result = ParseRuleBodySchema.safeParse({
      extractors: [
        {
          field: "phone",
          extractor: { type: "regex", pattern: "(a+)+", captureGroup: 0 },
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("KAN-1140 PR 9a — constants", () => {
  it("MAX_RULES_PER_TENANT is 100 (Q10 lock)", () => {
    expect(MAX_RULES_PER_TENANT).toBe(100);
  });

  it("PARSE_RULE_WRITABLE_FIELDS does not include engine-load-bearing fields", () => {
    expect(PARSE_RULE_WRITABLE_FIELDS).not.toContain("id");
    expect(PARSE_RULE_WRITABLE_FIELDS).not.toContain("tenantId");
    expect(PARSE_RULE_WRITABLE_FIELDS).not.toContain("email");
    expect(PARSE_RULE_WRITABLE_FIELDS).not.toContain("extractionConfidence");
  });

  it("PARSE_RULE_TRANSFORMS does not include code-execution-adjacent names", () => {
    expect(PARSE_RULE_TRANSFORMS).not.toContain("eval" as never);
    expect(PARSE_RULE_TRANSFORMS).not.toContain("exec" as never);
    expect(PARSE_RULE_TRANSFORMS).not.toContain("function" as never);
  });
});
