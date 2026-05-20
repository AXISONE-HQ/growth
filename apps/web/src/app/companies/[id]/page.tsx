'use client';

/**
 * KAN-884 — /companies/[id] detail page (read-only).
 *
 * Mirrors the DS v1 inline-token pattern from /settings/account/identity.
 * 7 cards (info / billing / mailing / tax / contacts / deals / orders).
 * Cards are unconditionally rendered for V1 — empty sections show a "—"
 * placeholder rather than hiding, so the page rhythm stays consistent
 * across companies with varying levels of completeness. Exception: the
 * mailing card collapses to a "Same as billing" hint when mailing fields
 * are all blank AND billing is populated (saves vertical space for the
 * common B2C case where there's only one address).
 *
 * pageTitle map in layout.tsx falls through to "Dashboard" for [id]
 * routes — known KAN-878 limitation. We set document.title on mount so
 * the browser tab is at least correct.
 */

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Building2, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { companiesApi } from '@/lib/api';
import { AddressBlock, isAddressEmpty } from '@/components/ui/address-block';
import { MoneyDisplay } from '@/components/ui/money-display';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  COMPANY_SIZE_LABELS,
  TAX_ID_TYPE_LABELS,
  enumLabel,
} from '@/lib/enum-labels';

const SECTION_HEADER_STYLE = { color: 'var(--ds-ink-primary)' } as const;
const MUTED_STYLE = { color: 'var(--ds-ink-tertiary)' } as const;
const LABEL_STYLE = { color: 'var(--ds-ink-secondary)' } as const;

