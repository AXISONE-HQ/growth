/**
 * KAN-859 — BlueprintDefaultField unit tests. Covers all 4 spec §7.7
 * states.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

import { BlueprintDefaultField } from "../blueprint-default-field";

const DEFAULT_TEXT = "Reply STOP to unsubscribe.";

describe("BlueprintDefaultField — KAN-859 (4 states)", () => {
  it("State 1 — empty (value=null): shows 'Blueprint default' badge, hides Reset, placeholder is the default", () => {
    render(
      <BlueprintDefaultField
        id="opt-out"
        label="Opt-out language"
        value={null}
        blueprintDefault={DEFAULT_TEXT}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Blueprint default")).toBeInTheDocument();
    expect(screen.queryByText("Custom")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Reset Opt-out language/i }),
    ).not.toBeInTheDocument();
    const input = screen.getByLabelText("Opt-out language") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(DEFAULT_TEXT);
  });

  it("State 2 — typing: first keystroke fires onChange with the typed value (badge flips to Custom)", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <BlueprintDefaultField
        id="opt-out"
        label="Opt-out language"
        value={null}
        blueprintDefault={DEFAULT_TEXT}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText("Opt-out language");
    await user.type(input, "X");
    expect(onChange).toHaveBeenCalledWith("X");
  });

  it("State 3 — override (value=non-null): shows 'Custom' badge + Reset button + value in input", () => {
    render(
      <BlueprintDefaultField
        id="opt-out"
        label="Opt-out language"
        value="My custom opt-out"
        blueprintDefault={DEFAULT_TEXT}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Custom")).toBeInTheDocument();
    expect(screen.queryByText("Blueprint default")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Reset Opt-out language/i }),
    ).toBeInTheDocument();
    const input = screen.getByLabelText("Opt-out language") as HTMLInputElement;
    expect(input.value).toBe("My custom opt-out");
  });

  it("State 4 — Reset: clicking the Reset button fires onChange(null)", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <BlueprintDefaultField
        id="opt-out"
        label="Opt-out language"
        value="My custom opt-out"
        blueprintDefault={DEFAULT_TEXT}
        onChange={onChange}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /Reset Opt-out language/i }),
    );
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("clearing the input (empty string) fires onChange(null) — same as Reset", () => {
    const onChange = vi.fn();
    render(
      <BlueprintDefaultField
        id="opt-out"
        label="Opt-out language"
        value="My custom opt-out"
        blueprintDefault={DEFAULT_TEXT}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Opt-out language"), {
      target: { value: "" },
    });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("variant=textarea renders a textarea element", () => {
    render(
      <BlueprintDefaultField
        id="footer"
        label="Email footer disclosure"
        value={null}
        blueprintDefault="Default footer text"
        variant="textarea"
        onChange={vi.fn()}
      />,
    );
    const el = screen.getByLabelText("Email footer disclosure");
    expect(el.tagName).toBe("TEXTAREA");
  });

  it("renders the helperText when provided", () => {
    render(
      <BlueprintDefaultField
        id="opt-out"
        label="Opt-out language"
        value={null}
        blueprintDefault={DEFAULT_TEXT}
        onChange={vi.fn()}
        helperText="Sentence the AI uses when contacts ask to stop being contacted."
      />,
    );
    expect(
      screen.getByText(
        "Sentence the AI uses when contacts ask to stop being contacted.",
      ),
    ).toBeInTheDocument();
  });
});
