/**
 * KAN-884 — AddressBlock + isAddressEmpty tests.
 *
 * Coverage:
 *   - Renders full address with all fields populated
 *   - Skips blank lines (no empty rows)
 *   - Returns null when every field is blank/nullish (parent decides
 *     between "No address on file" placeholder and hiding the card)
 *   - isAddressEmpty correctly detects empty vs partially populated
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { AddressBlock, isAddressEmpty } from "../address-block";

describe("KAN-884 — AddressBlock render", () => {
  it("renders full address — 4 lines (street, line2, city/region/postal, country)", () => {
    const { container } = render(
      <AddressBlock
        addressLine1="100 Main St"
        addressLine2="Suite 200"
        city="Toronto"
        region="ON"
        postalCode="M5V 1A1"
        country="Canada"
      />,
    );
    // Inner address div is the firstElementChild of the test container.
    // Its direct children are the rendered <div> lines.
    const addressDiv = container.firstElementChild;
    expect(addressDiv).not.toBeNull();
    const lines = Array.from(addressDiv!.children);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toHaveTextContent("100 Main St");
    expect(lines[1]).toHaveTextContent("Suite 200");
    expect(lines[2]).toHaveTextContent("Toronto, ON, M5V 1A1");
    expect(lines[3]).toHaveTextContent("Canada");
  });

  it("skips blank lines — partial address renders without empty rows", () => {
    const { container } = render(
      <AddressBlock
        addressLine1="100 Main St"
        addressLine2={null}
        city="Toronto"
        region={null}
        postalCode={null}
        country="Canada"
      />,
    );
    // Only 3 lines: street, "Toronto" (city only, no region/postal), country
    const lines = Array.from(container.firstElementChild!.children);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveTextContent("100 Main St");
    expect(lines[1]).toHaveTextContent("Toronto");
    expect(lines[2]).toHaveTextContent("Canada");
  });

  it("returns null when every field is null/blank — parent decides empty-state copy", () => {
    const { container } = render(
      <AddressBlock
        addressLine1={null}
        addressLine2={null}
        city={null}
        region={null}
        postalCode={null}
        country={null}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("KAN-884 — isAddressEmpty", () => {
  it("true when all fields are nullish", () => {
    expect(
      isAddressEmpty({
        addressLine1: null,
        city: null,
        region: null,
        postalCode: null,
        country: null,
      }),
    ).toBe(true);
  });

  it("false when ANY field has content", () => {
    expect(isAddressEmpty({ addressLine1: "1 Main St" })).toBe(false);
    expect(isAddressEmpty({ country: "Canada" })).toBe(false);
    expect(isAddressEmpty({ city: "Toronto" })).toBe(false);
  });

  it("treats undefined the same as null", () => {
    expect(isAddressEmpty({})).toBe(true);
  });
});
