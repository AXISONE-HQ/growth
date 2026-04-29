'use client';

/**
 * KAN-754 — /escalations: Recommendations review queue.
 *
 * Wired to recommendationsApi (post-KAN-750 schema). Replaces the prior
 * mock-data UI. Operator workflow:
 *   - List view (left) shows open recommendations sorted by severity desc.
 *   - Click a row → detail panel (right) loads full context via getDetail.
 *   - Accept → resolves the row + (optionally) emits action.decided.
 *   - Modify → preview-edit the AI suggestion before accepting.
 *   - Dismiss → resolves the row without emitting.
 *
 * Per KAN-754 reinforcement #2: null-safe decisionId — the Decision context
 * panel hides cleanly when null (guardrail/assignment paths). Per #3: no
 * optimistic update on accept (downstream side effects); optimistic OK on
 * dismiss + modify. Per #4: thoughtful empty state for axisone-growth's
 * zero-traffic baseline.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  AlertTriangle,
  Sparkles,
  CheckCircle,
  XCircle,
  Edit2,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import {
  recommendationsApi,
  type RecommendationListItem,
  type RecommendationDetail,
} from '@/lib/api';

const SEVERITY_BADGE: Record<string, { label: string; bg: string; text: string }> = {
  critical: { label: 'CRITICAL', bg: 'bg-red-50', text: 'text-red-700' },
  high: { label: 'HIGH', bg: 'bg-orange-50', text: 'text-orange-700' },
  medium: { label: 'MEDIUM', bg: 'bg-amber-50', text: 'text-amber-700' },
  low: { label: 'LOW', bg: 'bg-gray-100', text: 'text-gray-600' },
};

function avatarFor(item: { contact: { firstName: string | null; lastName: string | null } }): string {
  const f = (item.contact.firstName ?? '').charAt(0);
  const l = (item.contact.lastName ?? '').charAt(0);
  return (f + l).toUpperCase() || '??';
}

function contactName(c: { firstName: string | null; lastName: string | null; email: string | null }): string {
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

export default function EscalationsPage() {
  const [items, setItems] = useState<RecommendationListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecommendationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [acceptInFlight, setAcceptInFlight] = useState(false);
  const [modifyMode, setModifyMode] = useState(false);
  const [modifyDraft, setModifyDraft] = useState('');

  const reload = useCallback(async () => {
    try {
      setError(null);
      const result = await recommendationsApi.list({ status: 'open', limit: 50 });
      setItems(result.items);
    } catch (e) {
      setError((e as Error).message);
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Detail loads when selection changes. Independent of list state so list
  // stays cached during navigation.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
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
          setModifyDraft(d.aiSuggestion ?? '');
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

  // Accept — NO optimistic update. publishActionDecided side-effect means a
  // failure-after-optimistic-UI leaves operator confused about whether the
  // emit happened. Spinner during the in-flight; transition to resolved
  // only after the mutation succeeds.
  const handleAccept = async () => {
    if (!detail) return;
    setAcceptInFlight(true);
    try {
      await recommendationsApi.accept(detail.id);
      // Refresh both list (drop the resolved row) and clear the detail.
      await reload();
      setSelectedId(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAcceptInFlight(false);
    }
  };

  // Dismiss — optimistic OK; pure local state change with trivial rollback.
  const handleDismiss = async () => {
    if (!detail) return;
    const reason = window.prompt('Reason for dismissing this recommendation?');
    if (!reason || !reason.trim()) return;
    const dismissedId = detail.id;
    // Optimistic: drop from list immediately.
    setItems((prev) => (prev ? prev.filter((i) => i.id !== dismissedId) : prev));
    setSelectedId(null);
    try {
      await recommendationsApi.dismiss(dismissedId, reason.trim());
    } catch (e) {
      // Roll back on failure.
      setError((e as Error).message);
      void reload();
    }
  };

  // Modify — optimistic OK; just updates a JSONB field locally.
  const handleModify = async () => {
    if (!detail || !modifyDraft.trim()) return;
    const id = detail.id;
    const next = modifyDraft.trim();
    // Optimistic: update detail in place.
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

  const filtered = items ?? [];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
              <AlertTriangle className="w-6 h-6 text-red-500" />
              Recommendations
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Review and act on contacts the AI escalated for human judgment.
            </p>
          </div>
          <button
            onClick={() => void reload()}
            className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg flex items-center gap-1.5"
          >
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Loading state */}
        {items === null && !error && (
          <div className="flex items-center gap-2 text-gray-500 py-12">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading recommendations…
          </div>
        )}

        {/* Empty state — KAN-754 reinforcement #4: thoughtful copy.
            axisone-growth has zero real escalations today. First impression
            matters. Mirror /settings/knowledge empty-state pattern. */}
        {items !== null && items.length === 0 && (
          <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
            <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-gray-100 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-gray-400" />
            </div>
            <h3 className="text-base font-semibold text-gray-900 mb-1">
              No recommendations to review
            </h3>
            <p className="text-sm text-gray-500 max-w-md mx-auto">
              When the AI escalates a contact decision for human judgment, you'll
              see it here with the suggested next action.
            </p>
          </div>
        )}

        {/* List + detail */}
        {items !== null && items.length > 0 && (
          <div className="flex gap-5">
            <div className="w-[420px] flex flex-col gap-3">
              {filtered.map((esc) => {
                const sev = SEVERITY_BADGE[esc.severity] ?? SEVERITY_BADGE.medium;
                return (
                  <button
                    key={esc.id}
                    onClick={() => setSelectedId(esc.id)}
                    className={`bg-white border rounded-xl p-4 text-left transition-all ${
                      selectedId === esc.id
                        ? 'border-indigo-500 ring-2 ring-indigo-500/10'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-red-50 text-red-700 flex items-center justify-center text-xs font-semibold">
                          {avatarFor(esc)}
                        </div>
                        <div>
                          <div className="text-sm font-semibold text-gray-900">
                            {contactName(esc.contact)}
                          </div>
                          <div className="text-[11px] text-gray-400">{esc.triggerType}</div>
                        </div>
                      </div>
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${sev.bg} ${sev.text}`}
                      >
                        {sev.label}
                      </span>
                    </div>
                    {esc.triggerReason && (
                      <div className="text-xs text-gray-600 mb-2 line-clamp-2">{esc.triggerReason}</div>
                    )}
                    <div className="flex items-center gap-2 text-[10px] text-gray-400">
                      <span>{relativeTime(esc.createdAt)}</span>
                      {esc.decisionId && (
                        <>
                          <span>·</span>
                          <span>linked decision</span>
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Right: Detail panel */}
            {selectedId && (
              <div className="flex-1 flex flex-col gap-4">
                {detailLoading && (
                  <div className="bg-white border border-gray-200 rounded-xl p-8 flex items-center gap-2 text-gray-500">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading detail…
                  </div>
                )}

                {detail && !detailLoading && (
                  <>
                    {/* Header card */}
                    <div className="bg-white border border-gray-200 rounded-xl p-5">
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 rounded-full bg-red-50 text-red-700 flex items-center justify-center text-lg font-semibold">
                            {avatarFor({ contact: detail.contact })}
                          </div>
                          <div>
                            <div className="text-base font-semibold text-gray-900">
                              {contactName(detail.contact)}
                            </div>
                            <div className="text-sm text-gray-500">
                              {detail.contact.email ?? 'no email'} · {detail.contact.lifecycleStage}
                            </div>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={handleAccept}
                            disabled={acceptInFlight || detail.status !== 'open'}
                            className="px-4 py-2 bg-indigo-500 text-white text-sm font-medium rounded-lg hover:bg-indigo-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                          >
                            {acceptInFlight ? (
                              <>
                                <Loader2 className="w-4 h-4 animate-spin" /> Accepting…
                              </>
                            ) : (
                              <>
                                <CheckCircle className="w-4 h-4" /> Accept
                              </>
                            )}
                          </button>
                          <button
                            onClick={() => setModifyMode((m) => !m)}
                            disabled={detail.status !== 'open'}
                            className="px-4 py-2 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                          >
                            <Edit2 className="w-4 h-4" /> Modify
                          </button>
                          <button
                            onClick={handleDismiss}
                            disabled={detail.status !== 'open'}
                            className="px-4 py-2 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
                          >
                            <XCircle className="w-4 h-4" /> Dismiss
                          </button>
                        </div>
                      </div>

                      {/* AI Suggestion */}
                      <div className="p-4 bg-indigo-50 border border-indigo-200 rounded-xl">
                        <div className="flex items-center gap-2 text-sm font-medium text-indigo-700 mb-1.5">
                          <Sparkles className="w-4 h-4" /> Suggested next action
                        </div>
                        {modifyMode ? (
                          <div className="flex flex-col gap-2">
                            <textarea
                              value={modifyDraft}
                              onChange={(e) => setModifyDraft(e.target.value)}
                              className="w-full p-2 text-sm border border-indigo-300 rounded bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                              rows={3}
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={handleModify}
                                className="px-3 py-1 bg-indigo-500 text-white text-xs font-medium rounded hover:bg-indigo-600"
                              >
                                Save
                              </button>
                              <button
                                onClick={() => {
                                  setModifyMode(false);
                                  setModifyDraft(detail.aiSuggestion ?? '');
                                }}
                                className="px-3 py-1 bg-white border border-gray-200 text-gray-600 text-xs font-medium rounded hover:bg-gray-50"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm text-indigo-600 leading-relaxed">
                            {detail.aiSuggestion ?? '(no suggestion provided)'}
                          </p>
                        )}
                      </div>

                      {/* Trigger meta */}
                      <div className="flex flex-wrap gap-2 mt-4">
                        <span className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">
                          {detail.triggerType}
                        </span>
                        <span className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">
                          severity: {detail.severity}
                        </span>
                        <span className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">
                          status: {detail.status}
                        </span>
                      </div>

                      {detail.triggerReason && (
                        <div className="mt-4 text-sm text-gray-600">
                          <span className="font-medium text-gray-700">Why escalated: </span>
                          {detail.triggerReason}
                        </div>
                      )}
                    </div>

                    {/* AI Decision context — shown only when decisionId is set.
                        Per KAN-754 reinforcement #2: hide cleanly for guardrail/
                        assignment escalations where decisionId is null. */}
                    {detail.decision && (
                      <div className="bg-white border border-gray-200 rounded-xl p-5">
                        <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-indigo-500" /> AI Decision context
                        </h3>
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          <div>
                            <div className="text-xs text-gray-500">Strategy</div>
                            <div className="text-gray-900">{detail.decision.strategySelected}</div>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500">Action</div>
                            <div className="text-gray-900">{detail.decision.actionType}</div>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500">Confidence</div>
                            <div className="text-gray-900">
                              {(detail.decision.confidence * 100).toFixed(0)}%
                            </div>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500">Decided</div>
                            <div className="text-gray-900">
                              {relativeTime(detail.decision.createdAt)}
                            </div>
                          </div>
                        </div>
                        {detail.decision.reasoning && (
                          <div className="mt-3 text-xs text-gray-600 italic">
                            {detail.decision.reasoning}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Audit context — escalation row's context payload */}
                    {detail.context && Object.keys(detail.context).length > 0 && (
                      <div className="bg-white border border-gray-200 rounded-xl p-5">
                        <h3 className="text-sm font-semibold text-gray-900 mb-3">Context</h3>
                        <pre className="text-xs text-gray-600 bg-gray-50 p-3 rounded overflow-x-auto">
                          {JSON.stringify(detail.context, null, 2)}
                        </pre>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
