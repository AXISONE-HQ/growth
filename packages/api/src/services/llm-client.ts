/**
 * llm-client — KAN-699 (Sprint 0.3) + KAN-734 (Sprint 5)
 *
 * Unified LLM provider abstraction. Wraps Anthropic (primary) + OpenAI (fallback)
 * SDKs behind one interface. Adds:
 *   - tier-based provider selection (reasoning / cheap / embedding)
 *   - retry on transient errors (429 / 5xx / network)
 *   - automatic fallback to alternate provider on persistent rate-limit
 *   - cost-tracking event emission to llm.call Pub/Sub topic
 *
 * KAN-734 extracted MODEL_PRICING / computeCostUsd / LLMCallEvent / emitLLMCallEvent
 * to `@growth/llm-cost-tracking` so apps/knowledge-worker can emit the same shape
 * for embedding cost coverage. Symbols are re-exported here for backward-compat
 * with existing test imports (kept zero-churn surface).
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  computeCostUsd,
  emitLLMCallEvent as emitCostEvent,
  MODEL_PRICING_VERSION,
  type LLMCallEvent,
  type LLMProvider,
  type LLMTier,
  type PubSubClient,
} from '@growth/llm-cost-tracking';

// Re-export the moved symbols so existing internal imports + test files
// continue to work unchanged. KAN-734's extraction is internal refactor;
// surface contract is preserved.
export { MODEL_PRICING, MODEL_PRICING_VERSION, computeCostUsd } from '@growth/llm-cost-tracking';
export type { LLMCallEvent, LLMProvider, LLMTier, PubSubClient } from '@growth/llm-cost-tracking';

// ─────────────────────────────────────────────
// Tier → provider chain
// ─────────────────────────────────────────────

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

/**
 * Thin wrapper that forwards the module-level `_pubsub` to the stateless
 * emitter in @growth/llm-cost-tracking. Keeps boot-time wiring (`setLLMCostPublisher`)
 * + test seam (`__setLLMClientsForTest`) backward-compatible.
 */
function emit(event: Omit<LLMCallEvent, 'eventId' | 'eventType' | 'publishedAt' | 'pricingVersion'>): void {
  void emitCostEvent({ pubsub: _pubsub, event });
}

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
      emit({
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
  emit({
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
    emit({
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
    emit({
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

void MODEL_PRICING_VERSION; // Tree-shake guard: keep the import live so re-export stays bound.
