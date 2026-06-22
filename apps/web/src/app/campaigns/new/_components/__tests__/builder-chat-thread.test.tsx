/**
 * KAN-1191 — BuilderChatThread RTL coverage.
 *
 * Memos cited:
 *   - surface_completeness_doctrine (KAN-1187 F4 — chat thread + F5 inline button)
 *   - discriminated_union_rejected_variant_doctrine (ChatTurnResult kind dispatch)
 *
 * Scope:
 *   (a) Empty turns: 'Start a new Campaign' empty state
 *   (b) Operator turn renders as OperatorMessage with content
 *   (c) AI turn with clarification result renders aiMessage
 *   (d) AI turn with dimension_confirmed renders confirmed chip
 *   (e) AI turn with all_dimensions_confirmed renders inline Generate button (F5)
 *   (f) isSending: LoadingState rendered as AI turn
 *   (g) sendError: alert rendered
 *   (h) Send button click + dispatch
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BuilderChatThread } from "../BuilderChatThread";
import type { BuilderTurn } from "@/lib/hooks/useCampaignBuilder";

const baseProps = {
  isSending: false,
  sendError: null,
  allDimensionsConfirmed: false,
  isGenerating: false,
};

describe("BuilderChatThread (KAN-1191)", () => {
  it("empty turns: renders 'Start a new Campaign' empty state", () => {
    render(
      <BuilderChatThread
        turns={[]}
        onSend={vi.fn()}
        onGeneratePlan={vi.fn()}
        {...baseProps}
      />,
    );
    expect(screen.getByText(/Start a new Campaign/i)).toBeInTheDocument();
  });

  it("operator turn renders content", () => {
    const turns: BuilderTurn[] = [
      {
        role: "operator",
        content: "I want to sell 50 widgets in Q3",
        timestamp: "2026-06-15T19:00:00.000Z",
      },
    ];
    render(
      <BuilderChatThread
        turns={turns}
        onSend={vi.fn()}
        onGeneratePlan={vi.fn()}
        {...baseProps}
      />,
    );
    expect(
      screen.getByText(/I want to sell 50 widgets in Q3/),
    ).toBeInTheDocument();
  });

  it("AI turn with clarification renders aiMessage", () => {
    const turns: BuilderTurn[] = [
      {
        role: "ai",
        content: "What product?",
        aiResult: {
          kind: "clarification",
          aiMessage: "What product are you selling?",
          state: {
            entityType: { kind: "empty" }, product: { kind: "empty" },
            objectives: { kind: "empty" },
            timeline: { kind: "empty" },
            audience: { kind: "empty" },
          },
          campaignId: "campaign-1",
        },
        timestamp: "2026-06-15T19:01:00.000Z",
      },
    ];
    render(
      <BuilderChatThread
        turns={turns}
        onSend={vi.fn()}
        onGeneratePlan={vi.fn()}
        {...baseProps}
      />,
    );
    expect(
      screen.getByText(/What product are you selling/i),
    ).toBeInTheDocument();
  });

  it("AI turn with dimension_confirmed renders '✓ Confirmed' chip", () => {
    const turns: BuilderTurn[] = [
      {
        role: "ai",
        content: "Got it",
        aiResult: {
          kind: "dimension_confirmed",
          aiMessage: "Got it: Widget Pro",
          state: {
            entityType: { kind: "confirmed", value: "product" }, product: { kind: "confirmed", value: "Widget Pro" },
            objectives: { kind: "empty" },
            timeline: { kind: "empty" },
            audience: { kind: "empty" },
          },
          campaignId: "campaign-1",
          dimensionKey: "product",
        },
        timestamp: "2026-06-15T19:02:00.000Z",
      },
    ];
    render(
      <BuilderChatThread
        turns={turns}
        onSend={vi.fn()}
        onGeneratePlan={vi.fn()}
        {...baseProps}
      />,
    );
    expect(screen.getByText(/✓ Confirmed: product/i)).toBeInTheDocument();
  });

  it("F5: all_dimensions_confirmed AI turn renders inline Generate Action Plan button", async () => {
    const onGeneratePlan = vi.fn();
    const turns: BuilderTurn[] = [
      {
        role: "ai",
        content: "All set",
        aiResult: {
          kind: "all_dimensions_confirmed",
          aiMessage: "All 4 dimensions confirmed. Ready to generate.",
          state: {
            entityType: { kind: "confirmed", value: "product" }, product: { kind: "confirmed", value: "Widget" },
            objectives: { kind: "confirmed", value: "Sales" },
            timeline: { kind: "confirmed", value: "Q3" },
            audience: { kind: "confirmed", value: "Existing" },
          },
          campaignId: "campaign-1",
        },
        timestamp: "2026-06-15T19:03:00.000Z",
      },
    ];
    render(
      <BuilderChatThread
        turns={turns}
        onSend={vi.fn()}
        onGeneratePlan={onGeneratePlan}
        {...baseProps}
        allDimensionsConfirmed={true}
      />,
    );
    const btn = screen.getByRole("button", { name: /Generate Action Plan/i });
    await userEvent.click(btn);
    expect(onGeneratePlan).toHaveBeenCalledTimes(1);
  });

  it("isSending: LoadingState rendered inside AI message", () => {
    render(
      <BuilderChatThread
        turns={[]}
        onSend={vi.fn()}
        onGeneratePlan={vi.fn()}
        {...baseProps}
        isSending={true}
      />,
    );
    // LoadingState renders the "Reading your historical signal…" line per
    // canonical LoadingState component shape
    expect(screen.getByText(/Reading your historical signal/i)).toBeInTheDocument();
  });

  it("sendError: 'Couldn't send. Try again.' alert rendered", () => {
    render(
      <BuilderChatThread
        turns={[]}
        onSend={vi.fn()}
        onGeneratePlan={vi.fn()}
        {...baseProps}
        sendError={new Error("network")}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't send/i);
  });

  it("Send button click dispatches onSend with trimmed message", async () => {
    const onSend = vi.fn();
    render(
      <BuilderChatThread
        turns={[]}
        onSend={onSend}
        onGeneratePlan={vi.fn()}
        {...baseProps}
      />,
    );
    const input = screen.getByLabelText(/Send a message/i);
    await userEvent.type(input, "  hello  ");
    await userEvent.click(screen.getByRole("button", { name: /Send message/i }));
    expect(onSend).toHaveBeenCalledWith("hello");
  });
});
