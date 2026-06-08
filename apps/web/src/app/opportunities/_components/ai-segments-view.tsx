'use client';

/**
 * KAN-886 — AI Segments view (Wedge Day-1 surface).
 *
 * MOVED VERBATIM from apps/web/src/app/opportunities/page.tsx as part
 * of the Cohort 1 PR 3 Tabs refactor. Behavior, copy, and data flow are
 * intentionally unchanged — the regression-protection snapshot tests
 * at __tests__/ai-segments-view.test.tsx pin the 3 sub-states
 * (empty / found / launched).
 *
 * KAN-984 Phase C.1 — dark→light token reskin. All hardcoded slate /
 * indigo / red / emerald utility classes migrated to the Phase A token
 * system + B.1 primitives (Card / Button / Badge). Snapshot tests
 * regenerated. Behavior + copy + data flow unchanged.
 *
 * Data source: `wedge.opportunities` (KAN-655) + per-opportunity
 * `outcomes.summaryForOpportunity` (KAN-657). NOT the new
 * deals.list — those flow through the All Deals tab. The two views
 * are intentionally separate: AI Segments groups Contacts by SIGNAL
 * pattern (dormant, high-intent-no-touch, data-enrichment), while
 * All Deals enumerates every Deal row from the canonical schema.
 *
 * KEEP USING raw trpcQuery (NOT TanStack Query) — the original
 * implementation manages 3 interacting concerns (opportunities fetch +
 * outcomes parallel fetch + launch mutation + post-launch refetch) and
 * the existing useState state-machine handles them coherently.
 */

import { useCallback, useEffect, useState } from 'react';
import { trpcQuery, trpcMutation } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

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

