/**
 * KAN-857 — TimezoneSelect filtering + grouping.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

import { TimezoneSelect, _getTimezoneOptionsForTest } from "../timezone-select";

describe("TimezoneSelect — IANA filtering (Decision 5)", () => {
  it("filters to canonical city-format zones (rejects Etc/GMT/UCT/POSIX)", () => {
    const zones = _getTimezoneOptionsForTest();
    expect(zones.length).toBeGreaterThan(100);
    const values = zones.map((z) => z.value);
    expect(values.some((v) => v.startsWith("Etc/"))).toBe(false);
    expect(values.some((v) => v.startsWith("GMT/"))).toBe(false);
    expect(values.some((v) => v.startsWith("US/"))).toBe(false);
    expect(values.some((v) => v.startsWith("Canada/"))).toBe(false);
    expect(values).toContain("America/Toronto");
    expect(values).toContain("Europe/Paris");
    expect(values).toContain("Asia/Tokyo");
  });

  it("display label is 'City, Continent' (typeahead-friendly)", () => {
    const zones = _getTimezoneOptionsForTest();
    const toronto = zones.find((z) => z.value === "America/Toronto");
    expect(toronto?.label).toBe("Toronto, America");
  });

  it("renders <optgroup> per continent + <option> per zone", () => {
    render(
      <TimezoneSelect id="tz" value="America/Toronto" onChange={() => undefined} />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("America/Toronto");
    // At least 4 continents (America, Europe, Asia, Africa)
    const groups = select.querySelectorAll("optgroup");
    expect(groups.length).toBeGreaterThanOrEqual(4);
  });
});
