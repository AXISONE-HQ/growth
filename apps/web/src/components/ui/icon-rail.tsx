/**
 * KAN-978 Phase B.3 — IconRail.
 *
 * Replaces the prior 240px BLACK sidebar at apps/web/src/app/layout.tsx
 * (was lines 195-293) with the slim 72px WHITE icon-only rail per the
 * prototype's `.rail` + `.rbtn` pattern.
 *
 * Anatomy:
 *   - 72px wide (w-18 ≈ Tailwind w-[72px])
 *   - White surface (bg-card)
 *   - Hairline border-right (border-border = #ECEDF3 via Phase A)
 *   - Sticky top-16 (sits below the TopNav's h-16/4rem)
 *   - Icon buttons: 44×44 rounded-[var(--ds-radius-icon)] (~13px)
 *   - Hover: light surface bg (accent token); icon shifts to ink
 *   - Active: [background-image:var(--ds-accent-gradient)] + white icon
 *   - Settings pinned at the bottom via flex spacer (prototype's .spacer)
 *
 * Labels:
 *   - Icon-only loses inline label; each button carries `title` (native
 *     tooltip) + `aria-label` (screen reader). Notifications and a tooltip
 *     primitive would be ideal but Radix Tooltip isn't installed yet —
 *     defer to a later phase.
 *
 * Notifications:
 *   - Bell stays in TopNav for now (no /notifications backing surface).
 *     Adding it to the IconRail bottom is a later phase concern alongside
 *     the notifications dropdown panel.
 */
"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface IconRailItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
  /** Pin this item to the bottom of the rail (Settings pattern). */
  pinBottom?: boolean;
}

export interface IconRailProps {
  items: IconRailItem[];
  /** Resolved active href via the parent's longest-prefix-wins helper. */
  activeHref: string | null;
  className?: string;
}

export function IconRail({ items, activeHref, className }: IconRailProps) {
  const topItems = items.filter((item) => !item.pinBottom);
  const bottomItems = items.filter((item) => item.pinBottom);

  return (
    <aside
      role="navigation"
      aria-label="Primary"
      className={cn(
        "sticky top-16 flex h-[calc(100vh-4rem)] w-[72px] flex-shrink-0 flex-col items-center gap-2 border-r border-border bg-card py-4",
        className,
      )}
    >
      {topItems.map((item) => (
        <IconRailButton key={item.href} item={item} active={activeHref === item.href} />
      ))}

      {/* Spacer pushes pinned-bottom items (Settings) to the bottom */}
      <div className="mt-auto" />

      {bottomItems.map((item) => (
        <IconRailButton key={item.href} item={item} active={activeHref === item.href} />
      ))}
    </aside>
  );
}

function IconRailButton({ item, active }: { item: IconRailItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={item.label}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-11 w-11 items-center justify-center rounded-[var(--ds-radius-icon)] transition-colors",
        active
          ? "[background-image:var(--ds-accent-gradient)] text-white"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Icon className="h-[21px] w-[21px]" />
      {item.badge ? (
        <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-white">
          {item.badge}
        </span>
      ) : null}
    </Link>
  );
}
