/**
 * KAN-978 Phase B.3 — AccountMenu.
 *
 * Extracted from apps/web/src/app/layout.tsx's sidebar user-footer (was
 * lines 246-292). Renders as a pill in the TopNav RIGHT side per the
 * prototype's `.acct`:
 *
 *   ┌───────────────────────────────────┐
 *   │ [FB] AxisOne                ⌄    │
 *   └───────────────────────────────────┘
 *
 * Pill bg = --ds-surface-sunken (cool cream), hairline border. Avatar
 * 30×30, violet-tinted bg (#EDEBFB), violet text (--ds-violet-500), 50%
 * round (per prototype .ava). Display: user.displayName || user.email
 * with truncation; subtitle (role + company) is hidden in pill to keep
 * the height tight — still visible inside the dropdown.
 *
 * Dropdown behavior preserved from the prior implementation: useState
 * open/closed, useRef + useEffect click-outside-to-close. Settings link
 * is admin-only (matches the existing gate); Sign out is always visible.
 */
"use client";

import Link from "next/link";
import { ChevronDown, Shield, Settings, LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface AccountMenuUser {
  /** Firebase email can be null in some auth flows; render gracefully. */
  email: string | null;
  displayName?: string | null;
  initials: string;
  role: "admin" | "member" | string;
  company?: string | null;
}

export interface AccountMenuProps {
  user: AccountMenuUser;
  onSignOut: () => void | Promise<void>;
  className?: string;
}

export function AccountMenu({ user, onSignOut, className }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const displayLabel = user.displayName || user.email || "Account";
  const isAdmin = user.role === "admin";

  return (
    <div ref={menuRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-[var(--ds-radius-pill)] border border-border bg-[var(--ds-surface-sunken)] py-[5px] pl-[5px] pr-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
      >
        <span
          aria-hidden="true"
          className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[var(--ds-violet-100)] text-xs font-semibold text-[var(--ds-violet-500)]"
        >
          {user.initials}
        </span>
        <span className="max-w-[140px] truncate">{displayLabel}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-[var(--ds-radius-card)] border border-border bg-card shadow-[var(--ds-shadow-overlay)]"
        >
          <div className="border-b border-border px-3 py-2">
            <div className="text-xs text-muted-foreground">{user.email ?? "(no email)"}</div>
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              {isAdmin ? <Shield className="h-3 w-3" /> : null}
              <span>{isAdmin ? "Admin" : "Member"}</span>
              {user.company ? <span>· {user.company}</span> : null}
            </div>
          </div>
          {isAdmin ? (
            <Link
              href="/settings"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2.5 text-sm text-foreground transition-colors hover:bg-accent"
            >
              <Settings className="h-4 w-4 text-muted-foreground" />
              Settings
            </Link>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void onSignOut();
            }}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-[var(--ds-danger-text)] transition-colors hover:bg-accent"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
