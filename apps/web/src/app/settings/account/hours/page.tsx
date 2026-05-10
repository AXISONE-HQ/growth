"use client";

/**
 * KAN-857 — Hours tab. Spec §7.4.
 *
 * Save flow mirrors Identity + Contact tabs.
 *
 * holidays render via HolidayList — adds + removes flow through their
 * own mutations (account.addHoliday / account.removeHoliday) which
 * persist immediately, NOT through the Save changes button. The Save
 * button covers timezone + weeklyHours + afterHoursBehavior only.
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
import { Label } from "@/components/ui/label";
import { trpcQuery, trpcMutation } from "@/lib/api";
import { TimezoneSelect } from "../_components/timezone-select";
import {
  WeeklyHoursEditor,
  type WeeklyHours,
} from "../_components/weekly-hours-editor";
import { HolidayList, type HolidayRow } from "../_components/holiday-list";
import {
  AfterHoursBehaviorPicker,
  type AfterHoursBehavior,
} from "../_components/after-hours-behavior-picker";
import {
  DetectionAffordances,
  type DetectionRow,
} from "../_components/detection-affordances";
import {
  LastUpdatedCaption,
  type LastUpdatedEntry,
} from "../_components/last-updated-caption";

const HOURS_DETECTION_FIELDS = ["weeklyHours"] as const;

interface ProposalsResponse {
  proposals: DetectionRow[];
}

interface AccountProfile {
  timeZone: string;
  weeklyHours: Partial<WeeklyHours> | Record<string, unknown>;
  afterHoursBehavior: AfterHoursBehavior;
  observedHolidays: HolidayRow[];
}

interface HoursFormState {
  timeZone: string;
  weeklyHours: WeeklyHours;
  afterHoursBehavior: AfterHoursBehavior;
}

function profileToForm(p: AccountProfile): HoursFormState {
  // weeklyHours might be {} on a fresh profile; the WeeklyHoursEditor
  // hydrates missing keys to closed.
  return {
    timeZone: p.timeZone ?? "America/Toronto",
    weeklyHours: (p.weeklyHours as WeeklyHours) ?? ({} as WeeklyHours),
    afterHoursBehavior: p.afterHoursBehavior ?? "send_anyway",
  };
}

function diffPatch(
  before: HoursFormState,
  after: HoursFormState,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (before.timeZone !== after.timeZone) patch.timeZone = after.timeZone;
  if (JSON.stringify(before.weeklyHours) !== JSON.stringify(after.weeklyHours)) {
    patch.weeklyHours = after.weeklyHours;
  }
  if (before.afterHoursBehavior !== after.afterHoursBehavior) {
    patch.afterHoursBehavior = after.afterHoursBehavior;
  }
  return patch;
}

export default function HoursTabPage(): React.ReactElement {
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
    queryKey: ["account", "fields-last-updated", HOURS_DETECTION_FIELDS],
    queryFn: () =>
      trpcQuery<Record<string, LastUpdatedEntry | null>>(
        "account.getFieldsLastUpdated",
        { fieldPaths: [...HOURS_DETECTION_FIELDS] },
      ),
  });

  const [form, setForm] = React.useState<HoursFormState | null>(null);
  const [snapshot, setSnapshot] = React.useState<HoursFormState | null>(null);

  React.useEffect(() => {
    if (!accountQuery.data) return;
    const next = profileToForm(accountQuery.data);
    setSnapshot(next);
    if (form === null) setForm(next);
  }, [accountQuery.data, form]);

  const saveMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>): Promise<AccountProfile> => {
      return trpcMutation<AccountProfile>("account.updateHours", patch);
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
          <CardTitle>Business hours</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3" aria-label="Loading account">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-12 rounded animate-pulse"
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
          <CardTitle>Business hours</CardTitle>
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
  const profile = accountQuery.data!;
  const proposals = proposalsQuery.data?.proposals ?? [];
  const lastUpdated = lastUpdatedQuery.data ?? {};
  const weeklyHoursDetection =
    proposals.find((p) => p.fieldPath === "weeklyHours") ?? null;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Business hours</CardTitle>
        <CardDescription>
          When AI sends and how it handles after-hours messages.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Timezone */}
        <div className="flex flex-col gap-2 max-w-md">
          <Label htmlFor="timezone-select">Time zone</Label>
          <TimezoneSelect
            id="timezone-select"
            value={form.timeZone}
            onChange={(v) => setForm({ ...form, timeZone: v })}
          />
          <p className="text-xs" style={{ color: "var(--ds-ink-tertiary)" }}>
            Anchors weekly hours and holidays.
          </p>
        </div>

        {/* Weekly hours */}
        <div className="flex flex-col gap-2">
          <WeeklyHoursEditor
            value={form.weeklyHours}
            onChange={(next) => setForm({ ...form, weeklyHours: next })}
          />
          <LastUpdatedCaption entry={lastUpdated["weeklyHours"] ?? null} />
          <DetectionAffordances detection={weeklyHoursDetection} />
        </div>

        {/* Holidays — its own mutation flow, not in the Save patch */}
        <section className="flex flex-col gap-2">
          <Label className="text-sm font-medium" style={{ color: "var(--ds-ink-primary)" }}>
            Observed holidays
          </Label>
          <HolidayList
            holidays={profile.observedHolidays ?? []}
            onChange={() => queryClient.invalidateQueries({ queryKey: ["account", "get"] })}
          />
        </section>

        {/* After-hours behavior */}
        <section className="flex flex-col gap-2">
          <Label className="text-sm font-medium" style={{ color: "var(--ds-ink-primary)" }}>
            After-hours behavior
          </Label>
          <p className="text-xs mb-1" style={{ color: "var(--ds-ink-tertiary)" }}>
            Controls AI sending behavior outside business hours.
          </p>
          <AfterHoursBehaviorPicker
            value={form.afterHoursBehavior}
            onChange={(v) => setForm({ ...form, afterHoursBehavior: v })}
          />
        </section>
      </CardContent>
      <CardFooter className="flex justify-end">
        <Button
          type="button"
          disabled={!canSave}
          onClick={() => saveMutation.mutate(patch)}
          aria-label="Save business hours"
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
