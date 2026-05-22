'use client';

/**
 * KAN-884 — /orders/[id] detail page (read-only).
 * KAN-989 Phase C.5 — converged onto shared DetailPageShell + FieldRow +
 * LinkedEntityRow + SectionCard primitives. Every section + field
 * preserved. TZ-safe dates via @/lib/fmt-date. Cross-links navigate to
 * /customers/[id], /companies/[id], /opportunities/[id].
 *
 * Layout:
 *   - Header: "Order {orderNumber}" + StatusBadge + Edit; "Placed {date}"
 *     subtitle; "Back to Orders"
 *   - Main slot (1.4fr): Order info + Money breakdown + Line items +
 *     Attribution (conditional) + Notes (conditional)
 *   - Side slot (1fr): Customer + Linked deal (conditional)
 *
 * Optional cards (deal, attribution, notes) still hide when their
 * payload is empty — they aren't always relevant, so collapsing keeps
 * the page rhythm tight.
 *
 * lineItems is JSONB on the backend. We render defensively: if the parsed
 * value isn't an array of {name, quantity, unitPrice, total?}, fall back
 * to a JSON dump in a <pre>. Producers (Stripe/Shopify webhooks) may
 * evolve the shape.
 */

import { useQuery } from '@tanstack/react-query';
import { Pencil, Receipt } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { ordersApi } from '@/lib/api';
import { MoneyDisplay } from '@/components/ui/money-display';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  DetailPageShell,
  FieldRow,
  LinkedEntityRow,
  SectionCard,
} from '@/components/ui/detail-page-shell';
import { fmtDateTime } from '@/lib/fmt-date';
import {
  ORDER_SOURCE_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_PROVIDER_LABELS,
  enumLabel,
} from '@/lib/enum-labels';

interface LineItem {
  name?: unknown;
  sku?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  total?: unknown;
}

