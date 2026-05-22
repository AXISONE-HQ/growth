/**
 * KAN-977 Phase B.2 — TopNav.
 *
 * Extracted from `apps/web/src/app/layout.tsx`'s inline header (was lines
 * 299-332). Same content shape preserved — page title + AIStatusIndicator
 * on the left, search in the middle, notification + pause icon buttons on
 * the right. Restyle only: pill search using --ds-surface-sunken, hairline
 * border via Phase A's HSL rewire, icon buttons using --ds-radius-icon,
 * ink/muted text via the new palette.
 *
 * Brand mark and account dropdown stay in the sidebar (layout.tsx:195-293)
 * for now. Phase B.3 will rewrite the sidebar to the slim 72px icon rail
 * and move brand + account into the TopNav per the prototype.
 */
"use client";

import { Search, Bell, Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import { AIStatusIndicator } from "@/components/growth/ai-status-indicator";

export interface TopNavProps {
  /** Resolved page title (from layout.tsx's longest-prefix pageTitle map). */
  title: string;
  className?: string;
}

export function TopNav({ title, className }: TopNavProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-40 flex items-center justify-between border-b border-border bg-card px-8 py-3",
        className,
      )}
    >
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        {/* AIStatusIndicator status hardcoded "active" until system-health backend wires up
         * (deferred follow-up alongside Decision Feed surface, Sprint 12+). */}
        <AIStatusIndicator status="active" />
      </div>

      {/* Pill search — sunken background, hairline border, focus state lifts
       * to violet ring via the rewired --ring (245 64% 57%). */}
      <div className="mx-6 max-w-[480px] flex-1">
        <div className="flex items-center gap-2 rounded-[var(--ds-radius-pill)] border border-border bg-[var(--ds-surface-sunken)] px-3.5 py-2 transition-all focus-within:border-ring focus-within:bg-card focus-within:ring-[3px] focus-within:ring-ring/10">
          <Search className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search contacts, decisions, actions..."
            className="w-full border-none bg-transparent text-sm font-[inherit] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <span className="flex-shrink-0 rounded border border-border px-1.5 py-[1px] text-[11px] text-muted-foreground">
            ⌘K
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label="Notifications"
          className="relative rounded-[var(--ds-radius-icon)] p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Bell className="h-5 w-5" />
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-destructive" />
        </button>
        <button
          type="button"
          aria-label="Pause"
          className="rounded-[var(--ds-radius-icon)] p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Pause className="h-5 w-5" />
        </button>
      </div>
    </header>
  );
}
