/**
 * KAN-866 — LastUpdatedCaption unit tests. Verifies the
 * render-nothing-when-null contract + actor humanization +
 * relativeTime integration.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  LastUpdatedCaption,
  humanizeActor,
  type LastUpdatedEntry,
} from "../last-updated-caption";

function entry(overrides: Partial<LastUpdatedEntry> = {}): LastUpdatedEntry {
  return {
    actor: "system",
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    ...overrides,
  };
}

describe("LastUpdatedCaption — KAN-866", () => {
  it("renders nothing when entry is null (industry-standard 'never touched' UX)", () => {
    const { container } = render(<LastUpdatedCaption entry={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for malformed createdAt", () => {
    const { container } = render(
      <LastUpdatedCaption entry={entry({ createdAt: "not-a-date" })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders 'Last updated 2h ago by System' for actor='system'", () => {
    render(<LastUpdatedCaption entry={entry({ actor: "system" })} />);
    expect(screen.getByText(/Last updated 2h ago by System/)).toBeInTheDocument();
  });

  it("renders 'Last updated 2h ago by AI' for actor prefixed with 'ai:'", () => {
    render(<LastUpdatedCaption entry={entry({ actor: "ai:account-detect" })} />);
    expect(screen.getByText(/Last updated 2h ago by AI/)).toBeInTheDocument();
  });

  it("renders 'Last updated 2h ago by you' for actor prefixed with 'user:'", () => {
    render(<LastUpdatedCaption entry={entry({ actor: "user:abc-123" })} />);
    expect(screen.getByText(/Last updated 2h ago by you/)).toBeInTheDocument();
  });

  it("humanizeActor maps prefixes correctly", () => {
    expect(humanizeActor("system")).toBe("System");
    expect(humanizeActor("ai:account-detect")).toBe("AI");
    expect(humanizeActor("ai:anything")).toBe("AI");
    expect(humanizeActor("user:abc")).toBe("you");
    expect(humanizeActor("custom-actor")).toBe("custom-actor");
  });
});
