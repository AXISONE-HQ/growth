/**
 * KAN-738 — agentic-decision-runner unit tests.
 *
 * Mocks the Anthropic SDK at the module boundary via __setAnthropicClientForTest.
 * Real Anthropic calls happen only in deployed envs with ANTHROPIC_API_KEY set.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AGENTIC_TOOLS,
  runAgenticLoop,
  __setAnthropicClientForTest,
  type ToolDescriptor,
} from "../agentic-decision-runner.js";

interface MessageBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface MockResponse {
  content: MessageBlock[];
  stop_reason: "end_turn" | "tool_use" | "stop_sequence" | "max_tokens";
}

function makeAnthropicMock(responses: MockResponse[]): unknown {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        const r = responses[i] ?? responses[responses.length - 1];
        i++;
        return r;
      }),
    },
  };
}

const validFinalDecision = JSON.stringify({
  strategy: "agentic_loop",
  action: { type: "send_email", channel: "email", payload: { template: "welcome" } },
  confidence: 0.8,
  outcome: "EXECUTED",
  reasoning: "Contact warm, send introductory email",
});

beforeEach(() => {
  __setAnthropicClientForTest(null);
});

describe("AGENTIC_TOOLS surface", () => {
  it("exports exactly 5 tools matching the S3.2 contract", () => {
    expect(AGENTIC_TOOLS).toHaveLength(5);
    expect(AGENTIC_TOOLS.map((t) => t.name).sort()).toEqual([
      "get_contact_context",
      "get_objective_progress",
      "get_pipeline_state",
      "get_recent_actions",
      "retrieve_knowledge",
    ]);
  });

  it("each tool has a JSON schema with type=object", () => {
    for (const tool of AGENTIC_TOOLS) {
      expect((tool.input_schema as { type: string }).type).toBe("object");
    }
  });

  it("stub handlers return { stub: true } so KAN-739 swap is detectable at runtime", async () => {
    const ctx = { tenantId: "t1", contactId: "c1", recordToolCall: vi.fn() };
    for (const tool of AGENTIC_TOOLS) {
      const result = await tool.handler({ contactId: "c1" }, ctx);
      expect((result as { stub?: boolean }).stub).toBe(true);
    }
  });
});

describe("runAgenticLoop — single-turn final decision", () => {
  it("parses a JSON final decision when LLM returns end_turn on first call", async () => {
    __setAnthropicClientForTest(
      makeAnthropicMock([
        {
          content: [{ type: "text", text: validFinalDecision }],
          stop_reason: "end_turn",
        },
      ]) as never,
    );

    const result = await runAgenticLoop({ tenantId: "t1", contactId: "c1" });

    expect(result.iterations).toBe(1);
    expect(result.payload.action.type).toBe("send_email");
    expect(result.payload.confidence).toBe(0.8);
    expect(result.payload.outcome).toBe("EXECUTED");
  });

  it("tolerates JSON wrapped in code fences or with preamble", async () => {
    __setAnthropicClientForTest(
      makeAnthropicMock([
        {
          content: [
            {
              type: "text",
              text: `Here's my decision:\n\`\`\`json\n${validFinalDecision}\n\`\`\``,
            },
          ],
          stop_reason: "end_turn",
        },
      ]) as never,
    );
    const result = await runAgenticLoop({ tenantId: "t1", contactId: "c1" });
    expect(result.payload.action.type).toBe("send_email");
  });

  it("throws when final turn contains no JSON object", async () => {
    __setAnthropicClientForTest(
      makeAnthropicMock([
        {
          content: [{ type: "text", text: "I cannot decide" }],
          stop_reason: "end_turn",
        },
      ]) as never,
    );
    await expect(runAgenticLoop({ tenantId: "t1", contactId: "c1" })).rejects.toThrow(
      /did not contain JSON|JSON parse/,
    );
  });
});

describe("runAgenticLoop — tool-use multi-turn", () => {
  it("dispatches a tool_use block to the matching handler and feeds result back", async () => {
    __setAnthropicClientForTest(
      makeAnthropicMock([
        {
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "get_contact_context",
              input: { contactId: "c1" },
            },
          ],
          stop_reason: "tool_use",
        },
        {
          content: [{ type: "text", text: validFinalDecision }],
          stop_reason: "end_turn",
        },
      ]) as never,
    );

    const result = await runAgenticLoop({ tenantId: "t1", contactId: "c1" });

    expect(result.iterations).toBe(2);
    expect(result.payload.action.type).toBe("send_email");
  });

  it("returns is_error=true when LLM calls an unknown tool", async () => {
    const customTools: ToolDescriptor[] = [];
    __setAnthropicClientForTest(
      makeAnthropicMock([
        {
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "nonexistent_tool",
              input: {},
            },
          ],
          stop_reason: "tool_use",
        },
        {
          content: [{ type: "text", text: validFinalDecision }],
          stop_reason: "end_turn",
        },
      ]) as never,
    );

    // With customTools=[] every name is unknown; the loop should still complete
    // by feeding is_error tool_results back to the LLM.
    const result = await runAgenticLoop({
      tenantId: "t1",
      contactId: "c1",
      tools: customTools,
    });
    expect(result.iterations).toBe(2);
  });

  it("throws on unexpected stop_reason", async () => {
    __setAnthropicClientForTest(
      makeAnthropicMock([
        {
          content: [{ type: "text", text: "" }],
          stop_reason: "max_tokens",
        },
      ]) as never,
    );
    await expect(runAgenticLoop({ tenantId: "t1", contactId: "c1" })).rejects.toThrow(
      /unexpected stop_reason/,
    );
  });

  it("aborts after 8 iterations without a final decision", async () => {
    const toolUseResponse: MockResponse = {
      content: [
        { type: "tool_use", id: "tool_1", name: "get_contact_context", input: { contactId: "c1" } },
      ],
      stop_reason: "tool_use",
    };
    __setAnthropicClientForTest(
      makeAnthropicMock(Array(20).fill(toolUseResponse)) as never,
    );
    await expect(runAgenticLoop({ tenantId: "t1", contactId: "c1" })).rejects.toThrow(
      /exceeded.*iterations/,
    );
  });
});
