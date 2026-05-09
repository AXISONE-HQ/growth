/**
 * KAN-859 — LocaleSection unit tests. Decision 4 (Cohort 1) supported
 * languages = en | fr only.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/firebase", () => ({
  app: {},
  auth: { currentUser: { getIdToken: vi.fn(async () => "test-id-token") } },
  googleProvider: {},
}));

import { LocaleSection } from "../locale-section";

describe("LocaleSection — KAN-859", () => {
  it("renders defaultLanguage select with the current value", () => {
    render(
      <LocaleSection
        defaultLanguage="en"
        supportedLanguages={["en", "fr"]}
        onDefaultLanguageChange={vi.fn()}
        onSupportedLanguagesChange={vi.fn()}
      />,
    );
    const select = screen.getByLabelText("Default language") as HTMLSelectElement;
    expect(select.value).toBe("en");
    // 2 options (en, fr) per Decision 4
    expect(select.querySelectorAll("option").length).toBe(2);
  });

  it("changing defaultLanguage fires onDefaultLanguageChange with the new code", () => {
    const onDefaultLanguageChange = vi.fn();
    render(
      <LocaleSection
        defaultLanguage="en"
        supportedLanguages={["en"]}
        onDefaultLanguageChange={onDefaultLanguageChange}
        onSupportedLanguagesChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Default language"), {
      target: { value: "fr" },
    });
    expect(onDefaultLanguageChange).toHaveBeenCalledWith("fr");
  });

  it("renders 2 supportedLanguages checkboxes; the default-language checkbox is disabled", () => {
    render(
      <LocaleSection
        defaultLanguage="en"
        supportedLanguages={["en", "fr"]}
        onDefaultLanguageChange={vi.fn()}
        onSupportedLanguagesChange={vi.fn()}
      />,
    );
    const en = document.getElementById(
      "supported-language-en",
    ) as HTMLInputElement;
    const fr = document.getElementById(
      "supported-language-fr",
    ) as HTMLInputElement;
    expect(en).not.toBeNull();
    expect(fr).not.toBeNull();
    expect(en.disabled).toBe(true); // can't remove the default
    expect(fr.disabled).toBe(false);
  });

  it("toggling a non-default supported language fires onSupportedLanguagesChange", async () => {
    const onSupportedLanguagesChange = vi.fn();
    const user = userEvent.setup();
    render(
      <LocaleSection
        defaultLanguage="en"
        supportedLanguages={["en"]}
        onDefaultLanguageChange={vi.fn()}
        onSupportedLanguagesChange={onSupportedLanguagesChange}
      />,
    );
    await user.click(document.getElementById("supported-language-fr")!);
    expect(onSupportedLanguagesChange).toHaveBeenCalledWith(["en", "fr"]);
  });

  it("removing the default-language checkbox does NOT fire onSupportedLanguagesChange (disabled)", async () => {
    const onSupportedLanguagesChange = vi.fn();
    const user = userEvent.setup();
    render(
      <LocaleSection
        defaultLanguage="en"
        supportedLanguages={["en", "fr"]}
        onDefaultLanguageChange={vi.fn()}
        onSupportedLanguagesChange={onSupportedLanguagesChange}
      />,
    );
    await user.click(document.getElementById("supported-language-en")!);
    expect(onSupportedLanguagesChange).not.toHaveBeenCalled();
  });
});
