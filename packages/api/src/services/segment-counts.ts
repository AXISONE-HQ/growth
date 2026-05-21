/**
 * KAN-962 (slice 2a) — deterministic segment-count queries.
 *
 * The proposer's `dataSufficiency` verdict (`ready | needs_more_data`)
 * is grounded in DB counts, not LLM guesses. This module owns those
 * queries — one per audience segment — so the same counts drive the
 * UI's evidence cards + slice-2b's daily discovery diffs + future
 * audit/observability surfaces.
 *
 * **Discipline**: thresholds are constants here (not env vars / config)
 * — they bake the founder's "enough data to operate credibly" judgment
 * into the proposer. Re-tune via PR, not runtime knob, so the change
 * shows up in audit + memory.
 *
 * **Segmentation signals** (all schema-verified per Phase 1 audit):
 * - new_leads:          Contact.lifecycleStage='lead' AND created < 90d AND no Deal
 * - closed_lost:        Stage.outcomeType='terminal_lost' (preferred) OR Deal.status='lost'
 * - cancelled_orders:   Order.status IN ('cancelled', 'failed')
 * - inactive_customers: Customer rows where status='active' but no recent engagement (90d)
 * - active_customers:   Customer rows where status='active'
 */
import type { PrismaClient } from "@prisma/client";

/** Sufficiency thresholds — values the proposer treats as "enough to operate". */
export const SUFFICIENCY_THRESHOLDS = {
  new_leads: 1,                       // 1 lead is enough to spin up a book-demo pipeline
  closed_lost: 5,                     // need at least 5 closed-lost to spot patterns
  cancelled_orders: 3,                // 3 cancelled/failed orders to justify recovery flow
  inactive_customers: 5,              // 5 inactive customers for reactivation outreach
  active_customers: 3,                // 3 active customers for retention/upsell pipelines
} as const;

export type SegmentCountKey = keyof typeof SUFFICIENCY_THRESHOLDS;

export interface SegmentCounts {
  new_leads: number;
  closed_lost: number;
  cancelled_orders: number;
  inactive_customers: number;
  active_customers: number;
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Compute all segment counts for a tenant in a single pass. Counts are
 * deterministic; running twice on the same DB state returns the same
 * numbers. Sufficient evidence for the proposer to ground verdicts.
 *
 * Each count is a single `prisma.{model}.count` — no fan-out, no joins
 * larger than the indexes already cover. Total query cost is bounded
 * by the slowest single count (lead count on contacts, since AxisOne
 * has 13.5k rows).
 */
export async function computeSegmentCounts(
  prisma: PrismaClient,
  tenantId: string,
): Promise<SegmentCounts> {
  const ninetyDaysAgo = new Date(Date.now() - NINETY_DAYS_MS);

  const [
    newLeadsCount,
    closedLostCount,
    cancelledOrdersCount,
    activeCustomersCount,
    inactiveCustomersCount,
  ] = await Promise.all([
    // new_leads: Contact.lifecycleStage='lead', created within 90d, no associated Deal
    prisma.contact.count({
      where: {
        tenantId,
        lifecycleStage: "lead",
        createdAt: { gte: ninetyDaysAgo },
        deals: { none: {} },
      },
    }),
    // closed_lost: Deal.currentStage.outcomeType='terminal_lost' (the stage-side
    // signal — more reliable than Deal.status per KAN-791; deals.status is
    // derived from currentStage.outcomeType going forward).
    prisma.deal.count({
      where: {
        tenantId,
        currentStage: { outcomeType: "terminal_lost" },
      },
    }),
    // cancelled_orders: includes 'failed' (payment processor failure) too —
    // both flow to recover_failed_payment objective.
    prisma.order.count({
      where: {
        tenantId,
        status: { in: ["cancelled", "failed"] },
      },
    }),
    // active_customers: simple count, status='active'. Pre-CustomerLifecycleEvent
    // (PR B) this relies on the manually-seeded 6 PROD customer rows; once
    // PR B's writer hook lands, terminal_won → upsert Customer keeps this
    // count fresh going forward.
    prisma.customer.count({
      where: { tenantId, status: "active" },
    }),
    // inactive_customers: status='active' but no recent engagement. Engagement
    // is the deal/contact-side signal — Customer doesn't carry a lastSeen
    // column today (slice-3+ enrichment territory). Proxy: customers whose
    // contact has no Engagement in the last 90d.
    prisma.customer.count({
      where: {
        tenantId,
        status: "active",
        contact: {
          engagements: {
            none: { occurredAt: { gte: ninetyDaysAgo } },
          },
        },
      },
    }),
  ]);

  return {
    new_leads: newLeadsCount,
    closed_lost: closedLostCount,
    cancelled_orders: cancelledOrdersCount,
    active_customers: activeCustomersCount,
    inactive_customers: inactiveCustomersCount,
  };
}

/**
 * Verdict helper — `ready` when count >= threshold, else `needs_more_data`.
 * Pure function so tests can call it directly without DB.
 */
export function classifySufficiency(
  segment: SegmentCountKey,
  count: number,
): "ready" | "needs_more_data" {
  return count >= SUFFICIENCY_THRESHOLDS[segment] ? "ready" : "needs_more_data";
}

/**
 * Human-readable "needed" message for the UI when sufficiency=needs_more_data.
 * Returns null when ready. The proposer surfaces these verbatim in the
 * "Needs more data" gap cards.
 */
export function neededMessage(
  segment: SegmentCountKey,
  count: number,
): string | null {
  const threshold = SUFFICIENCY_THRESHOLDS[segment];
  if (count >= threshold) return null;
  const remaining = threshold - count;
  switch (segment) {
    case "new_leads":
      return `Need at least ${threshold} recent inbound lead${threshold === 1 ? "" : "s"} to start routing; you have ${count}.`;
    case "closed_lost":
      return `Need at least ${threshold} closed-lost deals to spot patterns and run a winback pipeline; you have ${count} (${remaining} more needed).`;
    case "cancelled_orders":
      return `Need at least ${threshold} cancelled or failed orders to justify a recovery flow; you have ${count} (${remaining} more needed).`;
    case "active_customers":
      return `Need at least ${threshold} active customers to run retention or upsell; you have ${count} (${remaining} more needed).`;
    case "inactive_customers":
      return `Need at least ${threshold} inactive customers (no engagement in 90d) to run a reactivation pipeline; you have ${count} (${remaining} more needed).`;
  }
}

/**
 * Description string for the evidence card. Same text regardless of
 * ready / needs_more_data — describes WHAT was counted.
 */
export function evidenceDescription(segment: SegmentCountKey): string {
  switch (segment) {
    case "new_leads":
      return "Recent inbound leads (lifecycle=lead, created in last 90 days, no deal yet)";
    case "closed_lost":
      return "Deals on a terminal-lost stage";
    case "cancelled_orders":
      return "Orders with status=cancelled or status=failed";
    case "active_customers":
      return "Customers with status=active";
    case "inactive_customers":
      return "Active customers with no engagement in the last 90 days";
  }
}
