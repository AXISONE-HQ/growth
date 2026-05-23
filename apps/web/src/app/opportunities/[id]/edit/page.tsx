'use client';

/**
 * KAN-938 — Sub-cohort 3.3 Edit Opportunity (Deal) route.
 */
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import {
  OpportunityForm,
  dealToFormValues,
} from '@/components/opportunities/opportunity-form';
import { dealsApi, type DealDetail } from '@/lib/api';

function formatContactLabel(c: DealDetail['contact']): string {
  const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim();
  return name ? `${name}${c.email ? ` <${c.email}>` : ''}` : c.email ?? c.id;
}

export default function EditOpportunityPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const { data: deal, isLoading, isError, error } = useQuery<DealDetail>({
    queryKey: ['deals', 'get', id],
    queryFn: () => dealsApi.get(id as string),
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
          {error instanceof Error ? error.message : 'Failed to load deal'}
        </p>
      </div>
    );
  }
  if (!deal) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <p className="text-sm">Lead not found.</p>
      </div>
    );
  }

  return (
    <OpportunityForm
      mode="edit"
      dealId={id}
      initialValues={dealToFormValues(deal)}
      initialContactLabel={formatContactLabel(deal.contact)}
      initialCompanyLabel={deal.company?.name}
      initialOwnerLabel={deal.owner ? (deal.owner.name ? `${deal.owner.name} <${deal.owner.email}>` : deal.owner.email) : undefined}
    />
  );
}
