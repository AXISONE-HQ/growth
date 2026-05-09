"use client";

/**
 * KAN-859 — Legal tab. Spec §7.7 framing.
 *
 * Save flow mirrors Cohorts 2/3: optimistic update with revert on
 * error, dirty-state button labels.
 *
 * Resolves §13 open question via Decision 1 — flat per-language
 * override columns + LanguageSwitchConfirmDialog when a defaultLanguage
 * switch would orphan a non-null override on optOutLanguage or
 * emailFooterDisclosure.
 *
 * Jurisdiction defaulting — Decision 2: no default value. Render the
 * Select with placeholder "Select country" + required marker. When
 * `addressCountry` IS populated on the AccountProfile (rare today,
 * common after Cohort 5 detect-from-website), seed the Select to that
 * value as a pre-selection.
 */
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpcQuery, trpcMutation } from "@/lib/api";
import { ALL_COUNTRIES, formatCountryOption } from "../_components/country-catalog";
import { BlueprintDefaultField } from "../_components/blueprint-default-field";
import {
  IndustryDisclosureList,
  type DisclosureRow,
} from "../_components/industry-disclosure-list";
import {
  LocaleSection,
  type SupportedLanguage,
} from "../_components/locale-section";
import { LanguageSwitchConfirmDialog } from "../_components/language-switch-confirm-dialog";

interface LegalDefaults {
  optOutLanguage: string;
  emailFooterDisclosure: string;
  source: {
    optOutLanguage: "override" | "language" | "fallback_en";
    emailFooterDisclosure: "override" | "language" | "fallback_en";
  };
}

interface AccountProfile {
  taxId: string | null;
  businessRegNumber: string | null;
  jurisdiction: string | null;
  addressCountry: string | null;
  optOutLanguage: string | null;
  emailFooterDisclosure: string | null;
  defaultLanguage: SupportedLanguage;
  supportedLanguages: SupportedLanguage[];
  industryDisclosures: DisclosureRow[];
  legalDefaults: LegalDefaults;
}

interface LegalFormState {
  taxId: string;
  businessRegNumber: string;
  /** null = no selection (placeholder shown). */
  jurisdiction: string | null;
  /** null = use Blueprint default. */
  optOutLanguage: string | null;
  /** null = use Blueprint default. */
  emailFooterDisclosure: string | null;
  defaultLanguage: SupportedLanguage;
  supportedLanguages: SupportedLanguage[];
}

function profileToForm(p: AccountProfile): LegalFormState {
  return {
    taxId: p.taxId ?? "",
    businessRegNumber: p.businessRegNumber ?? "",
    // Decision 2: seed from addressCountry only when jurisdiction is null
    // AND addressCountry is populated; else null (placeholder).
    jurisdiction: p.jurisdiction ?? p.addressCountry ?? null,
    optOutLanguage: p.optOutLanguage,
    emailFooterDisclosure: p.emailFooterDisclosure,
    defaultLanguage: (p.defaultLanguage ?? "en") as SupportedLanguage,
    supportedLanguages: (p.supportedLanguages ?? ["en"]) as SupportedLanguage[],
  };
}

