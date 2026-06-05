/**
 * KAN-1087 — SparseDataBadge component render tests.
 *
 * Matches against container.textContent (concatenated) since the badge
 * interpolates <strong> across the text — RTL's getByText doesn't
 * normalize across element boundaries.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SparseDataBadge } from '../sparse-data-badge';

describe('SparseDataBadge', () => {
  it('shows row count + window label with singular event when totalTier1Rows === 1', () => {
    const { container } = render(<SparseDataBadge totalTier1Rows={1} windowLabel="last 7 days" />);
    expect(container.textContent).toMatch(/Window\s*last 7 days\s*covers\s*1\s*engine event\s*$/);
  });

  it('pluralizes when totalTier1Rows !== 1', () => {
    const { container } = render(<SparseDataBadge totalTier1Rows={17} windowLabel="last 30 days" />);
    expect(container.textContent).toMatch(/17\s*engine events\s*$/);
  });

  it('handles zero rows gracefully', () => {
    const { container } = render(<SparseDataBadge totalTier1Rows={0} windowLabel="last 24h" />);
    expect(container.textContent).toMatch(/0\s*engine events\s*$/);
  });

  it('formats large numbers with locale separators', () => {
    const { container } = render(<SparseDataBadge totalTier1Rows={12345} windowLabel="last 30 days" />);
    expect(container.textContent).toMatch(/12,345\s*engine events\s*$/);
  });
});
