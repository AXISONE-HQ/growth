'use client';

/**
 * KAN-937 — Sub-cohort 3.2 New Company route.
 */
import { CompanyForm } from '@/components/companies/company-form';

export default function NewCompanyPage() {
  return <CompanyForm mode="create" />;
}
