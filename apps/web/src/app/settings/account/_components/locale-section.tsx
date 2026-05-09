"use client";

/**
 * KAN-859 — LocaleSection. defaultLanguage Select + supportedLanguages
 * multi-select. Per Cohort 1 Decision 4 the language enum is en | fr
 * only — so supportedLanguages renders as 2 checkboxes, not a full
 * picker.
 *
 * Client validates: defaultLanguage MUST be present in supportedLanguages.
 * If user un-checks the default from supported, we auto-add it back —
 * the brief calls this out as the expected UX.
 */
import * as React from "react";
import { Label } from "@/components/ui/label";

export type SupportedLanguage = "en" | "fr";

const LANGUAGE_OPTIONS: ReadonlyArray<{ value: SupportedLanguage; label: string }> = [
  { value: "en", label: "English" },
  { value: "fr", label: "French" },
];

interface LocaleSectionProps {
  defaultLanguage: SupportedLanguage;
  supportedLanguages: readonly SupportedLanguage[];
  onDefaultLanguageChange: (next: SupportedLanguage) => void;
  onSupportedLanguagesChange: (next: SupportedLanguage[]) => void;
  disabled?: boolean;
}

export function LocaleSection({
  defaultLanguage,
  supportedLanguages,
  onDefaultLanguageChange,
  onSupportedLanguagesChange,
  disabled,
}: LocaleSectionProps): React.ReactElement {
  function toggleSupported(lang: SupportedLanguage): void {
    if (supportedLanguages.includes(lang)) {
      // If user is unchecking the default language, snap it back —
      // server's LegalUpdateSchema rejects supportedLanguages without
      // defaultLanguage, so this is preventative not optional.
      if (lang === defaultLanguage) return;
      onSupportedLanguagesChange(
        supportedLanguages.filter((l) => l !== lang),
      );
    } else {
      onSupportedLanguagesChange([...supportedLanguages, lang]);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="default-language">Default language</Label>
        <select
          id="default-language"
          value={defaultLanguage}
          disabled={disabled}
          onChange={(e) =>
            onDefaultLanguageChange(e.target.value as SupportedLanguage)
          }
          className="h-10 w-full rounded-md border px-3 text-sm motion-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:var(--ds-violet-500)] [--tw-ring-offset-color:var(--ds-ring-offset)]"
          style={{
            backgroundColor: "var(--ds-surface-base)",
            borderColor: "var(--ds-border-default)",
            color: "var(--ds-ink-primary)",
          }}
        >
          {LANGUAGE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
          AI uses this language for outbound messages by default.
        </p>
      </div>

      <fieldset
        aria-label="Supported languages"
        className="flex flex-col gap-1.5 m-0 p-0 border-0"
      >
        <legend className="text-sm font-medium" style={{ color: "var(--ds-ink-primary)" }}>
          Supported languages
        </legend>
        <div className="flex flex-wrap gap-3 mt-1">
          {LANGUAGE_OPTIONS.map((opt) => {
            const id = `supported-language-${opt.value}`;
            const checked = supportedLanguages.includes(opt.value);
            const isDefault = opt.value === defaultLanguage;
            return (
              <label
                key={opt.value}
                htmlFor={id}
                className={[
                  "flex items-center gap-2 text-sm cursor-pointer",
                  disabled || isDefault ? "cursor-not-allowed opacity-60" : "",
                ].join(" ")}
              >
                <input
                  id={id}
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || isDefault}
                  onChange={() => toggleSupported(opt.value)}
                  aria-label={
                    isDefault
                      ? `${opt.label} (default — cannot be removed)`
                      : opt.label
                  }
                  className="h-4 w-4 [accent-color:var(--ds-violet-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:var(--ds-violet-500)] [--tw-ring-offset-color:var(--ds-ring-offset)]"
                />
                <span style={{ color: "var(--ds-ink-primary)" }}>{opt.label}</span>
              </label>
            );
          })}
        </div>
        <p className="text-xs mt-1" style={{ color: "var(--ds-ink-tertiary)" }}>
          The default language is always supported.
        </p>
      </fieldset>
    </div>
  );
}
