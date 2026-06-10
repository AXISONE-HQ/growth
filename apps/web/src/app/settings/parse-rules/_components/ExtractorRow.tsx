'use client';

/**
 * KAN-1140 Phase 3 PR 9c — Single-extractor editor row.
 *
 * Renders a field selector + type radio (jsonPath / regex) + conditional
 * inputs + transforms multi-select + remove button.
 *
 * Validation is light here (display-only); server-side
 * ParseRuleBodySchema is authoritative at submit. Empty patterns surface
 * via the form's submit error display.
 */
import * as React from 'react';
import type { ParseRuleFieldExtractor, ParseRuleExtractor } from '@/lib/api';

const WRITABLE_FIELDS = ['firstName', 'lastName', 'companyName', 'phone', 'intentSummary'] as const;
const TRANSFORMS = ['trim', 'lowercase', 'uppercase', 'splitN'] as const;

export function ExtractorRow({
  index,
  extractor,
  canRemove,
  onUpdate,
  onRemove,
}: {
  index: number;
  extractor: ParseRuleFieldExtractor;
  canRemove: boolean;
  onUpdate: (updated: ParseRuleFieldExtractor) => void;
  onRemove: () => void;
}): React.ReactElement {
  const updateField = (field: (typeof WRITABLE_FIELDS)[number]) => {
    onUpdate({ ...extractor, field });
  };

  const updateType = (newType: 'jsonPath' | 'regex') => {
    const newExtractor: ParseRuleExtractor =
      newType === 'jsonPath'
        ? { type: 'jsonPath', path: '' }
        : { type: 'regex', pattern: '', captureGroup: 1 };
    onUpdate({ ...extractor, extractor: newExtractor });
  };

  const updateExtractorField = (updates: Partial<ParseRuleExtractor>) => {
    onUpdate({
      ...extractor,
      extractor: { ...extractor.extractor, ...updates } as ParseRuleExtractor,
    });
  };

  const transforms = extractor.extractor.transforms ?? [];
  const toggleTransform = (t: (typeof TRANSFORMS)[number]) => {
    const current = new Set(transforms);
    if (current.has(t)) current.delete(t);
    else current.add(t);
    updateExtractorField({ transforms: Array.from(current) });
  };

  return (
    <div className="rounded border p-2">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">#{index + 1}</span>
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          className="text-xs text-red-600 hover:underline disabled:opacity-50"
          title={canRemove ? 'Remove extractor' : 'At least one extractor required'}
        >
          Remove
        </button>
      </div>

      {/* Field selector */}
      <div className="mb-2 grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-muted-foreground">Field</label>
          <select
            value={extractor.field}
            onChange={(e) => updateField(e.target.value as (typeof WRITABLE_FIELDS)[number])}
            className="w-full rounded border px-2 py-1 text-xs"
          >
            {WRITABLE_FIELDS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground">Type</label>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs">
              <input
                type="radio"
                checked={extractor.extractor.type === 'regex'}
                onChange={() => updateType('regex')}
              />
              regex
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="radio"
                checked={extractor.extractor.type === 'jsonPath'}
                onChange={() => updateType('jsonPath')}
              />
              jsonPath
            </label>
          </div>
        </div>
      </div>

      {/* Conditional inputs */}
      {extractor.extractor.type === 'jsonPath' ? (
        <div>
          <label className="block text-xs text-muted-foreground">JSON path</label>
          <input
            type="text"
            value={extractor.extractor.path}
            onChange={(e) => updateExtractorField({ path: e.target.value })}
            className="w-full rounded border px-2 py-1 font-mono text-xs"
            placeholder='$.contact.first_name'
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Whitelist: $.foo, $.foo.bar, $.foo[0], $.foo[&quot;bar&quot;]. No recursive (..) or wildcards (*).
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2">
            <label className="block text-xs text-muted-foreground">Regex pattern</label>
            <input
              type="text"
              value={extractor.extractor.pattern}
              onChange={(e) => updateExtractorField({ pattern: e.target.value })}
              className="w-full rounded border px-2 py-1 font-mono text-xs"
              placeholder='Name: (\w+)'
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground">Capture group</label>
            <input
              type="number"
              min={0}
              max={20}
              value={extractor.extractor.captureGroup}
              onChange={(e) =>
                updateExtractorField({ captureGroup: Number.parseInt(e.target.value, 10) || 0 })
              }
              className="w-full rounded border px-2 py-1 text-xs"
            />
          </div>
        </div>
      )}

      {/* Transforms */}
      <div className="mt-2">
        <label className="block text-xs text-muted-foreground">Transforms</label>
        <div className="flex flex-wrap gap-2">
          {TRANSFORMS.map((t) => (
            <label key={t} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={transforms.includes(t)}
                onChange={() => toggleTransform(t)}
              />
              {t}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
