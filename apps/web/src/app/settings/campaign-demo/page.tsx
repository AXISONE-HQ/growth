'use client';

/**
 * KAN-997 Campaign Layer Slice 1 — internal demo surface.
 *
 * Behind `NEXT_PUBLIC_CAMPAIGN_LAYER_DEMO=true` so a half-experience
 * isn't exposed to prod users until Slice 2 lands the proposal/preview
 * card. NOT linked from the rail or Settings nav — direct URL only.
 *
 * Surface: text input → submit → audienceApi.textToSegment → render
 * one of {segment | thin | ambiguous}. No commit button (read-only).
 *
 * Honest UX:
 *   - segment  → "{count} contacts match" + show the resolved
 *                audience_conditions JSON for inspectability
 *   - thin     → "Only N contact(s) match this segment." (or "No
 *                contacts match.") + still show conditions
 *   - ambiguous → render the model's clarifying question; user can
 *                 edit the NL and resubmit
 *   - error    → surface the error message (LLM gave non-JSON, schema
 *                rejected, etc.)
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Sparkles, AlertCircle, HelpCircle, Users } from 'lucide-react';
import { audienceApi, type AudienceTextToSegmentResult } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/detail-page-shell';

const FLAG_ON = process.env.NEXT_PUBLIC_CAMPAIGN_LAYER_DEMO === 'true';

export default function CampaignDemoPage() {
  const [nl, setNl] = useState('');

  const mutation = useMutation<AudienceTextToSegmentResult, Error, string>({
    mutationFn: (input) => audienceApi.textToSegment(input),
  });

  if (!FLAG_ON) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ds-surface-sunken)]">
          <Sparkles className="h-6 w-6 text-muted-foreground" />
        </div>
        <h1 className="text-h1 text-foreground">Campaign Layer — internal preview</h1>
        <p className="mt-2 text-body text-muted-foreground">
          This surface is gated. Set <code className="rounded bg-[var(--ds-surface-sunken)] px-1.5 py-0.5 font-mono text-caption">NEXT_PUBLIC_CAMPAIGN_LAYER_DEMO=true</code> to enable.
        </p>
      </div>
    );
  }

  const result = mutation.data;
  const error = mutation.error;

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <div className="mb-2 inline-flex items-center gap-2 rounded-[var(--ds-radius-pill)] bg-[var(--ds-violet-100)] px-3 py-1 text-caption font-medium uppercase tracking-wide text-[var(--ds-violet-500)]">
          <Sparkles className="h-3.5 w-3.5" />
          Internal preview · Slice 1
        </div>
        <h1 className="text-h1 text-foreground">Text-to-segment</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Describe an audience in plain English. growth structures it into a query and shows you the live count. Read-only — nothing is sent or committed.
        </p>
      </header>

      <SectionCard title="Describe your audience">
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
            placeholder="contacts that bought or sent a lead in March, April & May of last year"
            rows={3}
            className="w-full rounded-[var(--ds-radius-input)] border border-border bg-card px-4 py-3 text-body text-foreground outline-none transition-colors focus:border-[var(--ds-violet-500)] focus:ring-2 focus:ring-[var(--ds-violet-500)]/20"
            disabled={mutation.isPending}
          />
          <div className="mt-3 flex items-center justify-between">
            <p className="text-caption text-muted-foreground">
              Tip — try &quot;customers who bought last month&quot; or
              &quot;leads from Canada created this year&quot;.
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
                  Resolving…
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  Find audience
                </>
              )}
            </Button>
          </div>
        </form>
      </SectionCard>

      {/* Error state — LLM gave non-JSON, schema rejected, network, etc. */}
      {error ? (
        <div className="mt-4 flex items-start gap-2 rounded-[var(--ds-radius-input)] border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] px-4 py-3 text-body text-[var(--ds-danger-text)]">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>
            <div className="font-medium">Couldn&apos;t resolve that segment.</div>
            <div className="mt-0.5 text-caption">{error.message}</div>
          </div>
        </div>
      ) : null}

      {/* Result — discriminated render */}
      {result ? <ResultBlock result={result} /> : null}
    </div>
  );
}

function ResultBlock({ result }: { result: AudienceTextToSegmentResult }) {
  if (result.kind === 'ambiguous') {
    return (
      <div className="mt-4">
        <SectionCard title="Need a clarification">
          <div className="flex items-start gap-3">
            <HelpCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--ds-warning-text)]" />
            <p className="text-body text-foreground">{result.clarifyingQuestion}</p>
          </div>
          <p className="mt-3 text-caption text-muted-foreground">
            Refine your description above and resubmit.
          </p>
        </SectionCard>
      </div>
    );
  }

  // segment OR thin — both have conditions + count + message.
  const isThin = result.kind === 'thin';
  return (
    <div className="mt-4 space-y-4">
      <SectionCard title={isThin ? 'Thin match' : 'Audience found'}>
        <div className="flex items-center gap-3">
          <div
            className={`flex h-12 w-12 items-center justify-center rounded-full ${
              isThin
                ? 'bg-[var(--ds-warning-soft)] text-[var(--ds-warning-text)]'
                : 'bg-[var(--ds-emerald-100)] text-[var(--ds-emerald-700)]'
            }`}
          >
            <Users className="h-5 w-5" />
          </div>
          <div>
            <div className="text-h2 text-foreground">{result.message}</div>
            <div className="mt-0.5 text-caption text-muted-foreground">
              {isThin
                ? 'Honest signal — small segment. Refine the description or proceed knowing the reach is limited.'
                : 'Slice 1 is read-only — no campaign is created. Slice 2 will add the propose & preview card.'}
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Resolved audience_conditions">
        <p className="mb-2 text-caption text-muted-foreground">
          The structured query the AI extracted from your description. This is what a manual filter
          builder would produce.
        </p>
        <pre className="overflow-x-auto rounded-[var(--ds-radius-input)] bg-[var(--ds-surface-sunken)] p-3 text-caption font-mono text-foreground">
          {JSON.stringify(result.conditions, null, 2)}
        </pre>
      </SectionCard>
    </div>
  );
}
