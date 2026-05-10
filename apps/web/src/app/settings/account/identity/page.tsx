"use client";

/**
 * KAN-855 — Identity tab. Spec §7.2.
 *
 * KAN-866 — Cohort 6 wiring:
 *   - "Detect from website" button now enabled, fires
 *     account.detectFromWebsite mutation via DetectButton (single-button
 *     pattern: re-labels to "Re-scan website" after first successful scan).
 *   - ScanningStateCard mounts while a scan is in progress, driven by
 *     SSE events from /api/account/detect-events.
 *   - DetectionAffordances rendered after each detection-eligible input:
 *     legalName, displayName, oneLineDescription, socialProfiles.
 *   - LastUpdatedCaption renders below each detection-eligible field
 *     (static text — KAN-830 wires the click-through to /audit later).
 *
 * Save semantics unchanged from Cohort 3.
 *
 * Decision A: compose from existing atoms. No FormField primitive.
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
import { DetectButton } from "../_components/detect-button";
import { ScanningStateCard } from "../_components/scanning-state-card";
import {
  DetectionAffordances,
  type DetectionRow,
} from "../_components/detection-affordances";
import {
  LastUpdatedCaption,
  type LastUpdatedEntry,
} from "../_components/last-updated-caption";

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

const IDENTITY_DETECTION_FIELDS = [
  "legalName",
  "displayName",
  "oneLineDescription",
  "socialProfiles",
] as const;

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

interface ProposalsResponse {
  proposals: DetectionRow[];
}

function pickDetection(
  proposals: DetectionRow[],
  fieldPath: string,
): DetectionRow | null {
  return proposals.find((p) => p.fieldPath === fieldPath) ?? null;
}

export default function IdentityTabPage(): React.ReactElement {
  const queryClient = useQueryClient();
  const accountQuery = useQuery<AccountProfile>({
    queryKey: ["account", "get"],
    queryFn: () => trpcQuery<AccountProfile>("account.get"),
  });

  const proposalsQuery = useQuery<ProposalsResponse>({
    queryKey: ["account", "detection-proposals"],
    queryFn: () => trpcQuery<ProposalsResponse>("account.getDetectionProposals"),
  });

  const lastUpdatedQuery = useQuery<Record<string, LastUpdatedEntry | null>>({
    queryKey: ["account", "fields-last-updated", IDENTITY_DETECTION_FIELDS],
    queryFn: () =>
      trpcQuery<Record<string, LastUpdatedEntry | null>>(
        "account.getFieldsLastUpdated",
        { fieldPaths: [...IDENTITY_DETECTION_FIELDS] },
      ),
  });

  const [form, setForm] = React.useState<IdentityFormState | null>(null);
  const [savedSnapshot, setSavedSnapshot] = React.useState<IdentityFormState | null>(null);
  const [activeJobId, setActiveJobId] = React.useState<string | null>(null);

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
      queryClient.invalidateQueries({ queryKey: ["account", "fields-last-updated"] });
    },
    onError: (err: Error) => {
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
  const proposals = proposalsQuery.data?.proposals ?? [];
  const lastUpdated = lastUpdatedQuery.data ?? {};
  const hasScannedBefore = profile.lastDetectAt !== null;

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
          <LastUpdatedCaption entry={lastUpdated["legalName"] ?? null} />
          <DetectionAffordances detection={pickDetection(proposals, "legalName")} />
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
          <LastUpdatedCaption entry={lastUpdated["displayName"] ?? null} />
          <DetectionAffordances detection={pickDetection(proposals, "displayName")} />
        </div>

        {/* Website + Detect-from-website */}
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
            <DetectButton
              websiteUrl={form.websiteUrl}
              hasScannedBefore={hasScannedBefore}
              disabled={activeJobId !== null}
              onScanStarted={({ jobId }) => setActiveJobId(jobId)}
            />
          </div>
          <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
            AI cites this in re-engagement messages.
          </p>
          {activeJobId && (
            <ScanningStateCard
              jobId={activeJobId}
              onCompleted={() => {
                setActiveJobId(null);
                queryClient.invalidateQueries({ queryKey: ["account", "detection-proposals"] });
                queryClient.invalidateQueries({ queryKey: ["account", "get"] });
              }}
              onFailed={() => setActiveJobId(null)}
            />
          )}
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
          <LastUpdatedCaption entry={lastUpdated["oneLineDescription"] ?? null} />
          <DetectionAffordances detection={pickDetection(proposals, "oneLineDescription")} />
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
          <LastUpdatedCaption entry={lastUpdated["socialProfiles"] ?? null} />
          <DetectionAffordances detection={pickDetection(proposals, "socialProfiles")} />
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
