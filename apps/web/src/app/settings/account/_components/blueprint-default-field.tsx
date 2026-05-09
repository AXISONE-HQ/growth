"use client";

/**
 * KAN-859 — BlueprintDefaultField. Wraps either Input or Textarea and
 * tracks override-vs-Blueprint state. Four states per Fred's spec §7.7:
 *
 *   1. Empty (override === null):
 *      - Field renders the Blueprint default as `placeholder` text in
 *        italic + muted style. `<input value>` is empty.
 *      - Badge: "Blueprint default" (secondary variant)
 *      - "Reset to default" button hidden
 *
 *   2. Typing (user starts entering text):
 *      - First keystroke → onChange fires with the typed string → value
 *        becomes non-null → render switches to Custom state immediately
 *        (optimistic; no server round-trip needed).
 *
 *   3. Override (override !== null):
 *      - Field renders the override in normal text style.
 *      - Badge: "Custom"
 *      - "Reset to default" button visible
 *
 *   4. Reset:
 *      - Click "Reset to default" → onChange(null) → next render shows
 *        Blueprint default again.
 *      - Equivalent to clearing the input (also fires onChange(null)).
 *
 * Save-payload contract: parent serialises `value === null ? null : value`.
 * Server treats null as "clear override → use Blueprint default".
 */
import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface BlueprintDefaultFieldProps {
  id: string;
  label: string;
  /** Override value. null means "use Blueprint default". */
  value: string | null;
  /** Resolved Blueprint default — always non-null (resolver guarantees a
   * fallback to `en` if the language bundle is missing). */
  blueprintDefault: string;
  /** Render as Input or Textarea. Defaults to "input". */
  variant?: "input" | "textarea";
  onChange: (value: string | null) => void;
  helperText?: string;
  disabled?: boolean;
  /** Only used when variant="textarea". Defaults to 4. */
  textareaRows?: number;
}

export function BlueprintDefaultField({
  id,
  label,
  value,
  blueprintDefault,
  variant = "input",
  onChange,
  helperText,
  disabled,
  textareaRows = 4,
}: BlueprintDefaultFieldProps): React.ReactElement {
  const isCustom = value !== null;

  function handleInputChange(next: string): void {
    // Empty string collapses to null (= reset to Blueprint default).
    onChange(next === "" ? null : next);
  }

  function handleReset(): void {
    onChange(null);
  }

  const sharedInputProps = {
    id,
    value: value ?? "",
    placeholder: blueprintDefault,
    disabled,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      handleInputChange(e.target.value),
    "aria-describedby": helperText ? `${id}-help` : undefined,
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex items-center gap-2">
          <Badge variant={isCustom ? "default" : "secondary"}>
            {isCustom ? "Custom" : "Blueprint default"}
          </Badge>
          {isCustom ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleReset}
              disabled={disabled}
              aria-label={`Reset ${label} to Blueprint default`}
            >
              Reset to default
            </Button>
          ) : null}
        </div>
      </div>
      {variant === "textarea" ? (
        <Textarea
          {...sharedInputProps}
          rows={textareaRows}
          className={isCustom ? "" : "italic placeholder:italic"}
        />
      ) : (
        <Input
          {...sharedInputProps}
          className={isCustom ? "" : "italic placeholder:italic"}
        />
      )}
      {helperText ? (
        <p
          id={`${id}-help`}
          className="text-xs"
          style={{ color: "var(--ds-ink-tertiary)" }}
        >
          {helperText}
        </p>
      ) : null}
    </div>
  );
}
