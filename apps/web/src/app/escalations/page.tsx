'use client';

/**
 * /escalations — Recommendations review queue.
 *
 * History:
 *   - KAN-754 shipped the original list+detail wiring against recommendationsApi
 *     (post-KAN-750 schema).
 *   - KAN-1006 (SAE PR2) refactored the surface to the KAN-972 light DS:
 *     Card/Badge/Button primitives + ds-* token pairs, 4-tier confidence
 *     badge from board-helpers::confidenceClasses (matching pipelines +
 *     dashboard), a11y additions (aria-live on the queue, keyboard nav
 *     j/k+enter+escape, collapsible reasoning, inline dismiss instead of
 *     window.prompt), and pagination (Load more). Functional contract
 *     unchanged — same 5 tRPC procedures, same semantics, no new send path.
 *
 * Backend contract (UNCHANGED — verified in PR2 Phase 1):
 *   - recommendations.list  (query, paginated, severity-DESC then recency-DESC at backend)
 *   - recommendations.getDetail (query, returns RecommendationDetail with decision context)
 *   - recommendations.accept    (mutation; if modifiedAction omitted, resolves without emit;
 *                                 under autoApproveEnabled=false the action.decided emit is
 *                                 the only path to a downstream action — see KAN-1006 PR
 *                                 description for the safety model)
 *   - recommendations.modify    (mutation; updates aiSuggestion only; non-terminal)
 *   - recommendations.dismiss   (mutation; resolves with reason; no emit)
 *
 * Safety boundary preserved: this page reads + triages existing rows; it
 * does NOT introduce any new send path. The Accept button hits the
 * already-wired `recommendations.accept` mutation, which is itself
 * subject to the full Decision Engine governance chain (kill-switch,
 * threshold gate, matrix). Under the current tenant's autoApproveEnabled
 * =false posture, accept-without-modifiedAction resolves the escalation
 * without firing any action.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  AlertTriangle,
  Sparkles,
  CheckCircle,
  XCircle,
  Edit2,
  Loader2,
  RefreshCw,
  Mail,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import {
  recommendationsApi,
  type RecommendationListItem,
  type RecommendationDetail,
} from '@/lib/api';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import {
  confidenceClasses,
  confidenceLevel,
  confidencePercent,
} from '@/lib/board-helpers';

// ─────────────────────────────────────────────────────────────
// Severity → Badge variant mapping (light DS tokens)
//
// The Escalation.severity column is a string (no enum) with values
// 'low'|'medium'|'high'|'critical'. Map each to the closest semantic
// chip variant so the queue's color language matches dashboards.
// Intentional ranking (most → least concern): rose → amber → ai → muted.
// ─────────────────────────────────────────────────────────────
const SEVERITY_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = {
  critical: 'rose',
  high: 'amber',
  medium: 'ai',
  low: 'muted',
};
const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

function severityBadge(severity: string): {
  variant: NonNullable<BadgeProps['variant']>;
  label: string;
} {
  return {
    variant: SEVERITY_VARIANT[severity] ?? 'muted',
    label: SEVERITY_LABEL[severity] ?? severity,
  };
}

function initials(c: { firstName: string | null; lastName: string | null }): string {
  const f = (c.firstName ?? '').charAt(0);
  const l = (c.lastName ?? '').charAt(0);
  return (f + l).toUpperCase() || '??';
}

function contactName(c: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return name || c.email || 'Unknown contact';
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

const PAGE_SIZE = 50;

export default function EscalationsPage() {
  const [items, setItems] = useState<RecommendationListItem[] | null>(null);
  const [total, setTotal] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecommendationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [acceptInFlight, setAcceptInFlight] = useState(false);
  const [modifyMode, setModifyMode] = useState(false);
  const [modifyDraft, setModifyDraft] = useState('');
  // KAN-1006 — inline dismiss replaces window.prompt (a11y + DS consistency)
  const [dismissMode, setDismissMode] = useState(false);
  const [dismissReason, setDismissReason] = useState('');
  // KAN-1006 — Load-more pagination (offset-based; the backend returns total)
  const [loadingMore, setLoadingMore] = useState(false);

  // Keyboard nav (j/k for prev/next, Enter to focus first item from header,
  // Escape to clear selection). Stored in a ref so handlers stay stable.
  const listRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      setError(null);
      const result = await recommendationsApi.list({
        status: 'open',
        limit: PAGE_SIZE,
        offset: 0,
      });
      setItems(result.items);
      setTotal(result.total);
    } catch (e) {
      setError((e as Error).message);
      setItems([]);
      setTotal(0);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!items) return;
    setLoadingMore(true);
    try {
      const result = await recommendationsApi.list({
        status: 'open',
        limit: PAGE_SIZE,
        offset: items.length,
      });
      setItems((prev) => (prev ? [...prev, ...result.items] : result.items));
      setTotal(result.total);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }, [items]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Detail loads when selection changes. Independent of list so list
  // stays cached during navigation.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setModifyMode(false);
      setDismissMode(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    recommendationsApi
      .getDetail(selectedId)
      .then((d) => {
        if (!cancelled) {
          setDetail(d);
          setModifyMode(false);
          setDismissMode(false);
          setModifyDraft(d.aiSuggestion ?? '');
          setDismissReason('');
        }
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // KAN-1006 keyboard nav. j = next, k = prev, Enter = select first if
  // none selected, Escape = clear selection. Respects text-editing focus
  // (skips when focus is in an input/textarea so users can type).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const inEditable =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (inEditable) return;
      const list = items;
      if (!list || list.length === 0) return;
      if (e.key === 'Escape') {
        setSelectedId(null);
        e.preventDefault();
        return;
      }
      if (e.key !== 'j' && e.key !== 'k' && e.key !== 'Enter') return;
      const idx = selectedId
        ? list.findIndex((i) => i.id === selectedId)
        : -1;
      if (e.key === 'j') {
        const next = list[Math.min(list.length - 1, idx + 1)];
        if (next) setSelectedId(next.id);
        e.preventDefault();
      } else if (e.key === 'k') {
        const prev = list[Math.max(0, idx === -1 ? 0 : idx - 1)];
        if (prev) setSelectedId(prev.id);
        e.preventDefault();
      } else if (e.key === 'Enter' && idx === -1) {
        const first = list[0];
        if (first) setSelectedId(first.id);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, selectedId]);

  // Accept — NO optimistic update. publishActionDecided side-effect means a
  // failure-after-optimistic-UI leaves operator confused about whether the
  // emit happened. Spinner during the in-flight; transition to resolved
  // only after the mutation succeeds.
  const handleAccept = async () => {
    if (!detail) return;
    setAcceptInFlight(true);
    try {
      await recommendationsApi.accept(detail.id);
      await reload();
      setSelectedId(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAcceptInFlight(false);
    }
  };

  const handleDismiss = async () => {
    if (!detail || !dismissReason.trim()) return;
    const dismissedId = detail.id;
    const reason = dismissReason.trim();
    // Optimistic: drop from list immediately.
    setItems((prev) => (prev ? prev.filter((i) => i.id !== dismissedId) : prev));
    setSelectedId(null);
    try {
      await recommendationsApi.dismiss(dismissedId, reason);
    } catch (e) {
      setError((e as Error).message);
      void reload();
    }
  };

  const handleModify = async () => {
    if (!detail || !modifyDraft.trim()) return;
    const id = detail.id;
    const next = modifyDraft.trim();
    setDetail((prev) => (prev ? { ...prev, aiSuggestion: next } : prev));
    setItems((prev) =>
      prev ? prev.map((i) => (i.id === id ? { ...i, aiSuggestion: next } : i)) : prev,
    );
    setModifyMode(false);
    try {
      await recommendationsApi.modify(id, next);
    } catch (e) {
      setError((e as Error).message);
      void reload();
    }
  };

  const list = items ?? [];
  const hasMore = items !== null && items.length < total;

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-6 py-8">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-h1 text-foreground">
              <AlertTriangle className="h-6 w-6 text-[var(--ds-danger-text)]" />
              Recommendations
            </h1>
            <p className="mt-1 text-body text-muted-foreground">
              Review and act on contacts the AI escalated for human judgment.{' '}
              <span className="text-caption">
                Use <kbd className="rounded bg-[var(--ds-surface-sunken)] px-1 py-0.5 font-mono text-caption">j</kbd>
                /<kbd className="rounded bg-[var(--ds-surface-sunken)] px-1 py-0.5 font-mono text-caption">k</kbd> to
                navigate, <kbd className="rounded bg-[var(--ds-surface-sunken)] px-1 py-0.5 font-mono text-caption">Esc</kbd> to
                clear selection.
              </span>
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>

        {error ? (
          <div
            role="alert"
            className="mb-4 rounded-[var(--ds-radius-input)] border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] px-4 py-3 text-body text-[var(--ds-danger-text)]"
          >
            {error}
          </div>
        ) : null}

        {/* Loading state */}
        {items === null && !error ? (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 py-12 text-body text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:hidden" />
            Loading recommendations…
          </div>
        ) : null}

        {/* Empty state — copy per PR2 brief: confidence-threshold framing.
            "growth is operating within your confidence threshold" makes
            the empty queue feel like signal-of-health, not absence-of-feature. */}
        {items !== null && items.length === 0 ? (
          <Card className="p-12">
            <EmptyState
              icon={Sparkles}
              heading="No items need review"
              body="growth is operating within your confidence threshold. When the AI escalates a contact for human judgment, you'll see it here with the suggested next action and reasoning."
            />
          </Card>
        ) : null}

        {/* Populated queue — list (left) + detail (right) */}
        {items !== null && items.length > 0 ? (
          <div className="flex gap-5">
            {/* Queue list. aria-live=polite so screen readers announce
                additions on Refresh / Load more. role=listbox would be
                semantically tighter but selection-as-routing here doesn't
                map cleanly to listbox keyboard contract; use role=list +
                explicit kbd hints in the header. */}
            <div
              ref={listRef}
              role="region"
              aria-label="Open recommendations queue"
              aria-live="polite"
              className="flex w-[420px] flex-col gap-3"
            >
              {list.map((esc) => {
                const sev = severityBadge(esc.severity);
                const isSelected = selectedId === esc.id;
                return (
                  <Card
                    key={esc.id}
                    className={`cursor-pointer p-4 transition-colors hover:border-[var(--ds-violet-100)] focus-within:border-[var(--ds-violet-500)] focus-within:ring-2 focus-within:ring-[var(--ds-violet-500)]/30 motion-reduce:transition-none ${
                      isSelected
                        ? 'border-[var(--ds-violet-500)] ring-2 ring-[var(--ds-violet-500)]/30'
                        : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(esc.id)}
                      aria-current={isSelected ? 'true' : undefined}
                      aria-label={`Open recommendation for ${contactName(esc.contact)} — ${SEVERITY_LABEL[esc.severity] ?? esc.severity} severity`}
                      className="block w-full text-left"
                    >
                      <div className="mb-2 flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <div
                            aria-hidden="true"
                            className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--ds-danger-soft)] text-caption font-semibold text-[var(--ds-danger-text)]"
                          >
                            {initials(esc.contact)}
                          </div>
                          <div>
                            <div className="text-label text-foreground">
                              {contactName(esc.contact)}
                            </div>
                            <div className="text-caption text-muted-foreground">
                              {esc.triggerType}
                            </div>
                          </div>
                        </div>
                        <Badge variant={sev.variant}>
                          <span className="sr-only">Severity </span>
                          {sev.label}
                        </Badge>
                      </div>
                      {esc.triggerReason ? (
                        <div className="mb-2 line-clamp-2 text-caption text-muted-foreground">
                          {esc.triggerReason}
                        </div>
                      ) : null}
                      <div className="flex items-center gap-2 text-caption text-muted-foreground">
                        <span>{relativeTime(esc.createdAt)}</span>
                        {esc.decisionId ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>linked decision</span>
                          </>
                        ) : null}
                      </div>
                    </button>
                  </Card>
                );
              })}

              {/* Load-more pagination — appears only when total > items.length */}
              {hasMore ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="mt-1 self-center"
                >
                  {loadingMore ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:hidden" />
                      Loading…
                    </>
                  ) : (
                    <>Load more ({total - list.length} remaining)</>
                  )}
                </Button>
              ) : null}
            </div>

            {/* Detail panel */}
            {selectedId ? (
              <div className="flex flex-1 flex-col gap-4">
                {detailLoading ? (
                  <Card className="p-8">
                    <div
                      role="status"
                      aria-live="polite"
                      className="flex items-center gap-2 text-body text-muted-foreground"
                    >
                      <Loader2 className="h-4 w-4 animate-spin motion-reduce:hidden" />
                      Loading detail…
                    </div>
                  </Card>
                ) : null}

                {detail && !detailLoading ? (
                  <DetailPanel
                    detail={detail}
                    acceptInFlight={acceptInFlight}
                    modifyMode={modifyMode}
                    modifyDraft={modifyDraft}
                    dismissMode={dismissMode}
                    dismissReason={dismissReason}
                    onAccept={handleAccept}
                    onModifyToggle={() => {
                      setModifyMode((m) => !m);
                      setDismissMode(false);
                    }}
                    onModifyChange={setModifyDraft}
                    onModifySave={handleModify}
                    onModifyCancel={() => {
                      setModifyMode(false);
                      setModifyDraft(detail.aiSuggestion ?? '');
                    }}
                    onDismissToggle={() => {
                      setDismissMode((m) => !m);
                      setModifyMode(false);
                    }}
                    onDismissReasonChange={setDismissReason}
                    onDismissConfirm={handleDismiss}
                    onDismissCancel={() => {
                      setDismissMode(false);
                      setDismissReason('');
                    }}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Detail panel
// ─────────────────────────────────────────────────────────────

function DetailPanel({
  detail,
  acceptInFlight,
  modifyMode,
  modifyDraft,
  dismissMode,
  dismissReason,
  onAccept,
  onModifyToggle,
  onModifyChange,
  onModifySave,
  onModifyCancel,
  onDismissToggle,
  onDismissReasonChange,
  onDismissConfirm,
  onDismissCancel,
}: {
  detail: RecommendationDetail;
  acceptInFlight: boolean;
  modifyMode: boolean;
  modifyDraft: string;
  dismissMode: boolean;
  dismissReason: string;
  onAccept: () => void;
  onModifyToggle: () => void;
  onModifyChange: (v: string) => void;
  onModifySave: () => void;
  onModifyCancel: () => void;
  onDismissToggle: () => void;
  onDismissReasonChange: (v: string) => void;
  onDismissConfirm: () => void;
  onDismissCancel: () => void;
}) {
  const sev = severityBadge(detail.severity);
  const isOpen = detail.status === 'open';

  return (
    <>
      {/* Header — contact + actions */}
      <Card className="p-5">
        <div className="mb-4 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div
              aria-hidden="true"
              className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ds-danger-soft)] text-h2 font-semibold text-[var(--ds-danger-text)]"
            >
              {initials(detail.contact)}
            </div>
            <div>
              <div className="text-h2 text-foreground">
                {contactName(detail.contact)}
              </div>
              <div className="flex items-center gap-1.5 text-body text-muted-foreground">
                <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                {detail.contact.email ?? 'no email'}
                <span aria-hidden="true">·</span>
                {detail.contact.lifecycleStage}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="gradient"
              size="sm"
              onClick={onAccept}
              disabled={acceptInFlight || !isOpen}
            >
              {acceptInFlight ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:hidden" />
                  Accepting…
                </>
              ) : (
                <>
                  <CheckCircle className="h-3.5 w-3.5" />
                  Accept recommendation
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onModifyToggle}
              disabled={!isOpen}
            >
              <Edit2 className="h-3.5 w-3.5" />
              Modify suggestion
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onDismissToggle}
              disabled={!isOpen}
            >
              <XCircle className="h-3.5 w-3.5" />
              Dismiss
            </Button>
          </div>
        </div>

        {/* AI Suggestion (KAN-972 violet) */}
        <div className="rounded-[var(--ds-radius-input)] border border-[var(--ds-violet-100)] bg-[var(--ds-violet-100)]/40 p-4">
          <div className="mb-1.5 flex items-center gap-2 text-label text-[var(--ds-violet-500)]">
            <Sparkles className="h-4 w-4" />
            Suggested next action
          </div>
          {modifyMode ? (
            <div className="flex flex-col gap-2">
              <textarea
                value={modifyDraft}
                onChange={(e) => onModifyChange(e.target.value)}
                rows={3}
                className="w-full rounded-[var(--ds-radius-input)] border border-border bg-card p-2 text-body text-foreground outline-none focus:border-[var(--ds-violet-500)] focus:ring-2 focus:ring-[var(--ds-violet-500)]/20"
              />
              <div className="flex gap-2">
                <Button variant="gradient" size="sm" onClick={onModifySave}>
                  Save suggestion
                </Button>
                <Button variant="outline" size="sm" onClick={onModifyCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-body text-foreground">
              {detail.aiSuggestion ?? '(no suggestion provided)'}
            </p>
          )}
        </div>

        {/* Inline dismiss disclosure — replaces window.prompt() */}
        {dismissMode ? (
          <div
            role="group"
            aria-labelledby="dismiss-heading"
            className="mt-4 rounded-[var(--ds-radius-input)] border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)]/40 p-4"
          >
            <div
              id="dismiss-heading"
              className="mb-1.5 flex items-center gap-2 text-label text-[var(--ds-danger-text)]"
            >
              <XCircle className="h-4 w-4" />
              Dismiss this recommendation
            </div>
            <p className="mb-2 text-caption text-muted-foreground">
              Provide a brief reason. This is audit-logged on the escalation row.
            </p>
            <textarea
              value={dismissReason}
              onChange={(e) => onDismissReasonChange(e.target.value)}
              rows={2}
              placeholder="e.g., already handled in last week's outreach"
              className="w-full rounded-[var(--ds-radius-input)] border border-border bg-card p-2 text-body text-foreground outline-none focus:border-[var(--ds-danger-text)] focus:ring-2 focus:ring-[var(--ds-danger-text)]/20"
            />
            <div className="mt-2 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onDismissConfirm}
                disabled={!dismissReason.trim()}
              >
                Confirm dismiss
              </Button>
              <Button variant="outline" size="sm" onClick={onDismissCancel}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {/* Trigger meta — small chips */}
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge variant="muted">{detail.triggerType}</Badge>
          <Badge variant={sev.variant}>
            <span className="sr-only">Severity </span>
            {sev.label}
          </Badge>
          <Badge variant="muted">status: {detail.status}</Badge>
        </div>

        {detail.triggerReason ? (
          <div className="mt-4 text-body text-foreground">
            <span className="text-label text-muted-foreground">Why escalated: </span>
            {detail.triggerReason}
          </div>
        ) : null}
      </Card>

      {/* AI Decision context — null-safe (hidden when decisionId is null,
          e.g., guardrail-block / lead-assignment paths). The confidence
          is rendered as a 4-tier badge (matching pipelines + dashboard);
          tier text + colored chip + numeric % — never color alone. */}
      {detail.decision ? (
        <Card className="p-5">
          <h3 className="mb-3 flex items-center gap-2 text-label text-foreground">
            <Sparkles className="h-4 w-4 text-[var(--ds-violet-500)]" />
            AI Decision context
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-caption text-muted-foreground">Strategy</div>
              <div className="text-body text-foreground">
                {detail.decision.strategySelected}
              </div>
            </div>
            <div>
              <div className="text-caption text-muted-foreground">Action</div>
              <div className="text-body text-foreground">
                {detail.decision.actionType}
              </div>
            </div>
            <div>
              <div className="text-caption text-muted-foreground">Confidence</div>
              <ConfidenceBadge confidence={detail.decision.confidence} />
            </div>
            <div>
              <div className="text-caption text-muted-foreground">Decided</div>
              <div className="text-body text-foreground">
                {relativeTime(detail.decision.createdAt)}
              </div>
            </div>
          </div>
          {/* M3-1c — discoveryTarget marker. Renders when the engine emitted
              a discovery candidate (decision.metadata.action.actionPayload.
              discoveryTarget present). Additive: non-discovery decisions
              omit cleanly. Reads tenant-scoped from existing payload. */}
          {(() => {
            const dt = (
              (detail.decision.metadata as { action?: { actionPayload?: { discoveryTarget?: { label?: string; triggerType?: string } } } } | null | undefined)
                ?.action?.actionPayload?.discoveryTarget
            );
            if (!dt?.label) return null;
            return (
              <div className="mt-3 flex items-center gap-2" data-testid="discovery-target-marker">
                <span className="inline-flex items-center rounded-[var(--ds-radius-input)] bg-primary/10 px-2 py-0.5 text-caption font-medium text-primary">
                  Discovery: {dt.label}
                </span>
                {dt.triggerType ? (
                  <span className="text-caption text-muted-foreground">({dt.triggerType} trigger)</span>
                ) : null}
              </div>
            );
          })()}
          {detail.decision.reasoning ? (
            <details className="mt-3 group">
              <summary className="flex cursor-pointer items-center gap-1 text-caption text-muted-foreground hover:text-foreground">
                <ChevronRight className="h-3 w-3 group-open:hidden" aria-hidden="true" />
                <ChevronDown className="hidden h-3 w-3 group-open:block" aria-hidden="true" />
                Show reasoning
              </summary>
              <div className="mt-2 rounded-[var(--ds-radius-input)] bg-[var(--ds-surface-sunken)] p-3 text-caption italic text-muted-foreground">
                {detail.decision.reasoning}
              </div>
            </details>
          ) : null}
        </Card>
      ) : null}

      {/* Audit context — raw JSONB from escalation.context (operator debug) */}
      {detail.context && Object.keys(detail.context).length > 0 ? (
        <Card className="p-5">
          <details>
            <summary className="cursor-pointer text-label text-foreground">
              Context payload
            </summary>
            <pre className="mt-3 overflow-x-auto rounded-[var(--ds-radius-input)] bg-[var(--ds-surface-sunken)] p-3 text-caption font-mono text-muted-foreground">
              {JSON.stringify(detail.context, null, 2)}
            </pre>
          </details>
        </Card>
      ) : null}
    </>
  );
}

/**
 * KAN-1006 — Confidence badge matching `board-helpers.ts::confidenceClasses`
 * (the same 4-tier palette pipelines + dashboard render). Text + color +
 * tier label = WCAG-friendly: confidence isn't conveyed by color alone.
 *
 * Tier banding (board-helpers::confidenceLevel): high ≥85, good ≥65,
 * uncertain ≥40, low <40 (confidence stored 0..1 in Decision.confidence).
 */
function ConfidenceBadge({ confidence }: { confidence: number }) {
  const level = confidenceLevel(confidence);
  const pct = confidencePercent(confidence);
  const label =
    level === 'high'
      ? 'High'
      : level === 'good'
        ? 'Good'
        : level === 'uncertain'
          ? 'Uncertain'
          : 'Low';
  return (
    <span
      data-confidence-level={level}
      aria-label={`Confidence ${label} — ${pct} percent`}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-caption font-medium ${confidenceClasses(level)}`}
    >
      <span aria-hidden="true">{label}</span>
      <span aria-hidden="true" className="font-mono">{pct}%</span>
    </span>
  );
}
