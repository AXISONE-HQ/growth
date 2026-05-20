'use client';

/**
 * KAN-945 — Sub-cohort 3.4 Order CRUD form.
 *
 * Shared form for /orders/new (create) + /orders/[id]/edit (edit).
 * Native <form> + useState + react-query useMutation — same convention as
 * KAN-934 (Contact), KAN-937 (Company), KAN-938 (Deal).
 *
 * Scope: 22 user-editable fields across 5 cards.
 *   Card 1 — Core Order: orderNumber (req, read-only on edit per Q8), status, source
 *   Card 2 — Money: totalAmount, taxAmount, discountAmount, grandTotal, currency
 *           (Q7: computed-total hint next to grandTotal — display-only, NOT enforced)
 *   Card 3 — Payment & Timeline: paymentMethod, paymentProvider, providerOrderId,
 *           placedAt, paidAt, refundedAt, cancelledAt (4× native date with Q6 guards)
 *   Card 4 — Relationships: contactId (req AsyncSelect), companyId (opt), dealId (opt)
 *   Card 5 — Attribution & Notes: 2× attribution + 2× notes Textarea
 *
 * Q6.1 time-preservation (load-bearing): in update mode, date fields the user
 * did NOT change are OMITTED from the payload entirely. The backend's
 * partial-update pattern preserves the original DateTime byte-for-byte. This
 * prevents silently truncating webhook-sourced timestamps (e.g., placedAt
 * with time-of-day precision from a Stripe webhook) to UTC midnight.
 *
 * Q6.2 TZ-safe pre-population: date inputs are seeded via `iso.slice(0, 10)`
 * (UTC parts), NOT `new Date(iso).toLocaleDateString()`. Avoids the
 * off-by-one shift across the day boundary in TZs west of UTC.
 *
 * Q8 friendly duplicate-orderNumber error: backend wraps P2002 → BAD_REQUEST
 * with a user-readable message. Surfaced via the standard mutation toast +
 * inline banner UX (KAN-942 pattern).
 *
 * Deferred from V1 (per KAN-945 design): lineItems (Json — read-only on
 * detail page; full editor = Cohort 4), externalIds / customFields /
 * aiContext / providerData (Sub-cohort 3.x extension pattern).
 */
import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AsyncSelect } from '@/components/ui/async-select';
import { DecimalInput } from '@/components/ui/decimal-input';
import { EntityFormShell } from '@/components/forms/entity-form-shell';
import {
  ordersApi,
  contactsApi,
  companiesApi,
  dealsApi,
  type OrderDetail,
  type OrderCreateInput,
  type OrderUpdateInput,
  type ContactListItem,
  type CompanyListItem,
  type DealListItem,
} from '@/lib/api';

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'paid', label: 'Paid' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'partially_refunded', label: 'Partially refunded' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'failed', label: 'Failed' },
] as const;

const SOURCE_OPTIONS = [
  { value: 'manual', label: 'Manual entry' },
  { value: 'stripe_webhook', label: 'Stripe webhook' },
  { value: 'shopify_webhook', label: 'Shopify webhook' },
  { value: 'api', label: 'API' },
  { value: 'csv_import', label: 'CSV import' },
] as const;

const PAYMENT_METHOD_OPTIONS = [
  { value: 'card', label: 'Card' },
  { value: 'ach', label: 'ACH' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'manual', label: 'Manual' },
  { value: 'other', label: 'Other' },
] as const;

const PAYMENT_PROVIDER_OPTIONS = [
  { value: 'stripe', label: 'Stripe' },
  { value: 'square', label: 'Square' },
  { value: 'shopify', label: 'Shopify' },
  { value: 'manual', label: 'Manual' },
  { value: 'other', label: 'Other' },
] as const;

const LABEL_STYLE = { color: 'var(--ds-ink-secondary)' } as const;
const MUTED_STYLE = { color: 'var(--ds-ink-tertiary)' } as const;

