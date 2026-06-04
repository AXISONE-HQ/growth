/**
 * KAN-1087 — Generic card shell for each metric chart.
 *
 * Matches MetricCard's outer surface (KAN-979 primitive tokens) but allows
 * an arbitrary chart body. Handles loading skeleton + empty-state framing
 * uniformly across all 8 chart components.
 *
 * Phase 1 Anchor 8 + discipline pin 1: empty state copy frames sparse data
 * as instrumentation-shipped-awaiting-traffic, not a bug.
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ChartCardProps {
  title: string;
  loading: boolean;
  isEmpty: boolean;
  className?: string;
  children: React.ReactNode;
  /** Optional sub-title / annotation under the title (e.g., "manual vs engine"). */
  subtitle?: React.ReactNode;
}

const EMPTY_COPY = 'No engine activity in this window — instrumentation is shipped, awaiting traffic.';

export function ChartCard({
  title,
  loading,
  isEmpty,
  className,
  children,
  subtitle,
}: ChartCardProps): React.ReactElement {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-[var(--ds-radius-card)] border border-border bg-card p-[18px] shadow-[var(--ds-shadow-card)]',
        className,
      )}
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--ds-ink-primary)' }}>
          {title}
        </h3>
        {subtitle ? (
          <span className="text-xs" style={{ color: 'var(--ds-ink-secondary)' }}>
            {subtitle}
          </span>
        ) : null}
      </div>
      {loading ? (
        <div
          className="h-40 w-full animate-pulse rounded-md"
          style={{ background: 'var(--ds-surface-sunken)' }}
          aria-label={`${title} loading`}
        />
      ) : isEmpty ? (
        <div
          className="flex h-40 items-center justify-center text-center text-xs"
          style={{ color: 'var(--ds-ink-secondary)' }}
        >
          {EMPTY_COPY}
        </div>
      ) : (
        <div className="h-40">{children}</div>
      )}
    </div>
  );
}
