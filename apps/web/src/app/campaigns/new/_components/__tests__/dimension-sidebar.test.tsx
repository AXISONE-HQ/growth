/**
 * KAN-1191 — DimensionSidebar RTL coverage.
 *
 * Memos cited:
 *   - surface_completeness_doctrine (KAN-1187 F3 — 4-dimension chip group)
 *
 * Scope:
 *   (a) Renders 4 dimension chips (Product / Objectives / Timeline / Audience)
 *   (b) Empty state badge ("Pending") for all dimensions when state is empty
 *   (c) Per-dimension chip variants reflect state (empty / proposed / confirmed)
 *   (d) Confirmed values surface as text under the chip
 *   (e) allDimensionsConfirmed=true: Generate Action Plan button rendered
 *   (f) Generate button click dispatches onGeneratePlan
 *   (g) isGenerating=true: button shows 'Generating...' + disabled
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DimensionSidebar } from "../DimensionSidebar";
import { emptyConversationState, type ConversationState } from "@growth/shared";

describe("DimensionSidebar (KAN-1191 / KAN-1219 G3)", () => {
  it("renders 5 dimension chips (KAN-1219 G3 — entityType promoted to FIRST)", () => {
    render(
      <DimensionSidebar
        state={emptyConversationState()}
        allDimensionsConfirmed={false}
        onGeneratePlan={vi.fn()}
        isGenerating={false}
      />,
    );
    expect(screen.getByText("Target type")).toBeInTheDocument();
    expect(screen.getByText("Product")).toBeInTheDocument();
    expect(screen.getByText("Objectives")).toBeInTheDocument();
    expect(screen.getByText("Timeline")).toBeInTheDocument();
    expect(screen.getByText("Audience")).toBeInTheDocument();
  });

  it("empty state: all 5 chips show 'Pending'", () => {
    render(
      <DimensionSidebar
        state={emptyConversationState()}
        allDimensionsConfirmed={false}
        onGeneratePlan={vi.fn()}
        isGenerating={false}
      />,
    );
    const pendingBadges = screen.getAllByText("Pending");
    expect(pendingBadges).toHaveLength(5);
  });

  it("proposed dimension: shows 'Proposed' badge", () => {
    const state: ConversationState = {
      ...emptyConversationState(),
      product: { kind: "proposed", value: "Widget", confidence: "high" },
    };
    render(
      <DimensionSidebar
        state={state}
        allDimensionsConfirmed={false}
        onGeneratePlan={vi.fn()}
        isGenerating={false}
      />,
    );
    expect(screen.getByText("Proposed")).toBeInTheDocument();
    // Value surfaces under the chip
    expect(screen.getByText("Widget")).toBeInTheDocument();
  });

  it("confirmed dimension: shows '✓ Confirmed' badge", () => {
    const state: ConversationState = {
      ...emptyConversationState(),
      product: { kind: "confirmed", value: "Widget Pro" },
    };
    render(
      <DimensionSidebar
        state={state}
        allDimensionsConfirmed={false}
        onGeneratePlan={vi.fn()}
        isGenerating={false}
      />,
    );
    expect(screen.getByText(/✓ Confirmed/)).toBeInTheDocument();
    expect(screen.getByText("Widget Pro")).toBeInTheDocument();
  });

  it("allDimensionsConfirmed=true: Generate Action Plan button rendered", () => {
    render(
      <DimensionSidebar
        state={emptyConversationState()}
        allDimensionsConfirmed={true}
        onGeneratePlan={vi.fn()}
        isGenerating={false}
      />,
    );
    expect(
      screen.getByRole("button", { name: /Generate Action Plan/i }),
    ).toBeInTheDocument();
  });

  it("allDimensionsConfirmed=false: Generate button NOT rendered", () => {
    render(
      <DimensionSidebar
        state={emptyConversationState()}
        allDimensionsConfirmed={false}
        onGeneratePlan={vi.fn()}
        isGenerating={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Generate Action Plan/i }),
    ).toBeNull();
  });

  it("Generate button click dispatches onGeneratePlan", async () => {
    const onGeneratePlan = vi.fn();
    render(
      <DimensionSidebar
        state={emptyConversationState()}
        allDimensionsConfirmed={true}
        onGeneratePlan={onGeneratePlan}
        isGenerating={false}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Generate Action Plan/i }),
    );
    expect(onGeneratePlan).toHaveBeenCalledTimes(1);
  });

  // ─── KAN-1225 — vehicle-mode audience skip disclosure ───
  // Memo 19/42 feature-affordance-honesty: a vehicle campaign never fills the
  // audience dimension (KAN-1219 Q3 lock), so showing a perpetual "Pending"
  // the operator can't resolve is dishonest. Disclose the skip instead.

  it("vehicle mode: audience chip discloses 'Skipped (vehicle mode)' not 'Pending'", () => {
    const state: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: "confirmed", value: "vehicle" },
    };
    render(
      <DimensionSidebar
        state={state}
        allDimensionsConfirmed={false}
        onGeneratePlan={vi.fn()}
        isGenerating={false}
      />,
    );
    expect(screen.getByText("Skipped (vehicle mode)")).toBeInTheDocument();
    // The audience row no longer dangles a resolvable-looking "Pending".
    // (entityType is confirmed, so only 3 remaining dims show "Pending".)
    expect(screen.getAllByText("Pending")).toHaveLength(3);
  });

  it("product mode: audience chip still shows 'Pending' (no skip)", () => {
    const state: ConversationState = {
      ...emptyConversationState(),
      entityType: { kind: "confirmed", value: "product" },
    };
    render(
      <DimensionSidebar
        state={state}
        allDimensionsConfirmed={false}
        onGeneratePlan={vi.fn()}
        isGenerating={false}
      />,
    );
    expect(screen.queryByText("Skipped (vehicle mode)")).toBeNull();
    // entityType confirmed + product/objectives/timeline/audience all Pending.
    expect(screen.getAllByText("Pending")).toHaveLength(4);
  });

  it("isGenerating=true: button shows 'Generating...' + disabled", () => {
    render(
      <DimensionSidebar
        state={emptyConversationState()}
        allDimensionsConfirmed={true}
        onGeneratePlan={vi.fn()}
        isGenerating={true}
      />,
    );
    const btn = screen.getByRole("button", { name: /Generating\.\.\./i });
    expect(btn).toBeDisabled();
  });
});
