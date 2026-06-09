/**
 * KAN-1140 Phase 3 PR 7 — parse-fingerprint helper unit tests.
 *
 * Pure function; no mocks. Covers:
 *   - Hash invariants (same logical input → same hash; different input → different hash)
 *   - Normalization rules (lowercase, attr-name sort, value strip, +suffix strip)
 *   - Per-format derivation (HTML/ADF → tree; plain-text → labels; unknown → null)
 *   - Golden-hash regression locks (known input → known hex; protects against
 *     algorithm drift on future helper edits)
 */
import { describe, it, expect } from "vitest";
import {
  deriveParseFingerprint,
  extractLabelTokens,
  extractTagTreeForHash,
  normalizeSenderAddress,
  shouldAutoSuggest,
} from "../parse-fingerprint.js";

describe("normalizeSenderAddress", () => {
  it("lowercases full address", () => {
    expect(normalizeSenderAddress("ALICE@Example.COM")).toBe("alice@example.com");
  });

  it("strips +suffix from local part", () => {
    expect(normalizeSenderAddress("noreply+xyz@formspree.io")).toBe("noreply@formspree.io");
  });

  it("strips +suffix AND lowercases", () => {
    expect(normalizeSenderAddress("Alice+work@Acme.CO")).toBe("alice@acme.co");
  });

  it("falls back to lowercase on malformed input (no @)", () => {
    expect(normalizeSenderAddress("not-an-email")).toBe("not-an-email");
  });
});

describe("extractTagTreeForHash", () => {
  it("yields the same canonical string for different attribute orders", () => {
    const a = '<input type="text" name="email" placeholder="email">';
    const b = '<input placeholder="email" name="email" type="text">';
    expect(extractTagTreeForHash(a)).toBe(extractTagTreeForHash(b));
  });

  it("yields the same canonical string for different attribute VALUES", () => {
    const a = '<input type="text" name="email">';
    const b = '<input type="text" name="phone">';
    expect(extractTagTreeForHash(a)).toBe(extractTagTreeForHash(b));
  });

  it("yields the same canonical string for different text content", () => {
    const a = "<div><p>Hello world</p></div>";
    const b = "<div><p>Goodbye Mars</p></div>";
    expect(extractTagTreeForHash(a)).toBe(extractTagTreeForHash(b));
  });

  it("distinguishes different tag inventories", () => {
    const a = "<div><p>x</p></div>";
    const b = "<div><span>x</span></div>";
    expect(extractTagTreeForHash(a)).not.toBe(extractTagTreeForHash(b));
  });

  it("lowercases tag names + attribute names", () => {
    const a = '<DIV class="x"><P>y</P></DIV>';
    const b = '<div CLASS="z"><p>q</p></div>';
    expect(extractTagTreeForHash(a)).toBe(extractTagTreeForHash(b));
  });

  it("strips comments, CDATA, and processing instructions", () => {
    const withComments =
      "<?xml version=\"1.0\"?><adf><!-- hi --><customer><![CDATA[Alice]]></customer></adf>";
    const without = "<adf><customer></customer></adf>";
    expect(extractTagTreeForHash(withComments)).toBe(extractTagTreeForHash(without));
  });

  it("ignores closing tags (tree shape captured by openings)", () => {
    const a = "<div><p>x</p></div>";
    const onlyOpenings = "<div><p>";
    expect(extractTagTreeForHash(a)).toBe(extractTagTreeForHash(onlyOpenings));
  });
});

