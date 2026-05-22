/**
 * KAN-983 — AssistantCard component tests.
 *
 * Coverage:
 *   - Default title + custom title
 *   - Suggestions render + click fires onSuggestionClick(suggestion)
 *   - Empty suggestions skips the chip row
 *   - Input + Enter key + Go button click fire onSubmit(value)
 *   - Submit clears the value
 *   - Submit ignores empty/whitespace-only input
 *   - Go button is disabled when input is empty
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AssistantCard } from "../assistant-card";

describe("KAN-983 — AssistantCard", () => {
  it("renders default title when none provided", () => {
    render(<AssistantCard />);
    expect(screen.getByText("How can I help you?")).toBeInTheDocument();
  });

  it("renders custom title", () => {
    render(<AssistantCard title="What's on your mind?" />);
    expect(screen.getByText("What's on your mind?")).toBeInTheDocument();
  });

  it("renders suggestion chips when provided + click fires handler with text", () => {
    const onClick = vi.fn();
    render(
      <AssistantCard
        suggestions={["Summarize today", "Find at-risk deals"]}
        onSuggestionClick={onClick}
      />,
    );
    const chip = screen.getByText("Summarize today");
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledWith("Summarize today");
  });

  it("omits chip row when suggestions is empty", () => {
    const { container } = render(<AssistantCard suggestions={[]} />);
    // No buttons in the suggestion area beyond the Send button
    const buttons = container.querySelectorAll("button");
    // Just the Send button
    expect(buttons.length).toBe(1);
  });

  it("Enter key submits + clears input", () => {
    const onSubmit = vi.fn();
    render(<AssistantCard onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/Ask growth anything/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "show me revenue" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("show me revenue");
    expect(input.value).toBe("");
  });

  it("Go button click submits + clears input", () => {
    const onSubmit = vi.fn();
    render(<AssistantCard onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/Ask growth anything/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "find leads" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/i }));
    expect(onSubmit).toHaveBeenCalledWith("find leads");
    expect(input.value).toBe("");
  });

  it("submit ignores whitespace-only input", () => {
    const onSubmit = vi.fn();
    render(<AssistantCard onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/Ask growth anything/i);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Go button is disabled when input is empty", () => {
    render(<AssistantCard onSubmit={() => {}} />);
    const btn = screen.getByRole("button", { name: /Send/i });
    expect(btn).toBeDisabled();
  });
});
