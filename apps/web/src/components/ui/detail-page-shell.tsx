/**
 * KAN-983 Phase B.6 — DetailPageShell.
 *
 * Shared shell for the 4 entity detail pages (/customers/[id],
 * /companies/[id], /orders/[id], /opportunities/[id]). Replaces the
 * per-page inline `SECTION_HEADER_STYLE` / `LABEL_STYLE` / `MUTED_STYLE`
 * constants that the audit found duplicated across each detail page.
 *
 * Anatomy per prototype:
 *   - Back link (← Back to {parent}) above the header
 *   - .dhead: 48×48 violet-tinted logo square (initials or icon) +
 *     h1 title (.text-h2 per DS v1 type scale) + optional metric strip
 *     slot (renders to the right of the title row when present)
 *   - .dgrid: 2-col responsive grid (1.4fr main + 1fr side), gap-4
 *   - <FieldRow label value /> primitive: label-muted + value-right-aligned
 *     with hairline border-top (border-top removed on first child)
 *   - <LinkedEntityRow icon name meta /> primitive: clickable row with
 *     icon avatar + name + meta line + hover state
 *
 * Slot pattern — pages pass mainSlot + sideSlot React nodes. Inside each
 * slot, pages can compose <Card>, <FieldRow>, <LinkedEntityRow>, etc.
 * The shell doesn't dictate layout INSIDE the slots — just the outer
 * frame + the field-row + linked-row primitives.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DetailPageShellProps {
  /** Optional href for the back link (e.g., /customers). */
  backHref?: string;
  backLabel?: string;
  title: string;
  /** Logo mark — string initials (rendered in the violet-tinted square)
   *  OR a Lucide icon component. */
  logoMark: string | LucideIcon;
  /** Subtitle line rendered under the title (e.g., "Deal ID: cmp...",
   *  "Placed 9/30/2026"). Optional. */
  subtitle?: React.ReactNode;
  /** Status badge slot — renders inline to the right of the title row.
   *  KAN-989 C.5 — added so the 4 detail pages can surface their
   *  entity-specific status (deal-status / order-status / contact-lifecycle
   *  / company-lifecycle) without going through metricStrip. */
  headerBadge?: React.ReactNode;
  /** Primary action slot on the far right (e.g., Edit button). KAN-989
   *  C.5 — rendered alongside metricStrip when both are present. */
  headerAction?: React.ReactNode;
  /** Slot for a metric strip on the right of the header. */
  metricStrip?: React.ReactNode;
  /** Main column (1.4fr). Caller composes Cards + FieldRows + sections. */
  mainSlot: React.ReactNode;
  /** Side column (1fr). Caller composes Cards (linked-entity lists, etc.). */
  sideSlot: React.ReactNode;
  className?: string;
}

export function DetailPageShell({
  backHref,
  backLabel = "Back",
  title,
  logoMark,
  subtitle,
  headerBadge,
  headerAction,
  metricStrip,
  mainSlot,
  sideSlot,
  className,
}: DetailPageShellProps) {
  const isIconLogo = typeof logoMark !== "string";
  const LogoIcon = isIconLogo ? logoMark : null;
  const logoInitials = isIconLogo ? null : logoMark;
  const hasRightCluster = metricStrip || headerAction;
  return (
    <div className={cn("mx-auto max-w-6xl px-6 py-8", className)}>
      {backHref ? (
        <Link
          href={backHref}
          className="text-label mb-3.5 inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          {backLabel}
        </Link>
      ) : null}

      <header className="mb-4 flex items-start justify-between gap-3.5">
        <div className="flex min-w-0 items-center gap-3.5">
          <div
            aria-hidden="true"
            className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-[13px] bg-[var(--ds-violet-100)] text-[15px] font-semibold text-[var(--ds-violet-500)]"
          >
            {LogoIcon ? <LogoIcon className="h-5 w-5" /> : logoInitials}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-h2 text-foreground">{title}</h1>
              {headerBadge ? <div className="flex-shrink-0">{headerBadge}</div> : null}
            </div>
            {subtitle ? (
              <div className="mt-0.5 text-caption text-muted-foreground">{subtitle}</div>
            ) : null}
          </div>
        </div>
        {hasRightCluster ? (
          <div className="flex flex-shrink-0 items-center gap-3">
            {metricStrip}
            {headerAction}
          </div>
        ) : null}
      </header>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0">{mainSlot}</div>
        <div className="min-w-0">{sideSlot}</div>
      </div>
    </div>
  );
}

