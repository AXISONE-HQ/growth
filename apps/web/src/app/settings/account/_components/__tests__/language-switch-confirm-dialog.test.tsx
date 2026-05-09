/**
 * KAN-859 — LanguageSwitchConfirmDialog unit tests. Resolves §13 open
 * question via Decision 1.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

import { LanguageSwitchConfirmDialog } from "../language-switch-confirm-dialog";

describe("LanguageSwitchConfirmDialog — KAN-859", () => {
  it("when open=false, the dialog is not rendered", () => {
    render(
      <LanguageSwitchConfirmDialog
        open={false}
        currentLanguage="en"
        newLanguage="fr"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByText("Reset custom legal text?")).not.toBeInTheDocument();
  });

  it("when open=true, renders title + descriptive copy with current/new language labels", () => {
    render(
      <LanguageSwitchConfirmDialog
        open={true}
        currentLanguage="en"
        newLanguage="fr"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Reset custom legal text?")).toBeInTheDocument();
    // Body must reference both languages by their full label
    const body = screen.getByText(/Your current legal text override is in/);
    expect(body.textContent).toMatch(/English/);
    expect(body.textContent).toMatch(/French/);
  });

  it("renders Cancel + Switch and reset buttons", () => {
    render(
      <LanguageSwitchConfirmDialog
        open={true}
        currentLanguage="en"
        newLanguage="fr"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Switch and reset" }),
    ).toBeInTheDocument();
  });

  it("clicking Cancel fires onCancel (not onConfirm)", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <LanguageSwitchConfirmDialog
        open={true}
        currentLanguage="en"
        newLanguage="fr"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("clicking Switch and reset fires onConfirm (not onCancel)", async () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <LanguageSwitchConfirmDialog
        open={true}
        currentLanguage="fr"
        newLanguage="en"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Switch and reset" }));
    expect(onConfirm).toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
