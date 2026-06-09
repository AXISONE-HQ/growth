/**
 * KAN-1140 Phase 3 PR 9b — Parse rule executor unit tests.
 *
 * Locks the runtime safety + cascade + failure-isolation contract. Each
 * test asserts a specific Q1/Q10 invariant or a cascade selection
 * outcome. Drift in either direction (relaxing safety OR breaking
 * cascade order) shows up as a test failure.
 */
import { describe, expect, it } from "vitest";
import {
  executeRules,
  traverseJsonPath,
  selectRuleForField,
  isAllFieldsCovered,
  type ExecutableRule,
} from "../parse-rule-executor.js";

function makeRule(overrides: Partial<ExecutableRule>): ExecutableRule {
  return {
    id: overrides.id ?? "r1",
    tenantId: overrides.tenantId ?? "t1",
    fingerprintId: overrides.fingerprintId ?? null,
    format: overrides.format ?? null,
    vendor: overrides.vendor ?? null,
    body: overrides.body ?? { extractors: [] },
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? new Date("2026-01-01"),
  };
}

describe("KAN-1140 PR 9b — traverseJsonPath", () => {
  it("returns named segment value", () => {
    expect(traverseJsonPath({ foo: "bar" }, "$.foo")).toBe("bar");
  });

  it("returns nested named segment value", () => {
    expect(traverseJsonPath({ foo: { bar: "baz" } }, "$.foo.bar")).toBe("baz");
  });

  it("returns indexed array value", () => {
    expect(traverseJsonPath({ foo: ["a", "b", "c"] }, "$.foo[1]")).toBe("b");
  });

  it("returns quoted-named-segment value (with hyphens)", () => {
    expect(traverseJsonPath({ foo: { "bar-baz": "qux" } }, '$.foo["bar-baz"]')).toBe("qux");
  });

  it("returns null on missing path", () => {
    expect(traverseJsonPath({ foo: "bar" }, "$.missing")).toBeNull();
  });

  it("returns null on path-to-object (non-primitive)", () => {
    expect(traverseJsonPath({ foo: { bar: "baz" } }, "$.foo")).toBeNull();
  });

  it("returns null on malformed path (defense-in-depth)", () => {
    expect(traverseJsonPath({ foo: "bar" }, "$..foo")).toBeNull();
    expect(traverseJsonPath({ foo: "bar" }, "$.foo.*")).toBeNull();
  });

  it("returns null on non-object input", () => {
    expect(traverseJsonPath(null, "$.foo")).toBeNull();
    expect(traverseJsonPath("string", "$.foo")).toBeNull();
  });
});

describe("KAN-1140 PR 9b — selectRuleForField cascade (Q2 specificity)", () => {
  const ruleGlobal = makeRule({
    id: "global",
    body: { extractors: [{ field: "firstName", extractor: { type: "regex", pattern: "G", captureGroup: 0 } }] },
    createdAt: new Date("2026-01-01"),
  });
  const ruleVendor = makeRule({
    id: "vendor",
    vendor: "tally",
    body: { extractors: [{ field: "firstName", extractor: { type: "regex", pattern: "V", captureGroup: 0 } }] },
    createdAt: new Date("2026-01-02"),
  });
  const ruleFormat = makeRule({
    id: "format",
    format: "html",
    body: { extractors: [{ field: "firstName", extractor: { type: "regex", pattern: "F", captureGroup: 0 } }] },
    createdAt: new Date("2026-01-03"),
  });
  const ruleFingerprint = makeRule({
    id: "fingerprint",
    fingerprintId: "fp-1",
    body: { extractors: [{ field: "firstName", extractor: { type: "regex", pattern: "FP", captureGroup: 0 } }] },
    createdAt: new Date("2026-01-04"),
  });

  it("fingerprint-scoped rule wins over format/vendor/global", () => {
    const winner = selectRuleForField(
      [ruleGlobal, ruleVendor, ruleFormat, ruleFingerprint],
      "firstName",
    );
    expect(winner?.id).toBe("fingerprint");
  });

  it("format AND vendor both beat global (same specificity 2; createdAt ASC tie-breaker)", () => {
    // format and vendor are tied at specificity 2 per Q2 lock; tie-breaker
    // is createdAt ASC. ruleVendor (2026-01-02) is older than ruleFormat
    // (2026-01-03), so vendor wins. The semantic point: both format-only
    // and vendor-only beat global; among themselves, age decides.
    const winner = selectRuleForField([ruleGlobal, ruleVendor, ruleFormat], "firstName");
    expect(["format", "vendor"]).toContain(winner?.id);
    expect(winner?.id).not.toBe("global");
  });

  it("vendor wins over global when no format/fingerprint match", () => {
    const winner = selectRuleForField([ruleGlobal, ruleVendor], "firstName");
    expect(winner?.id).toBe("vendor");
  });

  it("global wins when no scoped rules", () => {
    const winner = selectRuleForField([ruleGlobal], "firstName");
    expect(winner?.id).toBe("global");
  });

  it("createdAt ASC tie-breaker — older wins among same-specificity", () => {
    const older = makeRule({
      id: "older",
      format: "html",
      body: {
        extractors: [{ field: "firstName", extractor: { type: "regex", pattern: "A", captureGroup: 0 } }],
      },
      createdAt: new Date("2026-01-01"),
    });
    const newer = makeRule({
      id: "newer",
      format: "html",
      body: {
        extractors: [{ field: "firstName", extractor: { type: "regex", pattern: "B", captureGroup: 0 } }],
      },
      createdAt: new Date("2026-01-05"),
    });
    const winner = selectRuleForField([newer, older], "firstName");
    expect(winner?.id).toBe("older");
  });

  it("returns null when no rules cover the requested field", () => {
    const ruleForLastName = makeRule({
      id: "ln-only",
      body: {
        extractors: [{ field: "lastName", extractor: { type: "regex", pattern: "X", captureGroup: 0 } }],
      },
    });
    expect(selectRuleForField([ruleForLastName], "firstName")).toBeNull();
  });
});

