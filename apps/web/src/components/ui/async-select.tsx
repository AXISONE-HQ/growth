'use client';

/**
 * KAN-932 — AsyncSelect (Cohort 3 Foundation).
 *
 * Searchable async-loading dropdown for FK pickers at scale. Built for
 * the Cohort 3 CRUD forms where Contact tenants can have 13K+ rows,
 * Company/Deal lists can have 1K+ — full-list <Select> is infeasible.
 *
 * V1 scope (minimum-viable):
 *   - Text input for search
 *   - Debounced fetchOptions call (300ms)
 *   - Result list rendered as absolute-positioned div below input
 *   - Click-outside to close
 *   - Loading / empty / error states
 *   - Clear button to reset to null
 *
 * V1.x polish (deferred):
 *   - Keyboard navigation (ArrowUp/Down/Enter/Escape)
 *   - "Load more" pagination past 50 results
 *   - Inline "+ Create new" affordance
 *
 * No new dependencies — uses existing <Input> + native div positioning.
 * cmdk + Radix Popover NOT added in V1 (would require new package install
 * + apps/web Dockerfile audit). Keyboard nav files as Cohort 3.x polish.
 */
import { useEffect, useRef, useState } from 'react';
import { Input } from './input';
import { Button } from './button';

export interface AsyncSelectProps<T> {
  fetchOptions: (search: string) => Promise<T[]>;
  getOptionLabel: (option: T) => string;
  getOptionValue: (option: T) => string;
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Display label when value is set but option list is not yet loaded
   * (edit-mode pre-population — form receives the FK id from server
   * data and displays the human-readable label without re-fetching).
   */
  selectedLabel?: string;
  /** Debounce window in ms. Default 300. */
  debounceMs?: number;
}

export function AsyncSelect<T>({
  fetchOptions,
  getOptionLabel,
  getOptionValue,
  value,
  onChange,
  placeholder = 'Search...',
  disabled = false,
  selectedLabel,
  debounceMs = 300,
}: AsyncSelectProps<T>) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<T[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Display label when a value is selected: prefer the cached selectedLabel
  // (from edit-mode pre-population), fallback to matching the option in the
  // current options list.
  const displayValue = (() => {
    if (!value) return '';
    if (isOpen) return query; // While dropdown is open, show what user typed
    const matched = options.find((o) => getOptionValue(o) === value);
    if (matched) return getOptionLabel(matched);
    return selectedLabel ?? '';
  })();

  // Debounced fetch when query changes (only while dropdown is open).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await fetchOptions(query);
        if (!cancelled) setOptions(result);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Search failed');
          setOptions([]);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, isOpen, fetchOptions, debounceMs]);

  // Click-outside to close dropdown.
  useEffect(() => {
    if (!isOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [isOpen]);

  const handleSelect = (option: T) => {
    onChange(getOptionValue(option));
    setIsOpen(false);
    setQuery('');
  };

  const handleClear = () => {
    onChange(null);
    setQuery('');
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="flex gap-2">
        <Input
          type="text"
          value={isOpen ? query : displayValue}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!isOpen) setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder}
          disabled={disabled}
          className="flex-1"
          autoComplete="off"
        />
        {value && !disabled ? (
          <Button
            type="button"
            variant="outline"
            onClick={handleClear}
            aria-label="Clear selection"
          >
            Clear
          </Button>
        ) : null}
      </div>

      {isOpen && !disabled ? (
        <div
          className="absolute top-full left-0 right-0 mt-1 max-h-64 overflow-y-auto bg-white border rounded-md shadow-lg z-50"
          style={{ borderColor: 'var(--ds-border-default)' }}
        >
          {isLoading ? (
            <div className="px-3 py-2 text-sm" style={{ color: 'var(--ds-ink-tertiary)' }}>
              Searching…
            </div>
          ) : error ? (
            <div className="px-3 py-2 text-sm" style={{ color: 'var(--ds-danger-text)' }}>
              {error}
            </div>
          ) : options.length === 0 ? (
            <div className="px-3 py-2 text-sm" style={{ color: 'var(--ds-ink-tertiary)' }}>
              {query ? 'No results' : 'Type to search…'}
            </div>
          ) : (
            <ul role="listbox" className="py-1">
              {options.map((option) => {
                const optionValue = getOptionValue(option);
                const optionLabel = getOptionLabel(option);
                const isSelected = optionValue === value;
                return (
                  <li key={optionValue} role="option" aria-selected={isSelected}>
                    <button
                      type="button"
                      onClick={() => handleSelect(option)}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 ${
                        isSelected ? 'bg-gray-100 font-medium' : ''
                      }`}
                    >
                      {optionLabel}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