export interface Opportunity {
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

// KAN-657: counts of action.executed → ActionOutcome rows for an opportunity.
interface OutcomeSummary {
  sent: number;
  failed: number;
  suppressed: number;
  delivered: number;
  total: number;
  lastLaunchedAt: string | null;
}

export function AiSegmentsView() {
  const [data, setData] = useState<OpportunitiesResponse | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, OutcomeSummary>>({});
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

      // KAN-657: fetch per-opportunity outcome summaries in parallel.
      // Failures here don't block the page — outcomes are a secondary surface.
      const summaries = await Promise.all(
        result.opportunities.map(async (opp) => {
          try {
            const s = await trpcQuery<OutcomeSummary>('outcomes.summaryForOpportunity', {
              opportunityType: opp.type,
            });
            return [opp.type, s] as const;
          } catch {
            return null;
          }
        }),
      );
      const map: Record<string, OutcomeSummary> = {};
      for (const entry of summaries) {
        if (entry) map[entry[0]] = entry[1];
      }
      setOutcomes(map);
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
      <main className="min-h-screen bg-background p-8">
        <header className="mb-8">
          <h1 className="text-h1 text-foreground">Leads</h1>
          <p className="mt-1 text-muted-foreground">growth is scanning your contacts…</p>
        </header>
        <div className="mx-auto max-w-4xl">
          <SkeletonCard />
        </div>
      </main>
    );
  }

  // ─── Error ──────────────────────────────────────────────────────────
  if (isError) {
    return (
      <main className="min-h-screen bg-background p-8">
        <header className="mb-8">
          <h1 className="text-h1 text-foreground">Leads</h1>
        </header>
        <div
          className="mx-auto max-w-4xl rounded-[var(--ds-radius-card)] border p-6"
          style={{
            backgroundColor: 'var(--ds-danger-soft)',
            borderColor: 'var(--ds-danger)',
          }}
        >
          <p style={{ color: 'var(--ds-danger-text)' }}>
            Couldn&apos;t scan leads: {error?.message ?? 'unknown error'}.
          </p>
          <Button onClick={() => refetch()} variant="gradient" size="sm" className="mt-4">
            Try again
          </Button>
        </div>
      </main>
    );
  }

  const opportunities = data?.opportunities ?? [];
  const summary = data?.summary;

  // ─── Empty State ────────────────────────────────────────────────────
  if (opportunities.length === 0) {
    return (
      <main className="min-h-screen bg-background p-8">
        <header className="mb-8">
          <h1 className="text-h1 text-foreground">Leads</h1>
          <p className="mt-1 text-muted-foreground">
            growth scans your contacts for revenue patterns you haven&apos;t worked.
          </p>
        </header>
        <Card className="mx-auto max-w-4xl p-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ds-surface-sunken)]">
            <span className="text-xl text-muted-foreground">✓</span>
          </div>
          <h2 className="text-h2 text-foreground">No leads right now</h2>
          <p className="mx-auto mt-2 max-w-md text-muted-foreground">
            We scanned {summary?.totalContacts ?? 0} contacts and didn&apos;t find any signals
            above threshold. New leads appear as contacts go dormant or arrive unworked.
          </p>
          <Button onClick={() => refetch()} variant="gradient" size="sm" className="mt-6">
            Scan again
          </Button>
        </Card>
      </main>
    );
  }

  // ─── Found State ────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-background p-8">
      <header className="mx-auto mb-8 max-w-4xl">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="text-h1 text-foreground">Leads</h1>
            <p className="mt-1 text-muted-foreground">
              growth found {opportunities.length}{' '}
              {opportunities.length === 1 ? 'lead' : 'leads'} across{' '}
              {summary?.totalContacts ?? 0} contacts.
            </p>
          </div>
          <button
            onClick={() => refetch()}
            className="rounded-[var(--ds-radius-pill)] px-2 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            aria-label="Rescan leads"
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

      <div className="mx-auto max-w-4xl space-y-6">
        {opportunities.map((opp) => (
          <OpportunityCard
            key={opp.type}
            opportunity={opp}
            outcomes={outcomes[opp.type]}
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
  outcomes,
  onLaunch,
  isLaunching,
}: {
  opportunity: Opportunity;
  outcomes?: OutcomeSummary;
  onLaunch: (opp: Opportunity, dryRun: boolean) => void;
  isLaunching: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    // Use article semantics directly with Card's token classes — Card
    // primitive doesn't accept asChild, and the article element is the
    // load-bearing role here (each opportunity is a discrete article).
    <article
      className="overflow-hidden rounded-[var(--ds-radius-card)] border border-border bg-card text-card-foreground shadow-[var(--ds-shadow-card)]"
      role="article"
      aria-label={`Opportunity: ${opportunity.displayName}`}
    >
        {/* Header */}
        <div className="border-b border-border p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <Badge variant="ai" className="mb-2 inline-flex items-center gap-2 uppercase tracking-wide">
                <span
                  className="h-2 w-2 rounded-full bg-[var(--ds-violet-500)]"
                  aria-hidden="true"
                />
                AI-identified lead
              </Badge>
              <h2 className="text-h2 text-foreground">{opportunity.displayName}</h2>
              <p className="mt-2 text-muted-foreground">{opportunity.reasoning}</p>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-h1 tabular-nums text-foreground">
                {opportunity.estimatedPopulation}
              </div>
              <div className="text-caption text-muted-foreground">
                {opportunity.estimatedPopulation === 1 ? 'contact' : 'contacts'}
              </div>
            </div>
          </div>
        </div>

        {/* Sample contacts */}
        <div className="border-b border-border px-6 py-4">
          <h3 className="text-micro mb-3 uppercase tracking-wide text-muted-foreground">
            Contacts in this segment
          </h3>
          <ul className="space-y-2">
            {opportunity.sampleContacts.map((c) => (
              <li key={c.id} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--ds-violet-100)] text-xs font-medium text-[var(--ds-violet-500)]">
                    {c.name.slice(0, 2).toUpperCase()}
                  </div>
                  <span className="text-foreground">{c.name}</span>
                  {c.email && (
                    <span className="text-mono-sm text-muted-foreground">{c.email}</span>
                  )}
                </div>
                {c.lifecycleStage && (
                  <span className="text-caption text-muted-foreground">{c.lifecycleStage}</span>
                )}
              </li>
            ))}
            {opportunity.estimatedPopulation > opportunity.sampleContacts.length && (
              <li className="text-caption pl-11 text-muted-foreground">
                + {opportunity.estimatedPopulation - opportunity.sampleContacts.length} more
              </li>
            )}
          </ul>
        </div>

        {/* Playbook preview */}
        {opportunity.playbook && (
          <div className="border-b border-border px-6 py-4">
            <div className="flex items-center justify-between">
              <h3 className="text-micro uppercase tracking-wide text-muted-foreground">
                What growth will do
              </h3>
              <button
                onClick={() => setExpanded((v) => !v)}
                className="rounded px-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                aria-expanded={expanded}
              >
                {expanded ? '▲ Hide reasoning' : '▼ Show reasoning'}
              </button>
            </div>
            <p className="mt-2 text-sm font-medium text-foreground">
              {opportunity.playbook.name}
            </p>
            <p className="text-caption mt-1 text-muted-foreground">
              {opportunity.playbook.description}
            </p>
            <ol className="mt-3 space-y-2">
              {opportunity.playbook.steps.map((step, i) => (
                <li key={i} className="flex items-start gap-3 text-sm">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ds-violet-100)] text-xs font-medium text-[var(--ds-violet-500)]">
                    {i + 1}
                  </span>
                  <div className="flex-1">
                    <span className="text-foreground">
                      Day {step.day}: {step.intent.replace(/_/g, ' ')}
                    </span>
                    <span className="text-micro ml-2 uppercase tracking-wide text-muted-foreground">
                      {step.channel}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
            {expanded && (
              <div className="text-mono-sm mt-4 rounded-md border border-border bg-[var(--ds-surface-sunken)] p-3 leading-relaxed text-muted-foreground">
                Signal source:{' '}
                <span className="text-[var(--ds-violet-500)]">{opportunity.signalSource}</span>
                <br />
                Playbook slug:{' '}
                <span className="text-[var(--ds-violet-500)]">{opportunity.playbookSlug}</span>
                <br />
                Each step is executed by growth&apos;s existing Decision Engine (KAN-649) with
                a constrained instruction — the engine doesn&apos;t pick what to say, it
                executes the step within guardrails.
              </div>
            )}
          </div>
        )}

        {/* Outcomes summary — KAN-657. Only rendered when at least one Outcome exists. */}
        {outcomes && outcomes.total > 0 && (
          <div className="border-b border-border bg-[var(--ds-surface-sunken)] px-6 py-3">
            <p className="text-caption text-muted-foreground">
              Last launched
              {outcomes.lastLaunchedAt && (
                /* USER-tz display: `lastLaunchedAt` is a DateTime instant — operator
                   sees launch timestamp in browser locale, correct for "this happened
                   at X" displays. KAN-943's off-by-one bug applies only to `@db.Date`
                   sources, not instants. KAN-1131 PR 2 audit 2026-06-08. */
                <span> · {new Date(outcomes.lastLaunchedAt).toLocaleString()}</span>
              )}
              :{' '}
              <span style={{ color: 'var(--ds-emerald-700)' }}>{outcomes.sent} sent</span>
              {outcomes.delivered > 0 && (
                <>
                  {' · '}
                  <span style={{ color: 'var(--ds-emerald-700)' }}>
                    {outcomes.delivered} delivered
                  </span>
                </>
              )}
              {' · '}
              <span
                style={{
                  color:
                    outcomes.failed > 0
                      ? 'var(--ds-danger-text)'
                      : 'var(--ds-ink-tertiary)',
                }}
              >
                {outcomes.failed} failed
              </span>
              {' · '}
              <span
                style={{
                  color:
                    outcomes.suppressed > 0
                      ? 'var(--ds-warning-text)'
                      : 'var(--ds-ink-tertiary)',
                }}
              >
                {outcomes.suppressed} suppressed
              </span>
            </p>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border px-6 py-4">
          <p className="text-caption text-muted-foreground">
            Preview sends no real messages. Launch dispatches via your connected channels.
          </p>
          <div className="flex shrink-0 gap-3">
            <Button
              onClick={() => onLaunch(opportunity, true)}
              disabled={isLaunching}
              variant="outline"
              size="sm"
            >
              Preview messages
            </Button>
            <Button
              onClick={() => onLaunch(opportunity, false)}
              disabled={isLaunching}
              variant="gradient"
              size="sm"
            >
              {isLaunching ? 'Launching…' : `Launch for ${opportunity.estimatedPopulation}`}
            </Button>
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
      className="mx-auto mb-6 max-w-4xl rounded-[var(--ds-radius-card)] border p-5"
      style={{
        backgroundColor: 'var(--ds-emerald-100)',
        borderColor: 'var(--ds-emerald-500)',
      }}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2">
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: 'var(--ds-emerald-500)' }}
              aria-hidden="true"
            />
            <span
              className="text-micro uppercase tracking-wide"
              style={{ color: 'var(--ds-emerald-700)' }}
            >
              {result.dryRun ? 'Preview complete' : 'Launched'}
            </span>
          </div>
          <p className="font-medium" style={{ color: 'var(--ds-emerald-700)' }}>
            {result.dryRun
              ? `Preview: growth composed ${result.launched} messages for ${result.opportunityType.replace(/_/g, ' ')}. No messages sent.`
              : `${result.launched} ${result.launched === 1 ? 'contact' : 'contacts'} enrolled — first message queued.`}
            {result.errors > 0 && ` (${result.errors} failed)`}
          </p>
          <p className="mt-1 text-sm" style={{ color: 'var(--ds-emerald-700)' }}>
            <a href="/audit" className="underline hover:opacity-80">
              View decisions in audit log →
            </a>
          </p>
        </div>
        <button
          onClick={onDismiss}
          className="text-lg leading-none transition-opacity hover:opacity-70"
          style={{ color: 'var(--ds-emerald-700)' }}
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
    <Card className="animate-pulse p-6">
      <div
        className="mb-3 h-4 w-32 rounded"
        style={{ backgroundColor: 'var(--ds-surface-sunken)' }}
      />
      <div
        className="mb-4 h-6 w-64 rounded"
        style={{ backgroundColor: 'var(--ds-surface-sunken)' }}
      />
      <div
        className="mb-2 h-4 w-full rounded"
        style={{ backgroundColor: 'var(--ds-surface-sunken)' }}
      />
      <div
        className="h-4 w-3/4 rounded"
        style={{ backgroundColor: 'var(--ds-surface-sunken)' }}
      />
    </Card>
  );
}
