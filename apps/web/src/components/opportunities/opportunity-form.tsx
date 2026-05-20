'use client';

/**
 * KAN-938 — Sub-cohort 3.3 Deal/Opportunity CRUD form.
 *
 * Shared form for /opportunities/new (create) + /opportunities/[id]/edit (edit)
 * routes. Mirrors KAN-934 ContactForm + KAN-937 CompanyForm conventions: native
 * <form> + useState + react-query useMutation, EntityFormShell wrapper.
 *
 * Scope: 13 user-editable fields across 4 cards.
 *   Card 1 — Core Deal: name (req), value (DecimalInput), currency, probability
 *   Card 2 — Status & Outcomes: status (Select), expectedCloseDate (native date),
 *     conditional trio (lostReason + lostReasonDetail when lost, wonProductSummary when won)
 *   Card 3 — Pipeline & Stage: cascading picker (pipelineId → currentStageId
 *     filtered by selected pipeline's .stages from pipelines.listWithStages)
 *   Card 4 — Relationships: contactId (req AsyncSelect), companyId (opt AsyncSelect)
 *
 * Defensive null-clear for conditional fields lives in `formToCreateInput` —
 * follows the KAN-937 isTaxExempt pattern. Backend trusts the cleaned payload.
 *
 * Deferred from V1 (per KAN-938 design): ownerId (KAN-936), assignedAgentId,
 * tags/customFields/externalIds/aiContext, products.
 */
import { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
  dealsApi,
  contactsApi,
  companiesApi,
  pipelinesApi,
  type DealDetail,
  type DealCreateInput,
  type ContactListItem,
  type CompanyListItem,
  type PipelineWithStages,
} from '@/lib/api';

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
] as const;

const LOST_REASON_OPTIONS = [
  { value: 'price', label: 'Price' },
  { value: 'timing', label: 'Timing' },
  { value: 'competitor', label: 'Competitor' },
  { value: 'no_response', label: 'No response' },
  { value: 'not_qualified', label: 'Not qualified' },
  { value: 'feature_gap', label: 'Feature gap' },
  { value: 'other', label: 'Other' },
] as const;

const LABEL_STYLE = { color: 'var(--ds-ink-secondary)' } as const;

export interface OpportunityFormValues {
  // Card 1 — Core
  name: string;
  value: string | null;
  currency: string;
  probability: string; // text-input; converted to number on submit
  // Card 2 — Status & Outcomes
  status: string;
  expectedCloseDate: string;
  lostReason: string;
  lostReasonDetail: string;
  wonProductSummary: string;
  // Card 3 — Pipeline & Stage
  pipelineId: string;
  currentStageId: string;
  // Card 4 — Relationships
  contactId: string;
  companyId: string | null;
}

const EMPTY_VALUES: OpportunityFormValues = {
  name: '',
  value: null,
  currency: 'USD',
  probability: '',
  status: 'open',
  expectedCloseDate: '',
  lostReason: '',
  lostReasonDetail: '',
  wonProductSummary: '',
  pipelineId: '',
  currentStageId: '',
  contactId: '',
  companyId: null,
};

/** Map a server Deal (nullable fields) to form values. */
export function dealToFormValues(d: DealDetail): OpportunityFormValues {
  return {
    name: d.name ?? '',
    value: d.value,
    currency: d.currency ?? 'USD',
    probability: d.probability != null ? String(d.probability) : '',
    status: d.status ?? 'open',
    expectedCloseDate: d.expectedCloseDate ? d.expectedCloseDate.slice(0, 10) : '',
    lostReason: d.lostReason ?? '',
    lostReasonDetail: d.lostReasonDetail ?? '',
    wonProductSummary: d.wonProductSummary ?? '',
    pipelineId: d.pipelineId,
    currentStageId: d.currentStageId,
    contactId: d.contactId,
    companyId: d.companyId,
  };
}

/** Convert form values → API input. Applies the defensive null-clear for
 *  conditional fields (lostReason gated by status='lost', wonProductSummary
 *  gated by status='won'). */
function formToCreateInput(v: OpportunityFormValues): DealCreateInput {
  const nullable = (s: string): string | null => (s.trim() === '' ? null : s.trim());
  const probabilityNum = v.probability.trim() === '' ? null : Number(v.probability);
  return {
    // Card 1
    name: v.name.trim() || undefined,
    value: v.value ?? undefined,
    currency: v.currency.trim() || undefined,
    probability: Number.isFinite(probabilityNum as number) ? (probabilityNum as number) : null,
    // Card 2 — defensive null-clear for conditional trio
    status: v.status || undefined,
    expectedCloseDate: nullable(v.expectedCloseDate),
    lostReason: v.status === 'lost' ? nullable(v.lostReason) : null,
    lostReasonDetail: v.status === 'lost' ? nullable(v.lostReasonDetail) : null,
    wonProductSummary: v.status === 'won' ? nullable(v.wonProductSummary) : null,
    // Card 3 — required
    pipelineId: v.pipelineId,
    currentStageId: v.currentStageId,
    // Card 4
    contactId: v.contactId,
    companyId: v.companyId,
  };
}

