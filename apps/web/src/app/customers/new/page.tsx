'use client';

/**
 * KAN-934 — Cohort 3.1 New Customer route.
 *
 * Renders the ContactForm in 'create' mode. Standalone route per Q1 design
 * decision (separate routes for create vs edit, shared form component).
 */
import { ContactForm } from '@/components/contacts/contact-form';

export default function NewCustomerPage() {
  return <ContactForm mode="create" />;
}
