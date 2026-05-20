'use client';

/**
 * KAN-884 — /orders/[id] detail page (read-only).
 *
 * Cards: info / money / line items / customer / deal / attribution / notes.
 * Optional cards (deal, attribution, notes) hide entirely when their
 * payload is empty — these aren't always relevant, so collapsing keeps
 * the page rhythm tight.
 *
 * lineItems is JSONB on the backend. We render defensively: if the parsed
 * value isn't an array of {name, quantity, unitPrice, total?}, fall back
 * to a JSON dump in a <pre>. Producers (KAN-2/3 cohort — Stripe/Shopify
 * webhooks) will land in a separate cohort and may evolve the shape.
 */

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Receipt } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { ordersApi } from '@/lib/api';
import { MoneyDisplay } from '@/components/ui/money-display';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  ORDER_SOURCE_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_PROVIDER_LABELS,
  enumLabel,
} from '@/lib/enum-labels';

const SECTION_HEADER_STYLE = { color: 'var(--ds-ink-primary)' } as const;
const MUTED_STYLE = { color: 'var(--ds-ink-tertiary)' } as const;
const LABEL_STYLE = { color: 'var(--ds-ink-secondary)' } as const;

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

/** KAN-945 Q10 — TZ-safe date rendering. Previously called
 *  `new Date(iso).toLocaleString()` without a `timeZone` option, which
 *  shifted the rendered date by the browser's UTC offset (KAN-943 class).
 *  Explicit `timeZone: 'UTC'` aligns the detail-page display with the
 *  edit-form's UTC-day pre-population. Broader Company/Customer audit
 *  stays in KAN-943 scope. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { timeZone: 'UTC' });
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

  if (isLoading) return <SkeletonCards />;

  if (isError) {
    const message = (error as Error)?.message ?? 'Unknown error';
    const isNotFound = /not found/i.test(message);
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link
          href="/orders"
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 mb-4"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Orders
        </Link>
        <div className="bg-white border rounded-lg p-12 text-center">
          <Receipt className="w-8 h-8 mx-auto text-gray-300" />
          <h2 className="text-lg font-semibold mt-3" style={SECTION_HEADER_STYLE}>
            {isNotFound ? 'Order not found' : 'Failed to load order'}
          </h2>
          <p className="text-sm mt-1" style={MUTED_STYLE}>{message}</p>
        </div>
      </div>
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
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
      <Link
        href="/orders"
        className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Orders
      </Link>

      {/* Card 1 — Order info */}
      <section className="bg-white border rounded-lg p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold" style={SECTION_HEADER_STYLE}>
              Order {order.orderNumber}
            </h1>
            <p className="text-sm mt-0.5" style={MUTED_STYLE}>
              Placed {fmtDate(order.placedAt)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge kind="order-status" value={order.status} />
            {/* KAN-945 — Sub-cohort 3.4 Edit affordance. Placed in Card 1
                header next to status (mirrors KAN-937/938 pattern). Row-
                level Edit avoided — list's orderNumber cell already navigates
                to detail via Link, and per-row Edit would compete. */}
            <Link
              href={`/orders/${order.id}/edit`}
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
          <Field label="Source" value={enumLabel(ORDER_SOURCE_LABELS, order.source)} />
          <Field label="Payment method" value={enumLabel(PAYMENT_METHOD_LABELS, order.paymentMethod)} />
          <Field label="Payment provider" value={enumLabel(PAYMENT_PROVIDER_LABELS, order.paymentProvider)} />
          <Field label="Provider order ID" value={order.providerOrderId} />
          <Field label="Paid" value={order.paidAt ? fmtDate(order.paidAt) : null} />
          <Field label="Refunded" value={order.refundedAt ? fmtDate(order.refundedAt) : null} />
          <Field label="Cancelled" value={order.cancelledAt ? fmtDate(order.cancelledAt) : null} />
        </div>
      </section>

      {/* Card 2 — Money breakdown */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Money</h2>
        <dl className="space-y-2 text-sm">
          <MoneyRow label="Subtotal" value={order.totalAmount} currency={order.currency} />
          <MoneyRow label="Tax" value={order.taxAmount} currency={order.currency} />
          <MoneyRow
            label="Discount"
            value={order.discountAmount}
            currency={order.currency}
            negative
          />
          <div className="border-t pt-2 flex items-center justify-between text-base font-semibold">
            <span style={SECTION_HEADER_STYLE}>Grand total</span>
            <span style={SECTION_HEADER_STYLE} className="tabular-nums">
              <MoneyDisplay value={order.grandTotal} currency={order.currency} />
            </span>
          </div>
        </dl>
      </section>

      {/* Card 3 — Line items */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Line items</h2>
        {lineItems === null ? (
          <div className="text-sm" style={MUTED_STYLE}>
            <p className="mb-2">Line items shape unexpected — showing raw payload:</p>
            <pre className="text-xs bg-gray-50 p-3 rounded overflow-x-auto">
              {JSON.stringify(order.lineItems, null, 2)}
            </pre>
          </div>
        ) : lineItems.length === 0 ? (
          <p className="text-sm" style={MUTED_STYLE}>No line items</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-left" style={MUTED_STYLE}>
                <th className="pb-2 font-medium">Item</th>
                <th className="pb-2 font-medium">SKU</th>
                <th className="pb-2 font-medium text-right">Qty</th>
                <th className="pb-2 font-medium text-right">Unit</th>
                <th className="pb-2 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((li, i) => (
                <tr key={i} className="border-t">
                  <td className="py-2">{typeof li.name === 'string' ? li.name : '—'}</td>
                  <td className="py-2 text-xs" style={MUTED_STYLE}>
                    {typeof li.sku === 'string' ? li.sku : '—'}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {typeof li.quantity === 'number' ? li.quantity : '—'}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    <MoneyDisplay value={li.unitPrice as string | number | null} currency={order.currency} />
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    <MoneyDisplay value={li.total as string | number | null} currency={order.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Card 4 — Customer */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Customer</h2>
        <div className="space-y-2 text-sm">
          <div>
            <Link href={`/customers/${order.contact.id}`} className="font-medium text-indigo-600 hover:underline">
              {contactName}
            </Link>
            {order.contact.email ? (
              <span style={MUTED_STYLE} className="ml-2 text-xs">{order.contact.email}</span>
            ) : null}
          </div>
          {order.company ? (
            <div>
              <Link href={`/companies/${order.company.id}`} className="text-indigo-600 hover:underline">
                {order.company.name}
              </Link>
            </div>
          ) : (
            <p style={MUTED_STYLE} className="text-xs">
              No linked company (direct purchase)
            </p>
          )}
        </div>
      </section>

      {/* Card 5 — Deal (conditional) */}
      {order.deal ? (
        <section className="bg-white border rounded-lg p-6">
          <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Linked deal</h2>
          <div className="flex items-center justify-between text-sm">
            <Link href={`/opportunities/${order.deal.id}`} className="font-medium text-indigo-600 hover:underline">
              {order.deal.name}
            </Link>
            <div className="flex items-center gap-3">
              <MoneyDisplay
                value={order.deal.value}
                currency={order.deal.currency}
                className="tabular-nums"
              />
              <StatusBadge kind="deal-status" value={order.deal.status} />
            </div>
          </div>
        </section>
      ) : null}

      {/* Card 6 — Attribution (conditional) */}
      {showAttribution ? (
        <section className="bg-white border rounded-lg p-6">
          <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Attribution</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <Field label="First source" value={order.attributionFirstSource} />
            <Field label="Last source" value={order.attributionLastSource} />
          </div>
        </section>
      ) : null}

      {/* Card 7 — Notes (conditional) */}
      {showNotes ? (
        <section className="bg-white border rounded-lg p-6">
          <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Notes</h2>
          <div className="space-y-3 text-sm">
            {order.customerNotes ? (
              <div>
                <div className="text-xs mb-1" style={MUTED_STYLE}>From customer</div>
                <p style={LABEL_STYLE} className="whitespace-pre-wrap">{order.customerNotes}</p>
              </div>
            ) : null}
            {order.internalNotes ? (
              <div>
                <div className="text-xs mb-1" style={MUTED_STYLE}>Internal</div>
                <p style={LABEL_STYLE} className="whitespace-pre-wrap">{order.internalNotes}</p>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
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

function MoneyRow({
  label,
  value,
  currency,
  negative = false,
}: {
  label: string;
  value: string;
  currency: string;
  negative?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span style={LABEL_STYLE}>{label}</span>
      <span className="tabular-nums" style={LABEL_STYLE}>
        {negative ? '−' : ''}
        <MoneyDisplay value={value} currency={currency} />
      </span>
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
