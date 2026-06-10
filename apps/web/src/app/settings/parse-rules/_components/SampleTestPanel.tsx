'use client';

/**
 * KAN-1140 Phase 3 PR 9c — Sample testing panel.
 *
 * Tabbed picker (stored / paste / recent inbound) + Run Test button +
 * output display. Q3 lock: all three sources shipped in v1.
 *
 * Q-ADD-TEST-AGAINST-DRAFT: tests the CURRENT form body (not saved DB
 * body). Iterative authoring without save→test→edit cycles.
 *
 * Q-ADD-TEST-RESULTS-DISPLAY: output prominent + metrics collapsible.
 * Warning banners when totalDurationMs > 50ms (per-rule budget envelope)
 * or rulesThrown > 0 (lead-first invariant preserved but operator-visible).
 */
import * as React from 'react';
import {
  parseRulesApi,
  inboxApi,
  inboxBodyApi,
  type ParseRuleBody,
  type ParseRuleTestResult,
  type LeadInboxEventRow,
} from '@/lib/api';

type SampleTab = 'stored' | 'paste' | 'recent';

export function SampleTestPanel({
  currentBody,
  fingerprintId,
}: {
  currentBody: ParseRuleBody;
  fingerprintId: string | null;
}): React.ReactElement {
  const [tab, setTab] = React.useState<SampleTab>('paste');
  const [result, setResult] = React.useState<ParseRuleTestResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [showMetrics, setShowMetrics] = React.useState(false);

  // Paste tab state.
  const [pasteBody, setPasteBody] = React.useState('');
  const [pasteFrom, setPasteFrom] = React.useState('');
  const [pasteStructuredJson, setPasteStructuredJson] = React.useState('');

  // Recent tab state.
  const [recentEvents, setRecentEvents] = React.useState<LeadInboxEventRow[] | null>(null);
  const [recentEventId, setRecentEventId] = React.useState<string>('');

  React.useEffect(() => {
    if (tab !== 'recent' || recentEvents !== null) return;
    void (async () => {
      try {
        const events = await inboxApi.listRecentEvents({ limit: 25 });
        setRecentEvents(events);
      } catch (err) {
        setError((err as Error)?.message ?? 'Failed to load recent events');
      }
    })();
  }, [tab, recentEvents]);

  // Note: stored sample picker would normally fetch
  // parserPatternsApi.getDetail(fingerprintId) to get the 5 LRU samples.
  // Skipping that prefetch here to keep the panel lazy — the operator
  // would need to either pick a fingerprint OR use paste/recent.
  // KAN-1164 follow-up: enrich stored picker with fingerprint sample
  // dropdown when fingerprintId is set on the rule.

  const handleTest = React.useCallback(async () => {
    setTesting(true);
    setError(null);
    try {
      let input;
      if (tab === 'paste') {
        if (!pasteBody.trim()) {
          throw new Error('Paste body required for paste source.');
        }
        let rawStructured: Record<string, unknown> | undefined;
        if (pasteStructuredJson.trim()) {
          try {
            rawStructured = JSON.parse(pasteStructuredJson);
          } catch {
            throw new Error('Structured JSON is not valid JSON.');
          }
        }
        input = {
          ruleBody: currentBody,
          sampleSource: 'paste' as const,
          rawBody: pasteBody,
          rawStructured,
          fromAddress: pasteFrom.trim() || undefined,
        };
      } else if (tab === 'recent') {
        if (!recentEventId) {
          throw new Error('Pick a recent inbound event.');
        }
        input = {
          ruleBody: currentBody,
          sampleSource: 'recent' as const,
          sampleId: recentEventId,
        };
      } else {
        // stored
        throw new Error(
          'Stored sample picker not enriched yet — use Paste or Recent tab. ' +
            '(KAN-1164: enrich stored picker with fingerprint sample dropdown.)',
        );
      }
      const r = await parseRulesApi.testAgainstSample(input);
      setResult(r);
    } catch (err) {
      setError((err as Error)?.message ?? 'Test failed');
      setResult(null);
    } finally {
      setTesting(false);
    }
  }, [tab, pasteBody, pasteFrom, pasteStructuredJson, recentEventId, currentBody]);

  return (
    <div>
      {/* Tab bar */}
      <div className="mb-2 flex items-center gap-2">
        {(['paste', 'recent', 'stored'] as SampleTab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
              setResult(null);
              setError(null);
            }}
            className={
              tab === t
                ? 'rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground'
                : 'rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted'
            }
          >
            {t === 'paste' ? 'Paste' : t === 'recent' ? 'Recent inbound' : 'Stored sample'}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'paste' ? (
        <div className="space-y-2">
          <div>
            <label className="block text-xs text-muted-foreground">Body text</label>
            <textarea
              value={pasteBody}
              onChange={(e) => setPasteBody(e.target.value)}
              rows={6}
              className="w-full rounded border px-2 py-1 font-mono text-xs"
              placeholder="Paste the email body or structured payload text here"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-muted-foreground">From address (optional)</label>
              <input
                type="text"
                value={pasteFrom}
                onChange={(e) => setPasteFrom(e.target.value)}
                className="w-full rounded border px-2 py-1 text-xs"
                placeholder="noreply@example.com"
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground">
                Structured payload (JSON; optional)
              </label>
              <input
                type="text"
                value={pasteStructuredJson}
                onChange={(e) => setPasteStructuredJson(e.target.value)}
                className="w-full rounded border px-2 py-1 font-mono text-xs"
                placeholder='{"contact": {"first_name": "Alice"}}'
              />
            </div>
          </div>
        </div>
      ) : tab === 'recent' ? (
        <div>
          <label className="block text-xs text-muted-foreground">
            Pick recent inbound (last 25 events)
          </label>
          {recentEvents === null ? (
            <div className="text-xs text-muted-foreground">Loading…</div>
          ) : recentEvents.length === 0 ? (
            <div className="text-xs text-muted-foreground">No recent inbox events.</div>
          ) : (
            <select
              value={recentEventId}
              onChange={(e) => setRecentEventId(e.target.value)}
              className="w-full rounded border px-2 py-1 text-xs"
            >
              <option value="">— select —</option>
              {recentEvents.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fromAddress} — {e.subject ?? '(no subject)'} —{' '}
                  {new Date(e.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : (
        <div className="rounded border bg-muted px-3 py-2 text-xs text-muted-foreground">
          Stored sample picker not enriched in PR 9c — use Paste or Recent tab.
          {fingerprintId ? (
            <span> Rule is fingerprint-scoped (id: {fingerprintId.slice(0, 8)}…); KAN-1164 will surface samples here.</span>
          ) : null}
        </div>
      )}

      <div className="mt-3 flex justify-end">
        <button
          type="button"
          onClick={handleTest}
          disabled={testing}
          className="rounded bg-blue-600 px-4 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {testing ? 'Running…' : 'Run test'}
        </button>
      </div>

      {error ? (
        <div className="mt-2 rounded border border-red-400 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      ) : null}

      {/* Output (Q-ADD-TEST-RESULTS-DISPLAY) */}
      {result ? (
        <div className="mt-3 space-y-2">
          {result.metrics.totalDurationMs > 50 ? (
            <div className="rounded border border-amber-400 bg-amber-50 px-3 py-1 text-xs text-amber-800">
              Slow extraction ({result.metrics.totalDurationMs}ms &gt; 50ms per-rule envelope).
              Consider regex optimization.
            </div>
          ) : null}
          {result.metrics.rulesThrown > 0 ? (
            <div className="rounded border border-amber-400 bg-amber-50 px-3 py-1 text-xs text-amber-800">
              Rule threw at runtime (lead-first invariant preserved; Haiku would still run).
            </div>
          ) : null}
          {result.metrics.pipelineBudgetExceeded ? (
            <div className="rounded border border-red-400 bg-red-50 px-3 py-1 text-xs text-red-800">
              Pipeline budget exceeded — remaining cascade fields would be skipped in PROD.
            </div>
          ) : null}
          <div className="rounded border bg-green-50 p-2">
            <div className="mb-1 text-xs font-medium text-green-900">Extracted fields</div>
            {Object.keys(result.output).length === 0 ? (
              <div className="text-xs text-muted-foreground">
                No fields extracted (rule produced no output).
              </div>
            ) : (
              <dl className="grid grid-cols-2 gap-1 text-xs">
                {Object.entries(result.output).map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt className="font-medium">{k}</dt>
                    <dd className="font-mono">{v}</dd>
                  </React.Fragment>
                ))}
              </dl>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowMetrics(!showMetrics)}
            className="text-xs text-muted-foreground underline"
          >
            {showMetrics ? 'Hide' : 'Show'} metrics
          </button>
          {showMetrics ? (
            <pre className="rounded border bg-muted p-2 text-xs">
{JSON.stringify(result.metrics, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
