"use client";

/**
 * KAN-855 — Identity tab. Spec §7.2.
 *
 * 6 form rows: legalName, displayName, websiteUrl, oneLineDescription,
 * industry, social profiles. Logo uploader on top. Save button at the
 * bottom. "Detect from website" rendered but disabled with tooltip
 * "Available in a future release" — Cohort 5/6 wires the scrape.
 *
 * Save semantics:
 *   - Optimistic: form state updates immediately on Save click; we
 *     invalidate the account.get cache after success so children
 *     (logo, social list) re-fetch fresh signed URLs.
 *   - Revert-on-error: mutation onError restores the pre-save form state.
 *   - Dirty detection: button is enabled only when at least one field
 *     differs from the loaded server state.
 *
 * Fred decision A: compose from existing atoms. No FormField/FormSection
 * primitive — Label + Input + Textarea inline with consistent gap utilities.
 */
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { trpcQuery, trpcMutation } from "@/lib/api";
import { LogoUploader } from "../_components/logo-uploader";
import { SocialProfileList, type SocialProfileRow } from "../_components/social-profile-list";

interface AccountProfile {
  id: string;
  tenantId: string;
  legalName: string;
  displayName: string | null;
  websiteUrl: string | null;
  oneLineDescription: string | null;
  industry: string | null;
  logoUrl: string | null;
  logoVariants: { 256: string; 128: string; 64: string } | null;
  lastDetectAt: string | null;
  lastDetectSource: string | null;
  detectStatus: string | null;
  socialProfiles: SocialProfileRow[];
}

interface IdentityFormState {
  legalName: string;
  displayName: string;
  websiteUrl: string;
  oneLineDescription: string;
  industry: string;
}

function profileToForm(p: AccountProfile): IdentityFormState {
  return {
    legalName: p.legalName,
    displayName: p.displayName ?? "",
    websiteUrl: p.websiteUrl ?? "",
    oneLineDescription: p.oneLineDescription ?? "",
    industry: p.industry ?? "",
  };
}

function diffPatch(before: IdentityFormState, after: IdentityFormState): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (before.legalName !== after.legalName) patch.legalName = after.legalName;
  if (before.displayName !== after.displayName) {
    patch.displayName = after.displayName.length > 0 ? after.displayName : null;
  }
  if (before.websiteUrl !== after.websiteUrl) {
    patch.websiteUrl = after.websiteUrl.length > 0 ? after.websiteUrl : null;
  }
  if (before.oneLineDescription !== after.oneLineDescription) {
    patch.oneLineDescription =
      after.oneLineDescription.length > 0 ? after.oneLineDescription : null;
  }
  if (before.industry !== after.industry) {
    patch.industry = after.industry.length > 0 ? after.industry : null;
  }
  return patch;
}

