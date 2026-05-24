'use client';

/**
 * KAN-1000 Campaign Layer Slice 2 — the real /campaigns page.
 *
 * Replaces the throwaway /settings/campaign-demo (KAN-997). Slice 2
 * scope (Story 4.0 + Slice 2 stories):
 *
 *   - "What to focus on" NL create flow (graduated from Slice 1)
 *   - Full proposal preview: audience + objective + strategy + stages
 *     + first-actions + historical USD value
 *   - Light edits — name + window (date range)
 *   - "No campaigns yet" empty state (no Campaign entity exists until
 *     Slice 0/3 ships the schema)
 *
 * Gated by NEXT_PUBLIC_CAMPAIGN_LAYER_DEMO=true (rail item also gated
 * in layout.tsx). Read-only — no commit button, nothing persisted, no
 * action.* events.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import {
  Loader2,
  Sparkles,
  AlertCircle,
  HelpCircle,
  Users,
  Target,
  Workflow,
  Mail,
  MessageCircle,
  Phone,
  Megaphone,
  DollarSign,
  CheckCircle2,
  Rocket,
  Zap,
  Pause,
  AlertOctagon,
} from 'lucide-react';
import {
  audienceApi,
  type AudienceProposeResult,
  type CampaignActivateResult,
  type CampaignCommitResult,
  type CampaignFirstAction,
  type CampaignPauseResult,
  type CampaignProposalShape,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/detail-page-shell';
import { EmptyState } from '@/components/ui/empty-state';

const FLAG_ON = process.env.NEXT_PUBLIC_CAMPAIGN_LAYER_DEMO === 'true';

const STRATEGY_LABELS: Record<CampaignProposalShape['strategy'], string> = {
  direct: 'Direct Conversion',
  re_engage: 'Re-engagement',
  trust_build: 'Trust Building',
  guided: 'Guided Assistance',
};

const STRATEGY_DESCRIPTIONS: Record<CampaignProposalShape['strategy'], string> = {
  direct: 'Push toward conversion for high-intent contacts.',
  re_engage: 'Win back dormant or churned contacts.',
  trust_build: 'Relationship-building for early-stage or at-risk contacts.',
  guided: 'Educational approach for evaluating contacts.',
};

const CHANNEL_ICONS: Record<CampaignFirstAction['channel'], typeof Mail> = {
  email: Mail,
  sms: Phone,
  whatsapp: MessageCircle,
};

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

function isoToDateInput(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 10); // 'YYYY-MM-DD'
}

/** Stable per-proposal UUID — generated client-side once when a proposal
 *  lands. Sent to audience.commit as `idempotencyKey` so a double-click
 *  on Activate returns the existing IDs (same key + same name within the
 *  server's 5-minute window = recognized as a retry). Re-generated on
 *  each new proposal so subsequent commits are distinct. */
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Defensive fallback for environments without WebCrypto (extremely
  // unlikely in browsers we ship for; here for SSR-safety only).
  return `ik-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function CampaignsPage() {
  const [nl, setNl] = useState('');
  // Editable copies of the proposal's name + window. Initialize on
  // proposal arrival; user edits stay local until they re-run the NL.
  const [editName, setEditName] = useState('');
  const [editWindowStart, setEditWindowStart] = useState('');
  const [editWindowEnd, setEditWindowEnd] = useState('');
  // KAN-1001 Slice 3a — per-proposal idempotency key. Reset on each new
  // proposal so the next proposal generates a fresh key.
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() =>
    newIdempotencyKey(),
  );

  const mutation = useMutation<AudienceProposeResult, Error, string>({
    mutationFn: (input) => audienceApi.propose(input),
    onSuccess: (result) => {
      if (result.kind === 'proposal' || result.kind === 'thin') {
        setEditName(result.proposal.name);
        setEditWindowStart(isoToDateInput(result.proposal.windowStartUtc));
        setEditWindowEnd(isoToDateInput(result.proposal.windowEndUtc));
        // Fresh idempotency key per new proposal — the previous key is
        // bound to the previous proposal's name window.
        setIdempotencyKey(newIdempotencyKey());
      }
    },
  });

  // KAN-1001 Slice 3a — commit mutation. Returns the persisted Campaign
  // + Pipeline IDs + a materialization status flag so the UI can show
  // honest text ("snapshot materialized: N contacts" vs "snapshot
  // queued — large audience materializing in the background").
  const commitMutation = useMutation<
    CampaignCommitResult,
    Error,
    {
      proposal: CampaignProposalShape;
      edits?: {
        name?: string;
        windowStartUtc?: string | null;
        windowEndUtc?: string | null;
      };
      idempotencyKey: string;
    }
  >({
    mutationFn: (input) => audienceApi.commit(input),
  });

  // KAN-1010 SAE PR5 — activate the just-committed campaign. M1 closer.
  const activateMutation = useMutation<CampaignActivateResult, Error, string>({
    mutationFn: (campaignId) => audienceApi.activate(campaignId),
  });

  // KAN-1010 SAE PR5 — pause an active campaign. Stop lever.
  const pauseMutation = useMutation<CampaignPauseResult, Error, string>({
    mutationFn: (campaignId) => audienceApi.pause(campaignId),
  });

  if (!FLAG_ON) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ds-surface-sunken)]">
          <Megaphone className="h-6 w-6 text-muted-foreground" />
        </div>
        <h1 className="text-h1 text-foreground">Campaigns — internal preview</h1>
        <p className="mt-2 text-body text-muted-foreground">
          This surface is gated. Set{' '}
          <code className="rounded bg-[var(--ds-surface-sunken)] px-1.5 py-0.5 font-mono text-caption">
            NEXT_PUBLIC_CAMPAIGN_LAYER_DEMO=true
          </code>{' '}
          to enable.
        </p>
      </div>
    );
  }

  const result = mutation.data;
  const error = mutation.error;
  const hasProposal = result?.kind === 'proposal' || result?.kind === 'thin';

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="mb-6">
        <div className="mb-2 inline-flex items-center gap-2 rounded-[var(--ds-radius-pill)] bg-[var(--ds-violet-100)] px-3 py-1 text-caption font-medium uppercase tracking-wide text-[var(--ds-violet-500)]">
          <Sparkles className="h-3.5 w-3.5" />
          Internal preview · Slice 2
        </div>
        <h1 className="text-h1 text-foreground">Campaigns</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Describe what you want to focus on. growth proposes a complete campaign — audience,
          objective, strategy, stages, first actions. Nothing is committed until you say so.
        </p>
      </header>

      {/* Create flow — NL input */}
      <SectionCard title="What to focus on">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (nl.trim().length === 0) return;
            mutation.mutate(nl.trim());
          }}
        >
          <textarea
            value={nl}
            onChange={(e) => setNl(e.target.value)}
            placeholder="win back churned customers — anyone who hasn't placed an order in 90 days"
            rows={3}
            className="w-full rounded-[var(--ds-radius-input)] border border-border bg-card px-4 py-3 text-body text-foreground outline-none transition-colors focus:border-[var(--ds-violet-500)] focus:ring-2 focus:ring-[var(--ds-violet-500)]/20"
            disabled={mutation.isPending}
          />
          <div className="mt-3 flex items-center justify-between">
            <p className="text-caption text-muted-foreground">
              Examples — &quot;reactivate dormant customers&quot;,
              &quot;book demos with qualified leads&quot;,
              &quot;upsell premium tier to active customers&quot;.
            </p>
            <Button
              type="submit"
              variant="gradient"
              size="sm"
              disabled={nl.trim().length === 0 || mutation.isPending}
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Proposing…
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  Propose campaign
                </>
              )}
            </Button>
          </div>
        </form>
      </SectionCard>

      {/* Error state */}
      {error ? (
        <div className="mt-4 flex items-start gap-2 rounded-[var(--ds-radius-input)] border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] px-4 py-3 text-body text-[var(--ds-danger-text)]">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>
            <div className="font-medium">Couldn&apos;t propose a campaign.</div>
            <div className="mt-0.5 text-caption">{error.message}</div>
          </div>
        </div>
      ) : null}

      {/* Result — discriminated render */}
      {result?.kind === 'ambiguous' ? (
        <div className="mt-4">
          <SectionCard title="Need a clarification">
            <div className="flex items-start gap-3">
              <HelpCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--ds-warning-text)]" />
              <p className="text-body text-foreground">{result.clarifyingQuestion}</p>
            </div>
            <p className="mt-3 text-caption text-muted-foreground">
              Refine the description above and resubmit.
            </p>
          </SectionCard>
        </div>
      ) : null}

      {hasProposal ? (
        <ProposalPreview
          result={result!}
          editName={editName}
          editWindowStart={editWindowStart}
          editWindowEnd={editWindowEnd}
          onNameChange={setEditName}
          onWindowStartChange={setEditWindowStart}
          onWindowEndChange={setEditWindowEnd}
          commitResult={commitMutation.data}
          commitError={commitMutation.error}
          commitPending={commitMutation.isPending}
          onCommit={() => {
            if (!result || (result.kind !== 'proposal' && result.kind !== 'thin')) return;
            const dateToIso = (d: string): string | null =>
              d ? new Date(`${d}T00:00:00.000Z`).toISOString() : null;
            commitMutation.mutate({
              proposal: result.proposal,
              edits: {
                name: editName.trim() || undefined,
                windowStartUtc: dateToIso(editWindowStart),
                windowEndUtc: dateToIso(editWindowEnd),
              },
              idempotencyKey,
            });
          }}
          // KAN-1010 SAE PR5 + fix-forward: pass activate/pause through
          // ProposalPreview to the inner CommitSuccessCard. Previously the
          // inner card referenced `activateMutation` directly which is
          // only in CampaignsPage's scope, not ProposalPreview's → runtime
          // ReferenceError. Verified via render-test regression
          // (campaigns-commit-success-render.test.tsx).
          activateResult={activateMutation.data}
          activateError={activateMutation.error}
          activatePending={activateMutation.isPending}
          onActivate={(campaignId) => activateMutation.mutate(campaignId)}
          pauseResult={pauseMutation.data}
          pauseError={pauseMutation.error}
          pausePending={pauseMutation.isPending}
          onPause={(campaignId) => pauseMutation.mutate(campaignId)}
        />
      ) : null}

      {/* Empty state — no campaigns yet (no Campaign entity until
          Slice 0/3). Always shown below the create flow so users know
          this is the home for committed campaigns once Slice 3 lands. */}
      <div className="mt-8 rounded-[var(--ds-radius-card)] border border-dashed border-border bg-card/50 p-8">
        <EmptyState
          icon={Megaphone}
          heading="No campaigns yet"
          body="Proposed campaigns aren't saved in Slice 2 — they're previewed read-only. Slice 3 will land the commit + activation flow."
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Proposal preview — the full card stack
// ─────────────────────────────────────────────

function ProposalPreview({
  result,
  editName,
  editWindowStart,
  editWindowEnd,
  onNameChange,
  onWindowStartChange,
  onWindowEndChange,
  commitResult,
  commitError,
  commitPending,
  onCommit,
  // KAN-1010 SAE PR5 fix-forward — receive activate/pause from parent
  // (CampaignsPage scope) instead of referencing CampaignsPage locals
  // from inside ProposalPreview (the original bug).
  activateResult,
  activateError,
  activatePending,
  onActivate,
  pauseResult,
  pauseError,
  pausePending,
  onPause,
}: {
  result: AudienceProposeResult;
  editName: string;
  editWindowStart: string;
  editWindowEnd: string;
  onNameChange: (v: string) => void;
  onWindowStartChange: (v: string) => void;
  onWindowEndChange: (v: string) => void;
  commitResult: CampaignCommitResult | undefined;
  commitError: Error | null;
  commitPending: boolean;
  onCommit: () => void;
  activateResult: CampaignActivateResult | undefined;
  activateError: Error | null;
  activatePending: boolean;
  onActivate: (campaignId: string) => void;
  pauseResult: CampaignPauseResult | undefined;
  pauseError: Error | null;
  pausePending: boolean;
  onPause: (campaignId: string) => void;
}) {
  if (result.kind === 'ambiguous') return null;
  const isThin = result.kind === 'thin';
  const p = result.proposal;

  return (
    <div className="mt-4 space-y-4">
      {/* Headline + edits (name + window) */}
      <SectionCard title={isThin ? 'Proposal — thin match' : 'Proposal'}>
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-label text-foreground">Campaign name</label>
            <input
              type="text"
              value={editName}
              onChange={(e) => onNameChange(e.target.value)}
              className="w-full rounded-[var(--ds-radius-input)] border border-border bg-card px-3 py-2 text-body text-foreground outline-none focus:border-[var(--ds-violet-500)]"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-label text-foreground">Window start</label>
              <input
                type="date"
                value={editWindowStart}
                onChange={(e) => onWindowStartChange(e.target.value)}
                className="w-full rounded-[var(--ds-radius-input)] border border-border bg-card px-3 py-2 text-body text-foreground outline-none focus:border-[var(--ds-violet-500)]"
              />
            </div>
            <div>
              <label className="mb-1 block text-label text-foreground">Window end</label>
              <input
                type="date"
                value={editWindowEnd}
                onChange={(e) => onWindowEndChange(e.target.value)}
                className="w-full rounded-[var(--ds-radius-input)] border border-border bg-card px-3 py-2 text-body text-foreground outline-none focus:border-[var(--ds-violet-500)]"
              />
            </div>
          </div>
          <p className="text-caption text-muted-foreground">
            Name + window are editable for validation. Refining the audience requires editing the description above and resubmitting.
          </p>
        </div>
      </SectionCard>

      {/* Audience */}
      <SectionCard title="Audience">
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-[var(--ds-radius-input)] border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-caption text-muted-foreground">
              <Users className="h-3.5 w-3.5" />
              Matching contacts
            </div>
            <div className="mt-1 text-h1 text-foreground">
              {p.audience.count.toLocaleString('en-US')}
            </div>
            {isThin ? (
              <div className="mt-1 text-caption text-[var(--ds-warning-text)]">{result.message}</div>
            ) : (
              <div className="mt-1 text-caption text-muted-foreground">{result.message}</div>
            )}
          </div>
          <div className="rounded-[var(--ds-radius-input)] border border-border bg-card p-4">
            <div className="flex items-center gap-2 text-caption text-muted-foreground">
              <DollarSign className="h-3.5 w-3.5" />
              Past USD revenue in this audience
            </div>
            <div className="mt-1 text-h1 text-foreground">{formatUsd(p.audience.historicalValueUsd)}</div>
            <div className="mt-1 text-caption text-muted-foreground">
              Historical signal, not a forecast. USD orders only.
            </div>
          </div>
        </div>
        <details className="mt-4">
          <summary className="cursor-pointer text-caption text-muted-foreground hover:text-foreground">
            View resolved audience_conditions
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-[var(--ds-radius-input)] bg-[var(--ds-surface-sunken)] p-3 text-caption font-mono text-foreground">
            {JSON.stringify(p.audience.conditions, null, 2)}
          </pre>
        </details>
      </SectionCard>

      {/* Objective + Strategy */}
      <SectionCard title="Inferred objective & strategy">
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--ds-violet-100)] text-[var(--ds-violet-500)]">
              <Target className="h-4 w-4" />
            </div>
            <div className="flex-1">
              <div className="text-label text-foreground">{p.objective.name}</div>
              <div className="text-caption text-muted-foreground">
                Objective type: <span className="font-mono">{p.objective.type}</span> · catalog id <span className="font-mono">{p.objective.id}</span>
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--ds-emerald-100)] text-[var(--ds-emerald-700)]">
              <Sparkles className="h-4 w-4" />
            </div>
            <div className="flex-1">
              <div className="text-label text-foreground">{STRATEGY_LABELS[p.strategy]}</div>
              <div className="text-caption text-muted-foreground">{STRATEGY_DESCRIPTIONS[p.strategy]}</div>
            </div>
          </div>
        </div>
      </SectionCard>

      {/* Proposed stages */}
      <SectionCard title="Proposed pipeline stages" count={p.proposedStages.length}>
        <ol className="space-y-2">
          {p.proposedStages.map((stage) => (
            <li
              key={stage.order}
              className="flex items-start gap-3 rounded-[var(--ds-radius-input)] border border-border p-3"
            >
              <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-sunken)] text-caption font-medium text-foreground">
                {stage.order + 1}
              </div>
              <div className="flex-1">
                <div className="text-label text-foreground">{stage.name}</div>
                <div className="text-caption text-muted-foreground">{stage.description}</div>
              </div>
            </li>
          ))}
        </ol>
      </SectionCard>

      {/* First actions */}
      <SectionCard title="First actions" count={p.firstActions.length}>
        <p className="mb-3 text-caption text-muted-foreground">
          Described, not dispatched. Commit persists these as a plan; the autonomous engine handoff (real execution) is a separate gated step.
        </p>
        <ol className="space-y-2">
          {p.firstActions.map((action, i) => {
            const Icon = CHANNEL_ICONS[action.channel];
            return (
              <li
                key={i}
                className="flex items-start gap-3 rounded-[var(--ds-radius-input)] border border-border p-3"
              >
                <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-violet-100)] text-[var(--ds-violet-500)]">
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-label text-foreground">Day {action.day}</span>
                    <span className="rounded-[var(--ds-radius-pill)] bg-[var(--ds-surface-sunken)] px-2 py-0.5 text-caption uppercase tracking-wide text-muted-foreground">
                      {action.channel}
                    </span>
                    <span className="text-caption text-muted-foreground">· {action.intent}</span>
                  </div>
                  <div className="mt-0.5 text-caption text-muted-foreground">{action.description}</div>
                </div>
              </li>
            );
          })}
        </ol>
      </SectionCard>

      {/* KAN-1001 Slice 3a — Commit card. Persists Campaign + Pipeline +
          Stages + initial membership snapshot. INERT: no Decision Engine
          handoff, no sends. Real activation (engine handoff) lands in a
          separate gated PR (SAE PR3). KAN-1004 SAE PR1 corrected the
          button copy from "Activate" → "Commit" to match semantics. */}
      {commitResult ? (
        <CommitSuccessCard
          result={commitResult}
          activateResult={activateResult}
          activateError={activateError}
          activatePending={activatePending}
          onActivate={() => onActivate(commitResult.campaignId)}
          pauseResult={pauseResult}
          pauseError={pauseError}
          pausePending={pausePending}
          onPause={() => onPause(commitResult.campaignId)}
        />
      ) : (
        <div className="rounded-[var(--ds-radius-card)] border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <Workflow className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--ds-violet-500)]" />
            <div className="flex-1 text-caption text-foreground">
              <strong>Committing creates the campaign + its pipeline, but doesn&apos;t start sending.</strong>{' '}
              The campaign becomes observable (rows exist, pipeline appears on the
              board, audit log records the commit) but no contacts get prioritized
              into the autonomous loop. The engine-handoff (real activation) lands
              in a separate gated PR.
            </div>
          </div>
          <div className="mt-4 flex items-center justify-end gap-3">
            {commitError ? (
              <div className="flex items-start gap-2 text-caption text-[var(--ds-danger-text)]">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <span>{commitError.message}</span>
              </div>
            ) : null}
            <Button
              variant="gradient"
              size="sm"
              disabled={commitPending || editName.trim().length === 0}
              onClick={onCommit}
            >
              {commitPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Committing…
                </>
              ) : (
                <>
                  <Rocket className="h-3.5 w-3.5" />
                  Commit campaign
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CommitSuccessCard({
  result,
  activateResult,
  activateError,
  activatePending,
  onActivate,
  pauseResult,
  pauseError,
  pausePending,
  onPause,
}: {
  result: CampaignCommitResult;
  activateResult: CampaignActivateResult | undefined;
  activateError: Error | null;
  activatePending: boolean;
  onActivate: () => void;
  pauseResult: CampaignPauseResult | undefined;
  pauseError: Error | null;
  pausePending: boolean;
  onPause: () => void;
}) {
  const materializedSync = result.membershipStatus === 'materialized_sync';
  // KAN-1010 — derived engine-handoff state. Drives the activate/pause
  // affordance below.
  const isActivated =
    activateResult?.kind === 'activated' || activateResult?.kind === 'already_active';
  const isPaused = pauseResult?.kind === 'paused';
  // The audience must be evaluated before activate can fire (PR3 interlock).
  // Async-materialize means the snapshot is still in-flight — surface this.
  const audienceNotEvaluated = !materializedSync && !isActivated;

  return (
    <>
      {/* Commit success card */}
      <div className="rounded-[var(--ds-radius-card)] border border-[var(--ds-emerald-100)] bg-[var(--ds-emerald-100)]/40 p-5">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--ds-emerald-700)]" />
          <div className="flex-1">
            <div className="text-label text-foreground">
              {result.alreadyExisted ? 'Campaign already committed' : 'Campaign committed'}
            </div>
            <div className="mt-1 text-caption text-muted-foreground">
              {result.alreadyExisted ? (
                <>
                  A campaign with this name was committed within the last 5 minutes —
                  returning the existing record. Campaign id{' '}
                  <code className="rounded bg-[var(--ds-surface-sunken)] px-1 py-0.5 font-mono">
                    {result.campaignId}
                  </code>
                  .
                </>
              ) : (
                <>
                  {materializedSync
                    ? `Audience snapshot materialized: ${result.membershipSnapshotCountSync.toLocaleString(
                        'en-US',
                      )} of ${result.audienceCount.toLocaleString('en-US')} contacts.`
                    : `Audience snapshot queued for ${result.audienceCount.toLocaleString(
                        'en-US',
                      )} contacts — materializing in the background.`}{' '}
                  Activate below to hand the membership to the autonomous engine
                  (each member queues for human review under your current
                  auto-approve setting).
                </>
              )}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Link
                href={`/pipelines/${result.pipelineId}`}
                className="text-caption font-medium text-[var(--ds-violet-500)] hover:underline"
              >
                View pipeline board →
              </Link>
              <span className="text-caption text-muted-foreground">·</span>
              <span className="text-caption text-muted-foreground">
                Campaign id <code className="font-mono">{result.campaignId}</code>
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* KAN-1010 — Activate / Pause affordance card */}
      {isPaused ? (
        <div className="rounded-[var(--ds-radius-card)] border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <Pause className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" />
            <div className="flex-1">
              <div className="text-label text-foreground">Campaign paused</div>
              <div className="mt-1 text-caption text-muted-foreground">
                Stack entries flipped to paused; the autonomous consumer will no-op
                on any in-flight or redelivered evaluations for this campaign. No
                further actions can fire. {pauseResult.stackEntriesPaused.toLocaleString('en-US')} stack entries paused.
              </div>
            </div>
          </div>
        </div>
      ) : isActivated ? (
        <ActivatedCard
          activateResult={activateResult!}
          onPause={onPause}
          pausePending={pausePending}
          pauseError={pauseError}
        />
      ) : (
        <div className="rounded-[var(--ds-radius-card)] border border-border bg-card p-5">
          <div className="flex items-start gap-3">
            <Zap className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--ds-violet-500)]" />
            <div className="flex-1 text-caption text-foreground">
              <strong>Activate hands the campaign to the autonomous engine.</strong>{' '}
              Under your current settings (auto-approve OFF), every contact
              evaluation lands as an item in{' '}
              <Link href="/escalations" className="font-medium text-[var(--ds-violet-500)] hover:underline">
                Escalations
              </Link>{' '}
              for review — no messages are sent. Pause anytime; the engine halts
              immediately. A daily LLM cost cap stands guard against runaway spend.
            </div>
          </div>
          <div className="mt-4 flex items-center justify-end gap-3">
            {activateError ? (
              <div className="flex items-start gap-2 text-caption text-[var(--ds-danger-text)]">
                <AlertOctagon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <span>{activateError.message}</span>
              </div>
            ) : null}
            {activateResult?.kind === 'rejected' ? (
              <div className="flex items-start gap-2 text-caption text-[var(--ds-warning-text)]">
                <AlertOctagon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <span>
                  Refused: {humanizeActivateRejection(activateResult.reason, activateResult.currentStatus)}
                </span>
              </div>
            ) : null}
            <Button
              variant="gradient"
              size="sm"
              disabled={activatePending || audienceNotEvaluated}
              onClick={onActivate}
            >
              {activatePending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:hidden" />
                  Activating…
                </>
              ) : (
                <>
                  <Zap className="h-3.5 w-3.5" />
                  Activate campaign
                </>
              )}
            </Button>
          </div>
          {audienceNotEvaluated ? (
            <div className="mt-2 text-right text-caption text-muted-foreground">
              Audience snapshot still materializing — activate becomes available
              when the snapshot finishes.
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}

function ActivatedCard({
  activateResult,
  onPause,
  pausePending,
  pauseError,
}: {
  activateResult: CampaignActivateResult;
  onPause: () => void;
  pausePending: boolean;
  pauseError: Error | null;
}) {
  // Narrow to the two states that mean "active" right now
  const data =
    activateResult.kind === 'activated'
      ? activateResult
      : activateResult.kind === 'already_active'
        ? activateResult
        : null;
  if (!data) return null;
  const isFresh = activateResult.kind === 'activated';
  return (
    <div className="rounded-[var(--ds-radius-card)] border border-[var(--ds-violet-100)] bg-[var(--ds-violet-100)]/40 p-5">
      <div className="flex items-start gap-3">
        <Zap className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--ds-violet-500)]" />
        <div className="flex-1">
          <div className="text-label text-foreground">
            {isFresh ? 'Campaign activated' : 'Campaign already active'}
          </div>
          <div className="mt-1 text-caption text-muted-foreground">
            {isFresh && activateResult.kind === 'activated' ? (
              <>
                {activateResult.memberCount.toLocaleString('en-US')} members queued for engine
                evaluation, drip-publishing at {activateResult.dripPublishesPerSecond}/sec.
                {activateResult.stackEntriesCreated > 0
                  ? ` ${activateResult.stackEntriesCreated.toLocaleString('en-US')} new stack entries created`
                  : ''}
                {activateResult.stackEntriesReactivated > 0
                  ? `, ${activateResult.stackEntriesReactivated.toLocaleString('en-US')} reactivated`
                  : ''}
                . Under auto-approve OFF, every evaluation lands as an item in{' '}
                <Link href="/escalations" className="font-medium text-[var(--ds-violet-500)] hover:underline">
                  Escalations
                </Link>
                .
              </>
            ) : (
              <>
                {data.memberCount.toLocaleString('en-US')} members in flight. Re-activate
                is a no-op (no re-publish).
              </>
            )}
          </div>
          <div className="mt-4 flex items-center justify-end gap-3">
            {pauseError ? (
              <div className="flex items-start gap-2 text-caption text-[var(--ds-danger-text)]">
                <AlertOctagon className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <span>{pauseError.message}</span>
              </div>
            ) : null}
            <Button variant="outline" size="sm" disabled={pausePending} onClick={onPause}>
              {pausePending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:hidden" />
                  Pausing…
                </>
              ) : (
                <>
                  <Pause className="h-3.5 w-3.5" />
                  Pause campaign
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function humanizeActivateRejection(reason: string, currentStatus?: string): string {
  switch (reason) {
    case 'campaign_not_found':
      return 'campaign not found in this tenant';
    case 'audience_not_evaluated':
      return 'audience snapshot is still materializing — try again in a moment';
    case 'status_draft':
      return 'campaign is still a draft — commit it first';
    case 'status_paused':
      return 'campaign is paused — pause→active resume is not available in M1';
    case 'status_completed':
      return 'campaign has already completed';
    case 'status_archived':
      return 'campaign is archived';
    default:
      return currentStatus ? `unexpected status: ${currentStatus}` : 'unexpected refusal';
  }
}

// KAN-1010 SAE PR5 fix-forward — testing seam. CommitSuccessCard is
// module-private (no direct export) so unit tests have nothing to
// import. Expose under a `__testing__` namespace following the
// established codebase convention (per redis-client.ts
// __setRedisClientForTest, etc.). Production code does not consume this.
export const __testing__ = { CommitSuccessCard };
