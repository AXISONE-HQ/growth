/**
 * KAN-1141 PR 0 — Lead-API route helper tests.
 *
 * Focused unit tests for the Q5(a) `customerMetadata` silent-drop fix.
 * `flattenMetadataToCustomFields` is the load-bearing pure helper for the
 * fix; the route's normalizer-call wiring is verified separately via the
 * dispatcher test in `packages/api/src/services/__tests__/lead-normalizer.test.ts`
 * (the `lead_api source routes through normalizeInboundLeadApi successfully`
 * case).
 *
 * Memo 32 disposition: route-handler integration testing via Hono harness
 * adds marginal value over direct helper tests for this PR. The wire-mapping
 * logic IS the bug; testing the helper directly gives the highest-confidence
 * regression guard for KAN-742's latent silent-drop. Full route integration
 * coverage deferred to a sibling PR if Hono test-harness setup gets dialed in.
 *
 * Test runner: apps/api vitest config picks up apps/api/src/__tests__/*.test.ts.
 */
import { describe, it, expect } from "vitest";
import { flattenMetadataToCustomFields } from "../routes/lead-api.js";

describe("flattenMetadataToCustomFields — KAN-1141 PR 0 Q5(a) wire-mapping fix", () => {
  // Undefined metadata → undefined customFields (route omits the field on wire event)
  it("undefined metadata → returns undefined", () => {
    expect(flattenMetadataToCustomFields(undefined)).toBeUndefined();
  });

  // Empty object → undefined (the route's `...(customFields ? {...} : {})` spread
  // omits the field; consumers see no customFields key on the wire event)
  it("empty metadata object → returns undefined", () => {
    expect(flattenMetadataToCustomFields({})).toBeUndefined();
  });

  // String values pass through unchanged
  it("string values pass through unchanged", () => {
    const result = flattenMetadataToCustomFields({
      utm_source: "partner",
      utm_campaign: "spring-2026",
    });
    expect(result).toEqual({
      utm_source: "partner",
      utm_campaign: "spring-2026",
    });
  });

  // Nested objects get JSON.stringify'd (the load-bearing fix — pre-PR-0
  // the route published these under `customerMetadata` which was silently
  // dropped by Zod's strip mode at the wire-schema parse step)
  it("nested objects get JSON.stringify'd (lossless preservation)", () => {
    const result = flattenMetadataToCustomFields({
      nested_obj: { name: "Bob", age: 42 },
      list: [1, 2, 3],
    });
    expect(result).toEqual({
      nested_obj: JSON.stringify({ name: "Bob", age: 42 }),
      list: JSON.stringify([1, 2, 3]),
    });
  });

  // Mixed scalar types — number, boolean, null all stringify cleanly
  it("number / boolean / null values all stringify", () => {
    const result = flattenMetadataToCustomFields({
      count: 42,
      active: true,
      missing: null,
    });
    expect(result).toEqual({
      count: "42",
      active: "true",
      missing: "null",
    });
  });
});
