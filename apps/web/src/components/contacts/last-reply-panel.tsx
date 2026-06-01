'use client';

/**
 * KAN-1037-PR5 — M3-2.5c Last reply panel.
 *
 * Surfaces the contact's most recent inbound `email_received` engagement
 * with engine-response context. Renders ONLY when
 * `contact.latestReply !== null`; the parent (Contact detail page)
 * passes the field verbatim.
 *
 * Reply body is rendered inline with a 200-char clamp + "Show more"
 * expand toggle. Body is verbatim per upstream KAN-1037 PR2
 * normalization (≤2000 chars at the webhook layer); no client-side
 * truncation beyond the display clamp.
 *
 * `engineResponseStatus` drives a status-dependent badge + action surface:
 *   - `escalated`: 🟡 amber chip + engine's reasoning blockquote +
 *     link to the new Escalation row in the Recommendations queue.
 *   - `no_action`: ▫ muted chip ("Engine evaluated, no action taken").
 *   - `filtered_autoresponder`: 🚫 muted chip ("Filtered as autoresponder").
 *   - `evaluating`: ⏳ violet chip ("Engine evaluating…") — implicit
 *     fallback during the cooldown / in-flight window.
 *
 * Status enum is intentionally narrow per KAN-1037-PR5 spec
 * confirmation. `auto_replied` + `paused_contact` deferred to KAN-1049
 * until corresponding audit signals are wired.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Reply, AlertTriangle, CheckCircle2, Shield, Loader2 } from 'lucide-react';
import type { LatestReply, LatestReplyEngineStatus } from '@/lib/api';
import { fmtDateTime } from '@/lib/fmt-date';

interface LastReplyPanelProps {
  latestReply: LatestReply;
}

/**
 * Signal-class chip styling mirrors the sibling helper at
 * `customers/[id]/page.tsx:54-63` (same color tokens). Inlined here to
 * avoid a cross-module helper export for one consumer.
 */
function signalClassChip(sc: string): string {
  switch (sc) {
    case 'positive':
      return 'bg-[var(--ds-emerald-100)] text-[var(--ds-emerald-700)]';
    case 'negative':
      return 'bg-[var(--ds-danger-soft)] text-[var(--ds-danger-text)]';
    default:
      return 'bg-[var(--ds-surface-sunken)] text-muted-foreground';
  }
}

/**
 * Status-dependent badge styling + icon + label per the PR5 status
 * table. Verbatim copy reviewed during Phase 1 sub-trace.
 */
function statusBadgeProps(status: LatestReplyEngineStatusKnown): {
  className: string;
  Icon: typeof Reply;
  label: string;
} {
  switch (status) {
    case 'escalated':
      return {
        className: 'bg-[var(--ds-amber-100)] text-[var(--ds-amber-700)]',
        Icon: AlertTriangle,
        label: 'Engine escalated to Recommendations queue',
      };
    case 'no_action':
      return {
        className: 'bg-[var(--ds-surface-sunken)] text-muted-foreground',
        Icon: CheckCircle2,
        label: 'Engine evaluated, no action taken',
      };
    case 'filtered_autoresponder':
      return {
        className: 'bg-[var(--ds-surface-sunken)] text-muted-foreground',
        Icon: Shield,
        label: 'Filtered as autoresponder',
      };
    case 'evaluating':
      return {
        className: 'bg-[var(--ds-violet-100)] text-[var(--ds-violet-500)]',
        Icon: Loader2,
        label: 'Engine evaluating…',
      };
  }
}

// Narrowed type alias for the exhaustive-switch above. Exported status
// enum (in @/lib/api) covers the same 4 values; this alias makes the
// switch's exhaustiveness explicit to tsc.
type LatestReplyEngineStatusKnown = Extract<
  LatestReplyEngineStatus,
  'escalated' | 'no_action' | 'filtered_autoresponder' | 'evaluating'
>;

const BODY_CLAMP_CHARS = 200;

export function LastReplyPanel({ latestReply }: LastReplyPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const body = latestReply.bodyPreview ?? '';
  const showExpand = body.length > BODY_CLAMP_CHARS;
  const visibleBody = expanded || !showExpand ? body : `${body.slice(0, BODY_CLAMP_CHARS)}…`;

  const status = statusBadgeProps(latestReply.engineResponseStatus);
  const StatusIcon = status.Icon;

  return (
    <section
      aria-label="Last reply received"
      className="rounded-[var(--ds-radius-card)] border border-[var(--ds-border)] bg-[var(--ds-card)] p-4"
    >
      {/* Header — icon + title + relative timestamp on the right */}
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-label text-foreground">
          <Reply className="h-4 w-4 text-[var(--ds-violet-500)]" />
          Last reply received
        </h2>
        <time
          dateTime={latestReply.occurredAt}
          className="text-caption text-muted-foreground"
        >
          {fmtDateTime(latestReply.occurredAt)}
        </time>
      </header>

      {/* Sender + signal class */}
      <div className="mb-2 flex items-center gap-2 text-body">
        <span className="text-foreground">{latestReply.fromAddress || '(unknown sender)'}</span>
        <span
          className={`inline-flex items-center rounded-[var(--ds-radius-pill)] px-2 py-0.5 text-caption font-medium ${signalClassChip(latestReply.signalClass)}`}
        >
          {latestReply.signalClass}
        </span>
      </div>

      {/* Subject */}
      {latestReply.subject ? (
        <p className="mb-2 text-body font-medium text-foreground">{latestReply.subject}</p>
      ) : null}

      {/* Body preview — clamped with "Show more" expand */}
      {body ? (
        <div className="mb-3">
          <p className="whitespace-pre-wrap text-body text-foreground">{visibleBody}</p>
          {showExpand ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-caption text-[var(--ds-violet-500)] hover:underline"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mb-3 text-caption text-muted-foreground">(no body captured)</p>
      )}

      {/* Correlation link — points back at the originating Decision */}
      {latestReply.correlatedDecisionId ? (
        <p className="mb-3 text-caption text-muted-foreground">
          Correlated to Decision{' '}
          <code className="rounded bg-[var(--ds-surface-sunken)] px-1 py-0.5 font-mono text-caption text-foreground">
            {latestReply.correlatedDecisionId.slice(0, 8)}
          </code>
        </p>
      ) : null}

      {/* Engine response status block */}
      <div
        className={`flex flex-col gap-2 rounded-[var(--ds-radius-input)] p-3 ${status.className}`}
      >
        <div className="flex items-center gap-2 text-label">
          <StatusIcon
            className={`h-4 w-4 ${latestReply.engineResponseStatus === 'evaluating' ? 'animate-spin' : ''}`}
          />
          {status.label}
          {latestReply.engineResponseAt ? (
            <span className="ml-auto text-caption opacity-75">
              at {fmtDateTime(latestReply.engineResponseAt)}
            </span>
          ) : null}
        </div>

        {/* Escalated — show engine's reasoning + queue link */}
        {latestReply.engineResponseStatus === 'escalated' && latestReply.engineReasoning ? (
          <blockquote className="border-l-2 border-current pl-3 text-body italic opacity-90">
            {latestReply.engineReasoning}
          </blockquote>
        ) : null}

        {latestReply.engineResponseStatus === 'escalated' &&
        latestReply.engineResponseEscalationId ? (
          <Link
            href={`/escalations?id=${latestReply.engineResponseEscalationId}`}
            className="text-caption font-medium underline-offset-2 hover:underline"
          >
            View escalation in Recommendations queue →
          </Link>
        ) : null}
      </div>
    </section>
  );
}
