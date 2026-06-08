/**
 * KAN-1140 Phase 1 PR 4 — Vendor registry unit tests.
 *
 * Pure-function tests; no mocks required. Tests use a fresh registry
 * instance per test (not the module-scoped singleton) to avoid cross-test
 * pollution.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  vendorRegistry,
  type VendorHandler,
  type VendorDetectionInput,
  type VendorExtraction,
  type VendorExtractionInput,
} from "../registry.js";

function makeHandler(
  name: string,
  shouldDetect: (payload: VendorDetectionInput) => boolean,
  extraction?: VendorExtraction,
): VendorHandler {
  return {
    name,
    detect: shouldDetect,
    extract: (_payload: VendorExtractionInput) =>
      extraction ?? {
        senderEmail: `${name}@test.local`,
        vendor: name,
      },
  };
}

beforeEach(() => {
  vendorRegistry.clear();
});

describe("vendorRegistry — register + list", () => {
  it("registers a handler and lists it back", () => {
    const h = makeHandler("test-vendor", () => false);
    vendorRegistry.register(h);
    const list = vendorRegistry.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("test-vendor");
  });

  it("preserves registration order (insertion-order stable per ECMA-262)", () => {
    vendorRegistry.register(makeHandler("first", () => false));
    vendorRegistry.register(makeHandler("second", () => false));
    vendorRegistry.register(makeHandler("third", () => false));
    expect(vendorRegistry.list().map((h) => h.name)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("throws on duplicate name registration", () => {
    vendorRegistry.register(makeHandler("dup", () => false));
    expect(() => vendorRegistry.register(makeHandler("dup", () => false))).toThrow(
      /already registered.*dup/i,
    );
  });
});

describe("vendorRegistry — detect (first-match-wins)", () => {
  it("returns null when no handler matches", () => {
    vendorRegistry.register(makeHandler("a", () => false));
    vendorRegistry.register(makeHandler("b", () => false));
    const result = vendorRegistry.detect({
      fromHeader: "x@example.com",
      subject: null,
      text: null,
    });
    expect(result).toBeNull();
  });

  it("returns the single matching handler when only one matches", () => {
    vendorRegistry.register(makeHandler("a", () => false));
    vendorRegistry.register(makeHandler("b", (p) => p.fromHeader.endsWith("@b.com")));
    vendorRegistry.register(makeHandler("c", () => false));
    const result = vendorRegistry.detect({
      fromHeader: "x@b.com",
      subject: null,
      text: null,
    });
    expect(result?.name).toBe("b");
  });

  it("returns the FIRST matching handler when multiple would match (first-wins)", () => {
    vendorRegistry.register(makeHandler("first-match", () => true));
    vendorRegistry.register(makeHandler("would-also-match", () => true));
    const result = vendorRegistry.detect({
      fromHeader: "x@example.com",
      subject: null,
      text: null,
    });
    expect(result?.name).toBe("first-match");
  });
});

describe("vendorRegistry — clear", () => {
  it("removes all registered handlers", () => {
    vendorRegistry.register(makeHandler("a", () => false));
    vendorRegistry.register(makeHandler("b", () => false));
    expect(vendorRegistry.list()).toHaveLength(2);
    vendorRegistry.clear();
    expect(vendorRegistry.list()).toHaveLength(0);
  });
});
