'use client';

/**
 * KAN-887 — /customers/[id] Contact detail page (read-only).
 *
 * 11 stacked cards rendering every relation `contacts.getById` returns
 * (extended in this PR — see packages/api/src/services/contacts-router.ts).
 * Pattern mirrors /companies/[id] (KAN-884): DS v1 inline token style,
 * SkeletonCards loading, isNotFound regex on error, useEffect doc title.
 *
 * Card layout:
 *   1. Identity                          (always)
 *   2. Lifecycle + Source                (always; skips deprecated
 *                                         currentPipelineId/StageId per
 *                                         KAN-791 — canonical surface is
 *                                         the Deal detail page)
 *   3. Address                           (always; empty state if blank)
 *   4. Company                           (always; "No linked company"
 *                                         if companyId is null)
 *   5. Customer status                   (conditional — only if Customer
 *                                         relation exists)
 *   6. Linked Deals                      (row click → /opportunities/[id])
 *   7. Recent Engagements                (no detail page; read-only table)
 *   8. Recent Outcomes                   (same)
 *   9. Recent Decisions                  (same)
 *  10. Recent Escalations                (same)
 *  11. Raw data                          (always visible <pre> blocks
 *                                         per close-out gate decision)
 */

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Users } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { contactsApi, type ContactDetail } from '@/lib/api';
import { AddressBlock, isAddressEmpty } from '@/components/ui/address-block';
import { MoneyDisplay } from '@/components/ui/money-display';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  CONTACT_SOURCE_LABELS,
  enumLabel,
} from '@/lib/enum-labels';

const SECTION_HEADER_STYLE = { color: 'var(--ds-ink-primary)' } as const;
const MUTED_STYLE = { color: 'var(--ds-ink-tertiary)' } as const;
const LABEL_STYLE = { color: 'var(--ds-ink-secondary)' } as const;

function displayName(c: ContactDetail): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return name || c.email || 'Unknown contact';
}

function initials(c: ContactDetail): string {
  const f = (c.firstName ?? '').charAt(0);
  const l = (c.lastName ?? '').charAt(0);
  const i = (f + l).toUpperCase();
  if (i) return i;
  if (c.email) return c.email.charAt(0).toUpperCase();
  return '??';
}

/** KAN-943 — TZ-safe date rendering. `new Date(iso).toLocaleDateString()`
 *  without a `timeZone` option shifts the rendered day by the browser's
 *  UTC offset (off-by-one in TZs west of UTC). `timeZone: 'UTC'` aligns
 *  the detail-page display with the edit-form's UTC-day pre-population.
 *  Broader non-entity audit tracked in KAN-947. */
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { timeZone: 'UTC' });
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { timeZone: 'UTC' });
}

function signalClassTone(sc: string): { bg: string; fg: string; border: string } {
  switch (sc) {
    case 'positive':
      return { bg: 'bg-emerald-50', fg: 'text-emerald-700', border: 'border-emerald-200' };
    case 'negative':
      return { bg: 'bg-red-50', fg: 'text-red-700', border: 'border-red-200' };
    default:
      return { bg: 'bg-gray-50', fg: 'text-gray-700', border: 'border-gray-200' };
  }
}

