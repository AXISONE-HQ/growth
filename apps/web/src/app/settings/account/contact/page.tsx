"use client";

/**
 * KAN-857 — Contact tab. Spec §7.5 framing.
 *
 * Save flow mirrors Identity tab exactly: optimistic update with revert
 * on error, dirty-state button labels ("Save changes" / "Saving…" /
 * "No changes to save").
 *
 * Decision 8 — Mailing same-as-physical: client tracks the boolean +
 * the mailing field independently. On save with `mailingSameAsPhysical
 * = true`, we send `mailingAddress: null` so the server-side wrapper
 * has explicit-null semantics regardless of the form's hidden state.
 * (The server wrapper also enforces this; client-side null is
 * defense-in-depth.)
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
import { Textarea } from "@/components/ui/textarea";
import { trpcQuery, trpcMutation } from "@/lib/api";
import { MailingAddressFields } from "../_components/mailing-address-fields";
import {
  ServiceAreaPicker,
  type ServiceAreaType,
} from "../_components/service-area-picker";
import {
  DetectionAffordances,
  type DetectionRow,
} from "../_components/detection-affordances";
import {
  LastUpdatedCaption,
  type LastUpdatedEntry,
} from "../_components/last-updated-caption";

const CONTACT_DETECTION_FIELDS = [
  "primaryPhone",
  "primaryEmail",
  "physicalAddress",
] as const;

interface AccountProfile {
  primaryPhone: string | null;
  supportPhone: string | null;
  primaryEmail: string | null;
  supportEmail: string | null;
  physicalAddress: string | null;
  mailingAddress: string | null;
  mailingSameAsPhysical: boolean;
  serviceAreaType: ServiceAreaType;
  serviceAreaRadiusKm: number | null;
  serviceAreaRegions: string[] | null;
}

interface ContactFormState {
  primaryPhone: string;
  supportPhone: string;
  primaryEmail: string;
  supportEmail: string;
  physicalAddress: string;
  mailingAddress: string;
  mailingSameAsPhysical: boolean;
  serviceAreaType: ServiceAreaType;
  serviceAreaRadiusKm: number | null;
  serviceAreaRegions: string[];
}

function profileToForm(p: AccountProfile): ContactFormState {
  return {
    primaryPhone: p.primaryPhone ?? "",
    supportPhone: p.supportPhone ?? "",
    primaryEmail: p.primaryEmail ?? "",
    supportEmail: p.supportEmail ?? "",
    physicalAddress: p.physicalAddress ?? "",
    mailingAddress: p.mailingAddress ?? "",
    mailingSameAsPhysical: p.mailingSameAsPhysical ?? true,
    serviceAreaType: p.serviceAreaType ?? "local",
    serviceAreaRadiusKm: p.serviceAreaRadiusKm ?? null,
    serviceAreaRegions: p.serviceAreaRegions ?? [],
  };
}

/** Optional-string → null (empty) | string (non-empty), trimmed. */
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
  before: ContactFormState,
  after: ContactFormState,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (before.primaryPhone !== after.primaryPhone) patch.primaryPhone = strToPatch(after.primaryPhone);
  if (before.supportPhone !== after.supportPhone) patch.supportPhone = strToPatch(after.supportPhone);
  if (before.primaryEmail !== after.primaryEmail) patch.primaryEmail = strToPatch(after.primaryEmail);
  if (before.supportEmail !== after.supportEmail) patch.supportEmail = strToPatch(after.supportEmail);
  if (before.physicalAddress !== after.physicalAddress) patch.physicalAddress = strToPatch(after.physicalAddress);
  // Decision 8: when same-as-physical, always send mailingAddress=null.
  // When toggling off and back on, this clears any stale value.
  if (
    before.mailingSameAsPhysical !== after.mailingSameAsPhysical ||
    before.mailingAddress !== after.mailingAddress
  ) {
    patch.mailingSameAsPhysical = after.mailingSameAsPhysical;
    patch.mailingAddress = after.mailingSameAsPhysical
      ? null
      : strToPatch(after.mailingAddress);
  }
  if (before.serviceAreaType !== after.serviceAreaType) patch.serviceAreaType = after.serviceAreaType;
  if (before.serviceAreaRadiusKm !== after.serviceAreaRadiusKm) {
    // Only include when type=local — otherwise the field is nulled
    // by the type switch below. ServiceAreaPicker tracks state cleanly.
    patch.serviceAreaRadiusKm = after.serviceAreaRadiusKm;
  }
  if (!arraysEqual(before.serviceAreaRegions, after.serviceAreaRegions)) {
    patch.serviceAreaRegions = after.serviceAreaRegions;
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

export default function ContactTabPage(): React.ReactElement {
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
    queryKey: ["account", "fields-last-updated", CONTACT_DETECTION_FIELDS],
    queryFn: () =>
      trpcQuery<Record<string, LastUpdatedEntry | null>>(
        "account.getFieldsLastUpdated",
        { fieldPaths: [...CONTACT_DETECTION_FIELDS] },
      ),
  });

  const [form, setForm] = React.useState<ContactFormState | null>(null);
  const [snapshot, setSnapshot] = React.useState<ContactFormState | null>(null);

  React.useEffect(() => {
    if (!accountQuery.data) return;
    const next = profileToForm(accountQuery.data);
    setSnapshot(next);
    if (form === null) setForm(next);
  }, [accountQuery.data, form]);

  const saveMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>): Promise<AccountProfile> => {
      return trpcMutation<AccountProfile>("account.updateContact", patch);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["account", "get"], (prev: AccountProfile | undefined) =>
        prev ? { ...prev, ...data } : data,
      );
      const next = profileToForm({ ...(accountQuery.data ?? data), ...data });
      setSnapshot(next);
      setForm(next);
      toast.success("Account saved.");
    },
    onError: (err: Error) => {
      if (snapshot) setForm(snapshot);
      toast.error(err.message || "Couldn't save. Try again.");
    },
  });

  if (accountQuery.isLoading || !form || !snapshot) {
    return (
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Contact details</CardTitle>
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
          <CardTitle>Contact details</CardTitle>
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
  const proposals = proposalsQuery.data?.proposals ?? [];
  const lastUpdated = lastUpdatedQuery.data ?? {};

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Contact details</CardTitle>
        <CardDescription>
          Phone, email, and address fields the AI cites when contacts ask
          how to reach you.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="primary-phone">Primary phone</Label>
            <Input
              id="primary-phone"
              type="tel"
              value={form.primaryPhone}
              onChange={(e) => setForm({ ...form, primaryPhone: e.target.value })}
              placeholder="+15551234567"
              autoComplete="tel"
            />
            <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
              AI quotes this when contacts ask how to reach you. Use country
              code, e.g., +1 555 123 4567.
            </p>
            <LastUpdatedCaption entry={lastUpdated["primaryPhone"] ?? null} />
            <DetectionAffordances detection={pickDetection(proposals, "primaryPhone")} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="support-phone">Support phone</Label>
            <Input
              id="support-phone"
              type="tel"
              value={form.supportPhone}
              onChange={(e) => setForm({ ...form, supportPhone: e.target.value })}
              placeholder="+15551112222"
              autoComplete="tel"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="primary-email">Primary email</Label>
            <Input
              id="primary-email"
              type="email"
              value={form.primaryEmail}
              onChange={(e) => setForm({ ...form, primaryEmail: e.target.value })}
              placeholder="hello@yourcompany.com"
              autoComplete="email"
            />
            <LastUpdatedCaption entry={lastUpdated["primaryEmail"] ?? null} />
            <DetectionAffordances detection={pickDetection(proposals, "primaryEmail")} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="support-email">Support email</Label>
            <Input
              id="support-email"
              type="email"
              value={form.supportEmail}
              onChange={(e) => setForm({ ...form, supportEmail: e.target.value })}
              placeholder="support@yourcompany.com"
              autoComplete="email"
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="physical-address">Physical address</Label>
          <Textarea
            id="physical-address"
            value={form.physicalAddress}
            onChange={(e) => setForm({ ...form, physicalAddress: e.target.value })}
            rows={3}
            placeholder="Street, city, region, postal code, country"
            autoComplete="street-address"
          />
          <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
            AI cites this when contacts ask where you are located.
          </p>
          <LastUpdatedCaption entry={lastUpdated["physicalAddress"] ?? null} />
          <DetectionAffordances detection={pickDetection(proposals, "physicalAddress")} />
        </div>

        <MailingAddressFields
          sameAsPhysical={form.mailingSameAsPhysical}
          mailingAddress={form.mailingAddress}
          onSameAsPhysicalChange={(next) =>
            setForm({ ...form, mailingSameAsPhysical: next })
          }
          onMailingAddressChange={(next) =>
            setForm({ ...form, mailingAddress: next })
          }
        />

        <ServiceAreaPicker
          type={form.serviceAreaType}
          radiusKm={form.serviceAreaRadiusKm}
          regions={form.serviceAreaRegions}
          onTypeChange={(next) => setForm({ ...form, serviceAreaType: next })}
          onRadiusChange={(next) => setForm({ ...form, serviceAreaRadiusKm: next })}
          onRegionsChange={(next) => setForm({ ...form, serviceAreaRegions: next })}
        />
      </CardContent>
      <CardFooter className="flex justify-end">
        <Button
          type="button"
          disabled={!canSave}
          onClick={() => saveMutation.mutate(patch)}
          aria-label="Save contact details"
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
