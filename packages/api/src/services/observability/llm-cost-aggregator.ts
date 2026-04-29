/**
 * KAN-745 PR B — LLM cost aggregator.
 *
 * Consumes `LLMCallEvent` payloads (KAN-745 PR A shape) and UPSERTs into
 * the LlmCostRollup table on `(tenantId, hourBucket, callerTagPrefix,
 * pricingVersion)`. Concurrent-safe via the unique index — Prisma's
 * `upsert` handles row-level conflicts when two subscriber instances flush
 * the same hour bucket.
 *
 * Hour bucket = `event.publishedAt` truncated to UTC hour. Late-arriving
 * events still land in the correct historical bucket (Prisma upsert
 * increments the existing row's totals).
 *
 * Validates incoming events at the function boundary — malformed events
 * (missing tenantId, etc.) are dropped with a structured error log per
 * `feedback_oidc_audience_smoke_test_required` discipline (best-effort
 * posture: never throw out of the subscriber handler; ack the message
 * either way to avoid Pub/Sub redelivery storms).
 */
import type { PrismaClient } from '@prisma/client';
import { callerTagToPrefix } from './tag-mapping.js';
import { emitThresholdAlarm } from './threshold-alarm.js';

/**
 * Subset of LLMCallEvent (KAN-745 PR A shape) — kept here to avoid a
 * runtime dep on llm-client.ts. Aggregator code path runs in the apps/api
 * push-subscription endpoint, but the type is pinned to the wire format.
 */
export interface LLMCallEventPayload {
  eventId: string;
  eventType: 'llm.call';
  publishedAt: string;
  tenantId: string;
  provider: 'anthropic' | 'openai';
  model: string;
  tier: 'reasoning' | 'cheap' | 'embedding';
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  pricingVersion: string;
  latencyMs: number;
  success: boolean;
  fallbackUsed: boolean;
  callerTag?: string;
  error?: string;
}

function isValidEvent(raw: unknown): raw is LLMCallEventPayload {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.tenantId === 'string' &&
    r.tenantId.length > 0 &&
    typeof r.publishedAt === 'string' &&
    typeof r.costUsd === 'number' &&
    typeof r.pricingVersion === 'string'
  );
}

/** Truncate a Date to UTC hour (zero out minutes/seconds/ms). */
export function toHourBucket(when: Date): Date {
  const d = new Date(when.getTime());
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/**
 * Apply a single llm.call event to the rollup table. Concurrent-safe:
 * Prisma `upsert` with the unique key handles two subscribers racing on
 * the same bucket.
 */
export async function applyEventToRollup(
  prisma: PrismaClient,
  event: LLMCallEventPayload,
): Promise<{ applied: true; tenantId: string; hourBucket: Date; callerTagPrefix: string } | { applied: false; reason: string }> {
  const hourBucket = toHourBucket(new Date(event.publishedAt));
  const callerTagPrefix = callerTagToPrefix(event.callerTag);

  await prisma.llmCostRollup.upsert({
    where: {
      tenantId_hourBucket_callerTagPrefix_pricingVersion: {
        tenantId: event.tenantId,
        hourBucket,
        callerTagPrefix,
        pricingVersion: event.pricingVersion,
      },
    },
    create: {
      tenantId: event.tenantId,
      hourBucket,
      callerTagPrefix,
      pricingVersion: event.pricingVersion,
      callCount: 1,
      totalInputTokens: event.inputTokens,
      totalOutputTokens: event.outputTokens,
      totalCostUsd: event.costUsd,
    },
    update: {
      callCount: { increment: 1 },
      totalInputTokens: { increment: event.inputTokens },
      totalOutputTokens: { increment: event.outputTokens },
      totalCostUsd: { increment: event.costUsd },
    },
  });

  return { applied: true, tenantId: event.tenantId, hourBucket, callerTagPrefix };
}

export interface HandleEventResult {
  ok: boolean;
  reason?: string;
  applied?: { tenantId: string; hourBucket: Date; callerTagPrefix: string };
  thresholdBreach?: boolean;
}

/**
 * Top-level subscriber handler. Validate → apply → evaluate threshold.
 * Never throws — returns `{ ok: false, reason }` so the push-subscription
 * endpoint can ack the message either way (avoids redelivery storms on
 * malformed events; valid events that hit DB errors are still ack'd, but
 * the structured-log error gives ops a signal).
 */
export async function handleLlmCallEvent(
  prisma: PrismaClient,
  raw: unknown,
): Promise<HandleEventResult> {
  if (!isValidEvent(raw)) {
    console.error('[llm-cost-aggregator] dropping malformed event', {
      severity: 'ERROR',
      'logging.googleapis.com/labels': { event: 'llm-cost-aggregator-bad-event' },
    });
    return { ok: false, reason: 'malformed_event' };
  }

  const event = raw;

  try {
    const applied = await applyEventToRollup(prisma, event);
    if (!applied.applied) {
      return { ok: false, reason: applied.reason };
    }

    // Evaluate threshold for the just-touched (tenant, hourBucket). Sums
    // all callerTagPrefix rows in the bucket — operates on the canonical
    // post-upsert state, so concurrent flushes converge.
    const breach = await evaluateThresholdForBucket(prisma, applied.tenantId, applied.hourBucket);
    return {
      ok: true,
      applied,
      thresholdBreach: breach,
    };
  } catch (err) {
    console.error('[llm-cost-aggregator] DB upsert failed', err, {
      severity: 'ERROR',
      'logging.googleapis.com/labels': { event: 'llm-cost-aggregator-db-failure' },
    });
    return { ok: false, reason: 'db_error' };
  }
}

/**
 * Sum agentic vs non-agentic for the bucket and emit threshold alarm if
 * breached. Public for testing; called from `handleLlmCallEvent`.
 */
export async function evaluateThresholdForBucket(
  prisma: PrismaClient,
  tenantId: string,
  hourBucket: Date,
): Promise<boolean> {
  const rows = await prisma.llmCostRollup.findMany({
    where: { tenantId, hourBucket },
    select: { callerTagPrefix: true, totalCostUsd: true },
  });

  let agenticUsd = 0;
  let nonAgenticUsd = 0;
  for (const r of rows) {
    if (r.callerTagPrefix === 'agentic' || r.callerTagPrefix === 'agentic-tool') {
      agenticUsd += r.totalCostUsd;
    } else {
      nonAgenticUsd += r.totalCostUsd;
    }
  }

  const result = emitThresholdAlarm({ tenantId, hourBucket, agenticUsd, nonAgenticUsd });
  return result.breach;
}
