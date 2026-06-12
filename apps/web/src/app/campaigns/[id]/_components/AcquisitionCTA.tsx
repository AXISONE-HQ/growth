/**
 * KAN-1166 PR 3-variants — Acquisition CTA card (one per missing
 * RequiredDataType).
 *
 * Q-ADD I3 lock (ratified with engagement_history swap):
 *   - Each card has ONE primary CTA + ONE secondary CTA, both linking to
 *     existing flows (no inline upload)
 *   - 4 hardcoded patterns mapped from RequiredDataType union
 *   - expectedUnlock from the analyzer's DataAcquisitionRecommendation
 *     renders below CTAs as italic "what this unlocks" framing
 *
 * engagement_history swap (Q-ADD I3 refinement):
 *   - Primary: "Connect email/SMS provider" → /settings/integrations
 *     (THE most direct unblock; populates engagement from real comms)
 *   - Secondary: "Activate an existing Campaign" → /campaigns
 *     (operator picks another draft Campaign to activate; avoids the
 *     recursive new-Campaign-from-Campaign-context loop)
 */
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import type { DataAcquisitionRecommendation, RequiredDataType } from "@growth/shared";

export interface AcquisitionCTAProps {
  recommendation: DataAcquisitionRecommendation;
  className?: string;
}

interface CTAPattern {
  title: string;
  primary: { label: string; href: string };
  secondary: { label: string; href: string };
}

const CTA_PATTERNS: Record<RequiredDataType, CTAPattern> = {
  sales_history: {
    title: "Add your sales history",
    primary: {
      label: "Upload past 12 mo orders (CSV)",
      href: "/imports?type=orders",
    },
    secondary: {
      label: "Connect Shopify / Stripe",
      href: "/settings/integrations",
    },
  },
  customer_base: {
    title: "Sync your customer list",
    primary: {
      label: "Sync HubSpot / Pipedrive",
      href: "/settings/integrations",
    },
    secondary: {
      label: "Upload customer CSV",
      href: "/imports?type=contacts&lifecycle=customer",
    },
  },
  lead_history: {
    title: "Connect lead-gen sources",
    primary: {
      label: "Connect Meta Lead Ads",
      href: "/settings/integrations",
    },
    secondary: {
      label: "Upload historical leads",
      href: "/imports?type=contacts&lifecycle=lead",
    },
  },
  engagement_history: {
    title: "Capture engagement",
    primary: {
      label: "Connect email/SMS provider",
      href: "/settings/integrations",
    },
    secondary: {
      label: "Activate an existing Campaign",
      href: "/campaigns",
    },
  },
};

export function AcquisitionCTA({ recommendation, className }: AcquisitionCTAProps) {
  const pattern = CTA_PATTERNS[recommendation.dataType];
  return (
    <div
      className={
        "rounded-lg border border-border bg-background px-4 py-3 " +
        (className ?? "")
      }
    >
      <h4 className="text-body font-semibold">{pattern.title}</h4>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:gap-3">
        <Link
          href={pattern.primary.href}
          className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {pattern.primary.label} <ArrowRight className="h-3.5 w-3.5" />
        </Link>
        <Link
          href={pattern.secondary.href}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
        >
          {pattern.secondary.label} <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <p className="mt-3 text-sm italic text-muted-foreground">
        {recommendation.expectedUnlock}
      </p>
    </div>
  );
}
