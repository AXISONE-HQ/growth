'use client';

/**
 * KAN-937 — Sub-cohort 3.2 Company CRUD form.
 *
 * Shared form for /companies/new (create) + /companies/[id]/edit (edit) routes.
 * Native form + useState + react-query useMutation, matching the convention
 * locked by KAN-934 (contact-form.tsx) and the rest of apps/web/src/app/settings.
 *
 * Scope: 30 user-editable fields across 5 cards. Required: name only.
 * Special UX:
 *   - "Same as billing" button on Card 4 copies billing → mailing
 *   - isTaxExempt boolean conditionally reveals taxExemptionCertificate field
 *   - annualRevenue uses DecimalInput (KAN-932 component, first user-facing use)
 *
 * Deferred from V1: ownerId (KAN-936), tags, customFields, externalIds,
 * aiContext — each needs its own UX in Sub-cohort 3.x.
 */
import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DecimalInput } from '@/components/ui/decimal-input';
import { AsyncSelect } from '@/components/ui/async-select';
import { EntityFormShell } from '@/components/forms/entity-form-shell';
import {
  companiesApi,
  usersApi,
  type CompanyDetail,
  type CompanyCreateInput,
  type UserListItem,
} from '@/lib/api';

const SIZE_OPTIONS = [
  { value: 'range_1_10', label: '1–10 employees' },
  { value: 'range_11_50', label: '11–50 employees' },
  { value: 'range_51_200', label: '51–200 employees' },
  { value: 'range_201_1000', label: '201–1,000 employees' },
  { value: 'range_1001_5000', label: '1,001–5,000 employees' },
  { value: 'range_5000_plus', label: '5,000+ employees' },
] as const;

const LIFECYCLE_OPTIONS = [
  { value: 'prospect', label: 'Prospect' },
  { value: 'customer', label: 'Customer' },
  { value: 'churned', label: 'Churned' },
  { value: 'partner', label: 'Partner' },
  { value: 'vendor', label: 'Vendor' },
] as const;

const TAX_ID_TYPE_OPTIONS = [
  { value: 'ein', label: 'EIN (US)' },
  { value: 'vat', label: 'VAT' },
  { value: 'gst', label: 'GST' },
  { value: 'hst', label: 'HST' },
  { value: 'qst', label: 'QST' },
  { value: 'abn', label: 'ABN (AU)' },
  { value: 'other', label: 'Other' },
] as const;

const LABEL_STYLE = { color: 'var(--ds-ink-secondary)' } as const;

export interface CompanyFormValues {
  // Card 1 — Core Info
  name: string;
  legalName: string;
  domain: string;
  website: string;
  industry: string;
  sizeRange: string;
  annualRevenue: string | null;
  description: string;
  lifecycleStage: string;
  // Card 2 — Contact Info
  phone: string;
  email: string;
  linkedinUrl: string;
  // Card 3 — Billing Address
  billingAddressLine1: string;
  billingAddressLine2: string;
  billingCity: string;
  billingRegion: string;
  billingPostalCode: string;
  billingCountry: string;
  // Card 4 — Mailing Address
  mailingAddressLine1: string;
  mailingAddressLine2: string;
  mailingCity: string;
  mailingRegion: string;
  mailingPostalCode: string;
  mailingCountry: string;
  // Card 5 — Tax & Compliance
  taxId: string;
  taxIdType: string;
  businessRegistrationNumber: string;
  incorporationJurisdiction: string;
  isTaxExempt: boolean;
  taxExemptionCertificate: string;
  // KAN-936 — optional FK to User (AsyncSelect picker in Card 1)
  ownerId: string | null;
}

const EMPTY_VALUES: CompanyFormValues = {
  name: '',
  legalName: '',
  domain: '',
  website: '',
  industry: '',
  sizeRange: '',
  annualRevenue: null,
  description: '',
  lifecycleStage: 'prospect',
  phone: '',
  email: '',
  linkedinUrl: '',
  billingAddressLine1: '',
  billingAddressLine2: '',
  billingCity: '',
  billingRegion: '',
  billingPostalCode: '',
  billingCountry: '',
  mailingAddressLine1: '',
  mailingAddressLine2: '',
  mailingCity: '',
  mailingRegion: '',
  mailingPostalCode: '',
  mailingCountry: '',
  taxId: '',
  taxIdType: '',
  businessRegistrationNumber: '',
  incorporationJurisdiction: '',
  isTaxExempt: false,
  taxExemptionCertificate: '',
  ownerId: null,
};

