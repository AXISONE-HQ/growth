/**
 * KAN-786 (sub-cohort b) + KAN-791 (lifecycle pivot) — Engagement service.
 *
 * Module-scoped functions for the Prisma-backed Engagement write path.
 * Replaces dead engagement-logger.ts (~430 LoC, KAN-782 deletion target).
 *
 * KAN-791 PIVOT (2026-05-03): Engagement now attaches to Deal via REQUIRED
 * dealId FK. EngagementInput.dealId is mandatory; callers MUST create the
 * Deal first. Per PRD §9.5 atomicity invariant — there is no moment when
 * an Engagement exists without a Deal. Track A (KAN-793) Normalizer
 * creates Deal first, then logs inbound Engagement with dealId = deal.id.
 * contactId stays as denormalized fast-query field for cheap
 * (tenantId, contactId, occurredAt) queries without joining through Deal.
 *
 * Shape: module-scoped exported functions taking `prisma` as first arg —
 * matches sibling-service convention in this directory (agentic-tools.ts,
 * threshold-gate.ts).
 *
 * Idempotency: `correlationId` is the natural-key dedup token. When provided
 * AND a row already exists with that value, `logEngagement` returns the
 * existing row as a no-op. Pub/Sub redelivery + handler retries are safe.
 * Recommended `correlationId` sources:
 *   - Resend webhook message id for inbound-derived engagements
 *   - Decision id for decision-derived events
 *   - Action id for agent-emitted engagements
 */
import type { Engagement, PrismaClient, SignalClass } from "@prisma/client";

export interface EngagementInput {
  tenantId: string;
  /** KAN-791 — REQUIRED. Engagement attaches to Deal; queryable to Contact
   *  via FK chain. Per PRD §9.5 atomicity invariant: Deal must exist before
   *  Engagement is written. Track A (KAN-793) Normalizer creates the Deal
   *  first, then logs the inbound Engagement with dealId = deal.id. */
  dealId: string;
  /** Denormalized fast-query field; redundant with deal.contactId but kept
   *  for cheap (tenantId, contactId, occurredAt) queries on a Contact's
   *  engagement history without joining through Deal. */
  contactId: string;
  engagementType: string;
  channel?: string | null;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
  /** Optional natural-key dedup token. If provided and a row with this
   *  correlationId already exists, the write is a no-op (returns the
   *  existing row). Pub/Sub redelivery + handler retries safe by
   *  construction. */
  correlationId?: string;
}

export async function logEngagement(
  prisma: PrismaClient,
  input: EngagementInput,
): Promise<Engagement> {
  if (input.correlationId) {
    const existing = await prisma.engagement.findUnique({
      where: { correlationId: input.correlationId },
    });
    if (existing) return existing;
  }

  return prisma.engagement.create({
    data: {
      tenantId: input.tenantId,
      dealId: input.dealId,
      contactId: input.contactId,
      engagementType: input.engagementType,
      signalClass: classifySignal(input.engagementType),
      channel: input.channel ?? null,
      occurredAt: input.occurredAt,
      metadata: (input.metadata ?? {}) as object,
      ...(input.correlationId && { correlationId: input.correlationId }),
    },
  });
}

export async function listEngagementsForContact(
  prisma: PrismaClient,
  tenantId: string,
  contactId: string,
  opts?: { since?: Date; limit?: number },
): Promise<Engagement[]> {
  return prisma.engagement.findMany({
    where: {
      tenantId,
      contactId,
      ...(opts?.since && { occurredAt: { gte: opts.since } }),
    },
    orderBy: { occurredAt: "desc" },
    take: opts?.limit ?? 100,
  });
}

export async function listEngagementsSinceForLearning(
  prisma: PrismaClient,
  after: Date,
  limit = 1000,
): Promise<Engagement[]> {
  return prisma.engagement.findMany({
    where: { occurredAt: { gte: after } },
    orderBy: { occurredAt: "asc" },
    take: limit,
  });
}

/**
 * Classify an engagement signal as positive, negative, or neutral.
 * Initial taxonomy per PRD §4 + decision_kan_749_mvp_shape_rationale —
 * passes engagementType AS-IS, defers vocab refactor to KAN-763 Phase C.
 *
 * Exported for test introspection. Production callers go through
 * logEngagement which calls this internally.
 */
export function classifySignal(engagementType: string): SignalClass {
  if (POSITIVE_TYPES.has(engagementType)) return "positive" as SignalClass;
  if (NEGATIVE_TYPES.has(engagementType)) return "negative" as SignalClass;
  return "neutral" as SignalClass;
}

const POSITIVE_TYPES = new Set([
  "email_open",
  "email_click",
  "email_reply",
  "form_submit",
]);

const NEGATIVE_TYPES = new Set([
  "email_bounce",
  "email_unsubscribe",
  "contact_optout",
]);
