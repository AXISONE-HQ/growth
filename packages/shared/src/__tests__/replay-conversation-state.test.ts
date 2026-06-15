/**
 * KAN-1189 Z1 — replayConversationState unit tests.
 */
import { describe, expect, it } from "vitest";
import {
  emptyConversationState,
  replayConversationState,
  type ConversationTurn,
} from "../conversation-types.js";

function turn(
  override: Partial<ConversationTurn>,
): ConversationTurn {
  return {
    turnType: "ai",
    content: "",
    createdAt: new Date().toISOString(),
    ...override,
  };
}

describe("replayConversationState", () => {
  it("returns empty state when no turns", () => {
    expect(replayConversationState([])).toEqual(emptyConversationState());
  });

  it("accumulates a single dimension confirmation", () => {
    const result = replayConversationState([
      turn({
        dimensionsExtracted: {
          product: { kind: "confirmed", value: "Widget" },
        },
      }),
    ]);
    expect(result.product.kind).toBe("confirmed");
    expect(result.objectives.kind).toBe("empty");
  });

  it("accumulates multiple dimensions across turns in order", () => {
    const result = replayConversationState([
      turn({
        dimensionsExtracted: {
          product: { kind: "confirmed", value: "Widget" },
        },
      }),
      turn({
        dimensionsExtracted: {
          objectives: { kind: "confirmed", value: "50 units" },
        },
      }),
      turn({
        dimensionsExtracted: {
          timeline: { kind: "proposed", value: "Q3", confidence: "high" },
        },
      }),
    ]);
    expect(result.product.kind).toBe("confirmed");
    expect(result.objectives.kind).toBe("confirmed");
    expect(result.timeline.kind).toBe("proposed");
    expect(result.audience.kind).toBe("empty");
  });

  it("respects reset turns (all-empty dimensionsExtracted marker)", () => {
    const result = replayConversationState([
      turn({
        dimensionsExtracted: {
          product: { kind: "confirmed", value: "Widget" },
        },
      }),
      turn({
        // Reset marker — all 4 dimensions empty
        dimensionsExtracted: emptyConversationState(),
      }),
      turn({
        dimensionsExtracted: {
          product: { kind: "confirmed", value: "Different Widget" },
        },
      }),
    ]);
    expect(result.product.kind).toBe("confirmed");
    if (result.product.kind === "confirmed") {
      expect(result.product.value).toBe("Different Widget");
    }
    expect(result.objectives.kind).toBe("empty");
  });

  it("skips turns with no dimensionsExtracted", () => {
    const result = replayConversationState([
      turn({ turnType: "operator", content: "I want to sell widgets" }),
      turn({
        dimensionsExtracted: {
          product: { kind: "confirmed", value: "Widget" },
        },
      }),
      turn({ turnType: "ai", content: "Got it" }),
    ]);
    expect(result.product.kind).toBe("confirmed");
  });

  it("later turn overrides earlier dimension state for the same key", () => {
    const result = replayConversationState([
      turn({
        dimensionsExtracted: {
          product: { kind: "proposed", value: "Widget", confidence: "low" },
        },
      }),
      turn({
        dimensionsExtracted: {
          product: { kind: "confirmed", value: "Widget" },
        },
      }),
    ]);
    expect(result.product.kind).toBe("confirmed");
  });
});
