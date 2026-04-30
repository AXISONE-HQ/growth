/**
 * KAN-734 — knowledge-worker default embedFn emits llm.call cost events.
 *
 * Tests the factory `makeDefaultEmbedFn` directly (exported from run-handler.ts)
 * with an OpenAI override + a mock cost publisher. Asserts every embed batch
 * triggers exactly one cost event with the right tenant + caller tag + model.
 *
 * Cross-tenant isolation guarded by the tenantId closure binding — two
 * embedFns built for two tenants emit events partitioned correctly.
 */
import { describe, it, expect, vi } from "vitest";
import { makeDefaultEmbedFn } from "../handlers/run-handler.js";
import type { PubSubClient, LLMCallEvent } from "@growth/llm-cost-tracking";

function buildFakeOpenAI(promptTokens: number, vec = 0.5) {
  return {
    embeddings: {
      create: vi.fn(async (args: { model: string; input: string | string[] }) => {
        const inputs = Array.isArray(args.input) ? args.input : [args.input];
        return {
          data: inputs.map(() => ({ embedding: Array(1536).fill(vec) })),
          usage: { prompt_tokens: promptTokens },
        };
      }),
    },
  };
}

describe("KAN-734 — knowledge-worker embed cost emission", () => {
  it("emits one llm.call event per batch with tenantId + caller tag", async () => {
    const publish = vi.fn().mockResolvedValue("msg-1");
    const pubsub: PubSubClient = { publish };
    const fakeOpenai = buildFakeOpenAI(150);
    const embedFn = makeDefaultEmbedFn("tenant-A", pubsub, fakeOpenai);

    const vectors = await embedFn(["hello", "world"]);
    expect(vectors).toHaveLength(2);
    expect(fakeOpenai.embeddings.create).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();

    const [topic, dataBuf, attrs] = publish.mock.calls[0]!;
    expect(topic).toBe("llm.call");
    const event = JSON.parse((dataBuf as Buffer).toString("utf8")) as LLMCallEvent;
    expect(event.tenantId).toBe("tenant-A");
    expect(event.provider).toBe("openai");
    expect(event.model).toBe("text-embedding-3-small");
    expect(event.tier).toBe("embedding");
    expect(event.inputTokens).toBe(150);
    expect(event.outputTokens).toBe(0);
    expect(event.callerTag).toBe("knowledge-worker:embed");
    // costUsd: 150 / 1M * $0.02 = $0.000003
    expect(event.costUsd).toBeCloseTo(0.000003, 8);
    expect(attrs).toMatchObject({ tenantId: "tenant-A", model: "text-embedding-3-small" });
  });

  it("emits separate events for separate batches", async () => {
    const publish = vi.fn().mockResolvedValue("msg-X");
    const pubsub: PubSubClient = { publish };
    const fakeOpenai = buildFakeOpenAI(100);
    const embedFn = makeDefaultEmbedFn("tenant-A", pubsub, fakeOpenai);

    await embedFn(["batch1-a", "batch1-b"]);
    await embedFn(["batch2-a", "batch2-b", "batch2-c"]);

    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("cross-tenant isolation: distinct embedFns publish with their own tenantId", async () => {
    const publish = vi.fn().mockResolvedValue("msg-X");
    const pubsub: PubSubClient = { publish };
    const fakeA = buildFakeOpenAI(50);
    const fakeB = buildFakeOpenAI(75);

    const embedA = makeDefaultEmbedFn("tenant-A", pubsub, fakeA);
    const embedB = makeDefaultEmbedFn("tenant-B", pubsub, fakeB);

    await embedA(["a"]);
    await embedB(["b"]);

    expect(publish).toHaveBeenCalledTimes(2);
    const eventA = JSON.parse(
      (publish.mock.calls[0]![1] as Buffer).toString("utf8"),
    ) as LLMCallEvent;
    const eventB = JSON.parse(
      (publish.mock.calls[1]![1] as Buffer).toString("utf8"),
    ) as LLMCallEvent;
    expect(eventA.tenantId).toBe("tenant-A");
    expect(eventA.inputTokens).toBe(50);
    expect(eventB.tenantId).toBe("tenant-B");
    expect(eventB.inputTokens).toBe(75);
  });

  it("missing cost publisher: embedFn still produces vectors (best-effort)", async () => {
    const fakeOpenai = buildFakeOpenAI(100);
    const embedFn = makeDefaultEmbedFn("tenant-A", undefined, fakeOpenai);
    const vectors = await embedFn(["hello"]);
    expect(vectors).toHaveLength(1);
    expect(fakeOpenai.embeddings.create).toHaveBeenCalledOnce();
  });
});
