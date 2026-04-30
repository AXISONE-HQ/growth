/**
 * Structural PubSubClient interface.
 *
 * Both @google-cloud/pubsub's `Topic.publishMessage`-derived helpers and
 * apps/api's `getPubSubClient()` happen to satisfy this minimal shape.
 * Keeping the contract here means this package has zero cloud-vendor
 * runtime deps + tests can pass an in-memory `{ publish: vi.fn() }`.
 */
export interface PubSubClient {
  publish(
    topic: string,
    data: Buffer,
    attributes?: Record<string, string>,
  ): Promise<string>;
}

export type LLMTier = 'reasoning' | 'cheap' | 'embedding';
export type LLMProvider = 'anthropic' | 'openai';

export interface LLMCallEvent {
  eventId: string;
  eventType: 'llm.call';
  publishedAt: string;
  tenantId: string;
  provider: LLMProvider;
  model: string;
  tier: LLMTier;
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
