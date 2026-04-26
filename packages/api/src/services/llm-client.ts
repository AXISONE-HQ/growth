/**
 * llm-client — KAN-699 (Sprint 0.3)
 *
 * Unified LLM provider abstraction. Wraps Anthropic (primary) + OpenAI (fallback)
 * SDKs behind one interface. Adds:
 *   - tier-based provider selection (reasoning / cheap / embedding)
 *   - retry on transient errors (429 / 5xx / network)
 *   - automatic fallback to alternate provider on persistent rate-limit
 *   - cost-tracking event emission to llm.call Pub/Sub topic
 *
 * Single call site today: message-composer.ts (cheap tier, JSON mode).
 * Sprint 3-4 agentic loop will add many more — must consume this interface.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import type { PubSubClient } from './action-decided-publisher.js';

// ─────────────────────────────────────────────
// Tier → provider chain
// ─────────────────────────────────────────────

export type LLMTier = 'reasoning' | 'cheap' | 'embedding';
export type LLMProvider = 'anthropic' | 'openai';

interface ProviderEntry {
  provider: LLMProvider;
  model: string;
}

interface TierConfig {
  primary: ProviderEntry;
  fallback?: ProviderEntry;
}

export const TIER_MAP: Record<LLMTier, TierConfig> = {
  reasoning: {
    primary: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback: { provider: 'openai', model: 'gpt-4o' },
  },
  cheap: {
    primary: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    fallback: { provider: 'openai', model: 'gpt-4o-mini' },
  },
  embedding: {
    primary: { provider: 'openai', model: 'text-embedding-3-small' },
  },
};

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export interface LLMCompleteInput {
  /** 'reasoning' for quality-critical, 'cheap' for high-volume. */
  tier: 'reasoning' | 'cheap';
  systemPrompt?: string;
  userPrompt: string;
  /** Defaults to 1024. */
  maxTokens?: number;
  /** OpenAI-side hints JSON-only output; Anthropic relies on the system prompt. */
  jsonMode?: boolean;
  /** Free-form correlation tag for the cost-tracking event (e.g. 'message-composer:compose'). */
  callerTag?: string;
}

export interface LLMCompleteResult {
  text: string;
  provider: LLMProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** True when primary provider failed and fallback succeeded. */
  fallbackUsed: boolean;
}

export interface LLMEmbedInput {
  text: string | string[];
  callerTag?: string;
}

export interface LLMEmbedResult {
  embeddings: number[][];
  provider: LLMProvider;
  model: string;
  inputTokens: number;
  latencyMs: number;
}

// ─────────────────────────────────────────────
// SDK clients (lazy + test-injectable)
// ─────────────────────────────────────────────

let _anthropic: Anthropic | null = null;
let _openai: OpenAI | null = null;
let _pubsub: PubSubClient | null = null;

function anthropicClient(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

function openaiClient(): OpenAI {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

/**
 * Boot-time wiring. Call from app entrypoint with the production Pub/Sub client
 * so cost-tracking events go to the llm.call topic. If left unset, emit is a
 * no-op — keeps local dev + tests quiet.
 */
export function setLLMCostPublisher(client: PubSubClient | null): void {
  _pubsub = client;
}

/** Test-only seam — replace SDK clients + pubsub with mocks. */
export function __setLLMClientsForTest(opts: {
  anthropic?: Anthropic | null;
  openai?: OpenAI | null;
  pubsub?: PubSubClient | null;
}): void {
  if (opts.anthropic !== undefined) _anthropic = opts.anthropic;
  if (opts.openai !== undefined) _openai = opts.openai;
  if (opts.pubsub !== undefined) _pubsub = opts.pubsub;
}

// ─────────────────────────────────────────────
// Retry + fallback
// ─────────────────────────────────────────────

const MAX_ATTEMPTS_PER_PROVIDER = 2;
const RETRY_BACKOFF_MS = 250;

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === 'number') {
    return status === 429 || (status >= 500 && status < 600);
  }
  // Network/transport errors carry no HTTP status — treat as retryable.
  const code = (err as { code?: string })?.code;
  if (code && /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_)/.test(code)) return true;
  return false;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_PROVIDER; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === MAX_ATTEMPTS_PER_PROVIDER - 1) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────
// Provider call dispatch
// ─────────────────────────────────────────────

async function callAnthropic(
  model: string,
  input: LLMCompleteInput,
): Promise<Omit<LLMCompleteResult, 'latencyMs' | 'fallbackUsed'>> {
  const resp = await anthropicClient().messages.create({
    model,
    max_tokens: input.maxTokens ?? 1024,
    system: input.systemPrompt,
    messages: [{ role: 'user', content: input.userPrompt }],
  });
  const textContent = resp.content.find((c) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error(`anthropic ${model}: no text content in response`);
  }
  return {
    text: textContent.text,
    provider: 'anthropic',
    model,
    inputTokens: resp.usage.input_tokens,
    outputTokens: resp.usage.output_tokens,
  };
}

