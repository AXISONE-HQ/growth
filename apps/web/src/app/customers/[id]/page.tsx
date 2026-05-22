'use client';

/**
 * KAN-887 — /customers/[id] Contact detail page (read-only).
 * KAN-989 Phase C.5 — converged onto shared DetailPageShell + FieldRow +
 * LinkedEntityRow + SectionCard primitives. Every section + field
 * preserved. TZ-safe dates via @/lib/fmt-date. Cross-links navigate to
 * /companies/[id], /opportunities/[id], /orders/[id].
 *
 * Layout:
 *   - Header: display name + StatusBadge (lifecycle) + Edit; "Contact
 *     ID: ..." subtitle; "Back to Customers"
 *   - Main slot (1.4fr): Identity (Email/Phone/Segment/Data quality) +
 *     Lifecycle & source + Address + Customer status (conditional) +
 *     Recent engagements + Recent outcomes + Recent decisions + Recent
 *     escalations + Raw data
 *   - Side slot (1fr): Company + Linked deals + Linked orders
 */

import { useQuery } from '@tanstack/react-query';
import { Pencil, Users } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { contactsApi, type ContactDetail } from '@/lib/api';
import { AddressBlock, isAddressEmpty } from '@/components/ui/address-block';
import { MoneyDisplay } from '@/components/ui/money-display';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  DetailPageShell,
  FieldRow,
  LinkedEntityRow,
  SectionCard,
} from '@/components/ui/detail-page-shell';
import { fmtDate, fmtDateTime } from '@/lib/fmt-date';
import { CONTACT_SOURCE_LABELS, enumLabel } from '@/lib/enum-labels';

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

