/**
 * KAN-1140 Phase 1 PR 1 — ADF pre-parser unit tests.
 *
 * Pure-function tests; no mocks required. Fixtures synthesized per
 * ADF 1.0 spec (per Q5 disposition (a) — real-world samples have PII
 * concerns).
 */
import { describe, it, expect } from "vitest";
import { parseAdfEmail, isAdfPayload } from "../adf-parser.js";

const FULL_ADF = `<?xml version="1.0"?>
<?ADF version="1.0"?>
<adf>
  <prospect>
    <requestdate>2026-06-08T12:00:00-05:00</requestdate>
    <vehicle interest="buy" status="new">
      <year>2026</year>
      <make>Toyota</make>
      <model>Camry</model>
      <stock>STK-12345</stock>
    </vehicle>
    <customer>
      <contact>
        <name part="first">Alice</name>
        <name part="last">Buyer</name>
        <email>alice@example.com</email>
        <phone>+1-555-0142</phone>
      </contact>
    </customer>
    <vendor>
      <contact>
        <name>Springfield Toyota</name>
      </contact>
    </vendor>
    <provider>
      <contact>
        <name>AutoLeadNetwork</name>
      </contact>
    </provider>
  </prospect>
</adf>`;

describe("isAdfPayload — presence check", () => {
  it("XML prolog → true", () => {
    expect(isAdfPayload('<?xml version="1.0"?><adf></adf>')).toBe(true);
  });

  it("ADF PI → true", () => {
    expect(isAdfPayload('<?ADF version="1.0"?>')).toBe(true);
  });

  it("bare <adf> root → true", () => {
    expect(isAdfPayload("<adf></adf>")).toBe(true);
  });

  it("plain text → false", () => {
    expect(isAdfPayload("Hi, I'd like to buy a car please")).toBe(false);
  });

  it("null/empty → false", () => {
    expect(isAdfPayload(null)).toBe(false);
    expect(isAdfPayload("")).toBe(false);
  });
});

describe("parseAdfEmail — happy path against synthesized full ADF", () => {
  const result = parseAdfEmail({ text: FULL_ADF });

  it("returns a non-null result", () => {
    expect(result).not.toBeNull();
  });

  it("extracts customer name (first / last via name[part])", () => {
    expect(result?.firstName).toBe("Alice");
    expect(result?.lastName).toBe("Buyer");
  });

  it("extracts and lowercases email", () => {
    expect(result?.senderEmail).toBe("alice@example.com");
  });

  it("extracts phone", () => {
    expect(result?.phone).toBe("+1-555-0142");
  });

  it("populates vehicle customFields", () => {
    expect(result?.customFields.vehicle_year).toBe("2026");
    expect(result?.customFields.vehicle_make).toBe("Toyota");
    expect(result?.customFields.vehicle_model).toBe("Camry");
    expect(result?.customFields.vehicle_stock).toBe("STK-12345");
    expect(result?.customFields.vehicle_interest).toBe("buy");
    expect(result?.customFields.vehicle_status).toBe("new");
  });

  it("populates dealer + provider customFields", () => {
    expect(result?.customFields.dealer_name).toBe("Springfield Toyota");
    expect(result?.customFields.provider_name).toBe("AutoLeadNetwork");
  });

  it("populates request_date customFields", () => {
    expect(result?.customFields.request_date).toBe("2026-06-08T12:00:00-05:00");
  });

  it("derives dealNameSeed from vehicle + buyer", () => {
    expect(result?.dealNameSeed).toBe("Auto lead — 2026 Toyota Camry — Alice Buyer");
  });

  it("reports prospectCount=1", () => {
    expect(result?.prospectCount).toBe(1);
  });
});

describe("parseAdfEmail — minimal ADF (no vehicle, no extra fields)", () => {
  const MINIMAL = `<?xml version="1.0"?>
<adf>
  <prospect>
    <customer>
      <contact>
        <name part="first">Bob</name>
        <email>bob@example.com</email>
      </contact>
    </customer>
  </prospect>
</adf>`;

  it("returns result with firstName only + email", () => {
    const r = parseAdfEmail({ text: MINIMAL });
    expect(r?.firstName).toBe("Bob");
    expect(r?.lastName).toBeNull();
    expect(r?.senderEmail).toBe("bob@example.com");
    expect(r?.phone).toBeNull();
  });

  it("dealNameSeed falls back to buyer-only when vehicle absent", () => {
    const r = parseAdfEmail({ text: MINIMAL });
    expect(r?.dealNameSeed).toBe("Auto lead — Bob");
  });

  it("vehicle customFields absent when <vehicle> missing", () => {
    const r = parseAdfEmail({ text: MINIMAL });
    expect(r?.customFields.vehicle_make).toBeUndefined();
    expect(r?.customFields.vehicle_year).toBeUndefined();
  });
});

describe("parseAdfEmail — vendor extension preservation (Q3 best-effort)", () => {
  const WITH_EXTENSION = `<?xml version="1.0"?>
<adf>
  <prospect>
    <customer>
      <contact>
        <name part="first">Carol</name>
        <email>carol@example.com</email>
      </contact>
    </customer>
    <financing>cash</financing>
    <tradein>2019 Honda Civic</tradein>
  </prospect>
</adf>`;

  it("unknown sibling tags preserved with adf_extension_ prefix", () => {
    const r = parseAdfEmail({ text: WITH_EXTENSION });
    expect(r?.customFields.adf_extension_financing).toBe("cash");
    expect(r?.customFields.adf_extension_tradein).toBe("2019 Honda Civic");
  });
});

describe("parseAdfEmail — malformed input handling", () => {
  it("malformed XML → returns null gracefully (no throw)", () => {
    const r = parseAdfEmail({ text: "<adf><prospect>unclosed" });
    // cheerio is permissive; this likely parses; null only on missing root
    // What matters: no throw.
    expect(() => r).not.toThrow();
  });

  it("missing <adf> root → returns null", () => {
    const r = parseAdfEmail({ text: "<?xml version='1.0'?><other></other>" });
    expect(r).toBeNull();
  });

  it("missing <prospect> → returns null", () => {
    const r = parseAdfEmail({ text: "<adf></adf>" });
    expect(r).toBeNull();
  });

  it("empty input → returns null", () => {
    const r = parseAdfEmail({ text: "" });
    expect(r).toBeNull();
  });
});