async function callOpenAI(
  model: string,
  input: LLMCompleteInput,
): Promise<Omit<LLMCompleteResult, 'latencyMs' | 'fallbackUsed'>> {
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (input.systemPrompt) messages.push({ role: 'system', content: input.systemPrompt });
  messages.push({ role: 'user', content: input.userPrompt });
  const resp = await openaiClient().chat.completions.create({
    model,
    max_tokens: input.maxTokens ?? 1024,
    messages,
    ...(input.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  });
  const text = resp.choices[0]?.message?.content ?? '';
  return {
    text,
    provider: 'openai',
    model,
    inputTokens: resp.usage?.prompt_tokens ?? 0,
    outputTokens: resp.usage?.completion_tokens ?? 0,
  };
}

async function callProvider(
  entry: ProviderEntry,
  input: LLMCompleteInput,
): Promise<Omit<LLMCompleteResult, 'latencyMs' | 'fallbackUsed'>> {
  if (entry.provider === 'anthropic') return callAnthropic(entry.model, input);
  return callOpenAI(entry.model, input);
}

// ─────────────────────────────────────────────
// Main entrypoints
// ─────────────────────────────────────────────

export async function complete(input: LLMCompleteInput): Promise<LLMCompleteResult> {
  const tier = TIER_MAP[input.tier];
  const chain: ProviderEntry[] = [tier.primary];
  if (tier.fallback) chain.push(tier.fallback);

  const start = Date.now();
  let lastErr: unknown;
  let fallbackUsed = false;

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    try {
      const out = await withRetry(() => callProvider(entry, input));
      const latencyMs = Date.now() - start;
      void emitLLMCallEvent({
        provider: out.provider,
        model: out.model,
        tier: input.tier,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        latencyMs,
        success: true,
        fallbackUsed,
        callerTag: input.callerTag,
      });
      return { ...out, latencyMs, fallbackUsed };
    } catch (err) {
      lastErr = err;
      fallbackUsed = true; // anything past the primary counts as fallback used
    }
  }

  const latencyMs = Date.now() - start;
  void emitLLMCallEvent({
    provider: tier.primary.provider,
    model: tier.primary.model,
    tier: input.tier,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs,
    success: false,
    fallbackUsed,
    callerTag: input.callerTag,
    error: (lastErr as Error)?.message ?? 'unknown',
  });
  throw lastErr;
}

export async function embed(input: LLMEmbedInput): Promise<LLMEmbedResult> {
  const entry = TIER_MAP.embedding.primary;
  const start = Date.now();
  try {
    const resp = await withRetry(() =>
      openaiClient().embeddings.create({ model: entry.model, input: input.text }),
    );
    const latencyMs = Date.now() - start;
    const inputTokens = resp.usage?.prompt_tokens ?? 0;
    void emitLLMCallEvent({
      provider: 'openai',
      model: entry.model,
      tier: 'embedding',
      inputTokens,
      outputTokens: 0,
      latencyMs,
      success: true,
      fallbackUsed: false,
      callerTag: input.callerTag,
    });
    return {
      embeddings: resp.data.map((d) => d.embedding),
      provider: 'openai',
      model: entry.model,
      inputTokens,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    void emitLLMCallEvent({
      provider: 'openai',
      model: entry.model,
      tier: 'embedding',
      inputTokens: 0,
      outputTokens: 0,
      latencyMs,
      success: false,
      fallbackUsed: false,
      callerTag: input.callerTag,
      error: (err as Error)?.message ?? 'unknown',
    });
    throw err;
  }
}

// ─────────────────────────────────────────────
// Cost-tracking event
// ─────────────────────────────────────────────

const LLM_CALL_TOPIC = 'llm.call';

export interface LLMCallEvent {
  eventId: string;
  eventType: 'llm.call';
  publishedAt: string;
  provider: LLMProvider;
  model: string;
  tier: LLMTier;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  success: boolean;
  fallbackUsed: boolean;
  callerTag?: string;
  error?: string;
}

async function emitLLMCallEvent(
  data: Omit<LLMCallEvent, 'eventId' | 'eventType' | 'publishedAt'>,
): Promise<void> {
  if (!_pubsub) return;
  const event: LLMCallEvent = {
    eventId: `evt_${randomUUID()}`,
    eventType: 'llm.call',
    publishedAt: new Date().toISOString(),
    ...data,
  };
  try {
    await _pubsub.publish(LLM_CALL_TOPIC, Buffer.from(JSON.stringify(event)), {
      eventType: 'llm.call',
      provider: event.provider,
      model: event.model,
      tier: event.tier,
    });
  } catch (err) {
    // Cost-tracking is best-effort. If the topic doesn't exist yet (until
    // the gcloud topic create lands) or the publish fails, we log and move
    // on — never break an LLM call because telemetry failed.
    console.error('[llm-client] cost-event publish failed', err);
  }
}
