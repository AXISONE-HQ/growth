'use client';

/**
 * KAN-905 — Ingestion Cohort 2.4. Field mapping review page.
 *
 * Full-width surface (no constraining card) — the mapping table is the
 * primary content. Three states:
 *   (a) empty   — fieldMappings IS NULL + no error → big CTA "Run AI mapping"
 *   (b) reviewing — fieldMappings populated → table + dropdowns + Save bar
 *   (c) error   — fieldMappingError populated → red panel + Retry
 *
 * On Save success: navigate back to /imports/[id] (which now shows
 * fieldMappingConfirmedAt populated + the "Continue to staging" CTA).
 *
 * Collision validation lives inline: before the Save mutation fires,
 * we walk the local mapping state and flag any non-skip target_field
 * used twice. The backend re-validates (defense-in-depth) and throws
 * BAD_REQUEST on collision — the UI catches that and surfaces the
 * specific colliding columns.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  Save,
  Sparkles,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  importJobsApi,
  type FieldMappingEntry,
  type ImportJobDetail,
  type TargetField,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ConfidenceBadge } from '@/components/growth/confidence-badge';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DETECTED_ENTITY_TYPE_LABELS, enumLabel } from '@/lib/enum-labels';

const SECTION_HEADER_STYLE = { color: 'var(--ds-ink-primary)' } as const;
const MUTED_STYLE = { color: 'var(--ds-ink-tertiary)' } as const;
const LABEL_STYLE = { color: 'var(--ds-ink-secondary)' } as const;

const SUPPORTED_ENTITIES = new Set(['contacts', 'companies', 'deals', 'orders']);

// KAN-922 — per-entity allow-list for the Dedup match key dropdown.
// Mirrors the matcher's per-entity MatchKey types (import-dedup.ts) and
// the saveFieldMappings backend validation.
const ELIGIBLE_DEDUP_KEYS = {
  contacts: ['email', 'phone', 'external_id'],
  companies: ['domain', 'external_id'],
  deals: ['external_id'],
  orders: ['orderNumber', 'providerOrderId', 'external_id'],
} as const;

export default function MappingPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = params?.id;

  const {
    data: job,
    isLoading,
    isError,
    error,
  } = useQuery<ImportJobDetail>({
    queryKey: ['importJobs', 'get', id],
    queryFn: () => importJobsApi.get(id as string),
    enabled: !!id,
  });

  const { data: fieldUniverse } = useQuery<TargetField[]>({
    queryKey: ['importJobs', 'fieldUniverse', job?.detectedEntityType],
    queryFn: () =>
      importJobsApi.getFieldUniverse(job!.detectedEntityType as string),
    enabled: !!job?.detectedEntityType && SUPPORTED_ENTITIES.has(job.detectedEntityType),
  });

  // Local mutable mapping state — seeded from job.fieldMappings, mutated
  // by dropdown changes. Save fires the saveMappings mutation against
  // this local state.
  const [localMappings, setLocalMappings] = useState<FieldMappingEntry[] | null>(
    null,
  );

  // KAN-922 — per-import match configuration local state. Seeded from
  // job columns on first load; nullable individually. The Save mutation
  // sends these alongside the mappings.
  const [dedupMatchField, setDedupMatchField] = useState<string | null>(null);
  const [externalSourceTag, setExternalSourceTag] = useState<string | null>(null);
  const [customerLinkField, setCustomerLinkField] = useState<string | null>(null);
  const [dealLinkField, setDealLinkField] = useState<string | null>(null);

  // Re-seed local state when the server's fieldMappings changes (e.g.,
  // after Run AI mapping finishes). Only re-seed if we don't have local
  // state yet OR the server's mapping count differs (proxy for "fresh
  // run replaced suggestions").
  useEffect(() => {
    if (!job?.fieldMappings) {
      setLocalMappings(null);
      return;
    }
    setLocalMappings((prev) => {
      if (!prev || prev.length !== job.fieldMappings!.length) {
        return job.fieldMappings;
      }
      return prev;
    });
  }, [job?.fieldMappings]);

  // KAN-922 — seed match-config state from job columns on first load.
  // We only seed once (initial render with job data) to avoid clobbering
  // user edits when the query refetches.
  const matchConfigSeededRef = useState({ seeded: false })[0];
  useEffect(() => {
    if (!job || matchConfigSeededRef.seeded) return;
    setDedupMatchField(job.dedupMatchField);
    setExternalSourceTag(job.externalSourceTag);
    setCustomerLinkField(job.customerLinkField);
    setDealLinkField(job.dealLinkField);
    matchConfigSeededRef.seeded = true;
  }, [job, matchConfigSeededRef]);

  useEffect(() => {
    if (job) document.title = `Map columns · ${job.fileName}`;
  }, [job]);

  const runMappingMutation = useMutation<ImportJobDetail, Error, string>({
    mutationFn: (importJobId) => importJobsApi.runMapping(importJobId),
    onSuccess: (updated) => {
      queryClient.setQueryData(['importJobs', 'get', id], updated);
      setLocalMappings(updated.fieldMappings);
    },
    onError: (err) => {
      toast.error(err.message || 'AI mapping failed', {
        description: 'See the error panel for details.',
      });
      void queryClient.invalidateQueries({ queryKey: ['importJobs', 'get', id] });
    },
  });

  const saveMappingsMutation = useMutation<
    ImportJobDetail,
    Error,
    FieldMappingEntry[]
  >({
    mutationFn: (mappings) =>
      importJobsApi.saveMappings({
        importJobId: job!.id,
        mappings,
        // KAN-922 — send match-config alongside mappings.
        dedupMatchField,
        externalSourceTag,
        customerLinkField,
        dealLinkField,
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['importJobs', 'get', id], updated);
      toast.success('Mappings saved.');
      router.push(`/imports/${updated.id}`);
    },
    onError: (err) => {
      toast.error(err.message || 'Save failed');
    },
  });

  const [reRunOpen, setReRunOpen] = useState(false);

  // Collision detection (live, per render).
  // HOISTED above early returns so it runs unconditionally — React's
  // rules-of-hooks forbids conditional Hook calls. The memo function
  // tolerates null `localMappings` by returning an empty Map, so it's
  // safe to compute even on loading/error/gate code paths.
  const collisions = useMemo(() => {
    if (!localMappings) return new Map<string, string[]>();
    const seen = new Map<string, string[]>();
    for (const m of localMappings) {
      if (m.targetField === 'skip') continue;
      const arr = seen.get(m.targetField) ?? [];
      arr.push(m.sourceColumn);
      seen.set(m.targetField, arr);
    }
    // Filter to entries with >1 source column.
    const out = new Map<string, string[]>();
    for (const [target, sources] of seen.entries()) {
      if (sources.length > 1) out.set(target, sources);
    }
    return out;
  }, [localMappings]);

  if (!id) return null;
  if (isLoading) return <MappingSkeleton />;
  if (isError) return <MappingErrorPanel message={(error as Error)?.message ?? 'Unknown error'} />;
  if (!job) return null;

  // Gate: must be inspected + detection complete + entity supported.
  if (job.status !== 'inspected' || !job.detectedEntityType) {
    return (
      <PageShell job={job}>
        <GateNotReady
          reason={
            !job.detectedEntityType
              ? 'Run AI entity detection on this file before mapping columns.'
              : `This file is in '${job.status}' state. Mapping requires status='inspected'.`
          }
        />
      </PageShell>
    );
  }
  if (!SUPPORTED_ENTITIES.has(job.detectedEntityType)) {
    return (
      <PageShell job={job}>
        <GateNotReady
          reason={`AI field mapping is not supported for '${enumLabel(DETECTED_ENTITY_TYPE_LABELS, job.detectedEntityType)}' files in this release. Re-run detection or upload a single-entity file.`}
        />
      </PageShell>
    );
  }

  const headers = (job.detectedHeaders ?? []) as string[];
  const sampleRows = (job.sampleRows ?? []) as Record<string, unknown>[];
  const hasError = !!job.fieldMappingError && !job.fieldMappings;
  const hasMappings = Array.isArray(localMappings) && localMappings.length > 0;
  const isRunning = runMappingMutation.isPending;
  const isSaving = saveMappingsMutation.isPending;

  const hasCollisions = collisions.size > 0;

  // KAN-922 — validation: external_id picked anywhere → externalSourceTag required.
  const anyFieldUsesExternalId =
    dedupMatchField === 'external_id' ||
    customerLinkField === 'external_id' ||
    dealLinkField === 'external_id';
  const sourceTagMissing =
    anyFieldUsesExternalId && (externalSourceTag == null || externalSourceTag.trim() === '');

  const onChangeTarget = (sourceColumn: string, newTarget: string) => {
    setLocalMappings((prev) => {
      if (!prev) return prev;
      return prev.map((m) =>
        m.sourceColumn === sourceColumn
          ? {
              ...m,
              targetField: newTarget,
              confidence: newTarget === 'skip' ? null : (m.confidence ?? 50),
            }
          : m,
      );
    });
  };

  const onSave = () => {
    if (!localMappings) return;
    if (hasCollisions) {
      const example = Array.from(collisions.entries())[0];
      toast.error(
        `Two source columns ('${example[1][0]}' and '${example[1][1]}') both map to '${example[0]}'.`,
        { description: 'Resolve all collisions before saving.' },
      );
      return;
    }
    if (sourceTagMissing) {
      toast.error('External source tag is required when any match field uses external_id.', {
        description: 'Enter a tag (e.g. hubspot, stripe) in the Match settings panel.',
      });
      return;
    }
    saveMappingsMutation.mutate(localMappings);
  };

  return (
    <PageShell job={job}>
      {/* State (c) — error panel */}
      {hasError ? (
        <section className="bg-red-50 border border-red-200 rounded-lg p-6 mb-4">
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" aria-hidden />
            <div className="flex-1 min-w-0">
              <h2 className="text-sm font-semibold text-red-800">
                AI mapping failed
              </h2>
              <p className="text-sm mt-1 text-red-700 whitespace-pre-wrap break-words">
                {job.fieldMappingError}
              </p>
              <div className="mt-3">
                <Button
                  onClick={() => runMappingMutation.mutate(job.id)}
                  disabled={isRunning}
                  variant="default"
                >
                  {isRunning ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Retrying…
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 mr-1.5" /> Retry
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {/* State (a) — empty, no mappings yet */}
      {!hasMappings && !hasError ? (
        <section className="bg-white border rounded-lg p-12 text-center">
          <Sparkles className="w-10 h-10 mx-auto text-violet-500" aria-hidden />
          <h2 className="text-lg font-semibold mt-3" style={SECTION_HEADER_STYLE}>
            Generate mapping suggestions
          </h2>
          <p className="text-sm mt-2 max-w-md mx-auto" style={LABEL_STYLE}>
            We'll use AI to suggest which target field each source column should
            map to for this {enumLabel(DETECTED_ENTITY_TYPE_LABELS, job.detectedEntityType)} file.
          </p>
          <div className="mt-5">
            <Button
              onClick={() => runMappingMutation.mutate(job.id)}
              disabled={isRunning}
              variant="default"
              size="lg"
            >
              {isRunning ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analyzing your columns…
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 mr-2" /> Run AI mapping
                </>
              )}
            </Button>
          </div>
        </section>
      ) : null}

      {/* State (b) — mapping table */}
      {hasMappings ? (
        <>
          {hasCollisions ? (
            <div
              className="flex items-start gap-2 p-3 mb-4 rounded-md border"
              style={{
                backgroundColor: 'var(--ds-warning-soft)',
                color: 'var(--ds-warning-text)',
                borderColor: 'var(--ds-warning)',
              }}
              role="alert"
            >
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden />
              <div className="text-sm">
                <strong>{collisions.size} collision{collisions.size === 1 ? '' : 's'}:</strong>{' '}
                each target field can only be used by one source column. Resolve
                before saving.
                <ul className="list-disc pl-5 mt-1">
                  {Array.from(collisions.entries()).map(([target, sources]) => (
                    <li key={target}>
                      <span className="font-mono">{target}</span>: {sources.join(', ')}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          <section className="bg-white border rounded-lg overflow-hidden mb-20">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr className="text-left" style={MUTED_STYLE}>
                    <th className="px-4 py-3 font-medium uppercase tracking-wider text-xs w-1/4">
                      Source column
                    </th>
                    <th className="px-4 py-3 font-medium uppercase tracking-wider text-xs w-1/3">
                      Sample data
                    </th>
                    <th className="px-4 py-3 font-medium uppercase tracking-wider text-xs w-1/3">
                      Target field
                    </th>
                    <th className="px-4 py-3 font-medium uppercase tracking-wider text-xs">
                      Confidence
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {localMappings!.map((m) => {
                    const samplePreview = sampleRowsPreview(sampleRows, m.sourceColumn);
                    const isCollision =
                      m.targetField !== 'skip' && collisions.has(m.targetField);
                    return (
                      <tr key={m.sourceColumn} className={isCollision ? 'bg-amber-50' : ''}>
                        <td className="px-4 py-3 font-mono text-xs align-top" style={LABEL_STYLE}>
                          {m.sourceColumn}
                        </td>
                        <td className="px-4 py-3 align-top" style={LABEL_STYLE}>
                          <div className="font-mono text-xs space-y-0.5">
                            {samplePreview.map((s, i) => (
                              <div key={i} className="truncate" title={s}>
                                {s || <span style={MUTED_STYLE}>—</span>}
                              </div>
                            ))}
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <Select
                            value={m.targetField}
                            onValueChange={(v) => onChangeTarget(m.sourceColumn, v)}
                          >
                            <SelectTrigger className="h-9 text-sm">
                              <SelectValue placeholder="Choose a target field…" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {(fieldUniverse ?? []).map((f) => (
                                  <SelectItem key={f.name} value={f.name}>
                                    <span className="flex items-center gap-2">
                                      <span>{f.label}</span>
                                      {f.kind === 'lookup' ? (
                                        <span
                                          className="text-xs px-1.5 py-0.5 rounded"
                                          style={{
                                            backgroundColor: 'var(--ds-violet-50)',
                                            color: 'var(--ds-violet-700)',
                                          }}
                                        >
                                          lookup
                                        </span>
                                      ) : null}
                                    </span>
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-4 py-3 align-top">
                          {m.targetField === 'skip' || m.confidence == null ? (
                            <span className="text-xs" style={MUTED_STYLE}>—</span>
                          ) : (
                            <ConfidenceBadge value={m.confidence} showWord={false} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* KAN-922 — Match settings panel. Configures how this import
              dedupes against existing records and links to other entities.
              All fields nullable; NULL falls back to the heuristic cascade. */}
          <section className="border rounded-lg p-6 mb-4 bg-white mt-4">
            <h3 className="font-semibold mb-1" style={SECTION_HEADER_STYLE}>
              Match settings
            </h3>
            <p className="text-sm mb-4" style={MUTED_STYLE}>
              Optional. Configure how this import dedupes against existing
              records and (for deals/orders) links to other entities.
              Leave blank to use the default heuristic.
            </p>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium mb-1" style={LABEL_STYLE}>
                  Dedup match key
                </label>
                <Select
                  value={dedupMatchField ?? '_auto'}
                  onValueChange={(v) => setDedupMatchField(v === '_auto' ? null : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Auto (heuristic)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_auto">Auto (heuristic)</SelectItem>
                    {ELIGIBLE_DEDUP_KEYS[job.detectedEntityType as keyof typeof ELIGIBLE_DEDUP_KEYS]?.map((k) => (
                      <SelectItem key={k} value={k}>{k}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs mt-1" style={MUTED_STYLE}>
                  Strict match on this canonical field. Picked value NULL on the
                  existing record → no match → insert.
                </p>
              </div>

              {(dedupMatchField === 'external_id' ||
                customerLinkField === 'external_id' ||
                dealLinkField === 'external_id') && (
                <div>
                  <label className="block text-sm font-medium mb-1" style={LABEL_STYLE}>
                    External source tag
                    <span className="text-red-600 ml-1">*</span>
                  </label>
                  <input
                    type="text"
                    list="external-source-suggestions"
                    className={`w-full px-3 py-2 border rounded ${
                      sourceTagMissing ? 'border-red-500' : 'border-gray-300'
                    }`}
                    placeholder="e.g. hubspot, stripe"
                    value={externalSourceTag ?? ''}
                    onChange={(e) => setExternalSourceTag(e.target.value || null)}
                  />
                  <datalist id="external-source-suggestions">
                    <option value="stripe" />
                    <option value="hubspot" />
                    <option value="salesforce" />
                    <option value="shopify" />
                    <option value="pipedrive" />
                    <option value="manual" />
                  </datalist>
                  <p className="text-xs mt-1" style={sourceTagMissing ? { color: 'rgb(220 38 38)' } : MUTED_STYLE}>
                    {sourceTagMissing
                      ? 'Required when any match field uses external_id.'
                      : 'Tags the external_id value with its source.'}
                  </p>
                </div>
              )}

              {(job.detectedEntityType === 'deals' || job.detectedEntityType === 'orders') && (
                <div>
                  <label className="block text-sm font-medium mb-1" style={LABEL_STYLE}>
                    Link customer by
                  </label>
                  <Select
                    value={customerLinkField ?? 'email'}
                    onValueChange={(v) => setCustomerLinkField(v)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="email">email</SelectItem>
                      <SelectItem value="phone">phone</SelectItem>
                      <SelectItem value="external_id">external_id</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {job.detectedEntityType === 'orders' && (
                <div>
                  <label className="block text-sm font-medium mb-1" style={LABEL_STYLE}>
                    Link deal by (optional)
                  </label>
                  <Select
                    value={dealLinkField ?? '_none'}
                    onValueChange={(v) => setDealLinkField(v === '_none' ? null : v)}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">No deal link</SelectItem>
                      <SelectItem value="external_id">external_id</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs mt-1" style={MUTED_STYLE}>
                    Order.dealId stays NULL when this is blank.
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* Sticky bottom action bar */}
          <div
            className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-6 py-3 shadow-lg z-10"
          >
            <div className="max-w-7xl mx-auto flex items-center justify-between gap-3">
              <Button
                variant="outline"
                onClick={() => setReRunOpen(true)}
                disabled={isRunning || isSaving}
              >
                <Sparkles className="w-4 h-4 mr-1.5" /> Re-run AI mapping
              </Button>
              <div className="flex items-center gap-2">
                <Link href={`/imports/${job.id}`}>
                  <Button variant="outline" disabled={isSaving}>
                    Cancel
                  </Button>
                </Link>
                <Button
                  onClick={onSave}
                  disabled={isSaving || hasCollisions || sourceTagMissing}
                  variant="default"
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Saving…
                    </>
                  ) : (
                    <>
                      <Save className="w-4 h-4 mr-1.5" /> Save mappings
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>

          <Dialog open={reRunOpen} onOpenChange={setReRunOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Re-run AI mapping?</DialogTitle>
                <DialogDescription>
                  This will discard your unsaved changes and replace all mappings
                  with fresh AI suggestions.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setReRunOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="default"
                  onClick={() => {
                    setReRunOpen(false);
                    runMappingMutation.mutate(job.id);
                  }}
                >
                  Re-run
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : null}
    </PageShell>
  );
}

// ─────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────

function PageShell({
  job,
  children,
}: {
  job: ImportJobDetail;
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-7xl mx-auto px-6 py-8 pb-24">
      <Link
        href={`/imports/${job.id}`}
        className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 mb-3"
      >
        <ArrowLeft className="w-4 h-4" /> Back to file
      </Link>
      <div className="mb-2 text-xs" style={MUTED_STYLE}>
        Imports / {job.fileName}
      </div>
      <h1 className="text-2xl font-semibold mb-1 flex items-center gap-3 flex-wrap" style={SECTION_HEADER_STYLE}>
        Map columns
        {job.detectedEntityType ? (
          <span
            className="text-sm font-normal px-2.5 py-0.5 rounded-full border"
            style={{
              backgroundColor: 'var(--ds-violet-50)',
              color: 'var(--ds-violet-700)',
              borderColor: 'var(--ds-violet-500)',
            }}
          >
            {enumLabel(DETECTED_ENTITY_TYPE_LABELS, job.detectedEntityType)}
          </span>
        ) : null}
      </h1>
      <p className="text-sm mb-6" style={LABEL_STYLE}>
        Review the AI-suggested mappings. You can override any field or skip
        columns you don't want to import.
      </p>
      {children}
    </div>
  );
}

function GateNotReady({ reason }: { reason: string }) {
  return (
    <section className="bg-white border rounded-lg p-12 text-center">
      <AlertTriangle className="w-10 h-10 mx-auto text-amber-500" aria-hidden />
      <h2 className="text-base font-semibold mt-3" style={SECTION_HEADER_STYLE}>
        Not ready for mapping
      </h2>
      <p className="text-sm mt-2 max-w-md mx-auto" style={LABEL_STYLE}>
        {reason}
      </p>
    </section>
  );
}

function MappingSkeleton() {
  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-4">
      <div className="h-4 w-24 bg-gray-200 rounded animate-pulse" />
      <div className="h-7 w-1/3 bg-gray-200 rounded animate-pulse" />
      <div className="h-4 w-1/2 bg-gray-100 rounded animate-pulse" />
      <div className="bg-white border rounded-lg p-6 space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />
        ))}
      </div>
    </div>
  );
}

function MappingErrorPanel({ message }: { message: string }) {
  const isNotFound = /not found/i.test(message);
  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="bg-white border rounded-lg p-12 text-center">
        <XCircle className="w-10 h-10 mx-auto text-red-500" aria-hidden />
        <h2 className="text-lg font-semibold mt-3" style={SECTION_HEADER_STYLE}>
          {isNotFound ? 'Import not found' : 'Failed to load import'}
        </h2>
        <p className="text-sm mt-1" style={MUTED_STYLE}>{message}</p>
        <div className="mt-4">
          <Link href="/imports">
            <Button variant="outline">Back to Imports</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

function sampleRowsPreview(
  rows: Record<string, unknown>[],
  column: string,
  count = 2,
): string[] {
  const slice = rows.slice(0, count);
  return slice.map((r) => {
    const v = r[column];
    if (v === null || v === undefined) return '';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 40 ? `${s.slice(0, 40)}…` : s;
  });
}
