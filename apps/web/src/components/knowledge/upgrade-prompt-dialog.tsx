// PROMOTION CANDIDATE: lift into packages/ui in KAN-847
// Used by: Knowledge Sources admin page (KAN-829), reused by future tier-gated surfaces

/**
 * UpgradePromptDialog — tier-gating UX surface fired when an operator hits a
 * plan-tier limit in the Knowledge Sources flow.
 *
 * Two `reason` variants drive heading + body copy:
 *  - `count-at-limit` — operator clicked Add Source while already at the cap
 *  - `feature-locked` — operator clicked a card (PDF) their tier doesn't include
 *
 * **KAN-XXX (FAQ first-class):** the FAQ feature-locked variant is removed
 * since FAQ entries are now unlimited across all tiers (their own table,
 * own dialog, no gating). Only PDF remains as a gated feature.
 *
 * Always-shown plan comparison (compact, NOT a giant pricing table) helps the
 * operator orient between current tier and recommended tier. Row logic per
 * `buildComparisonRows()` in tier-labels.ts:
 *   free       → Free (current) + Pro (recommended) + Enterprise
 *   starter    → Starter (current) + Pro (recommended) + Enterprise
 *   pro        → Pro (current) + Enterprise (recommended)   (2 rows, no synthetic)
 *   enterprise → no comparison; custom-limit branch
 *
 * **Honest copy posture (audited at gate):**
 *  - States what the current plan INCLUDES (positive frame), not what's missing
 *  - No pricing — billing isn't wired (pre-launch); naming a price would be a lie
 *  - Recommends ONE tier — doesn't push the top
 *  - Action verb is "Talk to us about upgrading" — captures intent honestly,
 *    no "Buy" or "Subscribe" since there's no checkout to land on
 *  - Zero FOMO, no fake urgency, no time-bound offers
 *
 * **DS v1 compliance:**
 *  - All colors via `--ds-*` tokens (zero hex)
 *  - shadcn Dialog primitive composed
 *  - Sentence case + verb+object button labels
 *  - Color paired with text label on every state (recommended pill, current pill)
 *  - Forbidden microcopy audit covers sub-cohort-6 list (unleash / supercharge
 *    / unlock the power / take it to the next level / limited time / hurry /
 *    don't miss out / exclusive / premium experience) AND carry-over list
 *    (magic / simply / just / easily / seamlessly / revolutionary /
 *    cutting-edge / leverage / synergy / unfortunately / please / sorry)
 *
 * **KAN-848 follow-up:** when tier rename lands, the local TIER_FEATURES
 * mirror in tier-labels.ts collapses into a shared module imported by
 * server + client. This dialog needs no further change.
 */
"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  type Tier,
  UPGRADE_INTENT_EMAIL,
  mapTierToLabel,
  tierFeatures,
  recommendedTierFor,
  buildComparisonRows,
} from "@/lib/tier-labels";
import { getTenantId } from "@/lib/api";

export type UpgradeReason = "count-at-limit" | "feature-locked";
// KAN-XXX — FAQ entries no longer tier-gated; PDF is the only feature-lock surface.
export type LockedFeature = "pdf";

interface UpgradePromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reason: UpgradeReason;
  currentTier: Tier;
  /** Required for `feature-locked`; ignored for `count-at-limit`. */
  feature?: LockedFeature;
}

const FEATURE_LABEL: Record<LockedFeature, string> = {
  pdf: "PDF uploads",
};

const REASON_SUMMARY: Record<string, string> = {
  "count-at-limit": "count at limit",
  "feature-locked:pdf": "unlock PDF uploads",
};

