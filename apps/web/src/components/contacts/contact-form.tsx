'use client';

/**
 * KAN-934 — Cohort 3.1 Contact CRUD form.
 *
 * Shared form component for `/customers/new` (create) + `/customers/[id]/edit`
 * (edit) routes. Uses the native form + useState + react-query pattern
 * (matches `apps/web/src/app/settings/account/identity/page.tsx` convention
 * per KAN-932 Phase 1 form-library audit).
 *
 * Path β scope: full 14-field surface (email, phone, firstName, lastName,
 * segment, lifecycleStage, source, companyId, addressLine1, addressLine2,
 * city, region, postalCode, country). Card-grouped into 3 sections.
 *
 * Path B (KAN-931 design decision): Company picker is an AsyncSelect (the
 * first user-facing proof of KAN-932's AsyncSelect contract). Select-from-
 * existing only; inline "+ Create new Company" deferred to Sub-cohort 3.2.
 */
import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AsyncSelect } from '@/components/ui/async-select';
import { EntityFormShell } from '@/components/forms/entity-form-shell';
import {
  contactsApi,
  companiesApi,
  type ContactDetail,
  type ContactCreateInput,
  type CompanyListItem,
} from '@/lib/api';

const LIFECYCLE_OPTIONS = [
  { value: 'lead', label: 'Lead' },
  { value: 'mql', label: 'Marketing-qualified' },
  { value: 'sql', label: 'Sales-qualified' },
  { value: 'customer', label: 'Customer' },
  { value: 'lost', label: 'Lost' },
] as const;

const SOURCE_OPTIONS = [
  { value: 'email_inbox', label: 'Email inbox' },
  { value: 'web_form', label: 'Web form' },
  { value: 'meta_ad', label: 'Meta ad' },
  { value: 'manual', label: 'Manual entry' },
  { value: 'csv_import', label: 'CSV import' },
  { value: 'api', label: 'API' },
  { value: 'hubspot', label: 'HubSpot' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'shopify', label: 'Shopify' },
  { value: 'other', label: 'Other' },
] as const;

const LABEL_STYLE = { color: 'var(--ds-ink-secondary)' } as const;

