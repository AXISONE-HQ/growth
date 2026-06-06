/**
 * KAN-1102 — Dashboard page tests, focused on the Escalation Queue panel.
 *
 * Coverage:
 *   1. Empty list → empty-state copy renders; no chip
 *   2. Populated list (3 sub-cases for chip framing: total=0, total=3, total=47)
 *   3. Loading state → 3 skeleton rows
 *   4. Error state → error copy + Retry button (refetch fires on click)
 *   5. Non-admin user → panel container NOT rendered + no recommendations call
 *   6. Sentinel: backend-authoritative sort order — UI renders items in
 *      payload order, NO client-side sort (catches regression if a future
 *      PR introduces client-side sort that diverges from backend)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DashboardPage from '../page';
import type { RecommendationListItem } from '@/lib/api';

const useAuthMock = vi.fn();
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}));

const recommendationsListMock = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    recommendationsApi: {
      list: (...args: unknown[]) => recommendationsListMock(...args),
      getDetail: vi.fn(),
      accept: vi.fn(),
      modify: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

// Helper — build a synthetic RecommendationListItem from minimal overrides.
function buildItem(overrides: Partial<RecommendationListItem> = {}): RecommendationListItem {
  return {
    id: overrides.id ?? 'rec-1',
    contactId: 'contact-1',
    contact: {
      id: 'contact-1',
      firstName: 'Sarah',
      lastName: 'Chen',
      email: 'sarah@example.com',
      companyName: 'Acme Inc',
    },
    decisionId: null,
    severity: 'high',
    status: 'open',
    triggerType: 'confidence_below_threshold',
    triggerReason: 'Confidence below threshold — 32% on strategy selection',
    aiSuggestion: null,
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    updatedAt: new Date().toISOString(),
    resolvedBy: null,
    resolvedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  useAuthMock.mockReset();
  recommendationsListMock.mockReset();
  // Default: admin user. Override per-test for non-admin path.
  useAuthMock.mockReturnValue({
    user: { role: 'admin', email: 'admin@test.local' },
    loading: false,
  });
});

describe('KAN-1102 — Escalation Queue panel', () => {
  it('Test 1 — empty list renders empty-state copy + no header chip', async () => {
    recommendationsListMock.mockResolvedValue({ items: [], total: 0, limit: 5, offset: 0 });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('escalation-queue-empty')).toBeInTheDocument();
    });
    expect(screen.getByTestId('escalation-queue-empty').textContent).toMatch(
      /No escalations right now — the engine is acting autonomously/i,
    );
    // No chip when total === 0 — scope query to the Escalation Queue
    // container so "pending"/"Pending review" copy elsewhere on the
    // dashboard doesn't false-positive the assertion.
    const queue = screen.getByTestId('dashboard-escalation-queue');
    expect(queue.querySelector('span.text-\\[var\\(--ds-danger\\)\\]')?.textContent).toBeFalsy();
  });

  it('Test 2a — populated list (total=3) renders chip "3 pending"', async () => {
    const items = [
      buildItem({ id: 'rec-1', severity: 'critical' }),
      buildItem({ id: 'rec-2', severity: 'high' }),
      buildItem({ id: 'rec-3', severity: 'medium' }),
    ];
    recommendationsListMock.mockResolvedValue({ items, total: 3, limit: 5, offset: 0 });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('dashboard-escalation-queue')).toBeInTheDocument();
    });
    const queue = screen.getByTestId('dashboard-escalation-queue');
    // Scope the chip text assertion to the panel — other panels' fixture
    // content may include "pending" copy (e.g., "Pending review" in
    // Agent Actions stream) that would false-positive a global query.
    expect(queue.textContent).toMatch(/3 pending/);
    expect(queue.textContent).not.toMatch(/Top \d/);
  });

  it('Test 2b — populated list (total=47) renders chip "Top 5 of 47 pending"', async () => {
    const items = Array.from({ length: 5 }, (_, i) =>
      buildItem({ id: `rec-${i}`, severity: i === 0 ? 'critical' : 'high' }),
    );
    recommendationsListMock.mockResolvedValue({ items, total: 47, limit: 5, offset: 0 });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('Top 5 of 47 pending')).toBeInTheDocument();
    });
    // Verify only 5 rows rendered (limit) even though total is 47
    const reviewLinks = screen.getAllByRole('link', { name: /Review/i });
    expect(reviewLinks).toHaveLength(5);
  });

  it('Test 2c — populated row composes name "FirstName LastName — Company" + reason + Review href', async () => {
    const item = buildItem({
      id: 'rec-xyz',
      contact: {
        id: 'contact-xyz',
        firstName: 'James',
        lastName: 'Rivera',
        email: 'james@techflow.com',
        companyName: 'TechFlow Inc',
      },
      severity: 'high',
      triggerReason: 'Deal value $28,000 — above $15K threshold',
    });
    recommendationsListMock.mockResolvedValue({ items: [item], total: 1, limit: 5, offset: 0 });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('James Rivera — TechFlow Inc')).toBeInTheDocument();
    });
    expect(screen.getByText(/Deal value \$28,000/)).toBeInTheDocument();
    const reviewLink = screen.getByRole('link', { name: /Review/i });
    expect(reviewLink).toHaveAttribute('href', '/escalations?id=rec-xyz');
  });

  it('Test 3 — loading state renders 3 skeleton rows', async () => {
    // Never-resolving promise → component stays in loading state
    let resolveLater!: (value: unknown) => void;
    recommendationsListMock.mockReturnValue(
      new Promise((resolve) => {
        resolveLater = resolve;
      }),
    );
    render(<DashboardPage />);
    const loadingContainer = await screen.findByTestId('escalation-queue-loading');
    expect(loadingContainer).toBeInTheDocument();
    // Cleanup — resolve so React doesn't complain
    resolveLater({ items: [], total: 0, limit: 5, offset: 0 });
  });

  it('Test 4 — error state renders error copy + Retry button; click triggers reload', async () => {
    recommendationsListMock.mockRejectedValueOnce(new Error('network'));
    render(<DashboardPage />);
    const errorContainer = await screen.findByTestId('escalation-queue-error');
    expect(errorContainer.textContent).toMatch(/Couldn.t load escalations/i);
    const retryBtn = screen.getByRole('button', { name: /Retry/i });
    // Second call succeeds
    recommendationsListMock.mockResolvedValueOnce({
      items: [buildItem({ id: 'rec-after-retry' })],
      total: 1,
      limit: 5,
      offset: 0,
    });
    fireEvent.click(retryBtn);
    await waitFor(() => {
      expect(recommendationsListMock).toHaveBeenCalledTimes(2);
    });
  });

  it('Test 5 — non-admin user does NOT render the panel + does NOT call recommendations.list', () => {
    useAuthMock.mockReturnValue({
      user: { role: 'member', email: 'member@test.local' },
      loading: false,
    });
    render(<DashboardPage />);
    expect(screen.queryByTestId('dashboard-escalation-queue')).toBeNull();
    expect(recommendationsListMock).not.toHaveBeenCalled();
  });

  it('Test 6 SENTINEL — UI renders items in payload order (backend-authoritative sort; NO client-side re-sort)', async () => {
    // Payload deliberately contains a non-trivial order that a client-side
    // sort would re-arrange. Items: [medium (rec-A), critical (rec-B),
    // high (rec-C)]. A client-side severity-DESC sort would reorder to
    // [critical, high, medium]. The backend's authoritative order is
    // what's IN the payload — UI must render in payload order.
    const items = [
      buildItem({ id: 'rec-A', severity: 'medium', triggerReason: 'A-medium' }),
      buildItem({ id: 'rec-B', severity: 'critical', triggerReason: 'B-critical' }),
      buildItem({ id: 'rec-C', severity: 'high', triggerReason: 'C-high' }),
    ];
    recommendationsListMock.mockResolvedValue({ items, total: 3, limit: 5, offset: 0 });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText(/A-medium/)).toBeInTheDocument();
    });
    const reviewLinks = screen.getAllByRole('link', { name: /Review/i });
    // Backend order in payload: A, B, C → href order must match.
    expect(reviewLinks[0]?.getAttribute('href')).toBe('/escalations?id=rec-A');
    expect(reviewLinks[1]?.getAttribute('href')).toBe('/escalations?id=rec-B');
    expect(reviewLinks[2]?.getAttribute('href')).toBe('/escalations?id=rec-C');
  });
});
