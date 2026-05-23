'use client';

/**
 * KAN-888 — /opportunities/[id] Deal detail page (read-only).
 * KAN-989 Phase C.5 — converged onto shared DetailPageShell + FieldRow +
 * LinkedEntityRow + SectionCard primitives. Every section + field
 * preserved. TZ-safe dates via @/lib/fmt-date. Cross-links navigate to
 * /customers/[id], /companies/[id], /orders/[id].
 *
 * Layout:
 *   - Header: deal.name + StatusBadge + Edit; "Deal ID: ..." subtitle;
 *     "Back to Leads"
 *   - Main slot (1.4fr): Identity (Value/Probability/Expected close) +
 *     Pipeline progress + Stage history + Outcome (conditional) +
 *     Products discussed + Raw data
 *   - Side slot (1fr): Ownership + Linked Contact + Linked Company +
 *     Linked Orders
 *
 * StageHistoryTimeline is exported so the regression-snapshot test in
 * __tests__/page.test.tsx can target it independently.
 */

import { useQuery } from '@tanstack/react-query';
import { Bot, FileText, Filter, Pencil, Server, Target, User as UserIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { dealsApi, type DealDetail, type DealStageTransition } from '@/lib/api';
import { MoneyDisplay } from '@/components/ui/money-display';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  DetailPageShell,
  FieldRow,
  LinkedEntityRow,
  SectionCard,
} from '@/components/ui/detail-page-shell';
import { fmtDate, fmtDateTime } from '@/lib/fmt-date';
import { DEAL_LOST_REASON_LABELS, enumLabel } from '@/lib/enum-labels';

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
  if (isLoading) return <SkeletonShell />;

  if (isError) {
    const message = (error as Error)?.message ?? 'Unknown error';
    const isNotFound = /not found/i.test(message);
    return (
      <DetailPageShell
        backHref="/opportunities"
        backLabel="Back to Leads"
        title={isNotFound ? 'Lead not found' : 'Failed to load lead'}
        logoMark={Target}
        mainSlot={
          <SectionCard title="Error">
            <p className="text-body text-muted-foreground">{message}</p>
          </SectionCard>
        }
        sideSlot={null}
      />
    );
  }

  if (!deal) return null;

  const showOutcome = deal.status === 'won' || deal.status === 'lost';
  const products = parseProducts(deal.products);

  return (
    <DetailPageShell
      backHref="/opportunities"
      backLabel="Back to Leads"
      title={deal.name}
      logoMark={Target}
      subtitle={`Lead ID: ${deal.id}`}
      headerBadge={<StatusBadge kind="deal-status" value={deal.status} />}
      headerAction={
        <Link
          href={`/opportunities/${deal.id}/edit`}
          className="inline-flex items-center gap-1.5 rounded-[var(--ds-radius-pill)] border border-border bg-card px-3 py-1.5 text-label text-foreground transition-colors hover:bg-[var(--ds-surface-sunken)]"
        >
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Link>
      }
      mainSlot={
        <div className="space-y-4">
          <SectionCard title="Identity">
            <FieldRow
              label="Value"
              value={<MoneyDisplay value={deal.value} currency={deal.currency} />}
            />
            <FieldRow
              label="Probability"
              value={
                deal.probability !== null ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="tabular-nums">{deal.probability}%</span>
                    <span className="inline-block h-1.5 w-16 overflow-hidden rounded bg-[var(--ds-surface-sunken)]">
                      <span
                        className="block h-full bg-[var(--ds-violet-500)]"
                        style={{
                          width: `${Math.max(0, Math.min(100, deal.probability))}%`,
                        }}
                      />
                    </span>
                  </span>
                ) : (
                  '—'
                )
              }
            />
            <FieldRow label="Expected close" value={fmtDate(deal.expectedCloseDate)} />
            {showOutcome ? (
              <FieldRow label="Closed" value={fmtDateTime(deal.closedAt)} />
            ) : null}
          </SectionCard>

          <SectionCard title="Pipeline progress">
            <FieldRow label="Pipeline" value={deal.pipeline.name} />
            <FieldRow
              label="Current stage"
              value={
                <span>
                  {deal.currentStage.name}{' '}
                  <span className="text-caption text-muted-foreground" style={{ fontWeight: 400 }}>
                    ({deal.currentStage.outcomeType})
                  </span>
                </span>
              }
            />
            <FieldRow label="Entered stage" value={fmtDateTime(deal.enteredStageAt)} />
            {Object.keys(deal.microObjectiveProgress).length > 0 ? (
              <div className="mt-4">
                <div className="mb-2 text-caption text-muted-foreground">
                  Micro-objective progress
                </div>
                <pre className="overflow-x-auto rounded bg-[var(--ds-surface-sunken)] p-3 text-caption font-mono">
                  {JSON.stringify(deal.microObjectiveProgress, null, 2)}
                </pre>
              </div>
            ) : null}
          </SectionCard>

          <SectionCard title="Stage history" count={deal.stageHistory.length}>
            <StageHistoryTimeline rows={deal.stageHistory} />
          </SectionCard>

          {showOutcome ? (
            <SectionCard title="Outcome">
              {deal.status === 'won' ? (
                deal.wonProductSummary ? (
                  <p className="whitespace-pre-wrap text-body text-foreground">
                    {deal.wonProductSummary}
                  </p>
                ) : (
                  <p className="text-body text-muted-foreground">
                    Won — no product summary recorded
                  </p>
                )
              ) : (
                <div className="space-y-2 text-body">
                  {deal.lostReason ? (
                    <span className="inline-flex items-center rounded-[var(--ds-radius-pill)] bg-[var(--ds-danger-soft)] px-2.5 py-0.5 text-caption font-medium text-[var(--ds-danger-text)]">
                      {enumLabel(DEAL_LOST_REASON_LABELS, deal.lostReason)}
                    </span>
                  ) : null}
                  {deal.lostReasonDetail ? (
                    <p className="whitespace-pre-wrap text-foreground">{deal.lostReasonDetail}</p>
                  ) : null}
                  {!deal.lostReason && !deal.lostReasonDetail ? (
                    <p className="text-muted-foreground">Lost — no reason recorded</p>
                  ) : null}
                </div>
              )}
            </SectionCard>
          ) : null}

          <SectionCard title="Products discussed">
            {!products || products.length === 0 ? (
              <p className="text-body text-muted-foreground">No products discussed</p>
            ) : (
              <table className="w-full text-body">
                <thead>
                  <tr className="text-left text-caption uppercase text-muted-foreground">
                    <th className="pb-2 font-medium">SKU</th>
                    <th className="pb-2 font-medium">Name</th>
                    <th className="pb-2 text-right font-medium">Qty</th>
                    <th className="pb-2 text-right font-medium">Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((p, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="py-2 font-mono text-caption text-muted-foreground">
                        {typeof p.sku === 'string' ? p.sku : '—'}
                      </td>
                      <td className="py-2 text-foreground">
                        {typeof p.name === 'string' ? p.name : '—'}
                      </td>
                      <td className="py-2 text-right tabular-nums text-foreground">
                        {typeof p.quantity === 'number' ? p.quantity : '—'}
                      </td>
                      <td className="py-2 text-right tabular-nums text-foreground">
                        <MoneyDisplay
                          value={p.unitPrice as string | number | null}
                          currency={deal.currency}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>

          <SectionCard title="Raw data">
            <div className="space-y-4">
              <RawBlock label="externalIds" value={deal.externalIds} />
              <RawBlock label="customFields" value={deal.customFields} />
              <RawBlock label="aiContext" value={deal.aiContext} />
              <RawBlock label="metadata" value={deal.metadata} />
              <FieldRow
                label="Correlation ID"
                value={
                  deal.correlationId ? (
                    <span className="font-mono text-caption">{deal.correlationId}</span>
                  ) : (
                    '—'
                  )
                }
              />
              <FieldRow label="Created" value={fmtDateTime(deal.createdAt)} />
              <FieldRow label="Updated" value={fmtDateTime(deal.updatedAt)} />
            </div>
          </SectionCard>
        </div>
      }
      sideSlot={
        <div className="space-y-4">
          <SectionCard title="Ownership">
            <FieldRow
              label="Owner"
              value={
                deal.owner ? (
                  <a
                    href={`mailto:${deal.owner.email}`}
                    className="text-[var(--ds-violet-500)] hover:underline"
                  >
                    {deal.owner.name || deal.owner.email}
                  </a>
                ) : (
                  <span className="text-muted-foreground">No owner assigned</span>
                )
              }
            />
            <FieldRow
              label="Assigned AI agent"
              value={
                deal.assignedAgentId ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="font-mono text-caption">{deal.assignedAgentId}</span>
                    <span className="inline-flex items-center gap-1 rounded-[var(--ds-radius-pill)] bg-[var(--ds-violet-100)] px-2 py-0.5 text-caption font-medium text-[var(--ds-violet-500)]">
                      <Bot className="h-3 w-3" /> AI agent
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">No AI agent assigned</span>
                )
              }
            />
          </SectionCard>

          <SectionCard title="Linked contact">
            <LinkedEntityRow
              href={`/customers/${deal.contact.id}`}
              iconLabel={
                (deal.contact.firstName?.[0] ?? deal.contact.email?.[0] ?? '?').toUpperCase()
              }
              name={contactDisplayName(deal.contact)}
              meta={
                <span className="inline-flex items-center gap-2">
                  {deal.contact.email ? <span>{deal.contact.email}</span> : null}
                  <StatusBadge kind="contact-lifecycle" value={deal.contact.lifecycleStage} />
                </span>
              }
            />
          </SectionCard>

          <SectionCard title="Linked company">
            {deal.company ? (
              <LinkedEntityRow
                href={`/companies/${deal.company.id}`}
                iconLabel={(deal.company.name[0] ?? 'C').toUpperCase()}
                name={deal.company.name}
                meta={
                  <span>
                    {deal.company.domain ? deal.company.domain : null}
                    {deal.company.industry ? (
                      <span> · {deal.company.industry}</span>
                    ) : null}
                  </span>
                }
              />
            ) : (
              <p className="text-body text-muted-foreground">No linked company</p>
            )}
          </SectionCard>

          <SectionCard title="Linked orders" count={deal._count.orders}>
            {deal.orders.length === 0 ? (
              <p className="text-body text-muted-foreground">No linked orders</p>
            ) : (
              <div>
                {deal.orders.map((o) => (
                  <LinkedEntityRow
                    key={o.id}
                    href={`/orders/${o.id}`}
                    iconLabel="#"
                    name={o.orderNumber}
                    meta={
                      <span className="inline-flex items-center gap-2">
                        <MoneyDisplay value={o.grandTotal} currency={o.currency} />
                        <StatusBadge kind="order-status" value={o.status} />
                      </span>
                    }
                  />
                ))}
              </div>
            )}
          </SectionCard>
        </div>
      }
    />
  );
}

export function StageHistoryTimeline({ rows }: { rows: DealStageTransition[] }) {
  if (rows.length === 0) {
    return <p className="text-body text-muted-foreground">No stage transitions recorded yet</p>;
  }
  return (
    <ol className="space-y-3">
      {rows.map((row) => {
        const Icon = triggeredByIcon(row.triggeredBy);
        const fromName = row.fromStage?.name ?? '(initial)';
        return (
          <li key={row.id} className="flex gap-3 text-body">
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-violet-100)]">
              <Icon className="h-4 w-4 text-[var(--ds-violet-500)]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{fromName}</span>
                <span className="text-muted-foreground">→</span>
                <span className="font-medium text-foreground">{row.toStage.name}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
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

function RawBlock({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 text-caption text-muted-foreground">{label}</div>
      <pre className="overflow-x-auto rounded bg-[var(--ds-surface-sunken)] p-3 text-caption font-mono">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function SkeletonShell() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-8 space-y-4">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="rounded-[var(--ds-radius-card)] border border-border bg-card p-6 shadow-[var(--ds-shadow-card)]"
        >
          <div className="h-5 w-1/3 animate-pulse rounded bg-muted" />
          <div className="mt-3 h-4 w-2/3 animate-pulse rounded bg-muted/60" />
          <div className="mt-2 h-4 w-1/2 animate-pulse rounded bg-muted/60" />
        </div>
      ))}
    </div>
  );
}