/**
 * KAN-983 — FieldRow primitive for detail page field lists.
 *
 * Per prototype `.field`:
 *   - flex row with label LEFT (muted) + value RIGHT (foreground, weight 500)
 *   - hairline border-top, removed on first child
 *   - vertical padding 9px
 *
 * Use inside a Card: <Card>...<FieldRow label value />...</Card>. The
 * `:first-child` rule handles border placement; callers don't need to
 * manage borders per row.
 */
export interface FieldRowProps {
  label: string;
  value: React.ReactNode;
  className?: string;
}

export function FieldRow({ label, value, className }: FieldRowProps) {
  return (
    <div
      className={cn(
        "flex justify-between gap-3.5 border-t border-border py-[9px] text-body first:border-t-0",
        className,
      )}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

/**
 * KAN-989 — SectionCard primitive for detail-page section blocks.
 *
 * Wraps a Card with a consistent header row: title + optional count
 * pill ("(5)") on the left, optional headerRight slot. Matches the
 * pattern that the 4 detail pages used to duplicate inline.
 *
 * Use inside DetailPageShell mainSlot / sideSlot. Card uses B.1
 * tokens (rounded-card, hairline border, --ds-shadow-card).
 */
export interface SectionCardProps {
  title: string;
  /** Renders as `({count})` next to the title in muted weight. */
  count?: number;
  headerRight?: React.ReactNode;
  /** Card body. */
  children: React.ReactNode;
  className?: string;
}

export function SectionCard({
  title,
  count,
  headerRight,
  children,
  className,
}: SectionCardProps) {
  return (
    <div
      className={cn(
        "rounded-[var(--ds-radius-card)] border border-border bg-card p-5 shadow-[var(--ds-shadow-card)]",
        className,
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-h3 text-foreground">
          {title}
          {count !== undefined ? (
            <span className="ml-1.5 text-muted-foreground" style={{ fontWeight: 400 }}>
              ({count})
            </span>
          ) : null}
        </h2>
        {headerRight ? <div className="flex-shrink-0">{headerRight}</div> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * KAN-983 — LinkedEntityRow primitive for detail-page side-column lists
 * (linked deals / orders / engagements / etc.).
 *
 * Per prototype `.relrow`:
 *   - icon avatar (rounded square, violet-tinted) + name + meta
 *   - hairline border-top, removed on first child
 *   - cursor-pointer when href is present; hover lifts name to violet
 *
 * Click target wraps the row when `href` is supplied; otherwise a plain
 * div (for non-clickable rows).
 */
export interface LinkedEntityRowProps {
  icon?: LucideIcon;
  iconLabel?: string;
  name: string;
  meta?: React.ReactNode;
  href?: string;
  onClick?: () => void;
  className?: string;
}

export function LinkedEntityRow({
  icon: Icon,
  iconLabel,
  name,
  meta,
  href,
  onClick,
  className,
}: LinkedEntityRowProps) {
  const inner = (
    <>
      <div
        aria-hidden="true"
        className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--ds-violet-100)] text-xs font-semibold text-[var(--ds-violet-500)]"
      >
        {Icon ? <Icon className="h-4 w-4" /> : iconLabel}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-medium text-foreground transition-colors group-hover:text-[var(--ds-violet-500)]">
          {name}
        </div>
        {meta ? <div className="text-caption text-muted-foreground">{meta}</div> : null}
      </div>
    </>
  );

  const baseClass = cn(
    "group flex items-center gap-[11px] border-t border-border py-2.5 first:border-t-0",
    (href || onClick) && "cursor-pointer",
    className,
  );

  if (href) {
    return (
      <Link href={href} className={baseClass}>
        {inner}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cn(baseClass, "w-full text-left")}>
        {inner}
      </button>
    );
  }
  return <div className={baseClass}>{inner}</div>;
}
