/**
 * KAN-786 Phase 1 — Engagement service (module-scoped functions).
 *
 * Replaces the dead engagement-logger.ts (~430 LoC, never wired into a
 * production runtime — see KAN-782 for deletion). Surfaces a Prisma-backed
 * write path for AI-agent action emits + future channel webhook signals
 * (email opens, clicks, replies, bounces, etc.) per
 * docs/prds/phase-1-deal-engagement.md §4.
 *
 * Shape: module-scoped exported functions taking `prisma` as first arg —
 * matches sibling-service convention in this directory (agentic-tools.ts,
 * threshold-gate.ts). PRD §4 originally specified a class-based shape; the
 * sub-cohort (b) audit on 2026-05-02 confirmed module-fn convention is
 * dominant + the PRD was amended to match.
 *
 * Idempotency: `correlationId` is the natural-key dedup token. When provided
 * AND a row already exists with that value, `logEngagement` returns the
 * existing row as a no-op. Pub/Sub redelivery + handler retries are safe by
 * construction. Recommended `correlationId` sources:
 *   - Resend webhook message id for inbound-derived engagements
 *   - Decision id for threshold-gate-derived events
 *   - Action id for agent-emitted engagements (sub-cohort (d))
 */
import type { Engagement, PrismaClient, SignalClass } from "@prisma/client";

export interface EngagementInput {
  tenantId: string;
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
