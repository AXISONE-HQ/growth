/**
 * KAN-866 — ConfidenceBadge unit tests. Covers the 4 variant boundaries +
 * a11y contract + clamping.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConfidenceBadge, levelForConfidence } from "../confidence-badge";

describe("ConfidenceBadge — KAN-866", () => {
  it("renders 'high' variant at 85+", () => {
    render(<ConfidenceBadge value={87} />);
    const badge = screen.getByRole("status");
    expect(badge).toHaveAttribute("aria-label", "87 percent confidence, high");
    expect(badge).toHaveTextContent("87% · high");
  });

  it("renders 'normal' variant at 65–84", () => {
    render(<ConfidenceBadge value={70} />);
    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "70 percent confidence, normal",
    );
  });

  it("renders 'low' variant at 40–64", () => {
    render(<ConfidenceBadge value={50} />);
    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "50 percent confidence, low",
    );
  });

  it("renders 'below' variant at 0–39", () => {
    render(<ConfidenceBadge value={31} />);
    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "31 percent confidence, below",
    );
  });

  it("clamps values out of [0,100] and rounds decimals", () => {
    render(<ConfidenceBadge value={142.7} />);
    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "100 percent confidence, high",
    );
  });

  it("hides status word when showWord=false", () => {
    render(<ConfidenceBadge value={87} showWord={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("87%");
    expect(screen.getByRole("status")).not.toHaveTextContent("high");
    // a11y label still encodes the level even without the word
    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "87 percent confidence, high",
    );
  });

  it("levelForConfidence boundaries are correct (84 normal, 85 high, 64 low, 65 normal)", () => {
    expect(levelForConfidence(85)).toBe("high");
    expect(levelForConfidence(84)).toBe("normal");
    expect(levelForConfidence(65)).toBe("normal");
    expect(levelForConfidence(64)).toBe("low");
    expect(levelForConfidence(40)).toBe("low");
    expect(levelForConfidence(39)).toBe("below");
    expect(levelForConfidence(0)).toBe("below");
  });
});
