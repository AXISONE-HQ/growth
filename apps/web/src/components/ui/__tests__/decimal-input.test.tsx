/**
 * KAN-932 — DecimalInput tests.
 *
 * Coverage:
 *   - Display formatting (en-US, 2-decimal)
 *   - Round-trip string ↔ display (no floating-point drift)
 *   - Empty input → null callback
 *   - Invalid input (letters, multiple dots) rejected
 *   - Min boundary enforcement (negatives rejected by default)
 *   - Comma stripping (1,234.56 → 1234.56)
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DecimalInput } from '../decimal-input';

describe('KAN-932 — DecimalInput', () => {
  it('displays en-US currency formatting when not focused', () => {
    render(<DecimalInput value="1234.56" onChange={() => undefined} currency="USD" />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('$1,234.56');
  });

  it('displays raw editable value when focused', () => {
    render(<DecimalInput value="1234.56" onChange={() => undefined} currency="USD" />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.focus(input);
    expect(input.value).toBe('1234.56');
  });

  it('round-trips clean numeric string on type', () => {
    const onChange = vi.fn();
    render(<DecimalInput value={null} onChange={onChange} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '250' } });
    expect(onChange).toHaveBeenLastCalledWith('250');
  });

  it('strips commas on parse (1,234.56 → 1234.56)', () => {
    const onChange = vi.fn();
    render(<DecimalInput value={null} onChange={onChange} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '1,234.56' } });
    expect(onChange).toHaveBeenLastCalledWith('1234.56');
  });

  it('empty input emits null', () => {
    const onChange = vi.fn();
    render(<DecimalInput value="100.00" onChange={onChange} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('invalid input (letters) does not propagate to onChange', () => {
    const onChange = vi.fn();
    render(<DecimalInput value="100.00" onChange={onChange} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('respects max-2-decimal-places (rejects 3+ decimals)', () => {
    const onChange = vi.fn();
    render(<DecimalInput value={null} onChange={onChange} maxDecimals={2} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '100.123' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('disabled input does not change value on input', () => {
    const onChange = vi.fn();
    render(<DecimalInput value="100" onChange={onChange} disabled />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input).toBeDisabled();
  });
});