describe("KAN-1140 PR 9b — executeRules (Q10 runtime safety)", () => {
  it("REJECTS cross-tenant rule (defense-in-depth assertion throws)", async () => {
    const rule = makeRule({ tenantId: "t-OTHER" });
    await expect(
      executeRules({
        tenantId: "t1",
        rules: [rule],
        payload: { fromAddress: "a@b.c", subject: "x", bodyPreview: "x" },
      }),
    ).rejects.toThrow(/cross-tenant rule leakage/);
  });

  it("rule throws → skip + continue (failure isolation)", async () => {
    const throwingRule = makeRule({
      id: "throws",
      body: {
        extractors: [
          // Body is non-Zod-compliant → ParseRuleBodySchema.parse throws
          // at execution → caught + counted as rulesThrown.
          { field: "firstName", extractor: { type: "regex", pattern: "[invalid", captureGroup: 0 } },
        ],
      },
    });
    const result = await executeRules({
      tenantId: "t1",
      rules: [throwingRule],
      payload: { fromAddress: "a@b.c", subject: "x", bodyPreview: "x" },
    });
    expect(result.metrics.rulesThrown).toBeGreaterThan(0);
    // Output empty; lead-normalizer falls through to Haiku.
    expect(Object.keys(result.output)).toHaveLength(0);
  });

  it("rule fires + produces output", async () => {
    const rule = makeRule({
      body: {
        extractors: [
          {
            field: "firstName",
            extractor: { type: "regex", pattern: "Name: (\\w+)", captureGroup: 1 },
          },
        ],
      },
    });
    const result = await executeRules({
      tenantId: "t1",
      rules: [rule],
      payload: { fromAddress: "a@b.c", subject: "Name: Alice", bodyPreview: null },
    });
    expect(result.output.firstName).toBe("Alice");
    expect(result.metrics.fieldsWritten).toBe(1);
  });

  it("jsonPath extractor fires + traverses structured payload", async () => {
    const rule = makeRule({
      body: {
        extractors: [
          {
            field: "companyName",
            extractor: { type: "jsonPath", path: "$.company.name", transforms: ["trim"] },
          },
        ],
      },
    });
    const result = await executeRules({
      tenantId: "t1",
      rules: [rule],
      payload: {
        fromAddress: "a@b.c",
        subject: null,
        bodyPreview: null,
        structured: { company: { name: "  Acme  " } },
      },
    });
    expect(result.output.companyName).toBe("Acme"); // trimmed
  });

  it("transforms apply in order (lowercase + trim)", async () => {
    const rule = makeRule({
      body: {
        extractors: [
          {
            field: "firstName",
            extractor: { type: "jsonPath", path: "$.name", transforms: ["trim", "lowercase"] },
          },
        ],
      },
    });
    const result = await executeRules({
      tenantId: "t1",
      rules: [rule],
      payload: {
        fromAddress: "a@b.c",
        subject: null,
        bodyPreview: null,
        structured: { name: "  ALICE  " },
      },
    });
    expect(result.output.firstName).toBe("alice");
  });

  it("no rules → empty output + zero metrics", async () => {
    const result = await executeRules({
      tenantId: "t1",
      rules: [],
      payload: { fromAddress: "a@b.c", subject: "x", bodyPreview: "x" },
    });
    expect(Object.keys(result.output)).toHaveLength(0);
    expect(result.metrics.rulesEvaluated).toBe(0);
    expect(result.metrics.fieldsWritten).toBe(0);
  });

  it("rule output empty string is treated as no-match (not written)", async () => {
    const rule = makeRule({
      body: {
        extractors: [
          {
            field: "firstName",
            extractor: { type: "jsonPath", path: "$.name" },
          },
        ],
      },
    });
    const result = await executeRules({
      tenantId: "t1",
      rules: [rule],
      payload: {
        fromAddress: "a@b.c",
        subject: null,
        bodyPreview: null,
        structured: { name: "" },
      },
    });
    expect(result.output.firstName).toBeUndefined();
  });
});

describe("KAN-1140 PR 9b — isAllFieldsCovered", () => {
  it("all 5 rule-writable fields present → true", () => {
    const out = {
      firstName: "A",
      lastName: "B",
      companyName: "C",
      phone: "D",
      intentSummary: "E",
    };
    expect(isAllFieldsCovered(out)).toBe(true);
  });

  it("4 of 5 fields present → false", () => {
    const out = {
      firstName: "A",
      lastName: "B",
      companyName: "C",
      phone: "D",
      // intentSummary missing
    };
    expect(isAllFieldsCovered(out)).toBe(false);
  });

  it("empty string in any field → false", () => {
    const out = {
      firstName: "",
      lastName: "B",
      companyName: "C",
      phone: "D",
      intentSummary: "E",
    };
    expect(isAllFieldsCovered(out)).toBe(false);
  });

  it("empty output → false", () => {
    expect(isAllFieldsCovered({})).toBe(false);
  });
});
