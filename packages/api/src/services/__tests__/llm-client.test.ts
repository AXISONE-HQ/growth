/**
 * Tests for KAN-699 llm-client.
 *
 * Coverage:
 *   - Tier → provider chain resolution (TIER_MAP shape contract)
 *   - Retry: 429 once → succeed (single SDK call boundary)
 *   - Fallback: anthropic 429 persistent → openai succeeds (fallbackUsed=true)
 *   - Cost-tracking llm.call event shape on success + on failure
 *   - Retry exhaustion + fallback exhaustion → throw, with failed-call event
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import {
  TIER_MAP,
  complete,
  __setLLMClientsForTest,
  type LLMCallEvent,
} from '../llm-client.js';
import type { PubSubClient } from '../action-decided-publisher.js';

// ─────────────────────────────────────────────
// SDK mock factories — shape only what llm-client touches.
// ─────────────────────────────────────────────

function makeAnthropicMock(create: ReturnType<typeof vi.fn>) {
  return { messages: { create } } as unknown as Anthropic;
}

function makeOpenAIMock(create: ReturnType<typeof vi.fn>) {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

function makePubSubMock() {
  return { publish: vi.fn(async () => 'msg-id') } as unknown as PubSubClient;
}

function anthropicTextResponse(text: string, inputTokens = 10, outputTokens = 20) {
  return {
    content: [{ type: 'text' as const, text }],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function openaiChatResponse(text: string, prompt = 8, completion = 16) {
  return {
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: prompt, completion_tokens: completion },
  };
}

function rateLimitError() {
  const err = new Error('rate limit') as Error & { status: number };
  err.status = 429;
  return err;
}

beforeEach(() => {
  vi.restoreAllMocks();
  __setLLMClientsForTest({ anthropic: null, openai: null, pubsub: null });
});

// ─────────────────────────────────────────────
// Tier → model resolution
// ─────────────────────────────────────────────

describe('llm-client TIER_MAP', () => {
  it('reasoning → claude-sonnet-4-6 primary, gpt-4o fallback', () => {
    expect(TIER_MAP.reasoning.primary).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    expect(TIER_MAP.reasoning.fallback).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('cheap → claude-haiku-4-5 primary, gpt-4o-mini fallback', () => {
    expect(TIER_MAP.cheap.primary).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    });
    expect(TIER_MAP.cheap.fallback).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
  });

  it('embedding → openai text-embedding-3-small (no V1 fallback)', () => {
    expect(TIER_MAP.embedding.primary).toEqual({
      provider: 'openai',
      model: 'text-embedding-3-small',
    });
    expect(TIER_MAP.embedding.fallback).toBeUndefined();
  });
});

// ─────────────────────────────────────────────
// complete() — primary path + tier wiring
// ─────────────────────────────────────────────

describe('llm-client complete()', () => {
  it('cheap tier routes to anthropic Haiku and returns text + usage', async () => {
    const anthropicCreate = vi.fn(async () => anthropicTextResponse('hello world'));
    __setLLMClientsForTest({ anthropic: makeAnthropicMock(anthropicCreate) });

    const out = await complete({ tier: 'cheap', userPrompt: 'hi' });

    expect(out.text).toBe('hello world');
    expect(out.provider).toBe('anthropic');
    expect(out.model).toBe('claude-haiku-4-5-20251001');
    expect(out.inputTokens).toBe(10);
    expect(out.outputTokens).toBe(20);
    expect(out.fallbackUsed).toBe(false);
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(anthropicCreate.mock.calls[0][0]).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
    });
  });

  it('reasoning tier routes to anthropic Sonnet 4.6', async () => {
    const anthropicCreate = vi.fn(async () => anthropicTextResponse('reason'));
    __setLLMClientsForTest({ anthropic: makeAnthropicMock(anthropicCreate) });

    const out = await complete({ tier: 'reasoning', userPrompt: 'think' });

    expect(out.model).toBe('claude-sonnet-4-6');
    expect(out.provider).toBe('anthropic');
  });
});

// ─────────────────────────────────────────────
// Retry on transient errors
// ─────────────────────────────────────────────

describe('llm-client retry behavior', () => {
  it('retries once on 429 then succeeds', async () => {
    let calls = 0;
    const anthropicCreate = vi.fn(async () => {
      calls++;
      if (calls === 1) throw rateLimitError();
      return anthropicTextResponse('after-retry');
    });
    __setLLMClientsForTest({ anthropic: makeAnthropicMock(anthropicCreate) });

    const out = await complete({ tier: 'cheap', userPrompt: 'x' });

    expect(out.text).toBe('after-retry');
    expect(out.fallbackUsed).toBe(false);
    expect(anthropicCreate).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on non-retryable errors (e.g., 400)', async () => {
    const err = new Error('bad request') as Error & { status: number };
    err.status = 400;
    const anthropicCreate = vi.fn(async () => {
      throw err;
    });
    const openaiCreate = vi.fn(async () => openaiChatResponse('fallback'));
    __setLLMClientsForTest({
      anthropic: makeAnthropicMock(anthropicCreate),
      openai: makeOpenAIMock(openaiCreate),
    });

    // 400 is not retryable → primary throws immediately → fallback runs.
    const out = await complete({ tier: 'cheap', userPrompt: 'x' });

    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(out.provider).toBe('openai');
    expect(out.fallbackUsed).toBe(true);
  });
});

// ─────────────────────────────────────────────
// Fallback to alternate provider
// ─────────────────────────────────────────────

describe('llm-client provider fallback', () => {
  it('persistent anthropic 429 → openai fallback succeeds with fallbackUsed=true', async () => {
    const anthropicCreate = vi.fn(async () => {
      throw rateLimitError();
    });
    const openaiCreate = vi.fn(async () => openaiChatResponse('from openai'));
    __setLLMClientsForTest({
      anthropic: makeAnthropicMock(anthropicCreate),
      openai: makeOpenAIMock(openaiCreate),
    });

    const out = await complete({ tier: 'cheap', userPrompt: 'x' });

    expect(out.provider).toBe('openai');
    expect(out.model).toBe('gpt-4o-mini');
    expect(out.text).toBe('from openai');
    expect(out.fallbackUsed).toBe(true);
    // Anthropic exhausted both retry attempts before falling back.
    expect(anthropicCreate).toHaveBeenCalledTimes(2);
    expect(openaiCreate).toHaveBeenCalledTimes(1);
  });

  it('JSON mode passes response_format to openai', async () => {
    const anthropicCreate = vi.fn(async () => {
      throw rateLimitError();
    });
    const openaiCreate = vi.fn(async () => openaiChatResponse('{"a":1}'));
    __setLLMClientsForTest({
      anthropic: makeAnthropicMock(anthropicCreate),
      openai: makeOpenAIMock(openaiCreate),
    });

    await complete({ tier: 'cheap', userPrompt: 'x', jsonMode: true });

    expect(openaiCreate.mock.calls[0][0]).toMatchObject({
      response_format: { type: 'json_object' },
    });
  });

  it('both providers fail → throws and emits failed cost event', async () => {
    const anthropicCreate = vi.fn(async () => {
      throw rateLimitError();
    });
    const openaiCreate = vi.fn(async () => {
      throw rateLimitError();
    });
    const pubsub = makePubSubMock();
    __setLLMClientsForTest({
      anthropic: makeAnthropicMock(anthropicCreate),
      openai: makeOpenAIMock(openaiCreate),
      pubsub,
    });

    await expect(complete({ tier: 'cheap', userPrompt: 'x' })).rejects.toThrow();

    // Both providers tried, each retried once → 4 total SDK invocations.
    expect(anthropicCreate).toHaveBeenCalledTimes(2);
    expect(openaiCreate).toHaveBeenCalledTimes(2);

    // One failed cost event emitted.
    expect((pubsub.publish as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    const [topic, dataBuffer] = (pubsub.publish as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(topic).toBe('llm.call');
    const event = JSON.parse((dataBuffer as Buffer).toString('utf8')) as LLMCallEvent;
    expect(event.success).toBe(false);
    expect(event.fallbackUsed).toBe(true);
  });
});

// ─────────────────────────────────────────────
// Cost-tracking event shape
// ─────────────────────────────────────────────

describe('llm-client llm.call event', () => {
  it('emits success event with provider, model, tier, tokens, latency, fallbackUsed', async () => {
    const anthropicCreate = vi.fn(async () => anthropicTextResponse('ok', 7, 13));
    const pubsub = makePubSubMock();
    __setLLMClientsForTest({
      anthropic: makeAnthropicMock(anthropicCreate),
      pubsub,
    });

    await complete({
      tier: 'cheap',
      userPrompt: 'x',
      callerTag: 'unit-test',
    });

    const calls = (pubsub.publish as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    const [topic, dataBuffer, attributes] = calls[0];
    expect(topic).toBe('llm.call');
    expect(attributes).toMatchObject({
      eventType: 'llm.call',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      tier: 'cheap',
    });
    const event = JSON.parse((dataBuffer as Buffer).toString('utf8')) as LLMCallEvent;
    expect(event.eventType).toBe('llm.call');
    expect(event.provider).toBe('anthropic');
    expect(event.model).toBe('claude-haiku-4-5-20251001');
    expect(event.tier).toBe('cheap');
    expect(event.inputTokens).toBe(7);
    expect(event.outputTokens).toBe(13);
    expect(event.success).toBe(true);
    expect(event.fallbackUsed).toBe(false);
    expect(event.callerTag).toBe('unit-test');
    expect(typeof event.latencyMs).toBe('number');
    expect(event.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('emits event with fallbackUsed=true when fallback succeeds', async () => {
    const anthropicCreate = vi.fn(async () => {
      throw rateLimitError();
    });
    const openaiCreate = vi.fn(async () => openaiChatResponse('fb'));
    const pubsub = makePubSubMock();
    __setLLMClientsForTest({
      anthropic: makeAnthropicMock(anthropicCreate),
      openai: makeOpenAIMock(openaiCreate),
      pubsub,
    });

    await complete({ tier: 'cheap', userPrompt: 'x' });

    const calls = (pubsub.publish as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    const event = JSON.parse((calls[0][1] as Buffer).toString('utf8')) as LLMCallEvent;
    expect(event.provider).toBe('openai');
    expect(event.fallbackUsed).toBe(true);
    expect(event.success).toBe(true);
  });

  it('skips event emission when no publisher is wired (unset = no-op)', async () => {
    const anthropicCreate = vi.fn(async () => anthropicTextResponse('ok'));
    __setLLMClientsForTest({
      anthropic: makeAnthropicMock(anthropicCreate),
      pubsub: null,
    });

    // Just must not throw.
    await complete({ tier: 'cheap', userPrompt: 'x' });
  });

  it('cost-event publish failure does not break the LLM call', async () => {
    const anthropicCreate = vi.fn(async () => anthropicTextResponse('ok'));
    const pubsub = {
      publish: vi.fn(async () => {
        throw new Error('pubsub down');
      }),
    } as unknown as PubSubClient;
    __setLLMClientsForTest({
      anthropic: makeAnthropicMock(anthropicCreate),
      pubsub,
    });

    const out = await complete({ tier: 'cheap', userPrompt: 'x' });
    expect(out.text).toBe('ok');
  });
});
