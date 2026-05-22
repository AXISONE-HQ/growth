import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// KAN-976 Phase B.1 — Button restyle.
//
// Shape: pill by default (rounded-full / --ds-radius-pill) for default/sm/lg;
// icon stays rounded-square at --ds-radius-icon (~13px) per the prototype's
// .rbtn pattern. Base CVA's prior rounded-md removed — per-size rounded is
// now the source of truth so the pill default propagates cleanly.
//
// Variants:
//   - `default` — bg-primary (violet via Phase A) + primary-foreground. The
//     conservative primary surface; use for most CTAs.
//   - `gradient` — NEW. Background = --ds-accent-gradient (purple→blue). Use
//     for the load-bearing primary CTA (hero, "Save", "Adopt"), the
//     IconRail active state surface, the AssistantCard's "Go" affordance.
//     Pair with .text-primary-foreground (white via Phase A) and the card
//     shadow for the lifted look in the prototype's .btn / .ask .go.
//   - `outline` / `secondary` / `ghost` / `link` / `destructive` — already
//     consume the rewired shadcn tokens (border / accent / etc.) via Phase A
//     and pick up the new palette automatically. No per-variant changes
//     beyond verifying token references are clean.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        gradient:
          "[background-image:var(--ds-accent-gradient)] text-primary-foreground shadow-[var(--ds-shadow-card)] hover:opacity-95",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-border bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 rounded-full px-5 py-2",
        sm: "h-9 rounded-full px-4",
        lg: "h-11 rounded-full px-7",
        icon: "h-10 w-10 rounded-[var(--ds-radius-icon)]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";
export { buttonVariants };
