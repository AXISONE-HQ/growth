"use client";

/**
 * KAN-866 — Account Page Cohort 6: detect-from-website CTA.
 *
 * **PROMOTION CANDIDATE** — KAN-842 lift candidate.
 *
 * Single button that re-labels based on prior-scan state:
 *   - Never run → "Detect from website"
 *   - After last successful detect → "Re-scan website"
 *   - 60s cooldown applies in both states (server-side rate limit is the
 *     source of truth; this is a UX pre-block to avoid round-trips)
 *
 * Disabled when:
 *   - cooldown countdown is active
 *   - websiteUrl is empty
 *   - mutation is pending
 *   - a scan is already in progress (parent passes `disabled`)
 *
 * On success, calls onScanStarted({ jobId }) so the parent page can mount
 * ScanningStateCard.
 */
import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { trpcMutation } from "@/lib/api";

const COOLDOWN_SECONDS = 60;

export interface DetectButtonProps {
  websiteUrl: string;
  hasScannedBefore: boolean;
  /** Parent passes `true` while ScanningStateCard is mounted. */
  disabled?: boolean;
  onScanStarted: (info: { jobId: string }) => void;
}

export function DetectButton({
  websiteUrl,
  hasScannedBefore,
  disabled,
  onScanStarted,
}: DetectButtonProps): React.ReactElement {
  const [cooldown, setCooldown] = React.useState(0);

  React.useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  const mutation = useMutation({
    mutationFn: () =>
      trpcMutation<{ jobId: string; estimatedSeconds: number }>(
        "account.detectFromWebsite",
        { websiteUrl },
      ),
    onSuccess: (data) => {
      setCooldown(COOLDOWN_SECONDS);
      onScanStarted({ jobId: data.jobId });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Couldn't start scan. Try again.");
    },
  });

  const trimmedUrl = websiteUrl.trim();
  const isUrlEmpty = trimmedUrl.length === 0;
  const isDisabled = disabled || isUrlEmpty || cooldown > 0 || mutation.isPending;

  const baseLabel = hasScannedBefore ? "Re-scan website" : "Detect from website";
  const label = mutation.isPending
    ? "Starting…"
    : cooldown > 0
      ? `Re-scan in ${cooldown}s`
      : baseLabel;

  const tooltip = isUrlEmpty
    ? "Enter a website first."
    : cooldown > 0
      ? `Available again in ${cooldown}s.`
      : undefined;

  return (
    <Button
      type="button"
      variant="outline"
      disabled={isDisabled}
      onClick={() => mutation.mutate()}
      aria-label={baseLabel}
      title={tooltip}
    >
      {label}
    </Button>
  );
}
