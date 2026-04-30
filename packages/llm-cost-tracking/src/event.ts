import { randomUUID } from 'crypto';
import type { LLMCallEvent, PubSubClient } from './types.js';
import { MODEL_PRICING_VERSION } from './pricing.js';

const LLM_CALL_TOPIC = 'llm.call';

/**
 * Stateless cost-event emitter. Pass `pubsub` explicitly so this function
 * can be reused across processes (apps/api, apps/knowledge-worker) without
 * a shared module-level state singleton.
 *
 * Best-effort by design: never throws, never blocks the LLM call path.
 * Logs failures so ops can investigate; the aggregator (KAN-745 PR B)
 * flags missing rows separately.
 */
export async function emitLLMCallEvent(opts: {
  pubsub: PubSubClient | null | undefined;
  event: Omit<LLMCallEvent, 'eventId' | 'eventType' | 'publishedAt' | 'pricingVersion'>;
}): Promise<void> {
  if (!opts.pubsub) return;
  const event: LLMCallEvent = {
    eventId: `evt_${randomUUID()}`,
    eventType: 'llm.call',
    publishedAt: new Date().toISOString(),
    pricingVersion: MODEL_PRICING_VERSION,
    ...opts.event,
  };
  try {
    await opts.pubsub.publish(LLM_CALL_TOPIC, Buffer.from(JSON.stringify(event)), {
      eventType: 'llm.call',
      tenantId: event.tenantId,
      provider: event.provider,
      model: event.model,
      tier: event.tier,
    });
  } catch (err) {
    console.error('[llm-cost-tracking] cost-event publish failed', err);
  }
}