export default function ContactDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;

  const { data: contact, isLoading, isError, error } = useQuery<ContactDetail>({
    queryKey: ['contacts', 'getById', id],
    queryFn: () => contactsApi.getById(id as string),
    enabled: !!id,
  });

  useEffect(() => {
    if (contact) document.title = `${displayName(contact)} · Customers`;
  }, [contact]);

  if (!id) return null;
  if (isLoading) return <SkeletonCards />;

  if (isError) {
    const message = (error as Error)?.message ?? 'Unknown error';
    const isNotFound = /not found/i.test(message);
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link
          href="/customers"
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 mb-4"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Customers
        </Link>
        <div className="bg-white border rounded-lg p-12 text-center">
          <Users className="w-8 h-8 mx-auto text-gray-300" />
          <h2 className="text-lg font-semibold mt-3" style={SECTION_HEADER_STYLE}>
            {isNotFound ? 'Contact not found' : 'Failed to load contact'}
          </h2>
          <p className="text-sm mt-1" style={MUTED_STYLE}>{message}</p>
        </div>
      </div>
    );
  }

  if (!contact) return null;

  const addressEmpty = isAddressEmpty({
    addressLine1: contact.addressLine1,
    addressLine2: contact.addressLine2,
    city: contact.city,
    region: contact.region,
    postalCode: contact.postalCode,
    country: contact.country,
  });

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
      <Link
        href="/customers"
        className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Customers
      </Link>

      {/* Card 1 — Identity */}
      <section className="bg-white border rounded-lg p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-indigo-50 text-indigo-700 flex items-center justify-center text-base font-semibold">
              {initials(contact)}
            </div>
            <div>
              <h1 className="text-xl font-semibold" style={SECTION_HEADER_STYLE}>
                {displayName(contact)}
              </h1>
              <p className="text-xs mt-0.5" style={MUTED_STYLE}>
                Contact ID: {contact.id}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge kind="contact-lifecycle" value={contact.lifecycleStage} />
            {/* KAN-934 — Cohort 3.1 Edit affordance */}
            <Link
              href={`/customers/${contact.id}/edit`}
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
            label="Email"
            value={contact.email}
            link={contact.email ? `mailto:${contact.email}` : null}
          />
          <Field
            label="Phone"
            value={contact.phone}
            link={contact.phone ? `tel:${contact.phone}` : null}
          />
          <Field label="Segment" value={contact.segment} />
          <Field
            label="Data quality"
            value={
              <span className="inline-flex items-center gap-2">
                <span className="font-medium">{contact.dataQualityScore.toFixed(0)}</span>
                <span style={MUTED_STYLE} className="text-xs">/ 100</span>
                <span className="inline-block w-16 h-1.5 bg-gray-100 rounded overflow-hidden">
                  <span
                    className="block h-full bg-indigo-500"
                    style={{ width: `${Math.max(0, Math.min(100, contact.dataQualityScore))}%` }}
                  />
                </span>
              </span>
            }
          />
        </div>
      </section>

      {/* Card 2 — Lifecycle + Source */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Lifecycle &amp; source</h2>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <StatusBadge kind="contact-lifecycle" value={contact.lifecycleStage} />
          {contact.source ? (
            <span className="inline-flex items-center px-2.5 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-700 border border-gray-200">
              Source: {enumLabel(CONTACT_SOURCE_LABELS, contact.source)}
            </span>
          ) : (
            <span style={MUTED_STYLE} className="text-xs">No source recorded</span>
          )}
        </div>
      </section>

      {/* Card 3 — Address */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Address</h2>
        {addressEmpty ? (
          <p className="text-sm" style={MUTED_STYLE}>No address on file</p>
        ) : (
          <AddressBlock
            addressLine1={contact.addressLine1}
            addressLine2={contact.addressLine2}
            city={contact.city}
            region={contact.region}
            postalCode={contact.postalCode}
            country={contact.country}
            className="text-sm"
          />
        )}
      </section>

      {/* Card 4 — Company */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Company</h2>
        {contact.company ? (
          <div className="text-sm">
            <Link href={`/companies/${contact.company.id}`} className="font-medium text-indigo-600 hover:underline">
              {contact.company.name}
            </Link>
            {contact.company.domain ? (
              <span style={MUTED_STYLE} className="ml-2 text-xs">{contact.company.domain}</span>
            ) : null}
          </div>
        ) : contact.companyName ? (
          <div className="text-sm">
            <span style={LABEL_STYLE}>{contact.companyName}</span>
            <span style={MUTED_STYLE} className="ml-2 text-xs">(unlinked)</span>
          </div>
        ) : (
          <p className="text-sm" style={MUTED_STYLE}>No linked company</p>
        )}
      </section>

      {/* Card 5 — Customer status (conditional) */}
      {contact.customer ? (
        <section className="bg-white border rounded-lg p-6">
          <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Customer status</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-sm">
            <Field label="Status" value={contact.customer.status} />
            <Field label="MRR" value={<MoneyDisplay value={contact.customer.mrr} currency="USD" />} />
            <Field label="LTV" value={<MoneyDisplay value={contact.customer.ltv} currency="USD" />} />
            <Field
              label="Health"
              value={
                <span className="inline-flex items-center gap-2">
                  <span className="font-medium">{contact.customer.healthScore.toFixed(0)}</span>
                  <span style={MUTED_STYLE} className="text-xs">/ 100</span>
                </span>
              }
            />
            <Field label="Plan" value={contact.customer.plan} />
            <Field label="Customer since" value={fmtDate(contact.customer.since)} />
          </div>
        </section>
      ) : null}

      {/* Card 6 — Linked Deals */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Linked deals{' '}
          <span style={MUTED_STYLE} className="font-normal">({contact.deals.length})</span>
        </h2>
        {contact.deals.length === 0 ? (
          <p className="text-sm" style={MUTED_STYLE}>No linked deals</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {contact.deals.map((d) => (
              <li
                key={d.id}
                role="button"
                tabIndex={0}
                onClick={() => router.push(`/opportunities/${d.id}`)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') router.push(`/opportunities/${d.id}`);
                }}
                className="py-2 flex items-center justify-between text-sm cursor-pointer hover:bg-gray-50 -mx-2 px-2 rounded"
              >
                <span className="font-medium">{d.name}</span>
                <div className="flex items-center gap-3">
                  <MoneyDisplay value={d.value} currency={d.currency} className="tabular-nums" />
                  <StatusBadge kind="deal-status" value={d.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Card 6.5 — Linked Orders (KAN-cohort-3.5). Capped take:20; total
          comes from _count.orders so the header is truthful even when the
          list is truncated. */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Linked orders{' '}
          <span style={MUTED_STYLE} className="font-normal">
            ({contact._count.orders})
          </span>
        </h2>
        {contact.orders.length === 0 ? (
          <p className="text-sm" style={MUTED_STYLE}>No linked orders</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {contact.orders.map((o) => (
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

      {/* Card 7 — Recent Engagements */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Recent engagements{' '}
          <span style={MUTED_STYLE} className="font-normal">({contact.engagements.length})</span>
        </h2>
        {contact.engagements.length === 0 ? (
          <p className="text-sm" style={MUTED_STYLE}>No recent engagements</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-left" style={MUTED_STYLE}>
                <th className="pb-2 font-medium">Type</th>
                <th className="pb-2 font-medium">Signal</th>
                <th className="pb-2 font-medium">Channel</th>
                <th className="pb-2 font-medium text-right">Occurred</th>
              </tr>
            </thead>
            <tbody>
              {contact.engagements.map((e) => {
                const tone = signalClassTone(e.signalClass);
                return (
                  <tr key={e.id} className="border-t">
                    <td className="py-2">{e.engagementType}</td>
                    <td className="py-2">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full border ${tone.bg} ${tone.fg} ${tone.border}`}
                      >
                        {e.signalClass}
                      </span>
                    </td>
                    <td className="py-2 text-xs" style={MUTED_STYLE}>{e.channel ?? '—'}</td>
                    <td className="py-2 text-right text-xs" style={MUTED_STYLE}>
                      {fmtDateTime(e.occurredAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Card 8 — Recent Outcomes */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Recent outcomes{' '}
          <span style={MUTED_STYLE} className="font-normal">({contact.outcomes.length})</span>
        </h2>
        {contact.outcomes.length === 0 ? (
          <p className="text-sm" style={MUTED_STYLE}>No recent outcomes</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-left" style={MUTED_STYLE}>
                <th className="pb-2 font-medium">Result</th>
                <th className="pb-2 font-medium">Reason</th>
                <th className="pb-2 font-medium">Objective</th>
                <th className="pb-2 font-medium text-right">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {contact.outcomes.map((o) => (
                <tr key={o.id} className="border-t">
                  <td className="py-2 font-medium">{o.result}</td>
                  <td className="py-2 text-xs" style={MUTED_STYLE}>{o.reasonCategory ?? '—'}</td>
                  <td className="py-2 text-xs font-mono" style={MUTED_STYLE}>{o.objectiveId}</td>
                  <td className="py-2 text-right text-xs" style={MUTED_STYLE}>
                    {fmtDateTime(o.recordedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Card 9 — Recent Decisions */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Recent AI decisions{' '}
          <span style={MUTED_STYLE} className="font-normal">({contact.decisions.length})</span>
        </h2>
        {contact.decisions.length === 0 ? (
          <p className="text-sm" style={MUTED_STYLE}>No recent decisions</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-left" style={MUTED_STYLE}>
                <th className="pb-2 font-medium">Action</th>
                <th className="pb-2 font-medium">Strategy</th>
                <th className="pb-2 font-medium text-right">Confidence</th>
                <th className="pb-2 font-medium text-right">When</th>
              </tr>
            </thead>
            <tbody>
              {contact.decisions.map((d) => (
                <tr key={d.id} className="border-t">
                  <td className="py-2">{d.actionType}</td>
                  <td className="py-2 text-xs" style={MUTED_STYLE}>{d.strategySelected}</td>
                  <td className="py-2 text-right tabular-nums">
                    {(d.confidence * 100).toFixed(0)}%
                  </td>
                  <td className="py-2 text-right text-xs" style={MUTED_STYLE}>
                    {fmtDateTime(d.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Card 10 — Recent Escalations */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Recent escalations{' '}
          <span style={MUTED_STYLE} className="font-normal">({contact.escalations.length})</span>
        </h2>
        {contact.escalations.length === 0 ? (
          <p className="text-sm" style={MUTED_STYLE}>No recent escalations</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-left" style={MUTED_STYLE}>
                <th className="pb-2 font-medium">Trigger</th>
                <th className="pb-2 font-medium">Reason</th>
                <th className="pb-2 font-medium">Severity</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium text-right">When</th>
              </tr>
            </thead>
            <tbody>
              {contact.escalations.map((e) => (
                <tr key={e.id} className="border-t">
                  <td className="py-2">{e.triggerType}</td>
                  <td className="py-2 text-xs" style={MUTED_STYLE}>{e.triggerReason ?? '—'}</td>
                  <td className="py-2 text-xs uppercase tracking-wide" style={MUTED_STYLE}>{e.severity}</td>
                  <td className="py-2 text-xs" style={LABEL_STYLE}>{e.status}</td>
                  <td className="py-2 text-right text-xs" style={MUTED_STYLE}>
                    {fmtDateTime(e.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Card 11 — Raw data */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Raw data</h2>
        <div className="space-y-4 text-xs">
          <RawBlock label="externalIds" value={contact.externalIds} />
          <RawBlock label="customFields" value={contact.customFields} />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-2">
            <Field label="Created" value={fmtDateTime(contact.createdAt)} />
            <Field label="Updated" value={fmtDateTime(contact.updatedAt)} />
            {contact.deletedAt ? (
              <Field label="Deleted" value={fmtDateTime(contact.deletedAt)} />
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  link,
}: {
  label: string;
  value: React.ReactNode | null | undefined;
  link?: string | null;
}) {
  const display = value === null || value === undefined || value === '' ? '—' : value;
  return (
    <div>
      <div className="text-xs" style={MUTED_STYLE}>{label}</div>
      <div className="mt-0.5">
        {link && display !== '—' ? (
          <a href={link} className="text-indigo-600 hover:underline">{display}</a>
        ) : (
          <span style={LABEL_STYLE}>{display}</span>
        )}
      </div>
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
