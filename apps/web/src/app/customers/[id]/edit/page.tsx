'use client';

/**
 * KAN-934 — Cohort 3.1 Edit Customer route.
 *
 * Renders the ContactForm in 'edit' mode with pre-populated values from
 * contacts.getById. Loading / error / not-found states handled inline.
 */
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import {
  ContactForm,
  contactToFormValues,
} from '@/components/contacts/contact-form';
import { contactsApi, type ContactDetail } from '@/lib/api';

export default function EditCustomerPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const { data: contact, isLoading, isError, error } = useQuery<ContactDetail>({
    queryKey: ['contacts', 'get', id],
    queryFn: () => contactsApi.getById(id as string),
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
          {error instanceof Error ? error.message : 'Failed to load contact'}
        </p>
      </div>
    );
  }
  if (!contact) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <p className="text-sm">Contact not found.</p>
      </div>
    );
  }

  return (
    <ContactForm
      mode="edit"
      contactId={id}
      initialValues={contactToFormValues(contact)}
      initialCompanyLabel={contact.company?.name}
    />
  );
}
