'use client';

/**
 * KAN-718 Day 10 — /customers wired to real contacts.list endpoint.
 *
 * Replaces 314 LoC of mock-data UI. Schema split: `name` → firstName +
 * lastName (rendered via null-safe concatenation). `company` field doesn't
 * exist in the canonical Contact schema — removed from V1 UI; ticket-time
 * follow-up if tenants want it back.
 *
 * Empty state: directional hint pointing operators to the lead inbox / API
 * sources that produce contacts.
 */

import {
  Users,
  RefreshCw,
  Loader2,
  Search,
  Sparkles,
} from 'lucide-react';
import { useEffect, useState, useCallback } from 'react';
import { contactsApi, type ContactListItem } from '@/lib/api';

function displayName(c: ContactListItem): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return name || c.email || 'Unknown contact';
}

function avatarFor(c: ContactListItem): string {
  const f = (c.firstName ?? '').charAt(0);
  const l = (c.lastName ?? '').charAt(0);
  const initials = (f + l).toUpperCase();
  if (initials) return initials;
  if (c.email) return c.email.charAt(0).toUpperCase();
  return '??';
}

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

const LIFECYCLE_COLORS: Record<string, { bg: string; text: string }> = {
  new: { bg: 'bg-gray-100', text: 'text-gray-600' },
  qualified: { bg: 'bg-indigo-50', text: 'text-indigo-700' },
  opportunity: { bg: 'bg-emerald-50', text: 'text-emerald-700' },
  proposal: { bg: 'bg-amber-50', text: 'text-amber-700' },
  negotiation: { bg: 'bg-orange-50', text: 'text-orange-700' },
  customer: { bg: 'bg-emerald-100', text: 'text-emerald-800' },
  at_risk: { bg: 'bg-red-50', text: 'text-red-700' },
};

export default function CustomersPage() {
  const [contacts, setContacts] = useState<ContactListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');

  // Debounce the search to avoid hammering the backend on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(searchQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const reload = useCallback(async () => {
    try {
      setError(null);
      const result = await contactsApi.list({
        search: searchDebounced || undefined,
        limit: 50,
      });
      setContacts(result.items);
    } catch (e) {
      setError((e as Error).message);
      setContacts([]);
    }
  }, [searchDebounced]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
              <Users className="w-6 h-6 text-gray-500" />
              Customers
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Contacts the AI is working with — leads, qualified prospects, customers.
            </p>
          </div>
          <button
            onClick={() => void reload()}
            className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg flex items-center gap-1.5"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>

        <div className="mb-4">
          <div className="flex items-center gap-2 px-3.5 py-2 rounded-lg border border-gray-200 bg-white max-w-md focus-within:border-indigo-500 focus-within:ring-[3px] focus-within:ring-indigo-500/10 transition-all">
            <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name or email..."
              className="border-none bg-transparent outline-none text-sm font-[inherit] text-gray-900 w-full placeholder:text-gray-400"
            />
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        {contacts === null && !error && (
          <div className="flex items-center gap-2 text-gray-500 py-12">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading contacts…
          </div>
        )}

        {/* Empty state — directional hint per KAN-718 reinforcement #4 */}
        {contacts !== null && contacts.length === 0 && !searchDebounced && (
          <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
            <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-gray-100 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-gray-400" />
            </div>
            <h3 className="text-base font-semibold text-gray-900 mb-1">
              No contacts yet
            </h3>
            <p className="text-sm text-gray-500 max-w-md mx-auto">
              Contacts arrive from the lead inbox (forward leads to your tenant
              inbox address from <code className="text-xs">/settings/leads/inbox</code>) or via the public Lead API
              (configure keys at <code className="text-xs">/settings/leads/api</code>). They'll appear here as soon
              as they land.
            </p>
          </div>
        )}

        {/* Empty state — search returned no results */}
        {contacts !== null && contacts.length === 0 && searchDebounced && (
          <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
            <p className="text-sm text-gray-500">
              No contacts match "<span className="font-medium text-gray-700">{searchDebounced}</span>".
            </p>
          </div>
        )}

        {contacts !== null && contacts.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
            {contacts.map((c) => {
              const lc = LIFECYCLE_COLORS[c.lifecycleStage] ?? LIFECYCLE_COLORS.new;
              return (
                <div key={c.id} className="px-5 py-4 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-indigo-50 text-indigo-700 flex items-center justify-center text-xs font-semibold flex-shrink-0">
                    {avatarFor(c)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-900 truncate">
                      {displayName(c)}
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                      {c.email ?? 'no email'}
                      {c.phone && ` · ${c.phone}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {c.segment && (
                      <span className="text-[11px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                        {c.segment}
                      </span>
                    )}
                    <span className={`text-[11px] px-2 py-0.5 rounded-full ${lc.bg} ${lc.text}`}>
                      {c.lifecycleStage}
                    </span>
                    <span className="text-[11px] text-gray-400 hidden sm:inline">
                      {relativeTime(c.createdAt)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
