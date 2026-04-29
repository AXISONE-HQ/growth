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
// KAN-745 PR A — model pricing for cost-event computation
// ─────────────────────────────────────────────

/**
 * Per-model price per million tokens, USD. Used at `llm.call` emit time to
 * compute `costUsd` for the event payload.
 *
 * **REVIEW DISCIPLINE — quarterly:** Anthropic + OpenAI both adjust prices
 * periodically. The `MODEL_PRICING_VERSION` constant below is bumped on each
 * refresh so observability data can be filtered by which pricing snapshot
 * was active. See `feedback_model_pricing_refresh_discipline` memory entry
 * for the audit checklist.
 *
 * Values below are placeholders matched to publicly-listed pricing as of
 * the constant's `version` date. Operator review required before going live
 * with real billing — small discrepancies in cost ratios are tolerable for
 * the shadow-vs-rules threshold use case (KAN-745), but absolute cost
 * reporting will need true-up.
 *
 * Sources:
 *   - Anthropic: https://www.anthropic.com/pricing
 *   - OpenAI:    https://openai.com/api/pricing/
 */
export const MODEL_PRICING_VERSION = '2026-04-29-v1';

interface ModelPrice {
  /** USD per 1M input tokens */
  inputPerMillion: number;
  /** USD per 1M output tokens */
  outputPerMillion: number;
}

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Anthropic — reasoning + cheap tiers
  'claude-sonnet-4-6': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  // OpenAI — fallback chain
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  // OpenAI — embedding tier (no output tokens)
  'text-embedding-3-small': { inputPerMillion: 0.02, outputPerMillion: 0 },
};

/**
 * Compute USD cost for a given (model, inputTokens, outputTokens) tuple.
 * Returns 0 for unknown models — better than throwing in the cost-tracking
 * hot path; aggregator (KAN-745 PR B) flags zero-cost rows for review.
 */
export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = MODEL_PRICING[model];
  if (!price) return 0;
  return (
    (inputTokens / 1_000_000) * price.inputPerMillion +
    (outputTokens / 1_000_000) * price.outputPerMillion
  );
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export interface LLMCompleteInput {
  /**
   * KAN-745 PR A: tenantId is required so the `llm.call` event can be
   * partitioned per-tenant downstream. Caller must thread it through from
   * the request context.
   */
  tenantId: string;
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
  /**
   * KAN-745 PR A: optional Anthropic-specific extras (tools + multi-turn
   * messages + stop_sequences) for the agentic loop. When present, the
   * Anthropic provider path uses these instead of the default single-turn
   * `userPrompt → text` shape. OpenAI fallback isn't wired for tool-use
   * yet — agentic callers stay anthropic-only by tier choice + this is
   * fine for the shadow-mode use case.
   */
  anthropicExtras?: {
    /** Multi-turn messages. When set, takes precedence over `userPrompt`. */
    messages?: AnthropicMessageParam[];
    /** Tool definitions for Anthropic's tool-use loop. */
    tools?: AnthropicToolParam[];
  };
}

/** Subset of @anthropic-ai/sdk's MessageParam — kept here to avoid leaking the SDK type. */
export interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
        | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
      >;
}

export interface AnthropicToolParam {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
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
  /**
   * KAN-745 PR A: Anthropic-specific raw response when `anthropicExtras` was
   * provided and the call took the Anthropic path. Lets agentic callers read
   * `stop_reason` and structured `content` blocks (tool_use / text).
   */
  anthropicRaw?: AnthropicRawResponse;
}

/** Subset of @anthropic-ai/sdk's Message — exposed so the agentic loop can read tool_use blocks + stop_reason. */
export interface AnthropicRawResponse {
  id: string;
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface LLMEmbedInput {
  /** KAN-745 PR A: tenantId required for per-tenant cost partition. */
  tenantId: string;
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
  // KAN-745 PR A: when anthropicExtras present, pass tools + multi-turn
  // messages through. agentic-decision-runner uses this path; everyone
  // else stays on the simple userPrompt → text shape.
  const messages = input.anthropicExtras?.messages
    ? input.anthropicExtras.messages
    : [{ role: 'user' as const, content: input.userPrompt }];

  const resp = await anthropicClient().messages.create({
    model,
    max_tokens: input.maxTokens ?? 1024,
    ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
    messages: messages as never,
    ...(input.anthropicExtras?.tools ? { tools: input.anthropicExtras.tools as never } : {}),
  });

  // For agentic (tool-use) callers, return the full content array via
  // anthropicRaw so they can branch on stop_reason + read tool_use blocks.
  // text comes from the FIRST text block (or empty if none — agentic loop
  // is allowed to produce tool_use-only turns).
  const textContent = resp.content.find((c) => c.type === 'text');
  const textValue = textContent && textContent.type === 'text' ? textContent.text : '';

  // Robust against test mocks that omit `usage` — production responses
  // always carry it, but tests that don't care about cost-tracking pass
  // partial shapes. Default to 0/0 so the surrounding cost-event emit
  // doesn't throw at access time.
  const inputTokens = resp.usage?.input_tokens ?? 0;
  const outputTokens = resp.usage?.output_tokens ?? 0;

  return {
    text: textValue,
    provider: 'anthropic',
    model,
    inputTokens,
    outputTokens,
    anthropicRaw: {
      id: resp.id ?? 'msg_test',
      content: resp.content as AnthropicRawResponse['content'],
      stop_reason: resp.stop_reason as AnthropicRawResponse['stop_reason'],
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
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
        tenantId: input.tenantId,
        provider: out.provider,
        model: out.model,
        tier: input.tier,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        costUsd: computeCostUsd(out.model, out.inputTokens, out.outputTokens),
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
    tenantId: input.tenantId,
    provider: tier.primary.provider,
    model: tier.primary.model,
    tier: input.tier,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
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
      tenantId: input.tenantId,
      provider: 'openai',
      model: entry.model,
      tier: 'embedding',
      inputTokens,
      outputTokens: 0,
      costUsd: computeCostUsd(entry.model, inputTokens, 0),
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
      tenantId: input.tenantId,
      provider: 'openai',
      model: entry.model,
      tier: 'embedding',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
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
  /** KAN-745 PR A: tenantId for per-tenant aggregation downstream. */
  tenantId: string;
  provider: LLMProvider;
  model: string;
  tier: LLMTier;
  inputTokens: number;
  outputTokens: number;
  /** KAN-745 PR A: USD cost computed from MODEL_PRICING table at emit time. */
  costUsd: number;
  /** KAN-745 PR A: which pricing snapshot was active when this event emitted. */
  pricingVersion: string;
  latencyMs: number;
  success: boolean;
  fallbackUsed: boolean;
  callerTag?: string;
  error?: string;
}

async function emitLLMCallEvent(
  data: Omit<LLMCallEvent, 'eventId' | 'eventType' | 'publishedAt' | 'pricingVersion'>,
): Promise<void> {
  if (!_pubsub) return;
  const event: LLMCallEvent = {
    eventId: `evt_${randomUUID()}`,
    eventType: 'llm.call',
    publishedAt: new Date().toISOString(),
    pricingVersion: MODEL_PRICING_VERSION,
    ...data,
  };
  try {
    await _pubsub.publish(LLM_CALL_TOPIC, Buffer.from(JSON.stringify(event)), {
      eventType: 'llm.call',
      tenantId: event.tenantId,
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