function strToPatch(v: string): string | null {
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function diffPatch(
  before: LegalFormState,
  after: LegalFormState,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (before.taxId !== after.taxId) patch.taxId = strToPatch(after.taxId);
  if (before.businessRegNumber !== after.businessRegNumber)
    patch.businessRegNumber = strToPatch(after.businessRegNumber);
  if (before.jurisdiction !== after.jurisdiction)
    patch.jurisdiction = after.jurisdiction;
  if (before.optOutLanguage !== after.optOutLanguage)
    patch.optOutLanguage = after.optOutLanguage;
  if (before.emailFooterDisclosure !== after.emailFooterDisclosure)
    patch.emailFooterDisclosure = after.emailFooterDisclosure;
  if (before.defaultLanguage !== after.defaultLanguage)
    patch.defaultLanguage = after.defaultLanguage;
  if (!arraysEqual(before.supportedLanguages, after.supportedLanguages))
    patch.supportedLanguages = after.supportedLanguages;
  return patch;
}

export default function LegalTabPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const accountQuery = useQuery<AccountProfile>({
    queryKey: ["account", "get"],
    queryFn: () => trpcQuery<AccountProfile>("account.get"),
  });

  const [form, setForm] = React.useState<LegalFormState | null>(null);
  const [snapshot, setSnapshot] = React.useState<LegalFormState | null>(null);
  const [pendingLanguage, setPendingLanguage] = React.useState<SupportedLanguage | null>(null);

  React.useEffect(() => {
    if (!accountQuery.data) return;
    const next = profileToForm(accountQuery.data);
    setSnapshot(next);
    if (form === null) setForm(next);
  }, [accountQuery.data, form]);

  const saveMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>): Promise<AccountProfile> => {
      return trpcMutation<AccountProfile>("account.updateLegal", patch);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["account", "get"], (prev: AccountProfile | undefined) =>
        prev ? { ...prev, ...data } : data,
      );
      const next = profileToForm({ ...(accountQuery.data ?? data), ...data });
      setSnapshot(next);
      setForm(next);
      toast.success("Legal saved.");
    },
    onError: (err: Error) => {
      if (snapshot) setForm(snapshot);
      toast.error(err.message || "Couldn't save. Try again.");
    },
  });

  if (accountQuery.isLoading || !form || !snapshot || !accountQuery.data) {
    return (
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Legal &amp; compliance</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3" aria-label="Loading legal">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-10 rounded animate-pulse"
                style={{ backgroundColor: "var(--ds-surface-sunken)" }}
                aria-hidden="true"
              />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (accountQuery.isError) {
    return (
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Legal &amp; compliance</CardTitle>
        </CardHeader>
        <CardContent>
          <p role="alert" className="text-sm" style={{ color: "var(--ds-danger-text)" }}>
            Couldn&apos;t load your account. Refresh and try again.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void accountQuery.refetch()}
            aria-label="Retry loading account"
          >
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const patch = diffPatch(snapshot, form);
  const isDirty = Object.keys(patch).length > 0;
  const canSave = isDirty && !saveMutation.isPending;
  const legalDefaults = accountQuery.data.legalDefaults;

  function applyLanguageSwitch(
    next: SupportedLanguage,
    alsoNullOverrides: boolean,
  ): void {
    if (!form) return;
    const supported = form.supportedLanguages.includes(next)
      ? form.supportedLanguages
      : [...form.supportedLanguages, next];
    setForm({
      ...form,
      defaultLanguage: next,
      supportedLanguages: supported,
      optOutLanguage: alsoNullOverrides ? null : form.optOutLanguage,
      emailFooterDisclosure: alsoNullOverrides
        ? null
        : form.emailFooterDisclosure,
    });
    setPendingLanguage(null);
  }

  function handleDefaultLanguageChange(next: SupportedLanguage): void {
    if (!form) return;
    if (next === form.defaultLanguage) return;
    const hasOverride =
      form.optOutLanguage !== null || form.emailFooterDisclosure !== null;
    if (hasOverride) {
      setPendingLanguage(next);
      return;
    }
    applyLanguageSwitch(next, false);
  }

  return (
    <>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Legal &amp; compliance</CardTitle>
          <CardDescription>
            Tax ID, jurisdiction, regulated-industry disclosures, and locale
            settings the AI cites in customer communications.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="tax-id">Tax ID</Label>
              <Input
                id="tax-id"
                value={form.taxId}
                onChange={(e) => setForm({ ...form, taxId: e.target.value })}
                placeholder="EIN, VAT, GST/HST…"
              />
              <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
                EIN, GST/HST, VAT — whatever applies in your jurisdiction.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="business-reg">Business registration number</Label>
              <Input
                id="business-reg"
                value={form.businessRegNumber}
                onChange={(e) =>
                  setForm({ ...form, businessRegNumber: e.target.value })
                }
              />
              <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
                Corporate registration number if your jurisdiction issues one.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="jurisdiction">
              Jurisdiction
              <span
                className="ml-1"
                style={{ color: "var(--ds-danger-text)" }}
                aria-hidden="true"
              >
                *
              </span>
            </Label>
            <select
              id="jurisdiction"
              value={form.jurisdiction ?? ""}
              required
              onChange={(e) =>
                setForm({
                  ...form,
                  jurisdiction: e.target.value === "" ? null : e.target.value,
                })
              }
              className="h-10 w-full rounded-md border px-3 text-sm motion-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 [--tw-ring-color:var(--ds-violet-500)] [--tw-ring-offset-color:var(--ds-ring-offset)]"
              style={{
                backgroundColor: "var(--ds-surface-base)",
                borderColor: "var(--ds-border-default)",
                color: "var(--ds-ink-primary)",
              }}
              aria-required="true"
            >
              <option value="" disabled>
                Select country
              </option>
              {ALL_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {formatCountryOption(c)}
                </option>
              ))}
            </select>
            <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
              Your business&apos;s primary legal jurisdiction.
            </p>
          </div>

          <BlueprintDefaultField
            id="opt-out-language"
            label="Opt-out language"
            value={form.optOutLanguage}
            blueprintDefault={legalDefaults.optOutLanguage}
            variant="input"
            onChange={(next) => setForm({ ...form, optOutLanguage: next })}
            helperText="Sentence the AI uses when contacts ask to stop being contacted."
          />

          <BlueprintDefaultField
            id="email-footer-disclosure"
            label="Email footer disclosure"
            value={form.emailFooterDisclosure}
            blueprintDefault={legalDefaults.emailFooterDisclosure}
            variant="textarea"
            textareaRows={4}
            onChange={(next) =>
              setForm({ ...form, emailFooterDisclosure: next })
            }
            helperText="Text appended to every outbound email — typically a legal/regulatory line."
          />

          <div className="flex flex-col gap-2">
            <Label>Industry disclosures</Label>
            <IndustryDisclosureList
              disclosures={accountQuery.data.industryDisclosures ?? []}
              onChange={() => queryClient.invalidateQueries({ queryKey: ["account", "get"] })}
            />
          </div>

          <div
            className="pt-4"
            style={{ borderTop: "1px solid var(--ds-border-subtle)" }}
          >
            <h3
              className="text-sm font-semibold mb-3"
              style={{ color: "var(--ds-ink-primary)" }}
            >
              Locale
            </h3>
            <LocaleSection
              defaultLanguage={form.defaultLanguage}
              supportedLanguages={form.supportedLanguages}
              onDefaultLanguageChange={handleDefaultLanguageChange}
              onSupportedLanguagesChange={(next) =>
                setForm({ ...form, supportedLanguages: next })
              }
            />
          </div>
        </CardContent>
        <CardFooter className="flex justify-end">
          <Button
            type="button"
            disabled={!canSave}
            onClick={() => saveMutation.mutate(patch)}
            aria-label="Save legal"
          >
            {saveMutation.isPending
              ? "Saving…"
              : isDirty
                ? "Save changes"
                : "No changes to save"}
          </Button>
        </CardFooter>
      </Card>

      {pendingLanguage !== null ? (
        <LanguageSwitchConfirmDialog
          open={true}
          currentLanguage={form.defaultLanguage}
          newLanguage={pendingLanguage}
          onCancel={() => setPendingLanguage(null)}
          onConfirm={() => applyLanguageSwitch(pendingLanguage, true)}
        />
      ) : null}
    </>
  );
}