describe("extractLabelTokens", () => {
  it("collapses duplicate labels", () => {
    const body = "Name: Alice\nName: Bob\nEmail: a@b.c";
    expect(extractLabelTokens(body)).toEqual(["Email", "Name"]);
  });

  it("sorts alphabetically (independent of source order)", () => {
    const a = "Email: a@b.c\nName: Alice\nPhone: 555";
    const b = "Phone: 555\nEmail: a@b.c\nName: Alice";
    expect(extractLabelTokens(a)).toEqual(extractLabelTokens(b));
  });

  it("ignores label values entirely (different values → same inventory)", () => {
    const a = "Name: Alice\nEmail: a@b.c";
    const b = "Name: Bob\nEmail: x@y.z";
    expect(extractLabelTokens(a)).toEqual(extractLabelTokens(b));
  });

  it("distinguishes different label inventories", () => {
    const a = "Name: Alice\nEmail: a@b.c";
    const b = "Name: Alice\nPhone: 555";
    expect(extractLabelTokens(a)).not.toEqual(extractLabelTokens(b));
  });

  it("preserves case-sensitivity (Name vs name capture per-form casing)", () => {
    const body = "Name: Alice\nname: bob";
    const labels = extractLabelTokens(body);
    expect(labels).toContain("Name");
    expect(labels).toContain("name");
  });

  it("returns empty array on body with no label patterns", () => {
    expect(extractLabelTokens("just a free-form message")).toEqual([]);
  });

  it("accepts hyphens and underscores in label names", () => {
    const body = "First-Name: Alice\nlast_name: B";
    const labels = extractLabelTokens(body);
    expect(labels).toContain("First-Name");
    expect(labels).toContain("last_name");
  });
});