export default function CompanyDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const { data: company, isLoading, isError, error } = useQuery({
    queryKey: ['companies', 'get', id],
    queryFn: () => companiesApi.get(id as string),
    enabled: !!id,
  });

  useEffect(() => {
    if (company) document.title = `${company.name} · Companies`;
  }, [company]);

  if (!id) return null;

  if (isLoading) return <SkeletonCards />;

  if (isError) {
    const message = (error as Error)?.message ?? 'Unknown error';
    const isNotFound = /not found/i.test(message);
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link
          href="/companies"
          className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 mb-4"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Companies
        </Link>
        <div className="bg-white border rounded-lg p-12 text-center">
          <Building2 className="w-8 h-8 mx-auto text-gray-300" />
          <h2 className="text-lg font-semibold mt-3" style={SECTION_HEADER_STYLE}>
            {isNotFound ? 'Company not found' : 'Failed to load company'}
          </h2>
          <p className="text-sm mt-1" style={MUTED_STYLE}>{message}</p>
        </div>
      </div>
    );
  }

  if (!company) return null;

  const billingAddr = {
    addressLine1: company.billingAddressLine1,
    addressLine2: company.billingAddressLine2,
    city: company.billingCity,
    region: company.billingRegion,
    postalCode: company.billingPostalCode,
    country: company.billingCountry,
  };
  const mailingAddr = {
    addressLine1: company.mailingAddressLine1,
    addressLine2: company.mailingAddressLine2,
    city: company.mailingCity,
    region: company.mailingRegion,
    postalCode: company.mailingPostalCode,
    country: company.mailingCountry,
  };
  const billingEmpty = isAddressEmpty(billingAddr);
  const mailingEmpty = isAddressEmpty(mailingAddr);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-4">
      <Link
        href="/companies"
        className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Companies
      </Link>

      {/* Card 1 — Company info */}
      <section className="bg-white border rounded-lg p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold" style={SECTION_HEADER_STYLE}>{company.name}</h1>
            {company.legalName && company.legalName !== company.name ? (
              <p className="text-sm mt-0.5" style={MUTED_STYLE}>{company.legalName}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge kind="company-lifecycle" value={company.lifecycleStage} />
            {/* KAN-937 — Sub-cohort 3.2 Edit affordance */}
            <Link
              href={`/companies/${company.id}/edit`}
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
          <Field label="Domain" value={company.domain} />
          <Field label="Website" value={company.website} link={company.website} />
          <Field label="Industry" value={company.industry} />
          <Field label="Size" value={enumLabel(COMPANY_SIZE_LABELS, company.sizeRange)} />
          <Field label="Phone" value={company.phone} />
          <Field label="Email" value={company.email} link={company.email ? `mailto:${company.email}` : null} />
          <Field
            label="Annual revenue"
            value={
              company.annualRevenue ? (
                <MoneyDisplay value={company.annualRevenue} currency="USD" />
              ) : null
            }
          />
        </div>
        {company.description ? (
          <p className="mt-4 text-sm" style={LABEL_STYLE}>{company.description}</p>
        ) : null}
      </section>

      {/* Card 2 — Billing address */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Billing address</h2>
        {billingEmpty ? (
          <p className="text-sm" style={MUTED_STYLE}>No billing address on file</p>
        ) : (
          <AddressBlock {...billingAddr} className="text-sm" />
        )}
      </section>

      {/* Card 3 — Mailing address */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Mailing address</h2>
        {mailingEmpty && !billingEmpty ? (
          <p className="text-sm" style={MUTED_STYLE}>Same as billing</p>
        ) : mailingEmpty ? (
          <p className="text-sm" style={MUTED_STYLE}>No mailing address on file</p>
        ) : (
          <AddressBlock {...mailingAddr} className="text-sm" />
        )}
      </section>

      {/* Card 4 — Tax & compliance */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>Tax & compliance</h2>
        {!company.taxId && !company.businessRegistrationNumber && !company.isTaxExempt ? (
          <p className="text-sm" style={MUTED_STYLE}>No tax info on file</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
            <Field
              label="Tax ID"
              value={
                company.taxId
                  ? `${company.taxId}${company.taxIdType ? ` (${enumLabel(TAX_ID_TYPE_LABELS, company.taxIdType)})` : ''}`
                  : null
              }
            />
            <Field label="Registration #" value={company.businessRegistrationNumber} />
            <Field label="Incorporation" value={company.incorporationJurisdiction} />
            {company.isTaxExempt ? (
              <Field
                label="Tax exempt"
                value={
                  <span className="inline-flex items-center gap-2">
                    <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                      Exempt
                    </span>
                    {company.taxExemptionCertificate ? (
                      <span style={MUTED_STYLE} className="text-xs">
                        Cert: {company.taxExemptionCertificate}
                      </span>
                    ) : null}
                  </span>
                }
              />
            ) : null}
          </div>
        )}
      </section>

      {/* Card 5 — Linked Contacts */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Linked contacts{' '}
          <span style={MUTED_STYLE} className="font-normal">
            ({company._count.contacts})
          </span>
        </h2>
        {company.contacts.length === 0 ? (
          <p className="text-sm" style={MUTED_STYLE}>No linked contacts</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {company.contacts.map((c) => {
              const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.email || 'Unknown';
              return (
                <li key={c.id} className="py-2 text-sm">
                  <Link href={`/customers/${c.id}`} className="flex items-center justify-between hover:bg-gray-50 -mx-2 px-2 py-1 rounded">
                    <div>
                      <span className="font-medium">{name}</span>
                      {c.email ? (
                        <span style={MUTED_STYLE} className="ml-2 text-xs">{c.email}</span>
                      ) : null}
                    </div>
                    <StatusBadge kind="contact-lifecycle" value={c.lifecycleStage} />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Card 6 — Linked Deals */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Linked deals{' '}
          <span style={MUTED_STYLE} className="font-normal">
            ({company._count.deals})
          </span>
        </h2>
        {company.deals.length === 0 ? (
          <p className="text-sm" style={MUTED_STYLE}>No linked deals</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {company.deals.map((d) => (
              <li key={d.id} className="py-2 text-sm">
                <Link href={`/opportunities/${d.id}`} className="flex items-center justify-between hover:bg-gray-50 -mx-2 px-2 py-1 rounded">
                  <span className="font-medium">{d.name}</span>
                  <div className="flex items-center gap-3">
                    <MoneyDisplay value={d.value} currency={d.currency} className="tabular-nums" />
                    <StatusBadge kind="deal-status" value={d.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Card 7 — Linked Orders */}
      <section className="bg-white border rounded-lg p-6">
        <h2 className="text-sm font-semibold mb-3" style={SECTION_HEADER_STYLE}>
          Linked orders{' '}
          <span style={MUTED_STYLE} className="font-normal">
            ({company._count.orders})
          </span>
        </h2>
        {company.orders.length === 0 ? (
          <p className="text-sm" style={MUTED_STYLE}>No linked orders</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {company.orders.map((o) => (
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
          <a
            href={link}
            target={link.startsWith('mailto:') ? undefined : '_blank'}
            rel="noopener noreferrer"
            className="text-indigo-600 hover:underline"
          >
            {display}
          </a>
        ) : (
          <span style={LABEL_STYLE}>{display}</span>
        )}
      </div>
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