function parseLineItems(raw: unknown): LineItem[] | null {
  if (!Array.isArray(raw)) return null;
  return raw as LineItem[];
}

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const { data: order, isLoading, isError, error } = useQuery({
    queryKey: ['orders', 'get', id],
    queryFn: () => ordersApi.get(id as string),
    enabled: !!id,
  });

  useEffect(() => {
    if (order) document.title = `Order ${order.orderNumber} · Orders`;
  }, [order]);

  if (!id) return null;
  if (isLoading) return <SkeletonShell />;

  if (isError) {
    const message = (error as Error)?.message ?? 'Unknown error';
    const isNotFound = /not found/i.test(message);
    return (
      <DetailPageShell
        backHref="/orders"
        backLabel="Back to Orders"
        title={isNotFound ? 'Order not found' : 'Failed to load order'}
        logoMark={Receipt}
        mainSlot={
          <SectionCard title="Error">
            <p className="text-body text-muted-foreground">{message}</p>
          </SectionCard>
        }
        sideSlot={null}
      />
    );
  }

  if (!order) return null;

  const lineItems = parseLineItems(order.lineItems);
  const contactName =
    [order.contact.firstName, order.contact.lastName].filter(Boolean).join(' ').trim() ||
    order.contact.email ||
    'Unknown';
  const showAttribution = !!(order.attributionFirstSource || order.attributionLastSource);
  const showNotes = !!(order.customerNotes || order.internalNotes);

  return (
    <DetailPageShell
      backHref="/orders"
      backLabel="Back to Orders"
      title={`Order ${order.orderNumber}`}
      logoMark={Receipt}
      subtitle={`Placed ${fmtDateTime(order.placedAt)}`}
      headerBadge={<StatusBadge kind="order-status" value={order.status} />}
      headerAction={
        <Link
          href={`/orders/${order.id}/edit`}
          className="inline-flex items-center gap-1.5 rounded-[var(--ds-radius-pill)] border border-border bg-card px-3 py-1.5 text-label text-foreground transition-colors hover:bg-[var(--ds-surface-sunken)]"
        >
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Link>
      }
      mainSlot={
        <div className="space-y-4">
          <SectionCard title="Order info">
            <FieldRow
              label="Source"
              value={enumLabel(ORDER_SOURCE_LABELS, order.source) ?? '—'}
            />
            <FieldRow
              label="Payment method"
              value={enumLabel(PAYMENT_METHOD_LABELS, order.paymentMethod) ?? '—'}
            />
            <FieldRow
              label="Payment provider"
              value={enumLabel(PAYMENT_PROVIDER_LABELS, order.paymentProvider) ?? '—'}
            />
            <FieldRow label="Provider order ID" value={order.providerOrderId ?? '—'} />
            <FieldRow label="Paid" value={order.paidAt ? fmtDateTime(order.paidAt) : '—'} />
            <FieldRow
              label="Refunded"
              value={order.refundedAt ? fmtDateTime(order.refundedAt) : '—'}
            />
            <FieldRow
              label="Cancelled"
              value={order.cancelledAt ? fmtDateTime(order.cancelledAt) : '—'}
            />
          </SectionCard>

          <SectionCard title="Money">
            <FieldRow
              label="Subtotal"
              value={<MoneyDisplay value={order.totalAmount} currency={order.currency} />}
            />
            <FieldRow
              label="Tax"
              value={<MoneyDisplay value={order.taxAmount} currency={order.currency} />}
            />
            <FieldRow
              label="Discount"
              value={
                <span className="tabular-nums">
                  −<MoneyDisplay value={order.discountAmount} currency={order.currency} />
                </span>
              }
            />
            <FieldRow
              label={'Grand total'}
              value={
                <span className="text-body-lg font-medium">
                  <MoneyDisplay value={order.grandTotal} currency={order.currency} />
                </span>
              }
            />
          </SectionCard>

          <SectionCard title="Line items">
            {lineItems === null ? (
              <div className="text-body text-muted-foreground">
                <p className="mb-2">Line items shape unexpected — showing raw payload:</p>
                <pre className="overflow-x-auto rounded bg-[var(--ds-surface-sunken)] p-3 text-caption font-mono">
                  {JSON.stringify(order.lineItems, null, 2)}
                </pre>
              </div>
            ) : lineItems.length === 0 ? (
              <p className="text-body text-muted-foreground">No line items</p>
            ) : (
              <table className="w-full text-body">
                <thead>
                  <tr className="text-left text-caption uppercase text-muted-foreground">
                    <th className="pb-2 font-medium">Item</th>
                    <th className="pb-2 font-medium">SKU</th>
                    <th className="pb-2 text-right font-medium">Qty</th>
                    <th className="pb-2 text-right font-medium">Unit</th>
                    <th className="pb-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((li, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="py-2 text-foreground">
                        {typeof li.name === 'string' ? li.name : '—'}
                      </td>
                      <td className="py-2 text-caption text-muted-foreground">
                        {typeof li.sku === 'string' ? li.sku : '—'}
                      </td>
                      <td className="py-2 text-right tabular-nums text-foreground">
                        {typeof li.quantity === 'number' ? li.quantity : '—'}
                      </td>
                      <td className="py-2 text-right tabular-nums text-foreground">
                        <MoneyDisplay
                          value={li.unitPrice as string | number | null}
                          currency={order.currency}
                        />
                      </td>
                      <td className="py-2 text-right tabular-nums text-foreground">
                        <MoneyDisplay
                          value={li.total as string | number | null}
                          currency={order.currency}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>

          {showAttribution ? (
            <SectionCard title="Attribution">
              <FieldRow label="First source" value={order.attributionFirstSource ?? '—'} />
              <FieldRow label="Last source" value={order.attributionLastSource ?? '—'} />
            </SectionCard>
          ) : null}

          {showNotes ? (
            <SectionCard title="Notes">
              <div className="space-y-3">
                {order.customerNotes ? (
                  <div>
                    <div className="text-caption text-muted-foreground">From customer</div>
                    <p className="mt-1 whitespace-pre-wrap text-body text-foreground">
                      {order.customerNotes}
                    </p>
                  </div>
                ) : null}
                {order.internalNotes ? (
                  <div>
                    <div className="text-caption text-muted-foreground">Internal</div>
                    <p className="mt-1 whitespace-pre-wrap text-body text-foreground">
                      {order.internalNotes}
                    </p>
                  </div>
                ) : null}
              </div>
            </SectionCard>
          ) : null}
        </div>
      }
      sideSlot={
        <div className="space-y-4">
          <SectionCard title="Customer">
            <div>
              <LinkedEntityRow
                href={`/customers/${order.contact.id}`}
                iconLabel={
                  (order.contact.firstName?.[0] ?? order.contact.email?.[0] ?? '?').toUpperCase()
                }
                name={contactName}
                meta={order.contact.email ?? undefined}
              />
              {order.company ? (
                <LinkedEntityRow
                  href={`/companies/${order.company.id}`}
                  iconLabel={(order.company.name[0] ?? 'C').toUpperCase()}
                  name={order.company.name}
                />
              ) : (
                <p className="border-t border-border py-2.5 text-caption text-muted-foreground first:border-t-0">
                  No linked company (direct purchase)
                </p>
              )}
            </div>
          </SectionCard>

          {order.deal ? (
            <SectionCard title="Linked deal">
              <LinkedEntityRow
                href={`/opportunities/${order.deal.id}`}
                iconLabel="$"
                name={order.deal.name}
                meta={
                  <span className="inline-flex items-center gap-2">
                    <MoneyDisplay value={order.deal.value} currency={order.deal.currency} />
                    <StatusBadge kind="deal-status" value={order.deal.status} />
                  </span>
                }
              />
            </SectionCard>
          ) : null}
        </div>
      }
    />
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
