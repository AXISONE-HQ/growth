'use client';

/**
 * KAN-937 — Sub-cohort 3.2 Edit Company route.
 */
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import {
  CompanyForm,
  companyToFormValues,
} from '@/components/companies/company-form';
import { companiesApi, type CompanyDetail } from '@/lib/api';

export default function EditCompanyPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const { data: company, isLoading, isError, error } = useQuery<CompanyDetail>({
    queryKey: ['companies', 'get', id],
    queryFn: () => companiesApi.get(id as string),
    enabled: !!id,
  });

  if (!id) return null;
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <p className="text-sm" style={{ color: 'var(--ds-danger-text)' }}>
          {error instanceof Error ? error.message : 'Failed to load company'}
        </p>
      </div>
    );
  }
  if (!company) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <p className="text-sm">Company not found.</p>
      </div>
    );
  }

  return (
    <CompanyForm
      mode="edit"
      companyId={id}
      initialValues={companyToFormValues(company)}
      initialOwnerLabel={
        company.owner
          ? company.owner.name
            ? `${company.owner.name} <${company.owner.email}>`
            : company.owner.email
          : undefined
      }
    />
  );
}
