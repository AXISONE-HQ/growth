import { describe, it, expect } from "vitest";
import {
  computeDivergence,
  DIVERGENCE_FLAGS,
  type DecisionPayload,
} from "../decision-payload.js";

const baseRules: DecisionPayload = {
  strategy: "engagement_recovery",
  action: {
    type: "send_email",
    channel: "email",
    payload: { template: "welcome", recipient: "user@example.com" },
  },
  confidence: 0.85,
  outcome: "EXECUTED",
  reasoning: "rules-based decision",
};

describe("computeDivergence", () => {
  it("returns empty array when both decisions match exactly", () => {
    const flags = computeDivergence(baseRules, baseRules, false);
    expect(flags).toEqual([]);
  });

  it("returns ['agentic_error'] when agentic is null", () => {
    const flags = computeDivergence(baseRules, null, true);
    expect(flags).toEqual(["agentic_error"]);
  });

  it("returns ['agentic_error'] when agenticErrored=true even with non-null payload", () => {
    const flags = computeDivergence(baseRules, baseRules, true);
    expect(flags).toContain("agentic_error");
  });

  it("flags different_action_type when action types differ", () => {
    const agentic: DecisionPayload = {
      ...baseRules,
      action: { ...baseRules.action, type: "send_sms" },
    };
    expect(computeDivergence(baseRules, agentic, false)).toContain("different_action_type");
  });

  it("flags different_channel when channel differs but action type matches", () => {
    const agentic: DecisionPayload = {
      ...baseRules,
      action: { ...baseRules.action, channel: "sms" },
    };
    const flags = computeDivergence(baseRules, agentic, false);
    expect(flags).toContain("different_channel");
    expect(flags).not.toContain("different_action_type");
  });

  it("flags different_target when payload differs but action+channel match", () => {
    const agentic: DecisionPayload = {
      ...baseRules,
      action: {
        ...baseRules.action,
        payload: { template: "follow_up", recipient: "user@example.com" },
      },
    };
    const flags = computeDivergence(baseRules, agentic, false);
    expect(flags).toContain("different_target");
    expect(flags).not.toContain("different_channel");
  });

  it("flags agentic_no_op when agentic chooses no_op but rules picked an action", () => {
    const agentic: DecisionPayload = {
      strategy: "agentic_loop",
      action: { type: "no_op", channel: null },
      confidence: 0.5,
      outcome: "EXECUTED",
      reasoning: "agentic chose no action",
    };
    const flags = computeDivergence(baseRules, agentic, false);
    expect(flags).toContain("agentic_no_op");
    expect(flags).not.toContain("rules_no_op");
  });

  it("flags rules_no_op when rules picked no action but agentic picked one", () => {
    const rulesNoOp: DecisionPayload = {
      ...baseRules,
      action: { type: "no_op", channel: null },
    };
    const flags = computeDivergence(rulesNoOp, baseRules, false);
    expect(flags).toContain("rules_no_op");
    expect(flags).not.toContain("agentic_no_op");
  });

  it("treats ESCALATED outcome as no-op for divergence purposes", () => {
    const rulesEscalated: DecisionPayload = { ...baseRules, outcome: "ESCALATED" };
    const flags = computeDivergence(rulesEscalated, baseRules, false);
    expect(flags).toContain("rules_no_op");
  });

  it("returns multiple flags simultaneously when multiple divergences apply", () => {
    const agentic: DecisionPayload = {
      ...baseRules,
      action: { type: "send_sms", channel: "sms", payload: { body: "hi" } },
    };
    const flags = computeDivergence(baseRules, agentic, false);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags).toContain("different_action_type");
  });
});

describe("DIVERGENCE_FLAGS export", () => {
  it("contains all 6 known flag values", () => {
    expect(DIVERGENCE_FLAGS).toEqual([
      "different_action_type",
      "different_channel",
      "different_target",
      "agentic_no_op",
      "rules_no_op",
      "agentic_error",
    ]);
  });
});
