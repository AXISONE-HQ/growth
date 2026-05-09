"use client";

/**
 * KAN-859 — LanguageSwitchConfirmDialog. Composed from the existing
 * Radix-based Dialog primitive at `apps/web/src/components/ui/dialog.tsx`.
 * Radix gives focus trap + escape-to-close + ARIA out of the box.
 *
 * Resolves §13 open question via Decision 1: per-language overrides
 * stay flat, but when a tenant switches `defaultLanguage` AND has a
 * non-null override on `optOutLanguage` or `emailFooterDisclosure`, we
 * surface this dialog. "Cancel" leaves state untouched. "Switch and
 * reset" proceeds with the language change AND nulls the override
 * fields server-side via the same `updateLegal` call.
 *
 * When the user has no override on either field, the parent does NOT
 * mount this dialog at all — the switch is silent.
 */
import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type SupportedLanguage = "en" | "fr";

const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: "English",
  fr: "French",
};

interface LanguageSwitchConfirmDialogProps {
  open: boolean;
  currentLanguage: SupportedLanguage;
  newLanguage: SupportedLanguage;
  onCancel: () => void;
  /** Confirm: parent should proceed with the language change AND null
   * out optOutLanguage + emailFooterDisclosure overrides server-side. */
  onConfirm: () => void;
}

export function LanguageSwitchConfirmDialog({
  open,
  currentLanguage,
  newLanguage,
  onCancel,
  onConfirm,
}: LanguageSwitchConfirmDialogProps): React.ReactElement {
  const currentLabel = LANGUAGE_LABELS[currentLanguage];
  const newLabel = LANGUAGE_LABELS[newLanguage];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Radix fires onOpenChange(false) on overlay click + Escape;
        // treat both as "Cancel" so the switch is reverted.
        if (!next) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset custom legal text?</DialogTitle>
          <DialogDescription>
            Your current legal text override is in {currentLabel}. Switching to{" "}
            {newLabel} will use the {newLabel} Blueprint default until you
            write a new override.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm}>
            Switch and reset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
