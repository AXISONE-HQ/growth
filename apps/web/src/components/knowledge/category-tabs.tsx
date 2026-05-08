// PROMOTION CANDIDATE: lift into packages/ui in KAN-847 / KAN-842
// Used by: Knowledge Sources admin page (this cohort), reusable for any
//          underline-tab filter surface (Audit feed, Decision Feed, etc.)

/**
 * CategoryTabs — underline-tab filter for the Knowledge Sources admin list.
 *
 * Wraps shadcn `Tabs` (Radix `@radix-ui/react-tabs` underneath) with DS v1
 * foundation tokens to render the underline-tab pattern instead of shadcn's
 * default pill-style. Renders `TabsList` + `TabsTrigger` only — content
 * rendering stays with the consumer (SourceList owns the table; tabs only
 * drive its `categoryFilter` state).
 *
 * **Visual contract** (per the cohort brief):
 *   Container (TabsList): flex row, no background, no rounded; bottom border
 *     (`--ds-border-subtle`) anchors the underline; `overflow-x-auto` keeps
 *     narrow viewports usable.
 *   TabsTrigger inactive: `text-label` + `--ds-ink-tertiary`,
 *     `border-b-2 border-transparent` (placeholder slot keeps tab heights
 *     stable when active changes).
 *   Hover: `--ds-ink-secondary`.
 *   Active (Radix `data-state="active"`): `--ds-ink-primary` +
 *     `border-b-2 border-[var(--ds-violet-500)]`.
 *   Focus-visible: `ring-2 ring-violet-500 ring-offset-2` with
 *     `[--tw-ring-offset-color:var(--ds-ring-offset)]` + `rounded-sm` on the
 *     focus indicator only.
 *
 * **Accessibility (Radix-provided):**
 *   - `role="tablist"` on container; `role="tab"` + `aria-selected` on each trigger
 *   - Keyboard nav: ArrowLeft/ArrowRight + Home/End handled by Radix
 *   - `activationMode="automatic"` (Radix default) — arrow keys both move
 *     focus AND select, which matches the consumer expectation that filter
 *     selection follows focus
 *
 * **DS v1 compliance:**
 *   - Every color via `var(--ds-*)` — zero hex
 *   - `.text-label` (13/18 weight 500) — within the two-weight rule
 *   - `.motion-default` for color/border transitions
 *   - `prefers-reduced-motion` honored at the CSS layer (motion-default
 *     class + Tailwind transition-* utilities both respect the media query)
 */
"use client";

import * as React from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface CategoryTab {
  /** Tab value passed to onCategoryChange. Use `'all'` for the "no filter" state. */
  value: string;
  /** User-facing label (sentence case). */
  label: string;
}

interface CategoryTabsProps {
  categories: CategoryTab[];
  /** Currently selected tab value. Use `'all'` for the unfiltered state. */
  selectedCategory: string;
  onCategoryChange: (category: string) => void;
  /** Optional aria-label override; default labels the tablist as a category filter. */
  ariaLabel?: string;
  className?: string;
}

export function CategoryTabs({
  categories,
  selectedCategory,
  onCategoryChange,
  ariaLabel = "Filter sources by category",
  className,
}: CategoryTabsProps): React.ReactElement {
  return (
    <Tabs
      value={selectedCategory}
      onValueChange={onCategoryChange}
      className={className}
    >
      {/* shadcn TabsList defaults to a pill container with bg-muted + rounded.
       * Override to underline-row pattern: bottom border anchors the active
       * indicator, no background, no rounded. */}
      <TabsList
        aria-label={ariaLabel}
        className="flex flex-row items-stretch gap-1 h-auto p-0 rounded-none bg-transparent overflow-x-auto"
        style={{ borderBottom: "1px solid var(--ds-border-subtle)" }}
      >
        {categories.map((cat) => (
          <TabsTrigger
            key={cat.value}
            value={cat.value}
            className={[
              // Reset shadcn defaults that conflict with the underline pattern
              "rounded-none shadow-none bg-transparent",
              // Layout + foundation type scale
              "px-4 py-2.5 text-label whitespace-nowrap",
              // Underline placeholder slot (transparent on inactive — keeps
              // height stable when activation changes)
              "border-b-2 border-transparent",
              // Active state per Radix data-state
              "data-[state=active]:border-[color:var(--ds-violet-500)]",
              // Motion via foundation token
              "motion-default",
              // Focus-visible ring per spec Part 6
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
              "[--tw-ring-color:var(--ds-violet-500)] [--tw-ring-offset-color:var(--ds-ring-offset)]",
              "focus-visible:rounded-sm",
            ].join(" ")}
            // Inactive color via inline style so it doesn't fight Tailwind's
            // text-* utilities; Radix data-state attribute drives the active
            // override below.
            style={
              cat.value === selectedCategory
                ? { color: "var(--ds-ink-primary)" }
                : { color: "var(--ds-ink-tertiary)" }
            }
          >
            {cat.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
