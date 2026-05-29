/**
 * M3-2.5a — resolve the active Deal for an engine decision.
 *
 * Single shared helper so the same lookup logic doesn't drift across the
 * three engine Decision-write sites in run-decision-for-contact.ts
 * (runFreeform / runAgentic / runPlaybookStep). Three independent inline
 * blocks would replay the exact drift class M3-1 reminded us costs the
 * most — one fix vs two stale copies the next time semantics evolve.
 *
 * Semantics (PRD §2 + Phase 1 founder confirm):
 *   - Most-recently-active open Deal for the contact.
 *   - Single-deal-per-contact (current AxisOne reality): deterministic.
 *   - Multi-deal: picks the one the contact most-recently moved on
 *     (highest-likelihood-correct attribution for a discovery question).
 *   - No open Deal: returns null → caller writes Decision without
 *     metadata.dealId → action-executed-push.ts's existing guard
 *     `if (dealId && ...)` skips Engagement write cleanly (back-compat).
 *
 * Multi-deal mis-attribution is a theoretical risk for now (1-tenant prod
 * has 1 Deal per contact). Future architectural improvement: Deal-to-
 * Objective explicit linkage on ContactObjectiveStack. Tracked as a
 * follow-up; out of scope here.
 */
import type { PrismaClient } from '@prisma/client';

export async function resolveActiveDealForContact(
  prisma: PrismaClient,
  tenantId: string,
  contactId: string,
): Promise<string | null> {
  const deal = await prisma.deal.findFirst({
    where: { tenantId, contactId, status: 'open' },
    orderBy: { enteredStageAt: 'desc' },
    select: { id: true },
  });
  return deal?.id ?? null;
}
