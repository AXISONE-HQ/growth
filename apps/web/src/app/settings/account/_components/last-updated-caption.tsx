"use client";

/**
 * KAN-866 — Account Page Cohort 6: per-field "Last updated" caption.
 *
 * **PROMOTION CANDIDATE** — KAN-842 lift candidate.
 *
 * Renders "Last updated {relativeTime} by {actor}" as STATIC TEXT (no
 * link) under each detection-eligible input. Per Cohort 6 Decision C,
 * the click-through to /audit?fieldPath=X is owned by KAN-830 and is
 * a follow-up; this caption is the precursor.
 *
 * When no audit row exists for the fieldPath, renders nothing (cleaner
 * than "Not yet updated" — matches HubSpot / Salesforce / Google Cloud
 * Console industry norm; absence-of-caption is unambiguous "never touched").
 *
 * Data source: receives a pre-resolved `entry` from the parent page
 * (which fires ONE batch `account.getFieldsLastUpdated` query for all
 * detection-eligible fields on that tab). This avoids 4–9 parallel
 * tRPC roundtrips per page-load.
 */
import * as React from "react";
import { relativeTime } from "@/lib/relative-time";

export interface LastUpdatedEntry {
  actor: string;
  createdAt: string; // ISO timestamp
}

export interface LastUpdatedCaptionProps {
  entry: LastUpdatedEntry | null;
}

/** Strip actor prefix ("user:abc" / "ai:account-detect" / "system") into
 * a humanized label. The prefix is the producer-side convention from
 * `account-field-updated-subscriber.ts`. */
export function humanizeActor(actor: string): string {
  if (actor === "system") return "System";
  if (actor.startsWith("ai:")) return "AI";
  if (actor.startsWith("user:")) return "you";
  return actor;
}

export function LastUpdatedCaption({
  entry,
}: LastUpdatedCaptionProps): React.ReactElement | null {
  if (!entry) return null;
  const date = new Date(entry.createdAt);
  if (Number.isNaN(date.getTime())) return null;
  const when = relativeTime(date);
  const who = humanizeActor(entry.actor);
  return (
    <p
      className="text-xs"
      style={{ color: "var(--ds-ink-tertiary)" }}
      aria-label={`Last updated ${when} by ${who}`}
    >
      Last updated {when} by {who}
    </p>
  );
}
