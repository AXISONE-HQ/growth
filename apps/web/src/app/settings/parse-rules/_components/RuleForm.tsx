'use client';

/**
 * KAN-1140 Phase 3 PR 9c — Rule authoring form.
 *
 * Plain controlled state (Q9 lock; matches parse-fingerprints + lead-inbox
 * sibling Settings convention). Multi-extractor array with add/remove
 * controls + "N of 20" counter (Q-ADD-EXTRACTOR-COUNT lock).
 *
 * Validation: client-side preview + server-side authoritative
 * ParseRuleBodySchema.parse on submit.
 *
 * Q-ADD-EDIT-WARNING: edit mode shows inline header notice + post-save
 * toast about version snapshot semantics.
 */
import * as React from 'react';
import type { ParseRuleBody, ParseRuleFieldExtractor } from '@/lib/api';
import { ExtractorRow } from './ExtractorRow';

const WRITABLE_FIELDS = ['firstName', 'lastName', 'companyName', 'phone', 'intentSummary'] as const;
const MAX_EXTRACTORS = 20;

export function createEmptyRuleBody(): ParseRuleBody {
  return {
    extractors: [
      {
        field: 'firstName',
        extractor: { type: 'regex', pattern: '', captureGroup: 1 },
      },
    ],
  };
}

export function RuleForm({
  mode,
  initialBody,
  initialLabel,
  initialFingerprintId,
  initialFormat,
  initialVendor,
  busy,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initialBody: ParseRuleBody;
  initialLabel: string;
  initialFingerprintId: string | null;
  initialFormat: string | null;
  initialVendor: string | null;
  busy: boolean;
  onSubmit: (input: {
    label: string;
    body: ParseRuleBody;
    fingerprintId?: string;
    format?: string;
    vendor?: string;
  }) => Promise<void>;
}): React.ReactElement {
  const [label, setLabel] = React.useState(initialLabel);
  const [body, setBody] = React.useState<ParseRuleBody>(initialBody);
  const [fingerprintId, setFingerprintId] = React.useState(initialFingerprintId ?? '');
  const [format, setFormat] = React.useState(initialFormat ?? '');
  const [vendor, setVendor] = React.useState(initialVendor ?? '');
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  const handleAddExtractor = React.useCallback(() => {
    if (body.extractors.length >= MAX_EXTRACTORS) return;
    // Find first unused field for sensible default; fall back to first field.
    const usedFields = new Set(body.extractors.map((e) => e.field));
    const defaultField =
      WRITABLE_FIELDS.find((f) => !usedFields.has(f)) ?? WRITABLE_FIELDS[0];
    setBody({
      extractors: [
        ...body.extractors,
        {
          field: defaultField,
          extractor: { type: 'regex', pattern: '', captureGroup: 1 },
        },
      ],
    });
  }, [body]);

  const handleRemoveExtractor = React.useCallback(
    (idx: number) => {
      if (body.extractors.length <= 1) return; // Can't remove last
      setBody({
        extractors: body.extractors.filter((_, i) => i !== idx),
      });
    },
    [body],
  );

  const handleUpdateExtractor = React.useCallback(
    (idx: number, updated: ParseRuleFieldExtractor) => {
      setBody({
        extractors: body.extractors.map((e, i) => (i === idx ? updated : e)),
      });
    },
    [body],
  );

  const handleSubmit = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSubmitError(null);
      if (label.trim().length === 0) {
        setSubmitError('Label is required.');
        return;
      }
      if (body.extractors.length < 1 || body.extractors.length > MAX_EXTRACTORS) {
        setSubmitError(`Rule must have 1-${MAX_EXTRACTORS} extractors.`);
        return;
      }
      // Light client-side check; server's ParseRuleBodySchema.parse is
      // authoritative. Empty patterns get rejected server-side with the
      // exact validation message.
      try {
        await onSubmit({
          label: label.trim(),
          body,
          fingerprintId: fingerprintId.trim() || undefined,
          format: format.trim() || undefined,
          vendor: vendor.trim() || undefined,
        });
      } catch (err) {
        setSubmitError((err as Error)?.message ?? 'Save failed.');
      }
    },
    [label, body, fingerprintId, format, vendor, onSubmit],
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {/* Q-ADD-EDIT-WARNING — version snapshot semantics on edit. */}
      {mode === 'edit' ? (
        <div className="rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
          Saving this rule will preserve the current body as the previous version
          (one snapshot retained). Use the Version History below to restore.
        </div>
      ) : null}

      {/* Label */}
      <div>
        <label className="block text-xs font-medium text-muted-foreground">Label</label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={100}
          className="w-full rounded border px-2 py-1 text-sm"
          placeholder="e.g. Extract company name from Formspree footer"
        />
      </div>

      {/* Scope — create mode only (scope doesn't change on edit) */}
      {mode === 'create' ? (
        <fieldset className="rounded border p-2">
          <legend className="px-1 text-xs font-medium text-muted-foreground">Scope</legend>
          <div className="space-y-2">
            <div>
              <label className="block text-xs text-muted-foreground">
                Fingerprint ID (optional)
              </label>
              <input
                type="text"
                value={fingerprintId}
                onChange={(e) => setFingerprintId(e.target.value)}
                className="w-full rounded border px-2 py-1 text-xs"
                placeholder="Leave blank to scope by format/vendor or globally"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-muted-foreground">Format</label>
                <input
                  type="text"
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                  className="w-full rounded border px-2 py-1 text-xs"
                  placeholder="html / plain-text / ..."
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground">Vendor</label>
                <input
                  type="text"
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value)}
                  className="w-full rounded border px-2 py-1 text-xs"
                  placeholder="formspree / tally / ..."
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              If all three are blank, the rule applies globally to every inbound.
            </p>
          </div>
        </fieldset>
      ) : null}

      {/* Extractors */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-xs font-medium text-muted-foreground">
            Extractors ({body.extractors.length} of {MAX_EXTRACTORS})
          </label>
          <button
            type="button"
            onClick={handleAddExtractor}
            disabled={body.extractors.length >= MAX_EXTRACTORS}
            className="rounded border px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
          >
            + Add extractor
          </button>
        </div>
        <div className="space-y-2">
          {body.extractors.map((e, idx) => (
            <ExtractorRow
              key={idx}
              index={idx}
              extractor={e}
              canRemove={body.extractors.length > 1}
              onUpdate={(updated) => handleUpdateExtractor(idx, updated)}
              onRemove={() => handleRemoveExtractor(idx)}
            />
          ))}
        </div>
      </div>

      {submitError ? (
        <div className="rounded border border-red-400 bg-red-50 px-3 py-2 text-xs text-red-700">
          {submitError}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-primary px-4 py-1 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Saving…' : mode === 'create' ? 'Create rule' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
