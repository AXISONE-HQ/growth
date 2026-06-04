/**
 * KAN-1087 — "Data window covers N events" badge.
 *
 * Surfaces the pre-launch sparse-data discipline pin from the epic Phase 1:
 * sparse charts are a FEATURE (instrumentation shipped, awaiting traffic),
 * not a bug. Badge makes the volume context explicit so empty/sparse cards
 * read as "no engine activity yet" rather than "dashboard broken."
 */
import * as React from 'react';
import { Activity } from 'lucide-react';

export interface SparseDataBadgeProps {
  totalTier1Rows: number;
  windowLabel: string;
}

export function SparseDataBadge({ totalTier1Rows, windowLabel }: SparseDataBadgeProps): React.ReactElement {
  return (
    <div
      className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs"
      style={{ color: 'var(--ds-ink-secondary)' }}
      aria-label={`Window ${windowLabel} contains ${totalTier1Rows} engine events`}
    >
      <Activity className="h-3 w-3" />
      <span>
        Window <strong>{windowLabel}</strong> covers <strong>{totalTier1Rows.toLocaleString()}</strong> engine
        {' '}event{totalTier1Rows === 1 ? '' : 's'}
      </span>
    </div>
  );
}