export interface OrderFormValues {
  // Card 1 — Core
  orderNumber: string;
  status: string;
  source: string;
  // Card 2 — Money
  totalAmount: string | null;
  taxAmount: string | null;
  discountAmount: string | null;
  grandTotal: string | null;
  currency: string;
  // Card 3 — Payment & Timeline
  paymentMethod: string;
  paymentProvider: string;
  providerOrderId: string;
  placedAt: string;
  paidAt: string;
  refundedAt: string;
  cancelledAt: string;
  // Card 4 — Relationships
  contactId: string;
  companyId: string | null;
  dealId: string | null;
  // Card 5 — Attribution & Notes
  attributionFirstSource: string;
  attributionLastSource: string;
  customerNotes: string;
  internalNotes: string;
}

const EMPTY_VALUES: OrderFormValues = {
  orderNumber: '',
  status: 'pending',
  source: 'manual',
  totalAmount: null,
  taxAmount: null,
  discountAmount: null,
  grandTotal: null,
  currency: 'USD',
  paymentMethod: '',
  paymentProvider: '',
  providerOrderId: '',
  placedAt: '',
  paidAt: '',
  refundedAt: '',
  cancelledAt: '',
  contactId: '',
  companyId: null,
  dealId: null,
  attributionFirstSource: '',
  attributionLastSource: '',
  customerNotes: '',
  internalNotes: '',
};

/** Q6.2 — TZ-safe date pre-population. Extracts yyyy-mm-dd via UTC parts
 *  (`iso.slice(0, 10)`) instead of `new Date(iso).toLocaleDateString()`,
 *  which would shift the day in TZs west of UTC for timestamps near a
 *  day boundary. */
function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

/** Map a server Order (nullable fields) to form values. */
export function orderToFormValues(o: OrderDetail): OrderFormValues {
  return {
    orderNumber: o.orderNumber ?? '',
    status: o.status ?? 'pending',
    source: o.source ?? 'manual',
    totalAmount: o.totalAmount,
    taxAmount: o.taxAmount,
    discountAmount: o.discountAmount,
    grandTotal: o.grandTotal,
    currency: o.currency ?? 'USD',
    paymentMethod: o.paymentMethod ?? '',
    paymentProvider: o.paymentProvider ?? '',
    providerOrderId: o.providerOrderId ?? '',
    placedAt: toDateInputValue(o.placedAt),
    paidAt: toDateInputValue(o.paidAt),
    refundedAt: toDateInputValue(o.refundedAt),
    cancelledAt: toDateInputValue(o.cancelledAt),
    contactId: o.contactId,
    companyId: o.companyId,
    dealId: o.dealId,
    attributionFirstSource: o.attributionFirstSource ?? '',
    attributionLastSource: o.attributionLastSource ?? '',
    customerNotes: o.customerNotes ?? '',
    internalNotes: o.internalNotes ?? '',
  };
}

/** Convert form values → create input. Send all non-empty fields. */
function formToCreateInput(v: OrderFormValues): OrderCreateInput {
  const nullable = (s: string): string | null => (s.trim() === '' ? null : s.trim());
  return {
    orderNumber: v.orderNumber.trim(),
    status: v.status || undefined,
    source: v.source || undefined,
    totalAmount: v.totalAmount ?? undefined,
    taxAmount: v.taxAmount ?? undefined,
    discountAmount: v.discountAmount ?? undefined,
    grandTotal: v.grandTotal ?? undefined,
    currency: v.currency.trim() || undefined,
    paymentMethod: v.paymentMethod || null,
    paymentProvider: v.paymentProvider || null,
    providerOrderId: nullable(v.providerOrderId),
    placedAt: nullable(v.placedAt),
    paidAt: nullable(v.paidAt),
    refundedAt: nullable(v.refundedAt),
    cancelledAt: nullable(v.cancelledAt),
    contactId: v.contactId,
    companyId: v.companyId,
    dealId: v.dealId,
    attributionFirstSource: nullable(v.attributionFirstSource),
    attributionLastSource: nullable(v.attributionLastSource),
    customerNotes: nullable(v.customerNotes),
    internalNotes: nullable(v.internalNotes),
  };
}

