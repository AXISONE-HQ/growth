/**
 * KAN-977 Phase B.2 — TopNav.
 * KAN-978 Phase B.3 — brand mark + account menu added to LEFT and RIGHT
 * (migrated from the prior sidebar's logo and user-footer).
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ ▣ growth  |  Page title · AI status     [search]    [Bell] [account ⌄] │
 *   └──────────────────────────────────────────────────────────────────┘
 *      brand              wayfinding              search    bell    account
 *
 * Brand mark = 32×32 gradient rounded square (radius 9px) + "growth"
 * wordmark. The wordmark uses the Phase A ink color. Sticky top-0,
 * bg-card, hairline border-bottom, h-16.
 *
 * Account dropdown is the new AccountMenu component. Bell stays in
 * TopNav for now — no /notifications backing surface yet; moving to the
 * IconRail bottom is a later phase.
 */
"use client";

import { Activity, Search, Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { AIStatusIndicator } from "@/components/growth/ai-status-indicator";
import { AccountMenu, type AccountMenuUser } from "@/components/ui/account-menu";

export interface TopNavProps {
  /** Resolved page title (from layout.tsx's longest-prefix pageTitle map). */
  title: string;
  user: AccountMenuUser;
  onSignOut: () => void | Promise<void>;
  className?: string;
}

export function TopNav({ title, user, onSignOut, className }: TopNavProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-40 flex h-16 items-center justify-between border-b border-border bg-card px-6",
        className,
      )}
    >
      {/* LEFT: brand + page title + AI status */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-[9px] [background-image:var(--ds-accent-gradient)]"
          >
            <Activity className="h-[18px] w-[18px] text-white" />
          </div>
          <span className="text-[17px] font-semibold tracking-tight text-foreground">
            growth
          </span>
        </div>
        <div className="h-6 w-px bg-border" aria-hidden="true" />
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">{title}</h1>
          {/* AIStatusIndicator status hardcoded "active" until system-health backend wires up
           * (deferred follow-up alongside Decision Feed surface, Sprint 12+). */}
          <AIStatusIndicator status="active" />
        </div>
      </div>

      {/* RIGHT: search + bell + account */}
      <div className="flex items-center gap-3">
        <div className="hidden w-[280px] md:block">
          <div className="flex items-center gap-2 rounded-[var(--ds-radius-pill)] border border-border bg-[var(--ds-surface-sunken)] px-3.5 py-2 transition-all focus-within:border-ring focus-within:bg-card focus-within:ring-[3px] focus-within:ring-ring/10">
            <Search className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search contacts, decisions…"
              className="w-full border-none bg-transparent text-sm font-[inherit] text-foreground outline-none placeholder:text-muted-foreground"
            />
            <span className="flex-shrink-0 rounded border border-border px-1.5 py-[1px] text-[11px] text-muted-foreground">
              ⌘K
            </span>
          </div>
        </div>

        <button
          type="button"
          aria-label="Notifications"
          className="relative rounded-[var(--ds-radius-icon)] p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Bell className="h-5 w-5" />
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-destructive" />
        </button>

        <AccountMenu user={user} onSignOut={onSignOut} />
      </div>
    </header>
  );
}
