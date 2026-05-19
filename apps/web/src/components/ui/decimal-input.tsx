'use client';

/**
 * KAN-932 — DecimalInput (Cohort 3 Foundation).
 *
 * Handles Prisma Decimal's string serialization shape per
 * `feedback_prisma_decimal_serializes_as_string.md` memory note.
 * Round-trips `string | null` to avoid floating-point drift.
 *
 * Display: en-US formatting ($250.00 with 2-decimal precision) when
 * the input is not focused. While focused: raw editable value. Locale-
 * aware formatting (1 234,56 fr-CA) deferred to Cohort 3.x — V1 displays
 * en-US for all users; file as polish ticket if Quebec users complain.
 *
 * Input semantics:
 *   - Accepts digits + dot + comma (commas stripped on parse)
 *   - Validates max-2-decimal-places
 *   - Enforces value >= 0 (no negatives in V1; can extend with `min` prop later)
 *   - Empty string → null (matches Prisma's nullable Decimal column shape)
 */
import { useState } from 'react';
import { Input } from './input';

export interface DecimalInputProps {
  value: string | null;
  onChange: (value: string | null) => void;
  /** Currency code for display formatting. Default: 'USD'. */
  currency?: string;
  /** Minimum value (default 0). */
  min?: number;
  /** Maximum decimal places (default 2). */
  maxDecimals?: number;
  disabled?: boolean;
  placeholder?: string;
  /** ID for label htmlFor binding. */
  id?: string;
  /** ARIA label if no visible label. */
  'aria-label'?: string;
}

/** Parse a raw input string into a clean numeric-string or null.
 *  Returns null for empty / invalid input.
 *  Returns the cleaned string (e.g., "1234.56") for valid input. */
function parseDecimalString(raw: string, maxDecimals: number): string | null {
  if (!raw) return null;
  // Strip commas (thousands separators).
  const stripped = raw.replace(/,/g, '').trim();
  if (!stripped) return null;
  // Validate: digits + optional one dot + up to maxDecimals digits.
  const re = new RegExp(`^\\d+(\\.\\d{0,${maxDecimals}})?$`);
  if (!re.test(stripped)) return null;
  // Strip leading zeros but preserve "0.xx" shape.
  const [intPart, decPart] = stripped.split('.');
  const cleanedInt = intPart.replace(/^0+(?=\d)/, '') || '0';
  return decPart != null ? `${cleanedInt}.${decPart}` : cleanedInt;
}

/** Format a clean numeric-string for display (en-US, 2-decimal pad).
 *  null → empty string. */
function formatDecimalDisplay(value: string | null, maxDecimals: number, currency?: string): string {
  if (value == null || value === '') return '';
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  const formatter = new Intl.NumberFormat('en-US', {
    style: currency ? 'currency' : 'decimal',
    currency: currency,
    minimumFractionDigits: maxDecimals,
    maximumFractionDigits: maxDecimals,
  });
  return formatter.format(num);
}

export function DecimalInput({
  value,
  onChange,
  currency,
  min = 0,
  maxDecimals = 2,
  disabled = false,
  placeholder,
  id,
  'aria-label': ariaLabel,
}: DecimalInputProps) {
  const [isFocused, setIsFocused] = useState(false);
  const [draftValue, setDraftValue] = useState<string>(value ?? '');

  // When external value changes while not focused, reset draft.
  // When focused, leave the user's in-progress typing alone.
  const displayedValue = isFocused
    ? draftValue
    : formatDecimalDisplay(value, maxDecimals, currency);

  const handleChange = (raw: string) => {
    setDraftValue(raw);
    const parsed = parseDecimalString(raw, maxDecimals);
    if (parsed === null) {
      onChange(null);
      return;
    }
    if (Number(parsed) < min) {
      // Reject below-min by NOT propagating; keep draft for user to see.
      return;
    }
    onChange(parsed);
  };

  const handleBlur = () => {
    setIsFocused(false);
    // Sync draft with parsed value (drops invalid trailing chars).
    setDraftValue(value ?? '');
  };

  const handleFocus = () => {
    setIsFocused(true);
    // Show raw editable value (not the en-US formatted one).
    setDraftValue(value ?? '');
  };

  return (
    <Input
      type="text"
      inputMode="decimal"
      value={displayedValue}
      onChange={(e) => handleChange(e.target.value)}
      onFocus={handleFocus}
      onBlur={handleBlur}
      disabled={disabled}
      placeholder={placeholder ?? (currency ? `0.00 ${currency}` : '0.00')}
      id={id}
      aria-label={ariaLabel}
      autoComplete="off"
    />
  );
}
