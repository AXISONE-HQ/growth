'use client';

/**
 * KAN-718 Day 10 — /audit wired to real auditLog.list endpoint.
 *
 * Replaces 291 LoC of mock-data UI. Default filter (operator-relevant —
 * excludes brain.blueprint_* infrastructure events) applied at the router.
 * KAN-758 (Sprint 5+) adds admin toggle for "show infrastructure-level audit".
 *
 * Empty state: directional copy that explains what produces audit entries
 * (any AI action, recommendation accept/dismiss, CSV import, tenant config
 * change) so first-time operators understand why the surface is empty
 * pre-traffic.
 */

import {
  FileText,
  RefreshCw,
  Loader2,
  Sparkles,
  ChevronRight,
} from 'lucide-react';
import { useEffect, useState, useCallback } from 'react';
import { auditLogApi, type AuditLogEntry } from '@/lib/api';

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionTypePrefix, setActionTypePrefix] = useState<string>('');

  const reload = useCallback(async () => {
    try {
      setError(null);
      const result = await auditLogApi.list({
        actionTypePrefix: actionTypePrefix || undefined,
        limit: 100,
      });
      setEntries(result.items);
    } catch (e) {
      setError((e as Error).message);
      setEntries([]);
    }
  }, [actionTypePrefix]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filterChips: Array<{ label: string; prefix: string }> = [
    { label: 'All', prefix: '' },
    { label: 'Recommendations', prefix: 'recommendation.' },
    { label: 'AI tool calls', prefix: 'agentic.' },
    { label: 'CSV imports', prefix: 'csv.' },
    { label: 'Tenant changes', prefix: 'tenant.' },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
              <FileText className="w-6 h-6 text-gray-500" />
              Audit Log
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Every AI action, operator decision, and configuration change.
            </p>
          </div>
          <button
            onClick={() => void reload()}
            className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg flex items-center gap-1.5"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          {filterChips.map((chip) => (
            <button
              key={chip.label}
              onClick={() => setActionTypePrefix(chip.prefix)}
              className={`px-3 py-1.5 text-xs rounded-full border transition-colors ${
                actionTypePrefix === chip.prefix
                  ? 'bg-indigo-500 border-indigo-500 text-white'
                  : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        {entries === null && !error && (
          <div className="flex items-center gap-2 text-gray-500 py-12">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading audit entries…
          </div>
        )}

        {/* Empty state — directional copy per KAN-718 reinforcement #4 */}
        {entries !== null && entries.length === 0 && (
          <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
            <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-gray-100 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-gray-400" />
            </div>
            <h3 className="text-base font-semibold text-gray-900 mb-1">
              No audit entries yet
            </h3>
            <p className="text-sm text-gray-500 max-w-md mx-auto">
              Every AI-taken action, recommendation accept/dismiss, CSV
              import, and tenant configuration change writes an entry here.
              Once you have leads flowing or accept your first recommendation,
              you'll see the trail.
            </p>
          </div>
        )}

        {entries !== null && entries.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
            {entries.map((e) => (
              <div key={e.id} className="px-5 py-4 flex items-start gap-3">
                <div className="w-2 h-2 rounded-full bg-indigo-500 mt-2 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-mono text-gray-900">{e.actionType}</span>
                    <span className="text-[11px] text-gray-400">·</span>
                    <span className="text-[11px] text-gray-500">{e.actor}</span>
                  </div>
                  {e.reasoning && (
                    <p className="text-xs text-gray-600 mb-1">{e.reasoning}</p>
                  )}
                  <div className="text-[11px] text-gray-400">
                    {relativeTime(e.createdAt)}
                  </div>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0 mt-2" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
