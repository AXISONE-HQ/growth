'use client';

/**
 * KAN-884 — /companies/[id] detail page (read-only).
 * KAN-989 Phase C.5 — converged onto shared DetailPageShell + FieldRow +
 * LinkedEntityRow + SectionCard primitives. Every section + field
 * preserved. TZ-safe dates via @/lib/fmt-date. Cross-links navigate to
 * /customers/[id], /opportunities/[id], /orders/[id].
 *
 * Layout:
 *   - Header: name + StatusBadge (lifecycle) + Edit, "Back to Companies"
 *   - Main slot (1.4fr): Company info + Description + Billing/Mailing
 *     addresses + Tax & compliance
 *   - Side slot (1fr): Linked contacts / deals / orders
 */

import { useQuery } from '@tanstack/react-query';
import { Building2, Pencil } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { companiesApi } from '@/lib/api';
import { AddressBlock, isAddressEmpty } from '@/components/ui/address-block';
import { MoneyDisplay } from '@/components/ui/money-display';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  DetailPageShell,
  FieldRow,
  LinkedEntityRow,
  SectionCard,
} from '@/components/ui/detail-page-shell';
import {
  COMPANY_SIZE_LABELS,
  TAX_ID_TYPE_LABELS,
  enumLabel,
} from '@/lib/enum-labels';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const i = (parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '');
  return i.toUpperCase() || 'CO';
}

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
  if (isLoading) return <SkeletonShell />;

  if (isError) {
    const message = (error as Error)?.message ?? 'Unknown error';
    const isNotFound = /not found/i.test(message);
    return (
      <DetailPageShell
        backHref="/companies"
        backLabel="Back to Companies"
        title={isNotFound ? 'Company not found' : 'Failed to load company'}
        logoMark={Building2}
        mainSlot={
          <SectionCard title="Error">
            <p className="text-body text-muted-foreground">{message}</p>
          </SectionCard>
        }
        sideSlot={null}
      />
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
  const showTax = !!(company.taxId || company.businessRegistrationNumber || company.isTaxExempt);

  return (
    <DetailPageShell
      backHref="/companies"
      backLabel="Back to Companies"
      title={company.name}
      logoMark={initials(company.name)}
      subtitle={
        company.legalName && company.legalName !== company.name
          ? company.legalName
          : undefined
      }
      headerBadge={<StatusBadge kind="company-lifecycle" value={company.lifecycleStage} />}
      headerAction={
        <Link
          href={`/companies/${company.id}/edit`}
          className="inline-flex items-center gap-1.5 rounded-[var(--ds-radius-pill)] border border-border bg-card px-3 py-1.5 text-label text-foreground transition-colors hover:bg-[var(--ds-surface-sunken)]"
        >
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Link>
      }
      mainSlot={
        <div className="space-y-4">
          <SectionCard title="Company info">
            <FieldRow label="Domain" value={company.domain ?? '—'} />
            <FieldRow
              label="Website"
              value={
                company.website ? (
                  <a
                    href={company.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--ds-violet-500)] hover:underline"
                  >
                    {company.website}
                  </a>
                ) : (
                  '—'
                )
              }
            />
            <FieldRow label="Industry" value={company.industry ?? '—'} />
            <FieldRow
              label="Size"
              value={enumLabel(COMPANY_SIZE_LABELS, company.sizeRange) ?? '—'}
            />
            <FieldRow label="Phone" value={company.phone ?? '—'} />
            <FieldRow
              label="Email"
              value={
                company.email ? (
                  <a
                    href={`mailto:${company.email}`}
                    className="text-[var(--ds-violet-500)] hover:underline"
                  >
                    {company.email}
                  </a>
                ) : (
                  '—'
                )
              }
            />
            <FieldRow
              label="Annual revenue"
              value={
                company.annualRevenue ? (
                  <MoneyDisplay value={company.annualRevenue} currency="USD" />
                ) : (
                  '—'
                )
              }
            />
          </SectionCard>

          {company.description ? (
            <SectionCard title="Description">
              <p className="text-body text-foreground">{company.description}</p>
            </SectionCard>
          ) : null}

          <SectionCard title="Billing address">
            {billingEmpty ? (
              <p className="text-body text-muted-foreground">No billing address on file</p>
            ) : (
              <AddressBlock {...billingAddr} className="text-body text-foreground" />
            )}
          </SectionCard>

          <SectionCard title="Mailing address">
            {mailingEmpty && !billingEmpty ? (
              <p className="text-body text-muted-foreground">Same as billing</p>
            ) : mailingEmpty ? (
              <p className="text-body text-muted-foreground">No mailing address on file</p>
            ) : (
              <AddressBlock {...mailingAddr} className="text-body text-foreground" />
            )}
          </SectionCard>

          <SectionCard title="Tax & compliance">
            {!showTax ? (
              <p className="text-body text-muted-foreground">No tax info on file</p>
            ) : (
              <>
                <FieldRow
                  label="Tax ID"
                  value={
                    company.taxId
                      ? `${company.taxId}${
                          company.taxIdType
                            ? ` (${enumLabel(TAX_ID_TYPE_LABELS, company.taxIdType)})`
                            : ''
                        }`
                      : '—'
                  }
                />
                <FieldRow
                  label="Registration #"
                  value={company.businessRegistrationNumber ?? '—'}
                />
                <FieldRow
                  label="Incorporation"
                  value={company.incorporationJurisdiction ?? '—'}
                />
                {company.isTaxExempt ? (
                  <FieldRow
                    label="Tax exempt"
                    value={
                      <span className="inline-flex items-center gap-2">
                        <span className="rounded-[var(--ds-radius-pill)] bg-[var(--ds-emerald-100)] px-2 py-0.5 text-caption font-medium text-[var(--ds-emerald-700)]">
                          Exempt
                        </span>
                        {company.taxExemptionCertificate ? (
                          <span className="text-caption text-muted-foreground">
                            Cert: {company.taxExemptionCertificate}
                          </span>
                        ) : null}
                      </span>
                    }
                  />
                ) : null}
              </>
            )}
          </SectionCard>
        </div>
      }
      sideSlot={
        <div className="space-y-4">
          <SectionCard title="Linked contacts" count={company._count.contacts}>
            {company.contacts.length === 0 ? (
              <p className="text-body text-muted-foreground">No linked contacts</p>
            ) : (
              <div>
                {company.contacts.map((c) => {
                  const name =
                    [c.firstName, c.lastName].filter(Boolean).join(' ').trim() ||
                    c.email ||
                    'Unknown';
                  return (
                    <LinkedEntityRow
                      key={c.id}
                      href={`/customers/${c.id}`}
                      iconLabel={(c.firstName?.[0] ?? c.email?.[0] ?? '?').toUpperCase()}
                      name={name}
                      meta={c.email ?? undefined}
                    />
                  );
                })}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Linked deals" count={company._count.deals}>
            {company.deals.length === 0 ? (
              <p className="text-body text-muted-foreground">No linked deals</p>
            ) : (
              <div>
                {company.deals.map((d) => (
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

          <SectionCard title="Linked orders" count={company._count.orders}>
            {company.orders.length === 0 ? (
              <p className="text-body text-muted-foreground">No linked orders</p>
            ) : (
              <div>
                {company.orders.map((o) => (
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
