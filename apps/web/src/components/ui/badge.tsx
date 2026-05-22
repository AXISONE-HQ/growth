import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// KAN-976 Phase B.1 — Badge gains the pastel-semantic chip variants that
// mirror the .ds-chip-* utility classes Phase A added. Existing variants
// (default/secondary/destructive/outline) preserved — consumers stay on
// current sizing/weight until Phase C migrates per-screen call sites.
//
// New chip variants:
//   - ai       — AI activity / actor (indigo pastel)
//   - amber    — warning / pending / in-progress
//   - green    — success / done / won
//   - teal     — review / qualification (neutral-positive)
//   - rose     — risk / churn / lost / escalated
//   - positive — success accent (alias of green for "things are good" copy)
//   - muted    — neutral / open / channel labels
//
// Confidence-tier callers (board-helpers.ts, dashboard demo) keep their
// current consumption pattern — Phase C migrates them to <Badge variant=...>
// where it makes sense. font-medium overrides the base font-semibold to
// match prototype chip weight (500).
const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive text-destructive-foreground",
        outline: "text-foreground",
        ai:       "border-transparent bg-[var(--ds-violet-100)] text-[var(--ds-violet-500)] font-medium",
        amber:    "border-transparent bg-[var(--ds-warning-soft)] text-[var(--ds-warning-text)] font-medium",
        green:    "border-transparent bg-[var(--ds-emerald-100)] text-[var(--ds-emerald-700)] font-medium",
        teal:     "border-transparent bg-[var(--ds-teal-100)] text-[var(--ds-teal-700)] font-medium",
        rose:     "border-transparent bg-[var(--ds-danger-soft)] text-[var(--ds-danger-text)] font-medium",
        positive: "border-transparent bg-[var(--ds-emerald-100)] text-[var(--ds-emerald-700)] font-medium",
        muted:    "border-transparent bg-[#EEF0F6] text-[var(--ds-ink-secondary)] font-medium",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
export { badgeVariants };