export interface ContactFormValues {
  email: string;
  phone: string;
  firstName: string;
  lastName: string;
  companyId: string | null;
  lifecycleStage: string;
  source: string;
  segment: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

const EMPTY_VALUES: ContactFormValues = {
  email: '',
  phone: '',
  firstName: '',
  lastName: '',
  companyId: null,
  lifecycleStage: 'lead',
  source: '',
  segment: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
};

/** Map a server Contact (nullable fields) to ContactFormValues (text inputs
 *  need empty-string, not null). */
export function contactToFormValues(c: ContactDetail): ContactFormValues {
  return {
    email: c.email ?? '',
    phone: c.phone ?? '',
    firstName: c.firstName ?? '',
    lastName: c.lastName ?? '',
    companyId: c.companyId,
    lifecycleStage: c.lifecycleStage ?? 'lead',
    source: c.source ?? '',
    segment: c.segment ?? '',
    addressLine1: c.addressLine1 ?? '',
    addressLine2: c.addressLine2 ?? '',
    city: c.city ?? '',
    region: c.region ?? '',
    postalCode: c.postalCode ?? '',
    country: c.country ?? '',
  };
}

/** Convert form text values back to API input. Empty strings → null where
 *  the API column is nullable; keeps `email` as-is (it's required + validated). */
function formToCreateInput(v: ContactFormValues): ContactCreateInput {
  const nullable = (s: string): string | null => (s.trim() === '' ? null : s.trim());
  return {
    email: v.email.trim(),
    phone: nullable(v.phone),
    firstName: nullable(v.firstName),
    lastName: nullable(v.lastName),
    companyId: v.companyId,
    lifecycleStage: v.lifecycleStage || undefined,
    source: nullable(v.source),
    segment: nullable(v.segment),
    addressLine1: nullable(v.addressLine1),
    addressLine2: nullable(v.addressLine2),
    city: nullable(v.city),
    region: nullable(v.region),
    postalCode: nullable(v.postalCode),
    country: nullable(v.country),
  };
}

function shallowEqual(a: ContactFormValues, b: ContactFormValues): boolean {
  return (
    a.email === b.email &&
    a.phone === b.phone &&
    a.firstName === b.firstName &&
    a.lastName === b.lastName &&
    a.companyId === b.companyId &&
    a.lifecycleStage === b.lifecycleStage &&
    a.source === b.source &&
    a.segment === b.segment &&
    a.addressLine1 === b.addressLine1 &&
    a.addressLine2 === b.addressLine2 &&
    a.city === b.city &&
    a.region === b.region &&
    a.postalCode === b.postalCode &&
    a.country === b.country
  );
}

/** Inline validation — fires onBlur on the relevant fields.
 *  Returns array of error strings (empty if no errors). */
function validateForm(v: ContactFormValues): string[] {
  const errors: string[] = [];
  if (!v.email.trim()) {
    errors.push('Email is required.');
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) {
    errors.push('Email must be a valid address (e.g., name@example.com).');
  }
  return errors;
}

export interface ContactFormProps {
  mode: 'create' | 'edit';
  initialValues?: ContactFormValues;
  contactId?: string;
  /** Pre-loaded company label for edit mode (so the Company picker shows the
   *  name immediately, not the UUID, before AsyncSelect first loads). */
  initialCompanyLabel?: string;
}

export function ContactForm({
  mode,
  initialValues,
  contactId,
  initialCompanyLabel,
}: ContactFormProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const initial = initialValues ?? EMPTY_VALUES;
  const [values, setValues] = useState<ContactFormValues>(initial);
  const [serverErrors, setServerErrors] = useState<string[]>([]);

  const isDirty = useMemo(() => !shallowEqual(values, initial), [values, initial]);

  const createMutation = useMutation<ContactDetail, Error, ContactFormValues>({
    mutationFn: (formValues) => contactsApi.create(formToCreateInput(formValues)),
    onSuccess: (saved) => {
      toast.success('Contact created.');
      void queryClient.invalidateQueries({ queryKey: ['contacts'] });
      router.push(`/customers/${saved.id}`);
    },
    onError: (err) => {
      setServerErrors([err.message || 'Create failed. Please try again.']);
    },
  });

  const updateMutation = useMutation<ContactDetail, Error, { id: string; values: ContactFormValues }>({
    mutationFn: ({ id, values: formValues }) =>
      contactsApi.update({ id, ...formToCreateInput(formValues) }),
    onSuccess: (saved) => {
      toast.success('Contact saved.');
      void queryClient.invalidateQueries({ queryKey: ['contacts'] });
      void queryClient.invalidateQueries({ queryKey: ['contacts', 'get', saved.id] });
      router.push(`/customers/${saved.id}`);
    },
    onError: (err) => {
      setServerErrors([err.message || 'Save failed. Please try again.']);
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const handleSave = () => {
    // Client-side validation gate (server is source of truth; this is just
    // fast feedback for required-field + format issues).
    const clientErrors = validateForm(values);
    if (clientErrors.length > 0) {
      setServerErrors(clientErrors);
      return;
    }
    setServerErrors([]);
    if (mode === 'create') {
      createMutation.mutate(values);
    } else {
      if (!contactId) return;
      updateMutation.mutate({ id: contactId, values });
    }
  };

  const fetchCompanies = async (search: string): Promise<CompanyListItem[]> => {
    const result = await companiesApi.list({ search: search || undefined, limit: 50 });
    return result.items;
  };

  return (
    <EntityFormShell
      title={mode === 'create' ? 'New customer' : 'Edit customer'}
      breadcrumb={[
        { label: 'Customers', href: '/customers' },
        ...(mode === 'edit' && contactId
          ? [{ label: 'Edit', href: `/customers/${contactId}/edit` }]
          : [{ label: 'New', href: '/customers/new' }]),
      ]}
      mode={mode}
      isPending={isPending}
      isDirty={isDirty}
      onSave={handleSave}
      errors={serverErrors.length > 0 ? serverErrors : undefined}
    >
      {/* Card 1 — Identity */}
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <Label htmlFor="email" style={LABEL_STYLE}>
              Email <span style={{ color: 'var(--ds-danger-text)' }}>*</span>
            </Label>
            <Input
              id="email"
              type="email"
              value={values.email}
              onChange={(e) => setValues({ ...values, email: e.target.value })}
              onBlur={() => {
                if (values.email.trim()) {
                  setServerErrors(validateForm(values));
                }
              }}
              placeholder="name@example.com"
              required
            />
          </div>
          <div>
            <Label htmlFor="phone" style={LABEL_STYLE}>Phone</Label>
            <Input
              id="phone"
              type="tel"
              value={values.phone}
              onChange={(e) => setValues({ ...values, phone: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="firstName" style={LABEL_STYLE}>First name</Label>
            <Input
              id="firstName"
              value={values.firstName}
              onChange={(e) => setValues({ ...values, firstName: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="lastName" style={LABEL_STYLE}>Last name</Label>
            <Input
              id="lastName"
              value={values.lastName}
              onChange={(e) => setValues({ ...values, lastName: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <Label style={LABEL_STYLE}>Company</Label>
            <AsyncSelect<CompanyListItem>
              fetchOptions={fetchCompanies}
              getOptionLabel={(c) => c.name}
              getOptionValue={(c) => c.id}
              value={values.companyId}
              onChange={(id) => setValues({ ...values, companyId: id })}
              placeholder="Search companies…"
              selectedLabel={initialCompanyLabel}
            />
          </div>
        </CardContent>
      </Card>

      {/* Card 2 — Lifecycle */}
      <Card>
        <CardHeader>
          <CardTitle>Lifecycle</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="lifecycleStage" style={LABEL_STYLE}>Lifecycle stage</Label>
            <Select
              value={values.lifecycleStage}
              onValueChange={(v) => setValues({ ...values, lifecycleStage: v })}
            >
              <SelectTrigger id="lifecycleStage">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIFECYCLE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="source" style={LABEL_STYLE}>Source</Label>
            <Select
              value={values.source || '__none'}
              onValueChange={(v) => setValues({ ...values, source: v === '__none' ? '' : v })}
            >
              <SelectTrigger id="source">
                <SelectValue placeholder="(none)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">(none)</SelectItem>
                {SOURCE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2">
            <Label htmlFor="segment" style={LABEL_STYLE}>Segment</Label>
            <Input
              id="segment"
              value={values.segment}
              onChange={(e) => setValues({ ...values, segment: e.target.value })}
              placeholder="e.g., enterprise, smb, mid-market"
            />
          </div>
        </CardContent>
      </Card>

      {/* Card 3 — Address */}
      <Card>
        <CardHeader>
          <CardTitle>Address</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <Label htmlFor="addressLine1" style={LABEL_STYLE}>Address line 1</Label>
            <Input
              id="addressLine1"
              value={values.addressLine1}
              onChange={(e) => setValues({ ...values, addressLine1: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <Label htmlFor="addressLine2" style={LABEL_STYLE}>Address line 2</Label>
            <Input
              id="addressLine2"
              value={values.addressLine2}
              onChange={(e) => setValues({ ...values, addressLine2: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="city" style={LABEL_STYLE}>City</Label>
            <Input
              id="city"
              value={values.city}
              onChange={(e) => setValues({ ...values, city: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="region" style={LABEL_STYLE}>Region / state</Label>
            <Input
              id="region"
              value={values.region}
              onChange={(e) => setValues({ ...values, region: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="postalCode" style={LABEL_STYLE}>Postal code</Label>
            <Input
              id="postalCode"
              value={values.postalCode}
              onChange={(e) => setValues({ ...values, postalCode: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="country" style={LABEL_STYLE}>Country (ISO alpha-2)</Label>
            <Input
              id="country"
              maxLength={2}
              value={values.country}
              onChange={(e) => setValues({ ...values, country: e.target.value.toUpperCase() })}
              placeholder="CA"
            />
          </div>
        </CardContent>
      </Card>
    </EntityFormShell>
  );
}
