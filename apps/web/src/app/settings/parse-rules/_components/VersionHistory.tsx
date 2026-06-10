'use client';

/**
 * KAN-1140 Phase 3 PR 9c — Version history + rollback.
 *
 * Q7 hybrid versioning surface: one previous version retained per rule
 * (PR 9a substrate). Operator can restore via confirmation modal; restore
 * is itself reversible (current body becomes new "previous" after restore).
 *
 * Simple collapsible display — no diff library (Q5 lock; would add dep
 * overhead for marginal value vs read-only summary).
 */
import * as React from 'react';
import type { ParseRulePreviousVersion } from '@/lib/api';

export function VersionHistory({
  previousVersion,
  onRestore,
  busy,
}: {
  previousVersion: ParseRulePreviousVersion | null;
  onRestore: () => void | Promise<void>;
  busy: boolean;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);

  if (!previousVersion) {
    return (
      <div>
        <h3 className="text-sm font-semibold">Version history</h3>
        <p className="text-xs text-muted-foreground">
          No previous version yet. The first edit to this rule will create one.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Version history</h3>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-muted-foreground underline"
        >
          {expanded ? 'Hide' : 'Show'} previous version
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Saved {new Date(previousVersion.archivedAt).toLocaleString()} by{' '}
        <code className="font-mono">{previousVersion.archivedBy}</code>
      </p>

      {expanded ? (
        <div className="mt-2 space-y-2">
          <div className="rounded border bg-muted p-2">
            <div className="mb-1 text-xs font-medium">Previous label: {previousVersion.label}</div>
            <div className="mb-1 text-xs">
              Previous status: <code>{previousVersion.status}</code>
            </div>
            <div className="text-xs font-medium">Previous extractors:</div>
            <ul className="ml-4 list-disc text-xs">
              {previousVersion.body.extractors.map((e, idx) => (
                <li key={idx}>
                  <code className="font-mono">{e.field}</code> ←{' '}
                  <code className="font-mono">{e.extractor.type}</code>
                  {e.extractor.type === 'regex'
                    ? ` (/${e.extractor.pattern}/)`
                    : ` (${e.extractor.path})`}
                </li>
              ))}
            </ul>
          </div>
          <button
            type="button"
            onClick={() => onRestore()}
            disabled={busy}
            className="rounded border border-blue-500 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
          >
            Restore previous version
          </button>
        </div>
      ) : null}
    </div>
  );
}