describe("deriveParseFingerprint — per-format derivation", () => {
  it("html → structureHash populated; labelTokenHash null", () => {
    const fp = deriveParseFingerprint({
      format: "html",
      body: '<div><input type="text" name="email"></div>',
      fromAddress: "a@b.com",
    });
    expect(fp.structureHash).not.toBeNull();
    expect(fp.structureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.labelTokenHash).toBeNull();
    expect(fp.senderDomainHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("adf → structureHash populated; labelTokenHash null", () => {
    const fp = deriveParseFingerprint({
      format: "adf",
      body: "<?xml version=\"1.0\"?><adf><customer><name>Alice</name></customer></adf>",
      fromAddress: "a@b.com",
    });
    expect(fp.structureHash).not.toBeNull();
    expect(fp.labelTokenHash).toBeNull();
  });

  it("html-in-text → structureHash populated; labelTokenHash null", () => {
    const fp = deriveParseFingerprint({
      format: "html-in-text",
      body: '<html><body><p>hi</p></body></html>',
      fromAddress: "a@b.com",
    });
    expect(fp.structureHash).not.toBeNull();
    expect(fp.labelTokenHash).toBeNull();
  });

  it("plain-text → structureHash EQUALS labelTokenHash", () => {
    const fp = deriveParseFingerprint({
      format: "plain-text",
      body: "Name: Alice\nEmail: a@b.c",
      fromAddress: "a@b.com",
    });
    expect(fp.labelTokenHash).not.toBeNull();
    expect(fp.structureHash).toBe(fp.labelTokenHash);
  });

  it("unknown format → BOTH structureHash and labelTokenHash are null", () => {
    const fp = deriveParseFingerprint({
      format: "unknown",
      body: "",
      fromAddress: "a@b.com",
    });
    expect(fp.structureHash).toBeNull();
    expect(fp.labelTokenHash).toBeNull();
    // senderDomainHash is ALWAYS populated even on unknown format
    expect(fp.senderDomainHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("deriveParseFingerprint — dedup invariants", () => {
  it("same HTML structure with different values → same structureHash", () => {
    const a = deriveParseFingerprint({
      format: "html",
      body: '<div><input type="text" name="email" value="alice@a.com"></div>',
      fromAddress: "alice@a.com",
    });
    const b = deriveParseFingerprint({
      format: "html",
      body: '<div><input type="text" name="email" value="bob@b.com"></div>',
      fromAddress: "alice@a.com",
    });
    expect(a.structureHash).toBe(b.structureHash);
  });

  it("same sender domain with different +suffix → same senderDomainHash", () => {
    const a = deriveParseFingerprint({
      format: "plain-text",
      body: "Name: Alice",
      fromAddress: "noreply+abc@formspree.io",
    });
    const b = deriveParseFingerprint({
      format: "plain-text",
      body: "Name: Alice",
      fromAddress: "noreply+xyz@formspree.io",
    });
    expect(a.senderDomainHash).toBe(b.senderDomainHash);
  });

  it("different sender LOCAL parts (same domain) → DIFFERENT senderDomainHash", () => {
    const a = deriveParseFingerprint({
      format: "plain-text",
      body: "x",
      fromAddress: "alice@acme.co",
    });
    const b = deriveParseFingerprint({
      format: "plain-text",
      body: "x",
      fromAddress: "bob@acme.co",
    });
    expect(a.senderDomainHash).not.toBe(b.senderDomainHash);
  });
});

describe("deriveParseFingerprint — golden-hash regression locks", () => {
  // Lock the SHA256 outputs against algorithm drift. Changing the helper
  // such that these hashes shift would silently corrupt fingerprint
  // dedup across rolling deploys — these tests fail loudly first.

  it("golden: HTML structure hash", () => {
    const fp = deriveParseFingerprint({
      format: "html",
      body: '<div><p class="x">hi</p></div>',
      fromAddress: "x@y.com",
    });
    // sha256("div[]|p[class]")
    expect(fp.structureHash).toBe(
      "0b0fc21a7ea692a90c8e4db430f58a4826d1b0668759a56d76256d275f40737a",
    );
  });

  it("golden: plain-text label hash", () => {
    const fp = deriveParseFingerprint({
      format: "plain-text",
      body: "Name: Alice\nEmail: a@b.c",
      fromAddress: "x@y.com",
    });
    // sha256("Email|Name")
    expect(fp.labelTokenHash).toBe(
      "5cbff0c2181c589c31b2364080930d040a13c097130be0a3f56ac0321a0db080",
    );
  });

  it("golden: sender domain hash (with +suffix stripping)", () => {
    const fp = deriveParseFingerprint({
      format: "plain-text",
      body: "x",
      fromAddress: "Noreply+ABC@formspree.io",
    });
    // sha256("noreply@formspree.io")
    expect(fp.senderDomainHash).toBe(
      "091e136d1b40ecb56333f77624c0146da42d83daa3a9fa48b3dd570878415058",
    );
  });
});

describe("shouldAutoSuggest — KAN-1140 PR 8 auto-suggest predicate", () => {
  // Per Memo 37: this predicate is the cross-workspace single source of
  // truth between webhook hook + integration test + future KAN-1147 cron.
  // Tests lock the truth table; refactors that change semantics fail loud.

  it("pending + occurrenceCount >= 5 + formatConfidence='high' → true", () => {
    expect(
      shouldAutoSuggest({
        supportStatus: "pending",
        occurrenceCount: 5,
        formatConfidence: "high",
        reclassifyCount: 0,
      }),
    ).toBe(true);
  });

  it("pending + reclassifyCount >= 1 → true (operator-behavioral signal)", () => {
    expect(
      shouldAutoSuggest({
        supportStatus: "pending",
        occurrenceCount: 1,
        formatConfidence: "medium",
        reclassifyCount: 1,
      }),
    ).toBe(true);
  });

  it("pending + occurrenceCount < 5 + reclassifyCount = 0 → false (under threshold)", () => {
    expect(
      shouldAutoSuggest({
        supportStatus: "pending",
        occurrenceCount: 4,
        formatConfidence: "high",
        reclassifyCount: 0,
      }),
    ).toBe(false);
  });

  it("pending + occurrenceCount >= 5 + formatConfidence='medium' → false (low confidence)", () => {
    expect(
      shouldAutoSuggest({
        supportStatus: "pending",
        occurrenceCount: 100,
        formatConfidence: "medium",
        reclassifyCount: 0,
      }),
    ).toBe(false);
  });

  it("supported → false (predicate gates on === 'pending', Q-ADD-2 lock)", () => {
    expect(
      shouldAutoSuggest({
        supportStatus: "supported",
        occurrenceCount: 100,
        formatConfidence: "high",
        reclassifyCount: 10,
      }),
    ).toBe(false);
  });

  it("unsupported → false (defends against operator-rejected re-suggestion)", () => {
    expect(
      shouldAutoSuggest({
        supportStatus: "unsupported",
        occurrenceCount: 100,
        formatConfidence: "high",
        reclassifyCount: 10,
      }),
    ).toBe(false);
  });

  it("suggested → false (already in target state; no-op)", () => {
    expect(
      shouldAutoSuggest({
        supportStatus: "suggested",
        occurrenceCount: 100,
        formatConfidence: "high",
        reclassifyCount: 5,
      }),
    ).toBe(false);
  });
});
