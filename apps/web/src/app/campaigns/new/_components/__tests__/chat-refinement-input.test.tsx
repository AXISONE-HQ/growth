/**
 * KAN-1191 — ChatRefinementInput RTL coverage.
 *
 * Memos cited:
 *   - discriminated_union_rejected_variant_doctrine (variant rendering)
 *   - surface_completeness_doctrine (KAN-1188 G3 — 4-family chips)
 *   - ui_hook_layer_test_family (KAN-1205 — UI contract verification)
 *
 * Scope:
 *   (a) 4-axis chips render (Stages / First Actions / Audience / Dimension)
 *   (b) Chip click pre-fills textarea with family starter
 *   (c) Send button click dispatches onSend with trimmed message
 *   (d) KAN-1205 contract: dispatch payload is JUST the message string —
 *       no expectedUpdatedAt in caller surface; ChatRefinementInput's onSend
 *       takes a string, not an object
 *   (e) Empty input: Send button disabled
 *   (f) bounds_violation banner persists for the rendered result
 *   (g) concurrent_edit_conflict banner with Reload affordance
 *   (h) no_plan_to_refine banner rendering
 *   (i) isRefining: input + Send disabled
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatRefinementInput } from "../ChatRefinementInput";
import type { RefineActionPlanResult, ActionPlan } from "@/lib/api";

const onSend = vi.fn();
const onReloadFromConflict = vi.fn();

beforeEach(() => {
  onSend.mockReset();
  onReloadFromConflict.mockReset();
});

function renderInput(
  refineResult: RefineActionPlanResult | null = null,
  isRefining = false,
) {
  return render(
    <ChatRefinementInput
      onSend={onSend}
      isRefining={isRefining}
      refineResult={refineResult}
      onReloadFromConflict={onReloadFromConflict}
    />,
  );
}

describe("ChatRefinementInput — 4-axis chips (G3)", () => {
  it("renders all 4 axis chips", () => {
    renderInput();
    expect(
      screen.getByRole("button", { name: /^Stages$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^First Actions$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Audience$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Dimension$/ }),
    ).toBeInTheDocument();
  });

  it("clicking Stages chip pre-fills input with 'Rename stage 1 to '", async () => {
    renderInput();
    await userEvent.click(screen.getByRole("button", { name: /^Stages$/ }));
    const input = screen.getByLabelText(/Refine the Action Plan/i);
    expect((input as HTMLInputElement).value).toBe("Rename stage 1 to ");
  });

  it("clicking First Actions chip pre-fills with 'Change Day 0 of the first pipeline to '", async () => {
    renderInput();
    await userEvent.click(
      screen.getByRole("button", { name: /^First Actions$/ }),
    );
    const input = screen.getByLabelText(/Refine the Action Plan/i);
    expect((input as HTMLInputElement).value).toBe(
      "Change Day 0 of the first pipeline to ",
    );
  });

  it("clicking Audience chip pre-fills with 'Narrow the audience to '", async () => {
    renderInput();
    await userEvent.click(screen.getByRole("button", { name: /^Audience$/ }));
    const input = screen.getByLabelText(/Refine the Action Plan/i);
    expect((input as HTMLInputElement).value).toBe("Narrow the audience to ");
  });

  it("clicking Dimension chip pre-fills with 'Raise the goal target to '", async () => {
    renderInput();
    await userEvent.click(screen.getByRole("button", { name: /^Dimension$/ }));
    const input = screen.getByLabelText(/Refine the Action Plan/i);
    expect((input as HTMLInputElement).value).toBe("Raise the goal target to ");
  });
});

// KAN-1205 LOAD-BEARING — ChatRefinementInput.onSend takes a plain string;
// caller (ActionPlanCard) DOES NOT pass expectedUpdatedAt. This test asserts
// the input surface is JUST the message string (no object wrapping).
describe("ChatRefinementInput — Send dispatch (KAN-1205 contract)", () => {
  it("Send dispatches onSend with trimmed message string", async () => {
    renderInput();
    const input = screen.getByLabelText(/Refine the Action Plan/i);
    await userEvent.type(input, "  Rename stage 1 to Discovery  ");
    await userEvent.click(
      screen.getByRole("button", { name: /Send refinement/i }),
    );
    expect(onSend).toHaveBeenCalledTimes(1);
    // Contract: onSend receives a plain string, NOT an object with
    // expectedUpdatedAt. KAN-1205 verified — the optimistic concurrency
    // token was the source of the silent commit-does-nothing bug.
    expect(onSend.mock.calls[0][0]).toBe("Rename stage 1 to Discovery");
    expect(typeof onSend.mock.calls[0][0]).toBe("string");
  });

  it("empty input: Send disabled", () => {
    renderInput();
    expect(
      screen.getByRole("button", { name: /Send refinement/i }),
    ).toBeDisabled();
  });

  it("whitespace-only input: Send disabled", async () => {
    renderInput();
    const input = screen.getByLabelText(/Refine the Action Plan/i);
    await userEvent.type(input, "   ");
    expect(
      screen.getByRole("button", { name: /Send refinement/i }),
    ).toBeDisabled();
  });

  it("isRefining: input + Send disabled", () => {
    renderInput(null, true);
    expect(screen.getByLabelText(/Refine the Action Plan/i)).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /Send refinement/i }),
    ).toBeDisabled();
  });
});

describe("ChatRefinementInput — result variant rendering", () => {
  it("bounds_violation: amber banner with message + strategy badge", () => {
    const result: RefineActionPlanResult = {
      kind: "bounds_violation",
      message: "Stage edit rejected — direct strategy requires 2-4 stages.",
      campaignId: "campaign-1",
      strategy: "direct",
      attemptedStageCount: 1,
    };
    renderInput(result);
    expect(
      screen.getByText(/Stage edit rejected/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/^direct$/)).toBeInTheDocument();
  });

  it("concurrent_edit_conflict: banner + Reload to current dispatches onReloadFromConflict", async () => {
    const stubPlan: ActionPlan = {
      pipelines: [
        {
          name: "Stub",
          segment: "new_leads",
          strategy: "direct",
          audienceConditions: {
            field: "lifecycleStage",
            op: "in",
            values: ["lead"],
          },
          audienceCount: 100,
          proposedStages: [
            { name: "A", order: 0, description: "A" },
            { name: "B", order: 1, description: "B" },
          ],
          firstActions: [
            { day: 0, channel: "email", intent: "i", description: "d" },
          ],
          projectedContribution: 5,
          shareOfGoal: 10,
        },
      ],
      confidence: "high",
      confidenceReason: "ok",
      gapAnalysis: {
        goalTarget: 50,
        projectedOrganic: 5,
        gapAbsolute: 45,
        gapPercent: 90,
        goalWindowDays: 90,
      },
      modelUsed: "claude-sonnet-4-6",
      generatedAt: "2026-06-15T19:00:00.000Z",
    };
    const result: RefineActionPlanResult = {
      kind: "concurrent_edit_conflict",
      message: "Another edit landed.",
      campaignId: "campaign-1",
      currentPlan: stubPlan,
    };
    renderInput(result);
    expect(screen.getByText(/Another edit landed/i)).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /Reload to current/i }),
    );
    expect(onReloadFromConflict).toHaveBeenCalledTimes(1);
  });

  it("no_plan_to_refine: banner rendered", () => {
    const result: RefineActionPlanResult = {
      kind: "no_plan_to_refine",
      message: "The Action Plan was cleared.",
      campaignId: "campaign-1",
    };
    renderInput(result);
    expect(
      screen.getByText(/Action Plan was cleared/i),
    ).toBeInTheDocument();
  });
});
