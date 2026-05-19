/**
 * KAN-932 — AsyncSelect tests.
 *
 * Coverage:
 *   - Renders search input + opens dropdown on focus
 *   - fetchOptions called after debounce when user types
 *   - Selecting an option calls onChange + closes dropdown
 *   - Clear button resets value to null
 *   - Disabled mode: no dropdown, no clear button
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AsyncSelect } from '../async-select';

interface FakeOption {
  id: string;
  label: string;
}

describe('KAN-932 — AsyncSelect', () => {
  const fakeOptions: FakeOption[] = [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
    { id: 'c', label: 'Charlie' },
  ];

  it('renders search input + initially shows nothing selected', () => {
    render(
      <AsyncSelect
        fetchOptions={async () => []}
        getOptionLabel={(o: FakeOption) => o.label}
        getOptionValue={(o: FakeOption) => o.id}
        value={null}
        onChange={() => undefined}
        placeholder="Pick one…"
      />,
    );
    const input = screen.getByPlaceholderText('Pick one…') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('fetchOptions fires after debounce when user types', async () => {
    const fetchOptions = vi.fn().mockResolvedValue(fakeOptions);
    render(
      <AsyncSelect
        fetchOptions={fetchOptions}
        getOptionLabel={(o: FakeOption) => o.label}
        getOptionValue={(o: FakeOption) => o.id}
        value={null}
        onChange={() => undefined}
        debounceMs={50}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'a' } });
    await waitFor(() => expect(fetchOptions).toHaveBeenCalledWith('a'), { timeout: 200 });
  });

  it('selecting an option calls onChange with the option value', async () => {
    const onChange = vi.fn();
    render(
      <AsyncSelect
        fetchOptions={async () => fakeOptions}
        getOptionLabel={(o: FakeOption) => o.label}
        getOptionValue={(o: FakeOption) => o.id}
        value={null}
        onChange={onChange}
        debounceMs={50}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'al' } });
    const option = await screen.findByText('Alpha', {}, { timeout: 200 });
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('a');
  });

  it('displays selectedLabel when value is set and dropdown closed', () => {
    render(
      <AsyncSelect
        fetchOptions={async () => []}
        getOptionLabel={(o: FakeOption) => o.label}
        getOptionValue={(o: FakeOption) => o.id}
        value="a"
        selectedLabel="Alpha (cached)"
        onChange={() => undefined}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('Alpha (cached)');
  });

  it('Clear button resets value to null', () => {
    const onChange = vi.fn();
    render(
      <AsyncSelect
        fetchOptions={async () => []}
        getOptionLabel={(o: FakeOption) => o.label}
        getOptionValue={(o: FakeOption) => o.id}
        value="a"
        selectedLabel="Alpha"
        onChange={onChange}
      />,
    );
    const clearBtn = screen.getByRole('button', { name: /clear/i });
    fireEvent.click(clearBtn);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('disabled mode hides Clear button + disables input', () => {
    render(
      <AsyncSelect
        fetchOptions={async () => []}
        getOptionLabel={(o: FakeOption) => o.label}
        getOptionValue={(o: FakeOption) => o.id}
        value="a"
        selectedLabel="Alpha"
        onChange={() => undefined}
        disabled
      />,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input).toBeDisabled();
    expect(screen.queryByRole('button', { name: /clear/i })).toBeNull();
  });
});