export default function ContactDetailPage() {
  const params = useParams<{ id: string }>();
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
  if (isLoading) return <SkeletonShell />;

  if (isError) {
    const message = (error as Error)?.message ?? 'Unknown error';
    const isNotFound = /not found/i.test(message);
    return (
      <DetailPageShell
        backHref="/customers"
        backLabel="Back to Customers"
        title={isNotFound ? 'Contact not found' : 'Failed to load contact'}
        logoMark={Users}
        mainSlot={
          <SectionCard title="Error">
            <p className="text-body text-muted-foreground">{message}</p>
          </SectionCard>
        }
        sideSlot={null}
      />
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
    <DetailPageShell
      backHref="/customers"
      backLabel="Back to Customers"
      title={displayName(contact)}
      logoMark={initials(contact)}
      subtitle={`Contact ID: ${contact.id}`}
      headerBadge={<StatusBadge kind="contact-lifecycle" value={contact.lifecycleStage} />}
      headerAction={
        <Link
          href={`/customers/${contact.id}/edit`}
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
              label="Email"
              value={
                contact.email ? (
                  <a
                    href={`mailto:${contact.email}`}
                    className="text-[var(--ds-violet-500)] hover:underline"
                  >
                    {contact.email}
                  </a>
                ) : (
                  '—'
                )
              }
            />
            <FieldRow
              label="Phone"
              value={
                contact.phone ? (
                  <a
                    href={`tel:${contact.phone}`}
                    className="text-[var(--ds-violet-500)] hover:underline"
                  >
                    {contact.phone}
                  </a>
                ) : (
                  '—'
                )
              }
            />
            <FieldRow label="Segment" value={contact.segment ?? '—'} />
            <FieldRow
              label="Data quality"
              value={
                <span className="inline-flex items-center gap-2">
                  <span className="tabular-nums">{contact.dataQualityScore.toFixed(0)}</span>
                  <span className="text-caption text-muted-foreground">/ 100</span>
                  <span className="inline-block h-1.5 w-16 overflow-hidden rounded bg-[var(--ds-surface-sunken)]">
                    <span
                      className="block h-full bg-[var(--ds-violet-500)]"
                      style={{
                        width: `${Math.max(0, Math.min(100, contact.dataQualityScore))}%`,
                      }}
                    />
                  </span>
                </span>
              }
            />
          </SectionCard>

          <SectionCard title="Lifecycle & source">
            <div className="flex flex-wrap items-center gap-3 text-body">
              <StatusBadge kind="contact-lifecycle" value={contact.lifecycleStage} />
              {contact.source ? (
                <span className="inline-flex items-center rounded-[var(--ds-radius-pill)] bg-[var(--ds-surface-sunken)] px-2.5 py-0.5 text-caption font-medium text-muted-foreground">
                  Source: {enumLabel(CONTACT_SOURCE_LABELS, contact.source)}
                </span>
              ) : (
                <span className="text-caption text-muted-foreground">No source recorded</span>
              )}
            </div>
          </SectionCard>

          <SectionCard title="Address">
            {addressEmpty ? (
              <p className="text-body text-muted-foreground">No address on file</p>
            ) : (
              <AddressBlock
                addressLine1={contact.addressLine1}
                addressLine2={contact.addressLine2}
                city={contact.city}
                region={contact.region}
                postalCode={contact.postalCode}
                country={contact.country}
                className="text-body text-foreground"
              />
            )}
          </SectionCard>

          {contact.customer ? (
            <SectionCard title="Customer status">
              <FieldRow label="Status" value={contact.customer.status} />
              <FieldRow
                label="MRR"
                value={<MoneyDisplay value={contact.customer.mrr} currency="USD" />}
              />
              <FieldRow
                label="LTV"
                value={<MoneyDisplay value={contact.customer.ltv} currency="USD" />}
              />
              <FieldRow
                label="Health"
                value={
                  <span className="inline-flex items-center gap-2">
                    <span className="tabular-nums">
                      {contact.customer.healthScore.toFixed(0)}
                    </span>
                    <span className="text-caption text-muted-foreground">/ 100</span>
                  </span>
                }
              />
              <FieldRow label="Plan" value={contact.customer.plan ?? '—'} />
              <FieldRow label="Customer since" value={fmtDate(contact.customer.since)} />
            </SectionCard>
          ) : null}

          <SectionCard title="Recent engagements" count={contact.engagements.length}>
            {contact.engagements.length === 0 ? (
              <p className="text-body text-muted-foreground">No recent engagements</p>
            ) : (
              <table className="w-full text-body">
                <thead>
                  <tr className="text-left text-caption uppercase text-muted-foreground">
                    <th className="pb-2 font-medium">Type</th>
                    <th className="pb-2 font-medium">Signal</th>
                    <th className="pb-2 font-medium">Channel</th>
                    <th className="pb-2 text-right font-medium">Occurred</th>
                  </tr>
                </thead>
                <tbody>
                  {contact.engagements.map((e) => (
                    <tr key={e.id} className="border-t border-border">
                      <td className="py-2 text-foreground">{e.engagementType}</td>
                      <td className="py-2">
                        <span
                          className={`inline-flex items-center rounded-[var(--ds-radius-pill)] px-2 py-0.5 text-caption font-medium ${signalClassChip(e.signalClass)}`}
                        >
                          {e.signalClass}
                        </span>
                      </td>
                      <td className="py-2 text-caption text-muted-foreground">
                        {e.channel ?? '—'}
                      </td>
                      <td className="py-2 text-right text-caption text-muted-foreground">
                        {fmtDateTime(e.occurredAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>

          <SectionCard title="Recent outcomes" count={contact.outcomes.length}>
            {contact.outcomes.length === 0 ? (
              <p className="text-body text-muted-foreground">No recent outcomes</p>
            ) : (
              <table className="w-full text-body">
                <thead>
                  <tr className="text-left text-caption uppercase text-muted-foreground">
                    <th className="pb-2 font-medium">Result</th>
                    <th className="pb-2 font-medium">Reason</th>
                    <th className="pb-2 font-medium">Objective</th>
                    <th className="pb-2 text-right font-medium">Recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {contact.outcomes.map((o) => (
                    <tr key={o.id} className="border-t border-border">
                      <td className="py-2 font-medium text-foreground">{o.result}</td>
                      <td className="py-2 text-caption text-muted-foreground">
                        {o.reasonCategory ?? '—'}
                      </td>
                      <td className="py-2 font-mono text-caption text-muted-foreground">
                        {o.objectiveId}
                      </td>
                      <td className="py-2 text-right text-caption text-muted-foreground">
                        {fmtDateTime(o.recordedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>

          <SectionCard title="Recent AI decisions" count={contact.decisions.length}>
            {contact.decisions.length === 0 ? (
              <p className="text-body text-muted-foreground">No recent decisions</p>
            ) : (
              <table className="w-full text-body">
                <thead>
                  <tr className="text-left text-caption uppercase text-muted-foreground">
                    <th className="pb-2 font-medium">Action</th>
                    <th className="pb-2 font-medium">Strategy</th>
                    <th className="pb-2 text-right font-medium">Confidence</th>
                    <th className="pb-2 text-right font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {contact.decisions.map((d) => (
                    <tr key={d.id} className="border-t border-border">
                      <td className="py-2 text-foreground">{d.actionType}</td>
                      <td className="py-2 text-caption text-muted-foreground">
                        {d.strategySelected}
                      </td>
                      <td className="py-2 text-right tabular-nums text-foreground">
                        {(d.confidence * 100).toFixed(0)}%
                      </td>
                      <td className="py-2 text-right text-caption text-muted-foreground">
                        {fmtDateTime(d.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>

          <SectionCard title="Recent escalations" count={contact.escalations.length}>
            {contact.escalations.length === 0 ? (
              <p className="text-body text-muted-foreground">No recent escalations</p>
            ) : (
              <table className="w-full text-body">
                <thead>
                  <tr className="text-left text-caption uppercase text-muted-foreground">
                    <th className="pb-2 font-medium">Trigger</th>
                    <th className="pb-2 font-medium">Reason</th>
                    <th className="pb-2 font-medium">Severity</th>
                    <th className="pb-2 font-medium">Status</th>
                    <th className="pb-2 text-right font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {contact.escalations.map((e) => (
                    <tr key={e.id} className="border-t border-border">
                      <td className="py-2 text-foreground">{e.triggerType}</td>
                      <td className="py-2 text-caption text-muted-foreground">
                        {e.triggerReason ?? '—'}
                      </td>
                      <td className="py-2 text-caption uppercase tracking-wide text-muted-foreground">
                        {e.severity}
                      </td>
                      <td className="py-2 text-caption text-foreground">{e.status}</td>
                      <td className="py-2 text-right text-caption text-muted-foreground">
                        {fmtDateTime(e.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>

          <SectionCard title="Raw data">
            <div className="space-y-4">
              <RawBlock label="externalIds" value={contact.externalIds} />
              <RawBlock label="customFields" value={contact.customFields} />
              <FieldRow label="Created" value={fmtDateTime(contact.createdAt)} />
              <FieldRow label="Updated" value={fmtDateTime(contact.updatedAt)} />
              {contact.deletedAt ? (
                <FieldRow label="Deleted" value={fmtDateTime(contact.deletedAt)} />
              ) : null}
            </div>
          </SectionCard>
        </div>
      }
      sideSlot={
        <div className="space-y-4">
          <SectionCard title="Company">
            {contact.company ? (
              <LinkedEntityRow
                href={`/companies/${contact.company.id}`}
                iconLabel={(contact.company.name[0] ?? 'C').toUpperCase()}
                name={contact.company.name}
                meta={contact.company.domain ?? undefined}
              />
            ) : contact.companyName ? (
              <div className="text-body">
                <span className="text-foreground">{contact.companyName}</span>
                <span className="ml-2 text-caption text-muted-foreground">(unlinked)</span>
              </div>
            ) : (
              <p className="text-body text-muted-foreground">No linked company</p>
            )}
          </SectionCard>

          <SectionCard title="Linked deals" count={contact.deals.length}>
            {contact.deals.length === 0 ? (
              <p className="text-body text-muted-foreground">No linked deals</p>
            ) : (
              <div>
                {contact.deals.map((d) => (
                  <LinkedEntityRow
                    key={d.id}
                    href={`/opportunities/${d.id}`}
                    iconLabel="$"
                    name={d.name}
                    meta={
                      <span className="inline-flex items-center gap-2">
                        <MoneyDisplay value={d.value} currency={d.currency} />
                        <StatusBadge kind="deal-status" value={d.status} />
                      </span>
                    }
                  />
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Linked orders" count={contact._count.orders}>
            {contact.orders.length === 0 ? (
              <p className="text-body text-muted-foreground">No linked orders</p>
            ) : (
              <div>
                {contact.orders.map((o) => (
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
