'use client';

/**
 * KAN-888 — /opportunities/[id] Deal detail page (read-only).
 *
 * 9 stacked cards rendering every Deal scalar + relations from the
 * extended `deals.get` route (this PR). Pattern mirrors /companies/[id]
 * + /orders/[id] (KAN-884).
 *
 *   1. Identity (always)
 *   2. Pipeline progress (always)
 *   3. Stage history timeline (always; empty-state copy if no transitions)
 *   4. Outcome (conditional — only renders when status='won' or 'lost')
 *   5. Products discussed (always; empty-state if products[] is empty)
 *   6. Ownership (always; muted state if owner + agent both null)
 *   7. Linked Contact (always)
 *   8. Linked Company (always; "No linked company" if companyId null)
 *   9. Raw data (always; <pre> blocks for externalIds, customFields,
 *      aiContext, metadata)
 *
 * StageHistoryTimeline is extracted so the regression-snapshot test
 * in __tests__/page.test.tsx can target it independently.
 */

import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Bot,
  FileText,
  Filter,
  Pencil,
  Server,
  Target,
  User as UserIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import {
  dealsApi,
  type DealDetail,
  type DealStageTransition,
} from '@/lib/api';
import { MoneyDisplay } from '@/components/ui/money-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { DEAL_LOST_REASON_LABELS, enumLabel } from '@/lib/enum-labels';

const SECTION_HEADER_STYLE = { color: 'var(--ds-ink-primary)' } as const;
const MUTED_STYLE = { color: 'var(--ds-ink-tertiary)' } as const;
const LABEL_STYLE = { color: 'var(--ds-ink-secondary)' } as const;

