"use client";

/**
 * KAN-855 — Account Page Cohort 2. Tab navigation as Link bar.
 *
 * Pure Next.js Link rendering with active-state styling driven by the
 * current pathname. Bypasses the Radix Tabs primitive because Cohort 2
 * needs URL-driven navigation (refresh on /identity stays on /identity;
 * tabs deeplink) — Radix Tabs is for controlled-value tab state, not
 * routing. Same visual treatment as components/knowledge/category-tabs.
 */
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface AccountTab {
  href: string;
  label: string;
}

const TABS: readonly AccountTab[] = [
  { href: "/settings/account/identity", label: "Identity" },
  { href: "/settings/account/contact", label: "Contact" },
  { href: "/settings/account/hours", label: "Hours" },
  { href: "/settings/account/payments", label: "Payments" },
  { href: "/settings/account/legal", label: "Legal" },
];

export function AccountTabs(): React.ReactElement {
  const pathname = usePathname() ?? "";
  return (
    <nav
      role="tablist"
      aria-label="Account settings tabs"
      className="flex flex-row items-stretch gap-1 overflow-x-auto"
      style={{ borderBottom: "1px solid var(--ds-border-subtle)" }}
    >
      {TABS.map((tab) => {
        const isActive = pathname === tab.href || pathname.startsWith(tab.href + "/");
        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={isActive}
            aria-current={isActive ? "page" : undefined}
            className={[
              "px-4 py-2.5 text-sm font-medium whitespace-nowrap motion-default",
              "border-b-2 -mb-px",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:rounded-sm",
              "[--tw-ring-color:var(--ds-violet-500)] [--tw-ring-offset-color:var(--ds-ring-offset)]",
              isActive ? "border-[color:var(--ds-violet-500)]" : "border-transparent",
            ].join(" ")}
            style={{
              color: isActive ? "var(--ds-ink-primary)" : "var(--ds-ink-tertiary)",
            }}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
