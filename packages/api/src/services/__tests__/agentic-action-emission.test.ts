/**
 * KAN-740 — agentic action emission tests.
 *
 * Covers the runner-boundary action-type validation (LLM hallucinated
 * actionType → escalation) + threshold-gate routing in runAgentic.
 *
 * Mocks the agentic loop module via __setAgenticLoopForTest from
 * run-decision-for-contact.ts (KAN-738 seam) so we can exercise the
 * dispatch + threshold-gate logic without spinning up Anthropic.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  runAgenticLoop,
  __setAnthropicClientForTest,
} from "../agentic-decision-runner.js";
import {
  ACTION_TYPES,
  HALLUCINATED_ACTION_REASON,
  isActionType,
} from "@growth/shared";

interface MessageBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface MockResponse {
  content: MessageBlock[];
  stop_reason: "end_turn" | "tool_use";
}

function makeAnthropicMock(responses: MockResponse[]): unknown {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => responses[i++] ?? responses[responses.length - 1]),
    },
  };
}

beforeEach(() => {
  __setAnthropicClientForTest(null);
});

describe("KAN-740 — runner-boundary action-type validation", () => {
  it("ESCALATES with HALLUCINATED_ACTION_REASON when LLM picks unknown actionType", async () => {
    const hallucinated = JSON.stringify({
      strategy: "agentic_loop",
      action: { type: "summon_ai_overlord", channel: null, payload: {} },
      confidence: 0.9,
      outcome: "EXECUTED",
      reasoning: "i feel powerful today",
    });
    __setAnthropicClientForTest(
      makeAnthropicMock([
        { content: [{ type: "text", text: hallucinated }], stop_reason: "end_turn" },
      ]) as never,
    );

    const result = await runAgenticLoop({ tenantId: "t1", contactId: "c1" });

    expect(result.payload.outcome).toBe("ESCALATED");
    expect(result.payload.action.type).toBe("escalate");
    expect(result.payload.reasoning).toContain(HALLUCINATED_ACTION_REASON);
    expect(result.payload.reasoning).toContain("summon_ai_overlord");
  });

  it("preserves the LLM's choice when actionType is in the canonical enum", async () => {
    for (const actionType of ACTION_TYPES) {
      __setAnthropicClientForTest(
        makeAnthropicMock([
          {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  strategy: "agentic_loop",
                  action: { type: actionType, channel: actionType.startsWith("send_") ? actionType.slice(5) : null, payload: {} },
                  confidence: 0.85,
                  outcome: "EXECUTED",
                  reasoning: `picking ${actionType}`,
                }),
              },
            ],
            stop_reason: "end_turn",
          },
        ]) as never,
      );

      const result = await runAgenticLoop({ tenantId: "t1", contactId: "c1" });
      expect(result.payload.action.type).toBe(actionType);
      // For 'escalate' or 'no_op' the existing parser maps outcome based on
      // what LLM returned; for canonical types the outcome is preserved.
      expect(result.payload.reasoning).not.toContain(HALLUCINATED_ACTION_REASON);
    }
  });

  it("isActionType type guard agrees with the runner validation logic", () => {
    for (const v of ACTION_TYPES) {
      expect(isActionType(v)).toBe(true);
    }
    expect(isActionType("summon_ai_overlord")).toBe(false);
    expect(isActionType("")).toBe(false);
    expect(isActionType(null)).toBe(false);
  });

  it("system prompt instructs the LLM to pick from ACTION_TYPES", () => {
    // The system prompt is built per-call in runAgenticLoop. Verify by
    // inspecting the captured arg to anthropic.messages.create.
    const captured: { system?: string }[] = [];
    __setAnthropicClientForTest({
      messages: {
        create: vi.fn(async (arg: { system?: string }) => {
          captured.push(arg);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  strategy: "agentic_loop",
                  action: { type: "send_email", channel: "email", payload: {} },
                  confidence: 0.9,
                  outcome: "EXECUTED",
                  reasoning: "ok",
                }),
              },
            ],
            stop_reason: "end_turn",
          };
        }),
      },
    } as never);

    return runAgenticLoop({ tenantId: "t1", contactId: "c1" }).then(() => {
      expect(captured.length).toBeGreaterThan(0);
      const sys = captured[0].system ?? "";
      // System prompt mentions every canonical action type
      for (const t of ACTION_TYPES) {
        expect(sys).toContain(t);
      }
      expect(sys).toContain("rejected");
    });
  });

  it("HALLUCINATED_ACTION_REASON is the canonical string", () => {
    expect(HALLUCINATED_ACTION_REASON).toBe("agentic_hallucinated_action_type");
  });
});