/** Map a server Company (nullable fields) to form values. */
export function companyToFormValues(c: CompanyDetail): CompanyFormValues {
  return {
    name: c.name ?? '',
    legalName: c.legalName ?? '',
    domain: c.domain ?? '',
    website: c.website ?? '',
    industry: c.industry ?? '',
    sizeRange: c.sizeRange ?? '',
    annualRevenue: c.annualRevenue,
    description: c.description ?? '',
    lifecycleStage: c.lifecycleStage ?? 'prospect',
    phone: c.phone ?? '',
    email: c.email ?? '',
    linkedinUrl: c.linkedinUrl ?? '',
    billingAddressLine1: c.billingAddressLine1 ?? '',
    billingAddressLine2: c.billingAddressLine2 ?? '',
    billingCity: c.billingCity ?? '',
    billingRegion: c.billingRegion ?? '',
    billingPostalCode: c.billingPostalCode ?? '',
    billingCountry: c.billingCountry ?? '',
    mailingAddressLine1: c.mailingAddressLine1 ?? '',
    mailingAddressLine2: c.mailingAddressLine2 ?? '',
    mailingCity: c.mailingCity ?? '',
    mailingRegion: c.mailingRegion ?? '',
    mailingPostalCode: c.mailingPostalCode ?? '',
    mailingCountry: c.mailingCountry ?? '',
    taxId: c.taxId ?? '',
    taxIdType: c.taxIdType ?? '',
    businessRegistrationNumber: c.businessRegistrationNumber ?? '',
    incorporationJurisdiction: c.incorporationJurisdiction ?? '',
    isTaxExempt: c.isTaxExempt,
    taxExemptionCertificate: c.taxExemptionCertificate ?? '',
    ownerId: c.ownerId,
  };
}

/** Convert form text values back to API input. Empty strings → null
 *  where the API column is nullable. Required: name. */
function formToCreateInput(v: CompanyFormValues): CompanyCreateInput {
  const nullable = (s: string): string | null => (s.trim() === '' ? null : s.trim());
  return {
    name: v.name.trim(),
    legalName: nullable(v.legalName),
    domain: nullable(v.domain),
    website: nullable(v.website),
    industry: nullable(v.industry),
    sizeRange: v.sizeRange || null,
    annualRevenue: v.annualRevenue,
    description: nullable(v.description),
    lifecycleStage: v.lifecycleStage || undefined,
    phone: nullable(v.phone),
    email: nullable(v.email),
    linkedinUrl: nullable(v.linkedinUrl),
    billingAddressLine1: nullable(v.billingAddressLine1),
    billingAddressLine2: nullable(v.billingAddressLine2),
    billingCity: nullable(v.billingCity),
    billingRegion: nullable(v.billingRegion),
    billingPostalCode: nullable(v.billingPostalCode),
    billingCountry: nullable(v.billingCountry),
    mailingAddressLine1: nullable(v.mailingAddressLine1),
    mailingAddressLine2: nullable(v.mailingAddressLine2),
    mailingCity: nullable(v.mailingCity),
    mailingRegion: nullable(v.mailingRegion),
    mailingPostalCode: nullable(v.mailingPostalCode),
    mailingCountry: nullable(v.mailingCountry),
    taxId: nullable(v.taxId),
    taxIdType: v.taxIdType || null,
    businessRegistrationNumber: nullable(v.businessRegistrationNumber),
    incorporationJurisdiction: nullable(v.incorporationJurisdiction),
    isTaxExempt: v.isTaxExempt,
    taxExemptionCertificate: v.isTaxExempt ? nullable(v.taxExemptionCertificate) : null,
    ownerId: v.ownerId,
  };
}

function shallowEqual(a: CompanyFormValues, b: CompanyFormValues): boolean {
  const keys = Object.keys(a) as Array<keyof CompanyFormValues>;
  return keys.every((k) => a[k] === b[k]);
}

function validateForm(v: CompanyFormValues): string[] {
  const errors: string[] = [];
  if (!v.name.trim()) {
    errors.push('Name is required.');
  }
  return errors;
}

export interface CompanyFormProps {
  mode: 'create' | 'edit';
  initialValues?: CompanyFormValues;
  companyId?: string;
  /** Pre-loaded owner label for edit mode (KAN-936). */
  initialOwnerLabel?: string;
}