export default function IdentityTabPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const accountQuery = useQuery<AccountProfile>({
    queryKey: ["account", "get"],
    queryFn: () => trpcQuery<AccountProfile>("account.get"),
  });

  const [form, setForm] = React.useState<IdentityFormState | null>(null);
  const [savedSnapshot, setSavedSnapshot] = React.useState<IdentityFormState | null>(null);

  // Sync server state into form once on first load + after every refetch
  // unless the form is dirty (don't clobber unsaved edits).
  React.useEffect(() => {
    if (!accountQuery.data) return;
    const next = profileToForm(accountQuery.data);
    setSavedSnapshot(next);
    if (form === null) {
      setForm(next);
    }
  }, [accountQuery.data, form]);

  const saveMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>): Promise<AccountProfile> => {
      return trpcMutation<AccountProfile>("account.updateIdentity", patch);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["account", "get"], data);
      const next = profileToForm(data);
      setSavedSnapshot(next);
      setForm(next);
      toast.success("Account saved.");
    },
    onError: (err: Error) => {
      // Revert form to last-known-good (savedSnapshot) per spec.
      if (savedSnapshot) setForm(savedSnapshot);
      toast.error(err.message || "Couldn't save. Try again.");
    },
  });

  if (accountQuery.isLoading || !form || !savedSnapshot) {
    return (
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3" aria-label="Loading account">
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
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent>
          <p
            role="alert"
            className="text-sm"
            style={{ color: "var(--ds-danger-text)" }}
          >
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

  const patch = diffPatch(savedSnapshot, form);
  const isDirty = Object.keys(patch).length > 0;
  const canSave = isDirty && form.legalName.trim().length > 0 && !saveMutation.isPending;
  const profile = accountQuery.data!;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Identity</CardTitle>
        <CardDescription>
          The fields the AI uses to refer to your business in messages and
          decisions.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Logo */}
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold" style={{ color: "var(--ds-ink-primary)" }}>
            Logo
          </h2>
          <LogoUploader
            currentUrl={profile.logoUrl}
            variants={profile.logoVariants}
            variantWarning={null}
            onChange={(next) => {
              queryClient.setQueryData(["account", "get"], (prev: AccountProfile | undefined) =>
                prev ? { ...prev, logoUrl: next.logoUrl, logoVariants: next.logoVariants } : prev,
              );
            }}
          />
        </section>

        {/* Legal name */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="legal-name">
            Legal name <span style={{ color: "var(--ds-danger-text)" }}>*</span>
          </Label>
          <Input
            id="legal-name"
            value={form.legalName}
            onChange={(e) => setForm({ ...form, legalName: e.target.value })}
            maxLength={200}
            required
            aria-required="true"
          />
          <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
            The registered name on your business documents.
          </p>
        </div>

        {/* Display name */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="display-name">Display name</Label>
          <Input
            id="display-name"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            maxLength={100}
          />
          <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
            How AI refers to your business in messages. Defaults to legal
            name if blank.
          </p>
        </div>

        {/* Website + Detect-from-website (disabled) */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="website-url">Website</Label>
          <div className="flex gap-2">
            <Input
              id="website-url"
              type="url"
              value={form.websiteUrl}
              onChange={(e) => setForm({ ...form, websiteUrl: e.target.value })}
              placeholder="https://example.com"
              className="flex-1"
            />
            <Button
              type="button"
              variant="outline"
              disabled
              title="Available in a future release"
              aria-label="Detect from website"
            >
              Detect from website
            </Button>
          </div>
          <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
            AI cites this in re-engagement messages.
          </p>
        </div>

        {/* One-line description */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="one-line">One-line description of what you do</Label>
          <Textarea
            id="one-line"
            value={form.oneLineDescription}
            onChange={(e) => setForm({ ...form, oneLineDescription: e.target.value })}
            maxLength={200}
            rows={3}
          />
          <span className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
            {form.oneLineDescription.length} / 200 — AI uses this to ground
            messaging context. Keep it short.
          </span>
        </div>

        {/* Industry */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="industry">Industry</Label>
          <Input
            id="industry"
            value={form.industry}
            onChange={(e) => setForm({ ...form, industry: e.target.value })}
            placeholder="e.g., Real estate, Auto repair, SaaS"
          />
          <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
            Selects the Blueprint that ships with growth.
          </p>
        </div>

        {/* Social profiles */}
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold" style={{ color: "var(--ds-ink-primary)" }}>
            Social profiles
          </h2>
          <SocialProfileList
            profiles={profile.socialProfiles ?? []}
            onChange={() => queryClient.invalidateQueries({ queryKey: ["account", "get"] })}
          />
        </section>
      </CardContent>
      <CardFooter className="flex justify-end gap-3">
        <Button
          type="button"
          disabled={!canSave}
          onClick={() => saveMutation.mutate(patch)}
          aria-label="Save account changes"
        >
          {saveMutation.isPending
            ? "Saving…"
            : isDirty
              ? "Save changes"
              : "No changes to save"}
        </Button>
      </CardFooter>
    </Card>
  );
}
