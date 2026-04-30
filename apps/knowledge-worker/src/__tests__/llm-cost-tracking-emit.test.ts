/**
 * KAN-734 — emitLLMCallEvent shape + best-effort behavior.
 *
 * The stateless emitter is the contract apps/api (via llm-client) and
 * apps/knowledge-worker (via the default embedFn) both depend on. Verify:
 *   - eventId/publishedAt/pricingVersion auto-populated
 *   - publish() called with the llm.call topic + the right attributes
 *   - publisher absence (null/undefined) is a no-op (never throws)
 *   - publisher failure is swallowed (logged, not thrown)
 */
import { describe, it, expect, vi } from "vitest";
import { emitLLMCallEvent, MODEL_PRICING_VERSION } from "@growth/llm-cost-tracking";
import type { PubSubClient, LLMCallEvent } from "@growth/llm-cost-tracking";

describe("KAN-734 — emitLLMCallEvent", () => {
  it("populates eventId/publishedAt/pricingVersion + forwards to publisher", async () => {
    const publish = vi.fn().mockResolvedValue("msg-1");
    const pubsub: PubSubClient = { publish };

    await emitLLMCallEvent({
      pubsub,
      event: {
        tenantId: "tenant-A",
        provider: "openai",
        model: "text-embedding-3-small",
        tier: "embedding",
        inputTokens: 100,
        outputTokens: 0,
        costUsd: 0.000002,
        latencyMs: 42,
        success: true,
        fallbackUsed: false,
        callerTag: "knowledge-worker:embed",
      },
    });

    expect(publish).toHaveBeenCalledOnce();
    const [topic, dataBuf, attrs] = publish.mock.calls[0]!;
    expect(topic).toBe("llm.call");
    const event = JSON.parse((dataBuf as Buffer).toString("utf8")) as LLMCallEvent;
    expect(event.eventType).toBe("llm.call");
    expect(event.eventId).toMatch(/^evt_[0-9a-f-]{36}$/);
    expect(event.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
    expect(event.pricingVersion).toBe(MODEL_PRICING_VERSION);
    expect(event.tenantId).toBe("tenant-A");
    expect(event.callerTag).toBe("knowledge-worker:embed");
    expect(attrs).toMatchObject({
      eventType: "llm.call",
      tenantId: "tenant-A",
      provider: "openai",
      model: "text-embedding-3-small",
      tier: "embedding",
    });
  });

  it("no-ops when pubsub is null", async () => {
    await expect(
      emitLLMCallEvent({
        pubsub: null,
        event: {
          tenantId: "tenant-A",
          provider: "openai",
          model: "text-embedding-3-small",
          tier: "embedding",
          inputTokens: 100,
          outputTokens: 0,
          costUsd: 0,
          latencyMs: 1,
          success: true,
          fallbackUsed: false,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("no-ops when pubsub is undefined", async () => {
    await expect(
      emitLLMCallEvent({
        pubsub: undefined,
        event: {
          tenantId: "tenant-A",
          provider: "openai",
          model: "text-embedding-3-small",
          tier: "embedding",
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          latencyMs: 1,
          success: true,
          fallbackUsed: false,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("swallows publisher errors (best-effort; never breaks the LLM call)", async () => {
    const publish = vi.fn().mockRejectedValue(new Error("topic not found"));
    const pubsub: PubSubClient = { publish };
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      emitLLMCallEvent({
        pubsub,
        event: {
          tenantId: "tenant-A",
          provider: "openai",
          model: "text-embedding-3-small",
          tier: "embedding",
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          latencyMs: 1,
          success: true,
          fallbackUsed: false,
        },
      }),
    ).resolves.toBeUndefined();
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});
