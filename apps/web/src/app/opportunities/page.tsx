/**
 * /opportunities — Day-1 Wedge demo surface
 *
 * Three states:
 *   1. Empty      — "No opportunities found right now"
 *   2. Found      — opportunity card with preview + playbook steps + Launch buttons
 *   3. Launched   — success state with link to audit log
 *
 * Location: apps/web/src/app/opportunities/page.tsx
 *
 * Design spec: growth-ui-ux-designer skill, "AI Action Card" + "Objective Gap Indicator" patterns.
 * Data: trpcQuery / trpcMutation from @/lib/api (repo's fetch wrapper — no React-Query hooks here).
 *
 * Accessibility: WCAG 2.1 AA. Confidence uses text + color (never color alone).
 * Mobile: stacks vertically, same component set.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { trpcQuery, trpcMutation } from '@/lib/api';

// Types (mirror the wedge router return shape)
interface PlaybookPreview {
  slug: string;
  name: string;
  description: string;
  steps: Array<{ day: number; channel: 'email' | 'sms' | 'meta'; intent: string }>;
}

interface SampleContact {
  id: string;
  name: string;
  email: string | null;
  lifecycleStage: string | null;
}

interface Opportunity {
  type: 'dormant_reactivation' | 'high_intent_no_touch' | 'data_enrichment';
  displayName: string;
  entityIds: string[];
  estimatedPopulation: number;
  reasoning: string;
  signalSource: string;
  playbookSlug: string;
  playbook: PlaybookPreview | null;
  sampleContacts: SampleContact[];
}

interface OpportunitiesResponse {
  opportunities: Opportunity[];
  summary?: { totalContacts: number };
}

interface LaunchResponse {
  opportunityType: string;
  launched: number;
  errors: number;
  dryRun: boolean;
}

export default function OpportunitiesPage() {
  const [data, setData] = useState<OpportunitiesResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);
  const [launchResult, setLaunchResult] = useState<LaunchResponse | null>(null);

  const fetchOpportunities = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await trpcQuery<OpportunitiesResponse>('wedge.opportunities');
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOpportunities();
  }, [fetchOpportunities]);

  const refetch = fetchOpportunities;
  const isError = error !== null;

  async function handleLaunch(opp: Opportunity, dryRun: boolean) {
    setIsLaunching(true);
    try {
      const result = await trpcMutation<LaunchResponse>('wedge.launch', {
        opportunityType: opp.type,
        playbookSlug: opp.playbookSlug,
        dryRun,
      });
      setLaunchResult(result);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setIsLaunching(false);
    }
  }

  // ─── Loading ────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <main className="min-h-screen bg-slate-900 p-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-slate-50">Opportunities</h1>
          <p className="text-slate-400 mt-1">growth is scanning your contacts…</p>
        </header>
        <div className="max-w-4xl mx-auto">
          <SkeletonCard />
        </div>
      </main>
    );
  }

  // ─── Error ──────────────────────────────────────────────────────────
  if (isError) {
    return (
      <main className="min-h-screen bg-slate-900 p-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-slate-50">Opportunities</h1>
        </header>
        <div className="max-w-4xl mx-auto rounded-xl border border-red-800 bg-red-950 p-6">
          <p className="text-red-200">
            Couldn't scan opportunities: {error?.message ?? 'unknown error'}.
          </p>
          <button
            onClick={() => refetch()}
            className="mt-4 px-4 py-2 text-sm font-medium text-white bg-indigo-500 rounded-lg hover:bg-indigo-400"
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  const opportunities = data?.opportunities ?? [];
  const summary = data?.summary;

  // ─── Empty State ────────────────────────────────────────────────────
  if (opportunities.length === 0) {
    return (
      <main className="min-h-screen bg-slate-900 p-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-slate-50">Opportunities</h1>
          <p className="text-slate-400 mt-1">
            growth scans your contacts for revenue patterns you haven't worked.
          </p>
        </header>
        <div className="max-w-4xl mx-auto rounded-xl border border-slate-700 bg-slate-800 p-8 text-center">
          <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-slate-700 flex items-center justify-center">
            <span className="text-slate-400 text-xl">✓</span>
          </div>
          <h2 className="text-xl font-semibold text-slate-100">No opportunities right now</h2>
          <p className="text-slate-400 mt-2 max-w-md mx-auto">
            We scanned {summary?.totalContacts ?? 0} contacts and didn't find any signals
            above threshold. New opportunities appear as contacts go dormant or new leads
            arrive unworked.
          </p>
          <button
            onClick={() => refetch()}
            className="mt-6 px-4 py-2 text-sm font-medium text-white bg-indigo-500 rounded-lg hover:bg-indigo-400"
          >
            Scan again
          </button>
        </div>
      </main>
    );
  }

  // ─── Found State ────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-slate-900 p-8">
      <header className="mb-8 max-w-4xl mx-auto">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-50">Opportunities</h1>
            <p className="text-slate-400 mt-1">
              growth found {opportunities.length}{' '}
              {opportunities.length === 1 ? 'opportunity' : 'opportunities'} across{' '}
              {summary?.totalContacts ?? 0} contacts.
            </p>
          </div>
          <button
            onClick={() => refetch()}
            className="text-sm text-slate-400 hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-slate-900 rounded px-2 py-1"
            aria-label="Rescan opportunities"
          >
            ↻ Rescan
          </button>
        </div>
      </header>

      {launchResult && (
        <LaunchSuccessBanner
          result={launchResult}
          onDismiss={() => setLaunchResult(null)}
        />
      )}

      <div className="max-w-4xl mx-auto space-y-6">
        {opportunities.map((opp) => (
          <OpportunityCard
            key={opp.type}
            opportunity={opp}
            onLaunch={handleLaunch}
            isLaunching={isLaunching}
          />
        ))}
      </div>
    </main>
  );
}

// ─── Opportunity Card ─────────────────────────────────────────────────

function OpportunityCard({
  opportunity,
  onLaunch,
  isLaunching,
}: {
  opportunity: Opportunity;
  onLaunch: (opp: Opportunity, dryRun: boolean) => void;
  isLaunching: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <article
      className="rounded-xl border border-slate-700 bg-slate-800 overflow-hidden"
      role="article"
      aria-label={`Opportunity: ${opportunity.displayName}`}
    >
      {/* Header */}
      <div className="p-6 border-b border-slate-700">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span
                className="w-2 h-2 rounded-full bg-indigo-400"
                aria-hidden="true"
              />
              <span className="text-xs font-medium text-indigo-400 uppercase tracking-wide">
                AI-identified opportunity
              </span>
            </div>
            <h2 className="text-xl font-semibold text-slate-50">
              {opportunity.displayName}
            </h2>
            <p className="text-slate-300 mt-2">{opportunity.reasoning}</p>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-3xl font-bold text-slate-50">
              {opportunity.estimatedPopulation}
            </div>
            <div className="text-xs text-slate-400">
              {opportunity.estimatedPopulation === 1 ? 'contact' : 'contacts'}
            </div>
          </div>
        </div>
      </div>

      {/* Sample contacts */}
      <div className="px-6 py-4 border-b border-slate-700">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
          Contacts in this segment
        </h3>
        <ul className="space-y-2">
          {opportunity.sampleContacts.map((c) => (
            <li key={c.id} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-slate-300 text-xs font-medium">
                  {c.name.slice(0, 2).toUpperCase()}
                </div>
                <span className="text-slate-100">{c.name}</span>
                {c.email && (
                  <span className="text-slate-500 font-mono text-xs">{c.email}</span>
                )}
              </div>
              {c.lifecycleStage && (
                <span className="text-xs text-slate-400">{c.lifecycleStage}</span>
              )}
            </li>
          ))}
          {opportunity.estimatedPopulation > opportunity.sampleContacts.length && (
            <li className="text-xs text-slate-500 pl-11">
              + {opportunity.estimatedPopulation - opportunity.sampleContacts.length} more
            </li>
          )}
        </ul>
      </div>

      {/* Playbook preview */}
      {opportunity.playbook && (
        <div className="px-6 py-4 border-b border-slate-700">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              What growth will do
            </h3>
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-xs text-slate-400 hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 rounded px-1"
              aria-expanded={expanded}
            >
              {expanded ? '▲ Hide reasoning' : '▼ Show reasoning'}
            </button>
          </div>
          <p className="text-sm text-slate-300 mt-2 font-medium">
            {opportunity.playbook.name}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            {opportunity.playbook.description}
          </p>
          <ol className="mt-3 space-y-2">
            {opportunity.playbook.steps.map((step, i) => (
              <li
                key={i}
                className="flex items-start gap-3 text-sm"
              >
                <span className="shrink-0 w-6 h-6 rounded-full bg-indigo-950 text-indigo-300 text-xs font-medium flex items-center justify-center mt-0.5">
                  {i + 1}
                </span>
                <div className="flex-1">
                  <span className="text-slate-100">
                    Day {step.day}: {step.intent.replace(/_/g, ' ')}
                  </span>
                  <span className="ml-2 text-xs text-slate-500 uppercase tracking-wide">
                    {step.channel}
                  </span>
                </div>
              </li>
            ))}
          </ol>
          {expanded && (
            <div className="mt-4 p-3 rounded-md bg-slate-900 border border-slate-700 text-xs font-mono text-slate-400 leading-relaxed">
              Signal source: <span className="text-indigo-400">{opportunity.signalSource}</span>
              <br />
              Playbook slug: <span className="text-indigo-400">{opportunity.playbookSlug}</span>
              <br />
              Each step is executed by growth's existing Decision Engine (KAN-649) with a
              constrained instruction — the engine doesn't pick what to say, it executes the
              step within guardrails.
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="px-6 py-4 bg-slate-800 border-t border-slate-700 flex items-center justify-between gap-4 flex-wrap">
        <p className="text-xs text-slate-500">
          Preview sends no real messages. Launch dispatches via your connected channels.
        </p>
        <div className="flex gap-3 shrink-0">
          <button
            onClick={() => onLaunch(opportunity, true)}
            disabled={isLaunching}
            className="px-4 py-2 text-sm font-medium border border-slate-600 text-slate-200 rounded-lg hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Preview messages
          </button>
          <button
            onClick={() => onLaunch(opportunity, false)}
            disabled={isLaunching}
            className="px-4 py-2 text-sm font-medium text-white bg-indigo-500 rounded-lg hover:bg-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLaunching ? 'Launching…' : `Launch for ${opportunity.estimatedPopulation}`}
          </button>
        </div>
      </div>
    </article>
  );
}

// ─── Launch Success Banner ────────────────────────────────────────────

function LaunchSuccessBanner({
  result,
  onDismiss,
}: {
  result: LaunchResponse;
  onDismiss: () => void;
}) {
  return (
    <div
      className="max-w-4xl mx-auto mb-6 rounded-xl border border-emerald-800 bg-emerald-950 p-5"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400" aria-hidden="true" />
            <span className="text-xs font-medium text-emerald-300 uppercase tracking-wide">
              {result.dryRun ? 'Preview complete' : 'Launched'}
            </span>
          </div>
          <p className="text-emerald-50 font-medium">
            {result.dryRun
              ? `Preview: growth composed ${result.launched} messages for ${result.opportunityType.replace(/_/g, ' ')}. No messages sent.`
              : `${result.launched} ${result.launched === 1 ? 'contact' : 'contacts'} enrolled — first message queued.`}
            {result.errors > 0 && ` (${result.errors} failed)`}
          </p>
          <p className="text-emerald-200 text-sm mt-1">
            <a href="/audit-log" className="underline hover:text-emerald-100">
              View decisions in audit log →
            </a>
          </p>
        </div>
        <button
          onClick={onDismiss}
          className="text-emerald-400 hover:text-emerald-200 text-lg leading-none"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800 p-6 animate-pulse">
      <div className="h-4 w-32 bg-slate-700 rounded mb-3" />
      <div className="h-6 w-64 bg-slate-700 rounded mb-4" />
      <div className="h-4 w-full bg-slate-700 rounded mb-2" />
      <div className="h-4 w-3/4 bg-slate-700 rounded" />
    </div>
  );
}
