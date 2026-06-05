/**
 * KAN-1087 — Error display for the cognitive-metrics dashboard.
 * apps/web has no Next.js ErrorBoundary convention wired; inline card +
 * Retry button covers the react-query error path per Phase 1 Anchor 8.
 */
import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ErrorCardProps {
  message: string;
  onRetry: () => void;
}

export function ErrorCard({ message, onRetry }: ErrorCardProps): React.ReactElement {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-[var(--ds-radius-card)] border border-rose-200 bg-rose-50 p-6 shadow-[var(--ds-shadow-card)]"
    >
      <div className="flex items-center gap-2 text-rose-700">
        <AlertTriangle className="h-4 w-4" />
        <span className="font-semibold">Could not load metrics</span>
      </div>
      <p className="text-sm text-rose-700">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