/** Q6.1 LOAD-BEARING — Convert form values → update input. Date fields
 *  that did NOT change vs initial values are OMITTED from the payload
 *  entirely (not sent as the same value). This preserves the backend's
 *  original DateTime byte-for-byte, including time-of-day precision on
 *  webhook-sourced rows.
 *
 *  Non-date fields are also diffed (minimal payload + reduces wire noise),
 *  but the Q6.1 invariant applies specifically to date fields. */
function formToUpdateInput(
  v: OrderFormValues,
  initial: OrderFormValues,
  id: string,
): OrderUpdateInput {
  const out: OrderUpdateInput = { id };
  const nullable = (s: string): string | null => (s.trim() === '' ? null : s.trim());

  // Helper: include only if changed.
  const setIfChanged = <K extends keyof OrderUpdateInput>(
    key: K,
    current: OrderUpdateInput[K],
    initialValue: OrderUpdateInput[K],
  ) => {
    if (current !== initialValue) out[key] = current;
  };

  // Card 1
  if (v.status !== initial.status) out.status = v.status;
  if (v.source !== initial.source) out.source = v.source;
  // Card 2 — Decimal as string | null
  if (v.totalAmount !== initial.totalAmount) out.totalAmount = v.totalAmount ?? undefined;
  if (v.taxAmount !== initial.taxAmount) out.taxAmount = v.taxAmount ?? undefined;
  if (v.discountAmount !== initial.discountAmount) out.discountAmount = v.discountAmount ?? undefined;
  if (v.grandTotal !== initial.grandTotal) out.grandTotal = v.grandTotal ?? undefined;
  if (v.currency !== initial.currency) out.currency = v.currency;
  // Card 3 — payment
  if (v.paymentMethod !== initial.paymentMethod) out.paymentMethod = v.paymentMethod || null;
  if (v.paymentProvider !== initial.paymentProvider) out.paymentProvider = v.paymentProvider || null;
  setIfChanged('providerOrderId', nullable(v.providerOrderId), nullable(initial.providerOrderId));
  // Card 3 — DATES (load-bearing Q6.1: omit unchanged)
  if (v.placedAt !== initial.placedAt) out.placedAt = nullable(v.placedAt);
  if (v.paidAt !== initial.paidAt) out.paidAt = nullable(v.paidAt);
  if (v.refundedAt !== initial.refundedAt) out.refundedAt = nullable(v.refundedAt);
  if (v.cancelledAt !== initial.cancelledAt) out.cancelledAt = nullable(v.cancelledAt);
  // Card 4
  if (v.contactId !== initial.contactId) out.contactId = v.contactId;
  if (v.companyId !== initial.companyId) out.companyId = v.companyId;
  if (v.dealId !== initial.dealId) out.dealId = v.dealId;
  // Card 5
  setIfChanged('attributionFirstSource', nullable(v.attributionFirstSource), nullable(initial.attributionFirstSource));
  setIfChanged('attributionLastSource', nullable(v.attributionLastSource), nullable(initial.attributionLastSource));
  setIfChanged('customerNotes', nullable(v.customerNotes), nullable(initial.customerNotes));
  setIfChanged('internalNotes', nullable(v.internalNotes), nullable(initial.internalNotes));

  return out;
}

function shallowEqual(a: OrderFormValues, b: OrderFormValues): boolean {
  const keys = Object.keys(a) as Array<keyof OrderFormValues>;
  return keys.every((k) => a[k] === b[k]);
}

function validateForm(v: OrderFormValues): string[] {
  const errors: string[] = [];
  if (!v.orderNumber.trim()) errors.push('Order number is required.');
  if (!v.contactId) errors.push('Contact is required.');
  return errors;
}

/** Q7 — computed total hint: totalAmount + taxAmount − discountAmount.
 *  Display-only. Returns null if no inputs are numeric. */