export function CompanyForm({
  mode,
  initialValues,
  companyId,
  initialOwnerLabel,
}: CompanyFormProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const initial = initialValues ?? EMPTY_VALUES;
  const [values, setValues] = useState<CompanyFormValues>(initial);
  const [serverErrors, setServerErrors] = useState<string[]>([]);

  const isDirty = useMemo(() => !shallowEqual(values, initial), [values, initial]);

  const createMutation = useMutation<CompanyDetail, Error, CompanyFormValues>({
    mutationFn: (formValues) => companiesApi.create(formToCreateInput(formValues)),
    onSuccess: (saved) => {
      toast.success('Company created.');
      void queryClient.invalidateQueries({ queryKey: ['companies'] });
      router.push(`/companies/${saved.id}`);
    },
    onError: (err) => {
      setServerErrors([err.message || 'Create failed. Please try again.']);
    },
  });

  const updateMutation = useMutation<CompanyDetail, Error, { id: string; values: CompanyFormValues }>({
    mutationFn: ({ id, values: formValues }) =>
      companiesApi.update({ id, ...formToCreateInput(formValues) }),
    onSuccess: (saved) => {
      toast.success('Company saved.');
      void queryClient.invalidateQueries({ queryKey: ['companies'] });
      void queryClient.invalidateQueries({ queryKey: ['companies', 'get', saved.id] });
      router.push(`/companies/${saved.id}`);
    },
    onError: (err) => {
      setServerErrors([err.message || 'Save failed. Please try again.']);
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;

  const handleSave = () => {
    const clientErrors = validateForm(values);
    if (clientErrors.length > 0) {
      setServerErrors(clientErrors);
      return;
    }
    setServerErrors([]);
    if (mode === 'create') {
      createMutation.mutate(values);
    } else {
      if (!companyId) return;
      updateMutation.mutate({ id: companyId, values });
    }
  };

  const copyBillingToMailing = () => {
    setValues({
      ...values,
      mailingAddressLine1: values.billingAddressLine1,
      mailingAddressLine2: values.billingAddressLine2,
      mailingCity: values.billingCity,
      mailingRegion: values.billingRegion,
      mailingPostalCode: values.billingPostalCode,
      mailingCountry: values.billingCountry,
    });
  };

  return (
    <EntityFormShell
      title={mode === 'create' ? 'New company' : 'Edit company'}
      breadcrumb={[
        { label: 'Companies', href: '/companies' },
        ...(mode === 'edit' && companyId
          ? [{ label: 'Edit', href: `/companies/${companyId}/edit` }]
          : [{ label: 'New', href: '/companies/new' }]),
      ]}
      mode={mode}
      isPending={isPending}
      isDirty={isDirty}
      onSave={handleSave}
      errors={serverErrors.length > 0 ? serverErrors : undefined}
    >
      {/* Card 1 — Core Info */}
      <Card>
        <CardHeader>
          <CardTitle>Core Info</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <Label htmlFor="name" style={LABEL_STYLE}>
              Name <span style={{ color: 'var(--ds-danger-text)' }}>*</span>
            </Label>
            <Input
              id="name"
              value={values.name}
              onChange={(e) => setValues({ ...values, name: e.target.value })}
              onBlur={() => {
                if (!values.name.trim()) {
                  setServerErrors(validateForm(values));
                }
              }}
              required
            />
          </div>
          <div className="col-span-2">
            <Label htmlFor="legalName" style={LABEL_STYLE}>Legal name</Label>
            <Input
              id="legalName"
              value={values.legalName}
              onChange={(e) => setValues({ ...values, legalName: e.target.value })}
              placeholder="Registered business name (if different from display name)"
            />
          </div>
          <div>
            <Label htmlFor="domain" style={LABEL_STYLE}>Domain</Label>
            <Input
              id="domain"
              value={values.domain}
              onChange={(e) => setValues({ ...values, domain: e.target.value })}
              placeholder="acme.com"
            />
          </div>
          <div>
            <Label htmlFor="website" style={LABEL_STYLE}>Website</Label>
            <Input
              id="website"
              type="url"
              value={values.website}
              onChange={(e) => setValues({ ...values, website: e.target.value })}
              placeholder="https://acme.com"
            />
          </div>
          <div>
            <Label htmlFor="industry" style={LABEL_STYLE}>Industry</Label>
            <Input
              id="industry"
              value={values.industry}
              onChange={(e) => setValues({ ...values, industry: e.target.value })}
              placeholder="e.g., SaaS, Manufacturing, Retail"
            />
          </div>
          <div>
            <Label htmlFor="sizeRange" style={LABEL_STYLE}>Company size</Label>
            <Select
              value={values.sizeRange || '__none'}
              onValueChange={(v) => setValues({ ...values, sizeRange: v === '__none' ? '' : v })}
            >
              <SelectTrigger id="sizeRange">
                <SelectValue placeholder="(unspecified)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">(unspecified)</SelectItem>
                {SIZE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="annualRevenue" style={LABEL_STYLE}>Annual revenue</Label>
            <DecimalInput
              id="annualRevenue"
              value={values.annualRevenue}
              onChange={(v) => setValues({ ...values, annualRevenue: v })}
              currency="USD"
              placeholder="0.00"
            />
          </div>
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
          <div className="col-span-2">
            <Label htmlFor="description" style={LABEL_STYLE}>Description</Label>
            <Textarea
              id="description"
              value={values.description}
              onChange={(e) => setValues({ ...values, description: e.target.value })}
              rows={3}
              placeholder="What this company does, who they are…"
            />
          </div>
          <div className="col-span-2">
            {/* KAN-936 — Owner picker (optional FK to User; clearable). */}
            <Label style={LABEL_STYLE}>Owner</Label>
            <AsyncSelect<UserListItem>
              fetchOptions={async (search) => {
                const result = await usersApi.list({ search: search || undefined, limit: 50 });
                return result.items;
              }}
              getOptionLabel={(u) => u.name ? `${u.name} <${u.email}>` : u.email}
              getOptionValue={(u) => u.id}
              value={values.ownerId}
              onChange={(id) => setValues({ ...values, ownerId: id })}
              placeholder="Search users…"
              selectedLabel={initialOwnerLabel}
            />
          </div>
        </CardContent>
      </Card>

      {/* Card 2 — Contact Info */}
      <Card>
        <CardHeader>
          <CardTitle>Contact Info</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
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
            <Label htmlFor="email" style={LABEL_STYLE}>Email</Label>
            <Input
              id="email"
              type="email"
              value={values.email}
              onChange={(e) => setValues({ ...values, email: e.target.value })}
              placeholder="contact@company.com"
            />
          </div>
          <div className="col-span-2">
            <Label htmlFor="linkedinUrl" style={LABEL_STYLE}>LinkedIn URL</Label>
            <Input
              id="linkedinUrl"
              type="url"
              value={values.linkedinUrl}
              onChange={(e) => setValues({ ...values, linkedinUrl: e.target.value })}
              placeholder="https://linkedin.com/company/…"
            />
          </div>
        </CardContent>
      </Card>

      {/* Card 3 — Billing Address */}
      <Card>
        <CardHeader>
          <CardTitle>Billing Address</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <Label htmlFor="billingAddressLine1" style={LABEL_STYLE}>Address line 1</Label>
            <Input
              id="billingAddressLine1"
              value={values.billingAddressLine1}
              onChange={(e) => setValues({ ...values, billingAddressLine1: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <Label htmlFor="billingAddressLine2" style={LABEL_STYLE}>Address line 2</Label>
            <Input
              id="billingAddressLine2"
              value={values.billingAddressLine2}
              onChange={(e) => setValues({ ...values, billingAddressLine2: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="billingCity" style={LABEL_STYLE}>City</Label>
            <Input
              id="billingCity"
              value={values.billingCity}
              onChange={(e) => setValues({ ...values, billingCity: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="billingRegion" style={LABEL_STYLE}>Region / state</Label>
            <Input
              id="billingRegion"
              value={values.billingRegion}
              onChange={(e) => setValues({ ...values, billingRegion: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="billingPostalCode" style={LABEL_STYLE}>Postal code</Label>
            <Input
              id="billingPostalCode"
              value={values.billingPostalCode}
              onChange={(e) => setValues({ ...values, billingPostalCode: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="billingCountry" style={LABEL_STYLE}>Country (ISO alpha-2)</Label>
            <Input
              id="billingCountry"
              maxLength={2}
              value={values.billingCountry}
              onChange={(e) =>
                setValues({ ...values, billingCountry: e.target.value.toUpperCase() })
              }
              placeholder="US"
            />
          </div>
        </CardContent>
      </Card>

      {/* Card 4 — Mailing Address */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Mailing Address</CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={copyBillingToMailing}
            >
              Same as billing
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <Label htmlFor="mailingAddressLine1" style={LABEL_STYLE}>Address line 1</Label>
            <Input
              id="mailingAddressLine1"
              value={values.mailingAddressLine1}
              onChange={(e) => setValues({ ...values, mailingAddressLine1: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <Label htmlFor="mailingAddressLine2" style={LABEL_STYLE}>Address line 2</Label>
            <Input
              id="mailingAddressLine2"
              value={values.mailingAddressLine2}
              onChange={(e) => setValues({ ...values, mailingAddressLine2: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="mailingCity" style={LABEL_STYLE}>City</Label>
            <Input
              id="mailingCity"
              value={values.mailingCity}
              onChange={(e) => setValues({ ...values, mailingCity: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="mailingRegion" style={LABEL_STYLE}>Region / state</Label>
            <Input
              id="mailingRegion"
              value={values.mailingRegion}
              onChange={(e) => setValues({ ...values, mailingRegion: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="mailingPostalCode" style={LABEL_STYLE}>Postal code</Label>
            <Input
              id="mailingPostalCode"
              value={values.mailingPostalCode}
              onChange={(e) => setValues({ ...values, mailingPostalCode: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="mailingCountry" style={LABEL_STYLE}>Country (ISO alpha-2)</Label>
            <Input
              id="mailingCountry"
              maxLength={2}
              value={values.mailingCountry}
              onChange={(e) =>
                setValues({ ...values, mailingCountry: e.target.value.toUpperCase() })
              }
              placeholder="US"
            />
          </div>
        </CardContent>
      </Card>

      {/* Card 5 — Tax & Compliance */}
      <Card>
        <CardHeader>
          <CardTitle>Tax &amp; Compliance</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="taxId" style={LABEL_STYLE}>Tax ID</Label>
            <Input
              id="taxId"
              value={values.taxId}
              onChange={(e) => setValues({ ...values, taxId: e.target.value })}
              placeholder="e.g., 12-3456789"
            />
          </div>
          <div>
            <Label htmlFor="taxIdType" style={LABEL_STYLE}>Tax ID type</Label>
            <Select
              value={values.taxIdType || '__none'}
              onValueChange={(v) =>
                setValues({ ...values, taxIdType: v === '__none' ? '' : v })
              }
            >
              <SelectTrigger id="taxIdType">
                <SelectValue placeholder="(unspecified)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">(unspecified)</SelectItem>
                {TAX_ID_TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="businessRegistrationNumber" style={LABEL_STYLE}>
              Business registration #
            </Label>
            <Input
              id="businessRegistrationNumber"
              value={values.businessRegistrationNumber}
              onChange={(e) =>
                setValues({ ...values, businessRegistrationNumber: e.target.value })
              }
            />
          </div>
          <div>
            <Label htmlFor="incorporationJurisdiction" style={LABEL_STYLE}>
              Incorporation jurisdiction
            </Label>
            <Input
              id="incorporationJurisdiction"
              value={values.incorporationJurisdiction}
              onChange={(e) =>
                setValues({ ...values, incorporationJurisdiction: e.target.value })
              }
              placeholder="e.g., Delaware, Singapore"
            />
          </div>
          <div className="col-span-2 flex items-center gap-3">
            <Switch
              id="isTaxExempt"
              checked={values.isTaxExempt}
              onCheckedChange={(checked) =>
                setValues({ ...values, isTaxExempt: checked })
              }
            />
            <Label htmlFor="isTaxExempt" style={LABEL_STYLE}>
              Tax-exempt
            </Label>
          </div>
          {values.isTaxExempt && (
            <div className="col-span-2">
              <Label htmlFor="taxExemptionCertificate" style={LABEL_STYLE}>
                Tax exemption certificate
              </Label>
              <Input
                id="taxExemptionCertificate"
                value={values.taxExemptionCertificate}
                onChange={(e) =>
                  setValues({ ...values, taxExemptionCertificate: e.target.value })
                }
                placeholder="Certificate number or reference"
              />
            </div>
          )}
        </CardContent>
      </Card>
    </EntityFormShell>
  );
}