function shallowEqual(a: OpportunityFormValues, b: OpportunityFormValues): boolean {
  const keys = Object.keys(a) as Array<keyof OpportunityFormValues>;
  return keys.every((k) => a[k] === b[k]);
}

function validateForm(v: OpportunityFormValues): string[] {
  const errors: string[] = [];
  if (!v.name.trim()) errors.push('Name is required.');
  if (!v.pipelineId) errors.push('Pipeline is required.');
  if (!v.currentStageId) errors.push('Stage is required.');
  if (!v.contactId) errors.push('Contact is required.');
  if (v.probability.trim() !== '') {
    const n = Number(v.probability);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      errors.push('Probability must be between 0 and 100.');
    }
  }
  return errors;
}

export interface OpportunityFormProps {
  mode: 'create' | 'edit';
  initialValues?: OpportunityFormValues;
  dealId?: string;
  /** Pre-loaded contact label for edit mode (so the picker shows the name
   *  immediately, not the UUID, before AsyncSelect first loads). */
  initialContactLabel?: string;
  /** Pre-loaded company label for edit mode. */
  initialCompanyLabel?: string;
}

export function OpportunityForm({
  mode,
  initialValues,
  dealId,
  initialContactLabel,
  initialCompanyLabel,
}: OpportunityFormProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const initial = initialValues ?? EMPTY_VALUES;
  const [values, setValues] = useState<OpportunityFormValues>(initial);
  const [serverErrors, setServerErrors] = useState<string[]>([]);

  const isDirty = useMemo(() => !shallowEqual(values, initial), [values, initial]);

  // KAN-932 — pipelines.listWithStages (small list, load-on-mount).
  const { data: pipelines } = useQuery<PipelineWithStages[]>({
    queryKey: ['pipelines', 'listWithStages'],
    queryFn: () => pipelinesApi.listWithStages(),
  });

  const selectedPipeline = useMemo(
    () => pipelines?.find((p) => p.id === values.pipelineId),
    [pipelines, values.pipelineId],
  );

  // Cascading picker: when pipelineId changes, ensure currentStageId belongs
  // to the new pipeline. If not, clear it.
  useEffect(() => {
    if (!selectedPipeline) return;
    if (values.currentStageId && !selectedPipeline.stages.find((s) => s.id === values.currentStageId)) {
      setValues((v) => ({ ...v, currentStageId: '' }));
    }
  }, [selectedPipeline, values.currentStageId]);

  // KAN-942 — Robust error message extraction. tRPC 500 responses may not
  // surface as Error instances with .message populated; fall back through
  // String(err) before the user-friendly fallback.
  const errMessage = (err: unknown, fallback: string): string => {
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : '';
    return msg || fallback;
  };

  const createMutation = useMutation<DealDetail, Error, OpportunityFormValues>({
    mutationFn: (formValues) => dealsApi.create(formToCreateInput(formValues)),
    onSuccess: (saved) => {
      toast.success('Deal created.');
      void queryClient.invalidateQueries({ queryKey: ['deals'] });
      router.push(`/opportunities/${saved.id}`);
    },
    onError: (err) => {
      // KAN-942 — silent-failure UX fix. The inline banner sits at body-top
      // and may scroll off-screen on long forms; pair with a toast so the
      // failure is always visible regardless of scroll position.
      const message = errMessage(err, 'Create failed. Please try again.');
      setServerErrors([message]);
      toast.error(message);
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
    },
  });

  const updateMutation = useMutation<DealDetail, Error, { id: string; values: OpportunityFormValues }>({
    mutationFn: ({ id, values: formValues }) =>
      dealsApi.update({ id, ...formToCreateInput(formValues) }),
    onSuccess: (saved) => {
      toast.success('Deal saved.');
      void queryClient.invalidateQueries({ queryKey: ['deals'] });
      void queryClient.invalidateQueries({ queryKey: ['deals', 'get', saved.id] });
      router.push(`/opportunities/${saved.id}`);
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
      if (!dealId) return;
      updateMutation.mutate({ id: dealId, values });
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

  const contactLabel = (c: ContactListItem) => {
    const name = `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim();
    return name ? `${name}${c.email ? ` <${c.email}>` : ''}` : c.email ?? c.id;
  };

  return (
    <EntityFormShell
      title={mode === 'create' ? 'New deal' : 'Edit deal'}
      breadcrumb={[
        { label: 'Opportunities', href: '/opportunities' },
        ...(mode === 'edit' && dealId
          ? [{ label: 'Edit', href: `/opportunities/${dealId}/edit` }]
          : [{ label: 'New', href: '/opportunities/new' }]),
      ]}
      mode={mode}
      isPending={isPending}
      isDirty={isDirty}
      onSave={handleSave}
      errors={serverErrors.length > 0 ? serverErrors : undefined}
    >
      {/* Card 1 — Core Deal */}
      <Card>
        <CardHeader>
          <CardTitle>Core Deal</CardTitle>
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
                if (!values.name.trim()) setServerErrors(validateForm(values));
              }}
              placeholder="e.g., Acme Q3 expansion"
              required
            />
          </div>
          <div>
            <Label htmlFor="value" style={LABEL_STYLE}>Value</Label>
            <DecimalInput
              id="value"
              value={values.value}
              onChange={(v) => setValues({ ...values, value: v })}
              currency={values.currency || 'USD'}
              placeholder="0.00"
            />
          </div>
          <div>
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
          <div className="col-span-2">
            <Label htmlFor="probability" style={LABEL_STYLE}>Probability (%)</Label>
            <Input
              id="probability"
              type="number"
              min={0}
              max={100}
              value={values.probability}
              onChange={(e) => setValues({ ...values, probability: e.target.value })}
              placeholder="0–100"
            />
          </div>
        </CardContent>
      </Card>

      {/* Card 2 — Status & Outcomes */}
      <Card>
        <CardHeader>
          <CardTitle>Status &amp; Outcomes</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
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
            <Label htmlFor="expectedCloseDate" style={LABEL_STYLE}>Expected close date</Label>
            <Input
              id="expectedCloseDate"
              type="date"
              value={values.expectedCloseDate}
              onChange={(e) => setValues({ ...values, expectedCloseDate: e.target.value })}
            />
          </div>
          {values.status === 'lost' && (
            <>
              <div>
                <Label htmlFor="lostReason" style={LABEL_STYLE}>Lost reason</Label>
                <Select
                  value={values.lostReason || '__none'}
                  onValueChange={(v) =>
                    setValues({ ...values, lostReason: v === '__none' ? '' : v })
                  }
                >
                  <SelectTrigger id="lostReason">
                    <SelectValue placeholder="(unspecified)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">(unspecified)</SelectItem>
                    {LOST_REASON_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2">
                <Label htmlFor="lostReasonDetail" style={LABEL_STYLE}>Lost reason detail</Label>
                <Textarea
                  id="lostReasonDetail"
                  value={values.lostReasonDetail}
                  onChange={(e) =>
                    setValues({ ...values, lostReasonDetail: e.target.value })
                  }
                  rows={2}
                  placeholder="Narrative context for the structured reason above."
                />
              </div>
            </>
          )}
          {values.status === 'won' && (
            <div className="col-span-2">
              <Label htmlFor="wonProductSummary" style={LABEL_STYLE}>Won product summary</Label>
              <Textarea
                id="wonProductSummary"
                value={values.wonProductSummary}
                onChange={(e) =>
                  setValues({ ...values, wonProductSummary: e.target.value })
                }
                rows={2}
                placeholder="What the deal closed on (SKU, plan tier, contract length)."
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Card 3 — Pipeline & Stage */}
      <Card>
        <CardHeader>
          <CardTitle>Pipeline &amp; Stage</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="pipelineId" style={LABEL_STYLE}>
              Pipeline <span style={{ color: 'var(--ds-danger-text)' }}>*</span>
            </Label>
            <Select
              value={values.pipelineId || '__none'}
              onValueChange={(v) =>
                setValues({
                  ...values,
                  pipelineId: v === '__none' ? '' : v,
                  currentStageId: '', // cascade: reset stage on pipeline change
                })
              }
            >
              <SelectTrigger id="pipelineId">
                <SelectValue placeholder="Select a pipeline…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">(select pipeline)</SelectItem>
                {(pipelines ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="currentStageId" style={LABEL_STYLE}>
              Stage <span style={{ color: 'var(--ds-danger-text)' }}>*</span>
            </Label>
            <Select
              value={values.currentStageId || '__none'}
              onValueChange={(v) =>
                setValues({ ...values, currentStageId: v === '__none' ? '' : v })
              }
              disabled={!selectedPipeline}
            >
              <SelectTrigger id="currentStageId">
                <SelectValue
                  placeholder={
                    selectedPipeline ? 'Select a stage…' : 'Pick a pipeline first'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">(select stage)</SelectItem>
                {(selectedPipeline?.stages ?? [])
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                      {s.isInitial ? ' (initial)' : ''}
                      {s.isTerminal ? ' (terminal)' : ''}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
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
    </EntityFormShell>
  );
}