function computeTotalHint(v: OrderFormValues): string | null {
  const t = Number(v.totalAmount ?? 0);
  const tax = Number(v.taxAmount ?? 0);
  const d = Number(v.discountAmount ?? 0);
  if (!Number.isFinite(t) && !Number.isFinite(tax) && !Number.isFinite(d)) return null;
  const sum = (Number.isFinite(t) ? t : 0) + (Number.isFinite(tax) ? tax : 0) - (Number.isFinite(d) ? d : 0);
  return sum.toFixed(2);
}

export interface OrderFormProps {
  mode: 'create' | 'edit';
  initialValues?: OrderFormValues;
  orderId?: string;
  initialContactLabel?: string;
  initialCompanyLabel?: string;
  initialDealLabel?: string;
}

export function OrderForm({
  mode,
  initialValues,
  orderId,
  initialContactLabel,
  initialCompanyLabel,
  initialDealLabel,
}: OrderFormProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const initial = initialValues ?? EMPTY_VALUES;
  const [values, setValues] = useState<OrderFormValues>(initial);
  const [serverErrors, setServerErrors] = useState<string[]>([]);

  const isDirty = useMemo(() => !shallowEqual(values, initial), [values, initial]);
  const computedHint = computeTotalHint(values);

  // KAN-942 standard — robust error message extraction.
  const errMessage = (err: unknown, fallback: string): string => {
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : '';
    return msg || fallback;
  };

  const createMutation = useMutation<OrderDetail, Error, OrderFormValues>({
    mutationFn: (formValues) => ordersApi.create(formToCreateInput(formValues)),
    onSuccess: (saved) => {
      toast.success('Order created.');
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      router.push(`/orders/${saved.id}`);
    },
    onError: (err) => {
      const message = errMessage(err, 'Create failed. Please try again.');
      setServerErrors([message]);
      toast.error(message);
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
    },
  });

  const updateMutation = useMutation<OrderDetail, Error, { id: string; values: OrderFormValues }>({
    mutationFn: ({ id, values: formValues }) =>
      ordersApi.update(formToUpdateInput(formValues, initial, id)),
    onSuccess: (saved) => {
      toast.success('Order saved.');
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['orders', 'get', saved.id] });
      router.push(`/orders/${saved.id}`);
    },
    onError: (err) => {
      const message = errMessage(err, 'Save failed. Please try again.');
      setServerErrors([message]);
      toast.error(message);
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
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
      if (!orderId) return;
      updateMutation.mutate({ id: orderId, values });
    }
  };

  const fetchContacts = async (search: string): Promise<ContactListItem[]> => {
    const result = await contactsApi.list({ search: search || undefined, limit: 50 });
    return result.items;
  };
  const fetchCompanies = async (search: string): Promise<CompanyListItem[]> => {
    const result = await companiesApi.list({ search: search || undefined, limit: 50 });
    return result.items;
  };
  const fetchDeals = async (search: string): Promise<DealListItem[]> => {
    const result = await dealsApi.list({ search: search || undefined, limit: 50 });
    return result.items;
  };
  const contactLabel = (c: ContactListItem) => {
    const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim();
    return name ? `${name}${c.email ? ` <${c.email}>` : ''}` : c.email ?? c.id;
  };

  return (
    <EntityFormShell
      title={mode === 'create' ? 'New order' : 'Edit order'}
      breadcrumb={[
        { label: 'Orders', href: '/orders' },
        ...(mode === 'edit' && orderId
          ? [{ label: 'Edit', href: `/orders/${orderId}/edit` }]
          : [{ label: 'New', href: '/orders/new' }]),
      ]}
      mode={mode}
      isPending={isPending}
      isDirty={isDirty}
      onSave={handleSave}
      errors={serverErrors.length > 0 ? serverErrors : undefined}
    >
      {/* Card 1 — Core Order */}
      <Card>
        <CardHeader>
          <CardTitle>Core Order</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <Label htmlFor="orderNumber" style={LABEL_STYLE}>
              Order number <span style={{ color: 'var(--ds-danger-text)' }}>*</span>
            </Label>
            <Input
              id="orderNumber"
              value={values.orderNumber}
              onChange={(e) => setValues({ ...values, orderNumber: e.target.value })}
              placeholder="e.g., ORD-2026-0001"
              required
              readOnly={mode === 'edit'}
              disabled={mode === 'edit'}
            />
            {mode === 'edit' ? (
              <p className="text-xs mt-1" style={MUTED_STYLE}>
                Order number is read-only on edit (often references an external system).
              </p>
            ) : null}
          </div>
          <div>
            <Label htmlFor="status" style={LABEL_STYLE}>Status</Label>
            <Select
              value={values.status}
              onValueChange={(v) => setValues({ ...values, status: v })}
            >
              <SelectTrigger id="status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((o) => (
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
              value={values.source}
              onValueChange={(v) => setValues({ ...values, source: v })}
            >
              <SelectTrigger id="source">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Card 2 — Money */}
      <Card>
        <CardHeader>
          <CardTitle>Money</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="totalAmount" style={LABEL_STYLE}>Total amount</Label>
            <DecimalInput
              id="totalAmount"
              value={values.totalAmount}
              onChange={(v) => setValues({ ...values, totalAmount: v })}
              currency={values.currency || 'USD'}
              placeholder="0.00"
            />
          </div>
          <div>
            <Label htmlFor="taxAmount" style={LABEL_STYLE}>Tax amount</Label>
            <DecimalInput
              id="taxAmount"
              value={values.taxAmount}
              onChange={(v) => setValues({ ...values, taxAmount: v })}
              currency={values.currency || 'USD'}
              placeholder="0.00"
            />
          </div>
          <div>
            <Label htmlFor="discountAmount" style={LABEL_STYLE}>Discount amount</Label>
            <DecimalInput
              id="discountAmount"
              value={values.discountAmount}
              onChange={(v) => setValues({ ...values, discountAmount: v })}
              currency={values.currency || 'USD'}
              placeholder="0.00"
            />
          </div>
          <div>
            <Label htmlFor="grandTotal" style={LABEL_STYLE}>Grand total</Label>
            <DecimalInput
              id="grandTotal"
              value={values.grandTotal}
              onChange={(v) => setValues({ ...values, grandTotal: v })}
              currency={values.currency || 'USD'}
              placeholder="0.00"
            />
            {/* Q7 — computed-total hint (display-only, not enforced) */}
            {computedHint != null ? (
              <p className="text-xs mt-1" style={MUTED_STYLE}>
                Computed: total + tax − discount = {computedHint} {values.currency || 'USD'}
              </p>
            ) : null}
          </div>
          <div className="col-span-2">
            <Label htmlFor="currency" style={LABEL_STYLE}>Currency (ISO 4217)</Label>
            <Input
              id="currency"
              maxLength={3}
              value={values.currency}
              onChange={(e) =>
                setValues({ ...values, currency: e.target.value.toUpperCase() })
              }
              placeholder="USD"
            />
          </div>
        </CardContent>
      </Card>

      {/* Card 3 — Payment & Timeline */}
      <Card>
        <CardHeader>
          <CardTitle>Payment &amp; Timeline</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="paymentMethod" style={LABEL_STYLE}>Payment method</Label>
            <Select
              value={values.paymentMethod || '__none'}
              onValueChange={(v) =>
                setValues({ ...values, paymentMethod: v === '__none' ? '' : v })
              }
            >
              <SelectTrigger id="paymentMethod">
                <SelectValue placeholder="(unspecified)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">(unspecified)</SelectItem>
                {PAYMENT_METHOD_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="paymentProvider" style={LABEL_STYLE}>Payment provider</Label>
            <Select
              value={values.paymentProvider || '__none'}
              onValueChange={(v) =>
                setValues({ ...values, paymentProvider: v === '__none' ? '' : v })
              }
            >
              <SelectTrigger id="paymentProvider">
                <SelectValue placeholder="(unspecified)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">(unspecified)</SelectItem>
                {PAYMENT_PROVIDER_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2">
            <Label htmlFor="providerOrderId" style={LABEL_STYLE}>Provider order ID</Label>
            <Input
              id="providerOrderId"
              value={values.providerOrderId}
              onChange={(e) => setValues({ ...values, providerOrderId: e.target.value })}
              placeholder="e.g., ch_test_abc123 (Stripe charge id)"
            />
          </div>
          <div>
            <Label htmlFor="placedAt" style={LABEL_STYLE}>Placed at</Label>
            <Input
              id="placedAt"
              type="date"
              value={values.placedAt}
              onChange={(e) => setValues({ ...values, placedAt: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="paidAt" style={LABEL_STYLE}>Paid at</Label>
            <Input
              id="paidAt"
              type="date"
              value={values.paidAt}
              onChange={(e) => setValues({ ...values, paidAt: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="refundedAt" style={LABEL_STYLE}>Refunded at</Label>
            <Input
              id="refundedAt"
              type="date"
              value={values.refundedAt}
              onChange={(e) => setValues({ ...values, refundedAt: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="cancelledAt" style={LABEL_STYLE}>Cancelled at</Label>
            <Input
              id="cancelledAt"
              type="date"
              value={values.cancelledAt}
              onChange={(e) => setValues({ ...values, cancelledAt: e.target.value })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Card 4 — Relationships */}
      <Card>
        <CardHeader>
          <CardTitle>Relationships</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <Label style={LABEL_STYLE}>
              Contact <span style={{ color: 'var(--ds-danger-text)' }}>*</span>
            </Label>
            <AsyncSelect<ContactListItem>
              fetchOptions={fetchContacts}
              getOptionLabel={contactLabel}
              getOptionValue={(c) => c.id}
              value={values.contactId || null}
              onChange={(id) => setValues({ ...values, contactId: id ?? '' })}
              placeholder="Search contacts…"
              selectedLabel={initialContactLabel}
            />
          </div>
          <div>
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
          <div>
            <Label style={LABEL_STYLE}>Deal</Label>
            <AsyncSelect<DealListItem>
              fetchOptions={fetchDeals}
              getOptionLabel={(d) => d.name}
              getOptionValue={(d) => d.id}
              value={values.dealId}
              onChange={(id) => setValues({ ...values, dealId: id })}
              placeholder="Search deals…"
              selectedLabel={initialDealLabel}
            />
          </div>
        </CardContent>
      </Card>

      {/* Card 5 — Attribution & Notes */}
      <Card>
        <CardHeader>
          <CardTitle>Attribution &amp; Notes</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="attributionFirstSource" style={LABEL_STYLE}>
              First-touch attribution
            </Label>
            <Input
              id="attributionFirstSource"
              value={values.attributionFirstSource}
              onChange={(e) =>
                setValues({ ...values, attributionFirstSource: e.target.value })
              }
              placeholder="e.g., organic_search"
            />
          </div>
          <div>
            <Label htmlFor="attributionLastSource" style={LABEL_STYLE}>
              Last-touch attribution
            </Label>
            <Input
              id="attributionLastSource"
              value={values.attributionLastSource}
              onChange={(e) =>
                setValues({ ...values, attributionLastSource: e.target.value })
              }
              placeholder="e.g., direct"
            />
          </div>
          <div className="col-span-2">
            <Label htmlFor="customerNotes" style={LABEL_STYLE}>Customer notes</Label>
            <Textarea
              id="customerNotes"
              value={values.customerNotes}
              onChange={(e) => setValues({ ...values, customerNotes: e.target.value })}
              rows={3}
              placeholder="Notes visible to customer-facing surfaces."
            />
          </div>
          <div className="col-span-2">
            <Label htmlFor="internalNotes" style={LABEL_STYLE}>Internal notes</Label>
            <Textarea
              id="internalNotes"
              value={values.internalNotes}
              onChange={(e) => setValues({ ...values, internalNotes: e.target.value })}
              rows={3}
              placeholder="Internal-only notes (not surfaced to customer)."
            />
          </div>
        </CardContent>
      </Card>
    </EntityFormShell>
  );
}

// KAN-945 — Re-export for the edit route + tests
export { formToUpdateInput };
