// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Knowledge Sources list/detail (KAN-829), future Sprint 12+ surfaces

/**
 * CategoryBadge — visual classification for a knowledge source's category.
 *
 * Maps 5 categories to Growth Design System v1 token treatments per the
 * KAN-829 sub-cohort 3 spec (mirrors StatusPill discipline). Color is
 * never the only signal — every badge pairs with the category text label
 * (sentence case per DS v1 microcopy rules).
 *
 * Token mapping:
 *   faq        → ds-violet (knowledge / instructional content)
 *   inventory  → ds-emerald (operational / catalog)
 *   warranty   → ds-surface-sunken / ink-secondary (neutral / policy)
 *   pricing    → ds-warning (commercial-attention)
 *   general    → ds-surface-base / ink-tertiary (low-emphasis fallback)
 *   other      → same as general
 *
 * Accessibility: role="img" + aria-label="{category} category" so screen
 * readers announce the classification. Text label rendered visually for
 * sighted users.
 */
import * as React from "react";

export type Category = "faq" | "inventory" | "warranty" | "pricing" | "general" | "other";

interface CategoryBadgeProps {
  category: Category;
  className?: string;
}

interface CategoryStyles {
  background: string;
  text: string;
  border: string;
  label: string;
}

const CATEGORY_STYLES: Record<Category, CategoryStyles> = {
  faq: {
    background: "var(--ds-violet-100)",
    text: "var(--ds-violet-700)",
    border: "color-mix(in srgb, var(--ds-violet-500) 30%, transparent)",
    label: "FAQ",
  },
  inventory: {
    background: "var(--ds-emerald-100)",
    text: "var(--ds-emerald-700)",
    border: "color-mix(in srgb, var(--ds-emerald-500) 30%, transparent)",
    label: "Inventory",
  },
  warranty: {
    background: "var(--ds-surface-sunken)",
    text: "var(--ds-ink-secondary)",
    border: "var(--ds-border-default)",
    label: "Warranty",
  },
  pricing: {
    background: "var(--ds-warning-soft)",
    text: "var(--ds-warning-text)",
    border: "color-mix(in srgb, var(--ds-warning) 30%, transparent)",
    label: "Pricing",
  },
  general: {
    background: "var(--ds-surface-base)",
    text: "var(--ds-ink-tertiary)",
    border: "var(--ds-border-subtle)",
    label: "General",
  },
  other: {
    background: "var(--ds-surface-base)",
    text: "var(--ds-ink-tertiary)",
    border: "var(--ds-border-subtle)",
    label: "Other",
  },
};

export function CategoryBadge({ category, className }: CategoryBadgeProps): React.ReactElement {
  const styles = CATEGORY_STYLES[category];
  return (
    <span
      role="img"
      aria-label={`${styles.label} category`}
      data-category={category}
      className={[
        "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium leading-none border",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        backgroundColor: styles.background,
        color: styles.text,
        borderColor: styles.border,
      }}
    >
      {styles.label}
    </span>
  );
}
