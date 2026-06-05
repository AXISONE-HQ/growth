/**
 * KAN-1087 — Dashboard header: title + window selector + manual refresh.
 *
 * Phase 1 Anchor 5: inline 3-button window selector (24h/7d/30d), no new
 * ButtonGroup primitive. Default '7d' per L5 lock.
 * Phase 1 Anchor 7: refresh = queryClient.invalidateQueries + forceRefresh
 * pass-through to server cache delete. Last-refreshed derived from
 * data.generatedAt (server-side timestamp).
 */
import * as React from 'react';
import { RefreshCw, BarChart3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatRelativeTime } from './format-relative-time';
import type { WindowOption } from '@/lib/cognitive-metrics-api';

export interface DashboardHeaderProps {
  selectedWindow: WindowOption;
  onWindowChange: (window: WindowOption) => void;
  generatedAt: string | null;
  cacheHit: boolean | null;
  isRefreshing: boolean;
  onRefresh: () => void;
}

const WINDOW_OPTIONS: Array<{ value: WindowOption; label: string }> = [
  { value: '24h', label: '24h' },
  { value: '7d',  label: '7d'  },
  { value: '30d', label: '30d' },
];

export function DashboardHeader({
  selectedWindow,
  onWindowChange,
  generatedAt,
  cacheHit,
  isRefreshing,
  onRefresh,
}: DashboardHeaderProps): React.ReactElement {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2">
        <BarChart3 className="h-5 w-5" style={{ color: 'var(--ds-violet-500)' }} />
        <h1 className="text-xl font-semibold">Cognitive metrics</h1>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex gap-1" role="group" aria-label="Time window">
          {WINDOW_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              variant={selectedWindow === opt.value ? 'default' : 'outline'}
              size="sm"
              onClick={() => onWindowChange(opt.value)}
              aria-pressed={selectedWindow === opt.value}
            >
              {opt.label}
            </Button>
          ))}
        </div>

        {generatedAt ? (
          <span
            className="text-xs"
            style={{ color: 'var(--ds-ink-secondary)' }}
            aria-label={cacheHit ? 'Showing cached metrics' : 'Showing freshly computed metrics'}
          >
            {cacheHit ? 'Cached • ' : ''}Last refreshed: {formatRelativeTime(generatedAt)}
          </span>
        ) : null}

        <Button variant="outline" size="sm" onClick={onRefresh} disabled={isRefreshing} aria-label="Refresh metrics">
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          <span className="ml-1.5">Refresh</span>
        </Button>
      </div>
    </header>
  );
}
