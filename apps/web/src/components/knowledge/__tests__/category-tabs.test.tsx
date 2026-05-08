/**
 * CategoryTabs tests — chips → underline tabs cohort.
 *
 * Covers:
 *   1. Renders all provided categories as tabs (role="tab")
 *   2. Active tab has aria-selected="true"; others have aria-selected="false"
 *   3. Click on inactive tab calls onCategoryChange with that tab's value
 *   4. Keyboard navigation (ArrowRight) moves selection (Radix handles arrow
 *      nav with activationMode="automatic" — selection follows focus)
 *   5. Foundation token coverage (no hex strings in className or inline style)
 *   6. Focus-visible state classes are applied (ring-2 + violet-500 ring color)
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CategoryTabs } from "../category-tabs";

const SAMPLE_CATEGORIES = [
  { value: "all", label: "All" },
  { value: "faq", label: "FAQ" },
  { value: "inventory", label: "Inventory" },
  { value: "warranty", label: "Warranty" },
  { value: "pricing", label: "Pricing" },
  { value: "other", label: "Other" },
];

describe("CategoryTabs — chips → tabs cohort", () => {
  it("Test 1 — renders all provided categories as tabs", () => {
    render(
      <CategoryTabs
        categories={SAMPLE_CATEGORIES}
        selectedCategory="all"
        onCategoryChange={() => {}}
      />,
    );
    const tablist = screen.getByRole("tablist", { name: "Filter sources by category" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs).toHaveLength(6);
    for (const cat of SAMPLE_CATEGORIES) {
      expect(within(tablist).getByRole("tab", { name: cat.label })).toBeInTheDocument();
    }
  });

  it("Test 2 — active tab has aria-selected='true'; others have aria-selected='false'", () => {
    render(
      <CategoryTabs
        categories={SAMPLE_CATEGORIES}
        selectedCategory="warranty"
        onCategoryChange={() => {}}
      />,
    );
    const warrantyTab = screen.getByRole("tab", { name: "Warranty", selected: true });
    expect(warrantyTab).toBeInTheDocument();
    expect(warrantyTab.getAttribute("data-state")).toBe("active");

    const allTab = screen.getByRole("tab", { name: "All", selected: false });
    expect(allTab).toBeInTheDocument();
    expect(allTab.getAttribute("data-state")).toBe("inactive");
  });

  it("Test 3 — click on inactive tab fires onCategoryChange with that tab's value", async () => {
    const user = userEvent.setup();
    const onCategoryChange = vi.fn();
    render(
      <CategoryTabs
        categories={SAMPLE_CATEGORIES}
        selectedCategory="all"
        onCategoryChange={onCategoryChange}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "FAQ" }));
    // Radix in activationMode="automatic" may fire onValueChange on both
    // focus + click for a single user action — pin the value, not the count.
    expect(onCategoryChange).toHaveBeenCalledWith("faq");
  });

  it("Test 4 — keyboard ArrowRight moves selection (Radix activationMode=automatic)", async () => {
    const user = userEvent.setup();
    const onCategoryChange = vi.fn();
    render(
      <CategoryTabs
        categories={SAMPLE_CATEGORIES}
        selectedCategory="all"
        onCategoryChange={onCategoryChange}
      />,
    );
    const allTab = screen.getByRole("tab", { name: "All" });
    allTab.focus();
    expect(document.activeElement).toBe(allTab);

    // ArrowRight moves to FAQ + activates it (automatic mode)
    await user.keyboard("{ArrowRight}");
    expect(onCategoryChange).toHaveBeenCalledWith("faq");
  });

  it("Test 5 — foundation token coverage: zero hardcoded hex in className or inline style", () => {
    const { container } = render(
      <CategoryTabs
        categories={SAMPLE_CATEGORIES}
        selectedCategory="faq"
        onCategoryChange={() => {}}
      />,
    );
    const html = container.innerHTML;
    const hexMatches = html.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(
      hexMatches,
      `Hardcoded hex colors leaked: ${hexMatches.join(", ")}`,
    ).toEqual([]);
  });

  it("Test 6 — focus-visible ring classes attached to every tab (per spec Part 6)", () => {
    render(
      <CategoryTabs
        categories={SAMPLE_CATEGORIES}
        selectedCategory="all"
        onCategoryChange={() => {}}
      />,
    );
    const tabs = screen.getAllByRole("tab");
    for (const tab of tabs) {
      const cls = tab.className;
      expect(cls).toMatch(/focus-visible:ring-2/);
      expect(cls).toMatch(/focus-visible:ring-offset-2/);
      // Ring color + offset color via DS foundation tokens
      expect(cls).toMatch(/--tw-ring-color:var\(--ds-violet-500\)/);
      expect(cls).toMatch(/--tw-ring-offset-color:var\(--ds-ring-offset\)/);
    }
  });
});
