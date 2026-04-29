import { describe, it, expect } from "vitest";
import {
  ACTION_TYPES,
  isActionType,
  HALLUCINATED_ACTION_REASON,
  type ActionType,
} from "../action-types.js";

describe("ACTION_TYPES enum", () => {
  it("contains the canonical transport-level set", () => {
    expect([...ACTION_TYPES].sort()).toEqual([
      "escalate",
      "no_op",
      "send_email",
      "send_meta",
      "send_sms",
    ]);
  });

  it("matches the channel→action mapping in run-decision-for-contact.ts", () => {
    // Rules-based runPlaybookStep mapping: { email: 'send_email', sms: 'send_sms', meta: 'send_meta' }
    expect(ACTION_TYPES).toContain("send_email");
    expect(ACTION_TYPES).toContain("send_sms");
    expect(ACTION_TYPES).toContain("send_meta");
  });
});

describe("isActionType type guard", () => {
  it("returns true for canonical values", () => {
    for (const v of ACTION_TYPES) {
      expect(isActionType(v)).toBe(true);
    }
  });

  it("returns false for hallucinated values", () => {
    expect(isActionType("summon_ai_overlord")).toBe(false);
    expect(isActionType("send_carrier_pigeon")).toBe(false);
    expect(isActionType("")).toBe(false);
  });

  it("returns false for non-string inputs", () => {
    expect(isActionType(null)).toBe(false);
    expect(isActionType(undefined)).toBe(false);
    expect(isActionType(42)).toBe(false);
    expect(isActionType({ type: "send_email" })).toBe(false);
  });

  it("narrows the type at compile time", () => {
    const v: unknown = "send_email";
    if (isActionType(v)) {
      // TS should now allow assignment to ActionType
      const narrowed: ActionType = v;
      expect(narrowed).toBe("send_email");
    }
  });
});

describe("HALLUCINATED_ACTION_REASON constant", () => {
  it("is the canonical reason string for escalation", () => {
    expect(HALLUCINATED_ACTION_REASON).toBe("agentic_hallucinated_action_type");
  });
});