export function UpgradePromptDialog({
  open,
  onOpenChange,
  reason,
  currentTier,
  feature,
}: UpgradePromptDialogProps): React.ReactElement {
  const recommended = recommendedTierFor(reason, currentTier, feature);
  const isEnterpriseCeiling = currentTier === "enterprise" && reason === "count-at-limit";
  const comparisonRows = isEnterpriseCeiling ? [] : buildComparisonRows(currentTier);

  const { heading, body } = buildCopy({ reason, currentTier, feature, isEnterpriseCeiling });
  const mailto = buildMailto({ reason, currentTier, recommended, feature, isEnterpriseCeiling });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>

        {comparisonRows.length > 0 ? (
          <ComparisonTable rows={comparisonRows} />
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            aria-label="Close upgrade prompt"
          >
            Close
          </Button>
          <Button
            asChild
            aria-label={isEnterpriseCeiling ? "Talk to us about a custom limit" : "Talk to us about upgrading"}
            style={{
              backgroundColor: "var(--ds-violet-500)",
              color: "var(--ds-on-violet, #fff)",
              borderColor: "var(--ds-violet-500)",
            }}
          >
            <a href={mailto.href}>
              {isEnterpriseCeiling ? "Talk to us about a custom limit" : "Talk to us about upgrading"}
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────
// Copy builders
// ─────────────────────────────────────────────

function buildCopy({
  reason,
  currentTier,
  feature,
  isEnterpriseCeiling,
}: {
  reason: UpgradeReason;
  currentTier: Tier;
  feature: LockedFeature | undefined;
  isEnterpriseCeiling: boolean;
}): { heading: string; body: string } {
  const currentLabel = mapTierToLabel(currentTier);
  const currentFeatures = tierFeatures(currentTier);

  if (reason === "count-at-limit") {
    if (isEnterpriseCeiling) {
      return {
        heading: "You've used all your knowledge sources.",
        body: `${currentLabel} includes ${currentFeatures.maxSources.toLocaleString()} sources, the current ceiling. Talk to us about a custom limit.`,
      };
    }
    const next = recommendedTierFor("count-at-limit", currentTier);
    if (!next) {
      // Defensive — should be unreachable given isEnterpriseCeiling check above.
      return {
        heading: "You've used all your knowledge sources.",
        body: `${currentLabel} includes ${formatSources(currentFeatures.maxSources)}.`,
      };
    }
    const nextLabel = mapTierToLabel(next);
    const nextFeatures = tierFeatures(next);
    return {
      heading: "You've used all your knowledge sources.",
      body: `${currentLabel} includes up to ${formatSources(currentFeatures.maxSources)}. You're using all of them. To add more, ${nextLabel} raises the cap to ${nextFeatures.maxSources.toLocaleString()}.`,
    };
  }

  // feature-locked
  const featureLabel = feature ? FEATURE_LABEL[feature] : "This feature";
  const minTier = recommendedTierFor("feature-locked", currentTier, feature);
  const minTierLabel = minTier ? mapTierToLabel(minTier) : "a higher plan";
  return {
    heading: `${featureLabel} is on a higher plan.`,
    body: `${featureLabel} is available on ${minTierLabel} and above. ${currentLabel} doesn't include it.`,
  };
}

function formatSources(n: number): string {
  return n === 1 ? "1 source" : `${n.toLocaleString()} sources`;
}

// ─────────────────────────────────────────────
// Mailto template builder
// ─────────────────────────────────────────────

interface MailtoArgs {
  reason: UpgradeReason;
  currentTier: Tier;
  recommended: Tier | null;
  feature: LockedFeature | undefined;
  isEnterpriseCeiling: boolean;
}

interface MailtoResult {
  href: string;
  subject: string;
  body: string;
}

export function buildMailto(args: MailtoArgs): MailtoResult {
  const currentLabel = mapTierToLabel(args.currentTier);
  const tenantId = getTenantId();

  let subject: string;
  const lines: string[] = ["Hi,", ""];

  if (args.isEnterpriseCeiling) {
    subject = "Custom limit request — Enterprise";
    lines.push(
      "I'd like to discuss a custom source limit for my AxisOne plan.",
      `Currently on ${currentLabel}.`,
      "Reason: count at limit beyond the standard 9,999 cap.",
    );
  } else {
    const recommendedLabel = args.recommended ? mapTierToLabel(args.recommended) : currentLabel;
    const reasonKey = args.reason === "feature-locked" && args.feature ? `feature-locked:${args.feature}` : args.reason;
    const reasonText = REASON_SUMMARY[reasonKey] ?? args.reason;
    subject = `Upgrade request — ${currentLabel} → ${recommendedLabel}`;
    lines.push(
      `I'd like to upgrade my AxisOne plan from ${currentLabel} to ${recommendedLabel}.`,
      `Reason: ${reasonText}.`,
    );
  }

  // Tenant ID line is convenience-only; omit entirely if not resolvable.
  if (tenantId) lines.push(`Tenant ID: ${tenantId}.`);
  lines.push("Thanks.");

  const body = lines.join("\n");
  const href = `mailto:${UPGRADE_INTENT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return { href, subject, body };
}

// ─────────────────────────────────────────────
// Comparison table — compact 2-3 row visual
// ─────────────────────────────────────────────

function ComparisonTable({
  rows,
}: {
  rows: ReturnType<typeof buildComparisonRows>;
}): React.ReactElement {
  return (
    <table
      className="w-full border-collapse rounded-lg overflow-hidden border"
      style={{ borderColor: "var(--ds-border-subtle)" }}
      aria-label="Plan comparison"
    >
      <thead>
        <tr style={{ backgroundColor: "var(--ds-surface-sunken)" }}>
          <th
            scope="col"
            className="text-left text-xs font-medium uppercase tracking-wide px-3 py-2"
            style={{ color: "var(--ds-ink-tertiary)" }}
          >
            Plan
          </th>
          <th
            scope="col"
            className="text-left text-xs font-medium uppercase tracking-wide px-3 py-2"
            style={{ color: "var(--ds-ink-tertiary)" }}
          >
            What it includes
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const features = tierFeatures(row.tier);
          const rowStyle: React.CSSProperties = row.isRecommended
            ? {
                backgroundColor: "var(--ds-violet-100)",
                borderTop: "1px solid color-mix(in srgb, var(--ds-violet-500) 30%, transparent)",
              }
            : {
                backgroundColor: "var(--ds-surface-base)",
                borderTop: "1px solid var(--ds-border-subtle)",
              };
          return (
            <tr key={row.tier} data-tier={row.tier} data-recommended={row.isRecommended || undefined} style={rowStyle}>
              <td className="px-3 py-2 align-top">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="text-sm font-medium"
                    style={{
                      color: row.isRecommended
                        ? "var(--ds-violet-700)"
                        : "var(--ds-ink-secondary)",
                    }}
                  >
                    {mapTierToLabel(row.tier)}
                  </span>
                  {row.isCurrent ? (
                    <span
                      className="text-xs font-medium px-1.5 py-0.5 rounded-full border"
                      style={{
                        backgroundColor: "var(--ds-surface-sunken)",
                        color: "var(--ds-ink-secondary)",
                        borderColor: "var(--ds-border-default)",
                      }}
                    >
                      Your plan
                    </span>
                  ) : null}
                  {row.isRecommended ? (
                    <span
                      className="text-xs font-medium px-1.5 py-0.5 rounded-full border"
                      style={{
                        backgroundColor: "var(--ds-violet-100)",
                        color: "var(--ds-violet-700)",
                        borderColor: "color-mix(in srgb, var(--ds-violet-500) 30%, transparent)",
                      }}
                    >
                      Recommended
                    </span>
                  ) : null}
                </div>
              </td>
              <td
                className="px-3 py-2 text-sm align-top"
                style={{ color: "var(--ds-ink-secondary)" }}
              >
                {features.description}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
