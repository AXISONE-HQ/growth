/**
 * KAN-745 PR A — llm.call event shape + cost computation tests.
 *
 * Coverage:
 *   - MODEL_PRICING table covers every model in TIER_MAP
 *   - computeCostUsd math is correct for input + output tokens
 *   - computeCostUsd returns 0 for unknown models (defensive)
 *   - emitted llm.call events carry tenantId + costUsd + pricingVersion
 *   - failure-path emit also carries tenantId + costUsd=0
 *   - test seam swaps both anthropic + pubsub mocks atomically
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  complete,
  computeCostUsd,
  MODEL_PRICING,
  MODEL_PRICING_VERSION,
  TIER_MAP,
  __setLLMClientsForTest,
} from "../llm-client.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";

describe("KAN-745 PR A — MODEL_PRICING table coverage", () => {
  it("covers every model in TIER_MAP", () => {
    const tierModels = Object.values(TIER_MAP).flatMap((tc) => {
      const r = [tc.primary.model];
      if (tc.fallback) r.push(tc.fallback.model);
      return r;
    });
    for (const model of tierModels) {
      expect(MODEL_PRICING).toHaveProperty(model);
    }
  });

  it("MODEL_PRICING_VERSION is a non-empty string", () => {
    expect(typeof MODEL_PRICING_VERSION).toBe("string");
    expect(MODEL_PRICING_VERSION.length).toBeGreaterThan(0);
  });
});

describe("KAN-745 PR A — computeCostUsd math", () => {
  it("computes input + output cost from per-million-token rates", () => {
    // Sonnet 4-6: $3/M input, $15/M output
    // 1000 input tokens = $0.003; 500 output tokens = $0.0075; total $0.0105
    const cost = computeCostUsd("claude-sonnet-4-6", 1000, 500);
    expect(cost).toBeCloseTo(0.0105, 5);
  });

  it("returns 0 for unknown models (defensive — aggregator flags zero rows)", () => {
    expect(computeCostUsd("nonexistent-model-v9", 10000, 5000)).toBe(0);
  });

  it("handles embedding models (no output tokens)", () => {
    // text-embedding-3-small: $0.02/M input
    expect(computeCostUsd("text-embedding-3-small", 1_000_000, 0)).toBeCloseTo(0.02, 5);
  });
});

describe("KAN-745 PR A — llm.call event payload", () => {
  beforeEach(() => {
    __setLLMClientsForTest({ anthropic: null, openai: null, pubsub: null });
  });

  it("emits an event carrying tenantId + costUsd + pricingVersion on success", async () => {
    const captured: Array<{ topic: string; data: Buffer; attrs: Record<string, string> }> = [];
    const fakePubsub = {
      publish: vi.fn(async (topic: string, data: Buffer, attrs: Record<string, string>) => {
        captured.push({ topic, data, attrs });
        return "msg-1";
      }),
    };
    const fakeAnthropic = {
      messages: {
        create: vi.fn(async () => ({
          id: "msg_a",
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 50 },
        })),
      },
    };
    __setLLMClientsForTest({ anthropic: fakeAnthropic as never, pubsub: fakePubsub });

    const result = await complete({
      tenantId: TENANT_A,
      tier: "cheap",
      userPrompt: "hi",
      callerTag: "test:happy-path",
    });
    expect(result.text).toBe("hello");

    expect(captured).toHaveLength(1);
    const event = JSON.parse(captured[0].data.toString()) as Record<string, unknown>;
    expect(event.tenantId).toBe(TENANT_A);
    expect(event.callerTag).toBe("test:happy-path");
    expect(event.tier).toBe("cheap");
    expect(event.success).toBe(true);
    expect(event.inputTokens).toBe(100);
    expect(event.outputTokens).toBe(50);
    expect(event.pricingVersion).toBe(MODEL_PRICING_VERSION);
    // Haiku 4.5: $1/M input + $5/M output → 100*1e-6 + 50*5e-6 = 0.0001 + 0.00025 = 0.00035
    expect(event.costUsd).toBeCloseTo(0.00035, 6);

    // Pub/Sub attributes carry tenantId for subscription-side filtering
    expect(captured[0].attrs.tenantId).toBe(TENANT_A);
  });

  it("emits failure-path event with costUsd=0 when both provider tiers fail", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const fakePubsub = {
      publish: vi.fn(async (_topic: string, data: Buffer) => {
        captured.push(JSON.parse(data.toString()));
        return "msg-fail";
      }),
    };
    const failingAnthropic = {
      messages: {
        create: vi.fn(async () => {
          const err = new Error("anthropic 500") as Error & { status?: number };
          err.status = 500;
          throw err;
        }),
      },
    };
    const failingOpenAI = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            const err = new Error("openai 500") as Error & { status?: number };
            err.status = 500;
            throw err;
          }),
        },
      },
    };
    __setLLMClientsForTest({
      anthropic: failingAnthropic as never,
      openai: failingOpenAI as never,
      pubsub: fakePubsub,
    });

    await expect(
      complete({
        tenantId: TENANT_A,
        tier: "cheap",
        userPrompt: "x",
        callerTag: "test:both-fail",
      }),
    ).rejects.toBeTruthy();

    expect(captured).toHaveLength(1);
    expect(captured[0].tenantId).toBe(TENANT_A);
    expect(captured[0].success).toBe(false);
    expect(captured[0].costUsd).toBe(0);
    expect(captured[0].fallbackUsed).toBe(true);
  });
});
