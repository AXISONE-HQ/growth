/**
 * KAN-734 — csv-import migration to llm-client.
 *
 * Verifies the column-mapping inference path now goes through llm-client
 * (tier:'cheap' = claude-haiku-4-5-20251001) and emits an llm.call cost
 * event with the right tenantId + caller tag. Direct anthropic.messages.create
 * is gone post-migration; the test injects the llm-client seam, NOT a raw
 * Anthropic mock.
 *
 * Behavior change documented: model upgrade from claude-3-haiku-20240307
 * (Mar 2024) → claude-haiku-4-5-20251001 (Oct 2025). Pre-merge manual smoke
 * uses __fixtures__/csv-import-baseline.csv to verify mapping fidelity.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { __setLLMClientsForTest } from "../llm-client.js";
import { runHaikuFieldMapping } from "../csv-import-haiku-mapping.js";

const TENANT_A = "11111111-1111-1111-1111-111111111111";

function makeAnthropicMock(handler: (args: any) => Promise<any>): any {
  return {
    messages: {
      create: vi.fn(handler),
    },
  };
}

beforeEach(() => {
  __setLLMClientsForTest({ anthropic: null, openai: null, pubsub: null });
});

describe("KAN-734 — csv-import routes through llm-client", () => {
  it("emits llm.call event with tenantId + callerTag csv-import:column-mapping", async () => {
    const publish = vi.fn().mockResolvedValue("msg-1");
    const fakePubsub = { publish };

    // Haiku response shaped as the JSON array runHaikuFieldMapping expects.
    const create = vi.fn(async () => ({
      id: "msg_test",
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { csvColumn: "email", targetField: "email", confidence: 0.99, reasoning: "exact match" },
            { csvColumn: "first_name", targetField: "firstName", confidence: 0.95, reasoning: "fname" },
          ]),
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 250, output_tokens: 100 },
    }));

    __setLLMClientsForTest({
      anthropic: makeAnthropicMock(create),
      pubsub: fakePubsub,
    });

    const mappings = await runHaikuFieldMapping(
      ["email", "first_name"],
      [{ email: "test@example.com", first_name: "Sarah" }],
      TENANT_A,
    );

    expect(mappings).toHaveLength(2);
    expect(mappings[0]!.csvColumn).toBe("email");
    expect(mappings[0]!.targetField).toBe("email");

    expect(create).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();

    const [topic, dataBuf] = publish.mock.calls[0]!;
    expect(topic).toBe("llm.call");
    const event = JSON.parse((dataBuf as Buffer).toString("utf8"));
    expect(event.tenantId).toBe(TENANT_A);
    expect(event.callerTag).toBe("csv-import:column-mapping");
    expect(event.tier).toBe("cheap");
    // Haiku 4.5 (claude-haiku-4-5-20251001) — not the legacy 3.0 model.
    expect(event.model).toBe("claude-haiku-4-5-20251001");
    expect(event.inputTokens).toBe(250);
    expect(event.outputTokens).toBe(100);
    expect(event.costUsd).toBeGreaterThan(0);
  });

  it("falls back to heuristic mapping when LLM returns malformed JSON", async () => {
    const create = vi.fn(async () => ({
      id: "msg_bad",
      content: [{ type: "text", text: "not a json array" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    }));

    __setLLMClientsForTest({
      anthropic: makeAnthropicMock(create),
      pubsub: null, // no cost event needed for fallback assertion
    });

    const mappings = await runHaikuFieldMapping(
      ["email"],
      [{ email: "test@example.com" }],
      TENANT_A,
    );

    // Fallback path returns a result, not a throw. Concrete shape is heuristic-
    // dependent; the assertion is "we don't crash on bad LLM output".
    expect(Array.isArray(mappings)).toBe(true);
  });
});