/** KAN-943 — TZ-safe date rendering. `new Date(iso).toLocaleDateString()`
 *  without a `timeZone` option shifts the rendered day by the browser's
 *  UTC offset (off-by-one in TZs west of UTC, originally surfaced by the
 *  KAN-3.3 PROD smoke). `timeZone: 'UTC'` aligns the detail-page display
 *  with the edit-form's UTC-day pre-population. Broader non-entity audit
 *  tracked in KAN-947. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { timeZone: 'UTC' });
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { timeZone: 'UTC' });
}

function contactDisplayName(c: DealDetail['contact']): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return name || c.email || 'Unknown contact';
}

function triggeredByIcon(tb: string) {
  switch (tb) {
    case 'agent':
      return Bot;
    case 'human':
      return UserIcon;
    case 'system':
      return Server;
    case 'rule':
      return Filter;
    case 'normalizer':
    default:
      return FileText;
  }
}

interface LineItem {
  sku?: unknown;
  name?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
}

function parseProducts(raw: unknown): LineItem[] | null {
  if (!Array.isArray(raw)) return null;
  return raw as LineItem[];
}

export default function DealDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const { data: deal, isLoading, isError, error } = useQuery<DealDetail>({
    queryKey: ['deals', 'get', id],
    queryFn: () => dealsApi.get(id as string),
    enabled: !!id,
  });

  useEffect(() => {
    if (deal) document.title = `${deal.name} · Opportunities`;
  }, [deal]);

  if (!id) return null;
  if (isLoading) return <SkeletonCards />;

  if (isError) {
    const message = (error as Error)?.message ?? 'Unknown error';
    const isNotFound = /not found/i.test(message);
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link
          href="/opportunities"
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 mb-4"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Opportunities
        </Link>
        <div className="bg-white border rounded-lg p-12 text-center">
          <Target className="w-8 h-8 mx-auto text-gray-300" />
          <h2 className="text-lg font-semibold mt-3" style={SECTION_HEADER_STYLE}>
            {isNotFound ? 'Deal not found' : 'Failed to load deal'}
          </h2>
          <p className="text-sm mt-1" style={MUTED_STYLE}>{message}</p>
        </div>
      </div>
    );
  }

  if (!deal) return null;

  const showOutcome = deal.status === 'won' || deal.status === 'lost';
  const products = parseProducts(deal.products);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
      <Link
        href="/opportunities"
        className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Opportunities
      </Link>

      {/* Card 1 — Identity */}
      <section className="bg-white border rounded-lg p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold" style={SECTION_HEADER_STYLE}>{deal.name}</h1>
            <p className="text-xs mt-0.5" style={MUTED_STYLE}>Deal ID: {deal.id}</p>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge kind="deal-status" value={deal.status} />
            {/* KAN-938 — Sub-cohort 3.3 Edit affordance. Placed in detail
                header (not row-level) — row-click already routes to detail
                via AllDealsView's stopPropagation pattern, and adding a per-
                row Edit would compete with that interaction. */}
            <Link
              href={`/opportunities/${deal.id}/edit`}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md border"
              style={{
                backgroundColor: 'var(--ds-surface-default)',
                borderColor: 'var(--ds-border-default)',
                color: 'var(--ds-ink-secondary)',
              }}
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </Link>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Field
            label="Value"
            value={<MoneyDisplay value={deal.value} currency={deal.currency} />}
          />
          <Field
            label="Probability"
            value={
              deal.probability !== null ? (
                <span className="inline-flex items-center gap-2">
                  <span className="font-medium tabular-nums">{deal.probability}%</span>
                  <span className="inline-block w-16 h-1.5 bg-gray-100 rounded overflow-hidden">
                    <span
                      className="block h-full bg-indigo-500"
                      style={{ width: `${Math.max(0, Math.min(100, deal.probability))}%` }}
                    />
                  </span>
                </span>
              ) : null
            }
          />
          <Field label="Expected close" value={fmtDate(deal.expectedCloseDate)} />
          {showOutcome ? (
            <Field label="Closed" value={fmtDateTime(deal.closedAt)} />
          ) : null}
        </div>
      </section>

      {/* Card 2 — Pipeline progress */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Pipeline progress</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Field label="Pipeline" value={deal.pipeline.name} />
          <Field
            label="Current stage"
            value={
              <span className="font-medium">
                {deal.currentStage.name}{' '}
                <span style={MUTED_STYLE} className="text-xs font-normal">
                  ({deal.currentStage.outcomeType})
                </span>
              </span>
            }
          />
          <Field label="Entered stage" value={fmtDateTime(deal.enteredStageAt)} />
        </div>
        {Object.keys(deal.microObjectiveProgress).length > 0 ? (
          <div className="mt-4">
            <div className="text-xs mb-2" style={MUTED_STYLE}>Micro-objective progress</div>
            <pre className="text-xs bg-gray-50 p-3 rounded overflow-x-auto font-mono">
              {JSON.stringify(deal.microObjectiveProgress, null, 2)}
            </pre>
          </div>
        ) : null}
      </section>

      {/* Card 3 — Stage history timeline */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Stage history{' '}
          <span style={MUTED_STYLE} className="font-normal">({deal.stageHistory.length})</span>
        </h2>
        <StageHistoryTimeline rows={deal.stageHistory} />
      </section>

      {/* Card 4 — Outcome (won/lost only) */}
      {showOutcome ? (
        <section className="bg-white border rounded-lg p-6">
          <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Outcome</h2>
          {deal.status === 'won' ? (
            deal.wonProductSummary ? (
              <p className="text-sm whitespace-pre-wrap" style={LABEL_STYLE}>
                {deal.wonProductSummary}
              </p>
            ) : (
              <p className="text-sm" style={MUTED_STYLE}>Won — no product summary recorded</p>
            )
          ) : (
            <div className="space-y-2 text-sm">
              {deal.lostReason ? (
                <span className="inline-flex items-center px-2.5 py-0.5 text-xs font-medium rounded-full bg-red-50 text-red-700 border border-red-200">
                  {enumLabel(DEAL_LOST_REASON_LABELS, deal.lostReason)}
                </span>
              ) : null}
              {deal.lostReasonDetail ? (
                <p className="whitespace-pre-wrap" style={LABEL_STYLE}>{deal.lostReasonDetail}</p>
              ) : null}
              {!deal.lostReason && !deal.lostReasonDetail ? (
                <p style={MUTED_STYLE}>Lost — no reason recorded</p>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      {/* Card 5 — Products discussed */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Products discussed</h2>
        {!products || products.length === 0 ? (
          <p className="text-sm" style={MUTED_STYLE}>No products discussed</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-left" style={MUTED_STYLE}>
                <th className="pb-2 font-medium">SKU</th>
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium text-right">Qty</th>
                <th className="pb-2 font-medium text-right">Unit</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p, i) => (
                <tr key={i} className="border-t">
                  <td className="py-2 text-xs font-mono" style={MUTED_STYLE}>
                    {typeof p.sku === 'string' ? p.sku : '—'}
                  </td>
                  <td className="py-2">{typeof p.name === 'string' ? p.name : '—'}</td>
                  <td className="py-2 text-right tabular-nums">
                    {typeof p.quantity === 'number' ? p.quantity : '—'}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    <MoneyDisplay value={p.unitPrice as string | number | null} currency={deal.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Card 6 — Ownership */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Ownership</h2>
        <div className="space-y-2 text-sm">
          <div>
            <div className="text-xs" style={MUTED_STYLE}>Owner</div>
            {deal.owner ? (
              <div>
                <a
                  href={`mailto:${deal.owner.email}`}
                  className="text-indigo-600 hover:underline font-medium"
                >
                  {deal.owner.name || deal.owner.email}
                </a>
                {deal.owner.name ? (
                  <span style={MUTED_STYLE} className="ml-2 text-xs">{deal.owner.email}</span>
                ) : null}
              </div>
            ) : (
              <span style={MUTED_STYLE}>No owner assigned</span>
            )}
          </div>
          <div>
            <div className="text-xs" style={MUTED_STYLE}>Assigned AI agent</div>
            {deal.assignedAgentId ? (
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs" style={LABEL_STYLE}>{deal.assignedAgentId}</span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                  <Bot className="w-3 h-3" /> AI agent
                </span>
              </div>
            ) : (
              <span style={MUTED_STYLE}>No AI agent assigned</span>
            )}
          </div>
        </div>
      </section>

      {/* Card 7 — Linked Contact */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Linked contact</h2>
        <div className="flex items-center justify-between text-sm">
          <Link
            href={`/customers/${deal.contact.id}`}
            className="font-medium text-indigo-600 hover:underline"
          >
            {contactDisplayName(deal.contact)}
          </Link>
          <div className="flex items-center gap-3">
            {deal.contact.email ? (
              <span style={MUTED_STYLE} className="text-xs">{deal.contact.email}</span>
            ) : null}
            <StatusBadge kind="contact-lifecycle" value={deal.contact.lifecycleStage} />
          </div>
        </div>
      </section>

      {/* Card 8 — Linked Company */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Linked company</h2>
        {deal.company ? (
          <div className="text-sm">
            <Link
              href={`/companies/${deal.company.id}`}
              className="font-medium text-indigo-600 hover:underline"
            >
              {deal.company.name}
            </Link>
            {deal.company.domain ? (
              <span style={MUTED_STYLE} className="ml-2 text-xs">{deal.company.domain}</span>
            ) : null}
            {deal.company.industry ? (
              <span style={MUTED_STYLE} className="ml-2 text-xs">· {deal.company.industry}</span>
            ) : null}
          </div>
        ) : (
          <p className="text-sm" style={MUTED_STYLE}>No linked company</p>
        )}
      </section>

      {/* Card 8.5 — Linked Orders (KAN-cohort-3.5). Capped take:20; the
          truthful total comes from _count.orders so the header doesn't lie
          when the list is truncated. */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Linked orders{' '}
          <span style={MUTED_STYLE} className="font-normal">
            ({deal._count.orders})
          </span>
        </h2>
        {deal.orders.length === 0 ? (
          <p className="text-sm" style={MUTED_STYLE}>No linked orders</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {deal.orders.map((o) => (
              <li key={o.id} className="py-2 text-sm">
                <Link href={`/orders/${o.id}`} className="flex items-center justify-between hover:bg-gray-50 -mx-2 px-2 py-1 rounded">
                  <span className="font-medium">{o.orderNumber}</span>
                  <div className="flex items-center gap-3">
                    <MoneyDisplay value={o.grandTotal} currency={o.currency} className="tabular-nums" />
                    <StatusBadge kind="order-status" value={o.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Card 9 — Raw data */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Raw data</h2>
        <div className="space-y-4 text-xs">
          <RawBlock label="externalIds" value={deal.externalIds} />
          <RawBlock label="customFields" value={deal.customFields} />
          <RawBlock label="aiContext" value={deal.aiContext} />
          <RawBlock label="metadata" value={deal.metadata} />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-2">
            <Field
              label="Correlation ID"
              value={deal.correlationId ? <span className="font-mono">{deal.correlationId}</span> : null}
            />
            <Field label="Created" value={fmtDateTime(deal.createdAt)} />
            <Field label="Updated" value={fmtDateTime(deal.updatedAt)} />
          </div>
        </div>
      </section>
    </div>
  );
}

export function StageHistoryTimeline({ rows }: { rows: DealStageTransition[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm" style={MUTED_STYLE}>No stage transitions recorded yet</p>
    );
  }
  return (
    <ol className="space-y-3">
      {rows.map((row) => {
        const Icon = triggeredByIcon(row.triggeredBy);
        const fromName = row.fromStage?.name ?? '(initial)';
        return (
          <li key={row.id} className="flex gap-3 text-sm">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center">
              <Icon className="w-4 h-4 text-gray-600" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium" style={LABEL_STYLE}>{fromName}</span>
                <span style={MUTED_STYLE}>→</span>
                <span className="font-medium" style={LABEL_STYLE}>{row.toStage.name}</span>
              </div>
              <div className="text-xs mt-0.5 flex items-center gap-2 flex-wrap" style={MUTED_STYLE}>
                <span>{fmtDateTime(row.transitionedAt)}</span>
                <span>·</span>
                <span>triggered by {row.triggeredBy}</span>
                {row.decision ? (
                  <>
                    <span>·</span>
                    <span className="font-mono">
                      {row.decision.actionType} ({row.decision.strategySelected})
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Field({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode | null | undefined;
}) {
  const display = value === null || value === undefined || value === '' ? '—' : value;
  return (
    <div>
      <div className="text-xs" style={MUTED_STYLE}>{label}</div>
      <div className="mt-0.5" style={LABEL_STYLE}>{display}</div>
    </div>
  );
}

function RawBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="text-xs mb-1" style={MUTED_STYLE}>{label}</div>
      <pre className="text-xs bg-gray-50 p-3 rounded overflow-x-auto font-mono">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function SkeletonCards() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="bg-white border rounded-lg p-6 space-y-3">
          <div className="h-5 w-1/3 bg-gray-200 rounded animate-pulse" />
          <div className="h-4 w-2/3 bg-gray-100 rounded animate-pulse" />
          <div className="h-4 w-1/2 bg-gray-100 rounded animate-pulse" />
        </div>
      ))}
    </div>
  );
}
