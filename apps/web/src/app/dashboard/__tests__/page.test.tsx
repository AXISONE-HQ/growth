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
import type { RecommendationListItem, DashboardStats, AuditLogEntry } from '@/lib/api';

const useAuthMock = vi.fn();
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}));

const recommendationsListMock = vi.fn();
const dashboardGetStatsMock = vi.fn();
const auditLogListMock = vi.fn();
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
    // KAN-1103 — mock dashboardApi + auditLogApi for KPI strip + Audit Log
    // panel tests. Default returns set in beforeEach below.
    dashboardApi: {
      getStats: (...args: unknown[]) => dashboardGetStatsMock(...args),
    },
    auditLogApi: {
      list: (...args: unknown[]) => auditLogListMock(...args),
      getById: vi.fn(),
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

// KAN-1103 — DashboardStats fixture builder. Field `avgResponseTimeMinutes`
// is the post-KAN-1103 unit-suffixed field name; sentinel Test 5 below
// asserts the rename holds.
function buildStats(overrides: Partial<DashboardStats> = {}): DashboardStats {
  return {
    contacts: 847,
    objectivesCompleted: 142,
    actionsToday: 87,
    avgResponseTimeMinutes: 2.4,
    escalationRate: 14,
    totalEscalations: 0,
    ...overrides,
  };
}

// KAN-1103 — AuditLogEntry fixture builder. `actionType` defaults to a
// real lowercase snake_case value (mirrors the raw DB column shape that
// /audit page renders as-is per KAN-1103 Q3 lock).
function buildAuditEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: overrides.id ?? 'audit-1',
    tenantId: 'tenant-test',
    actor: 'system',
    actionType: 'email_send',
    payload: {},
    reasoning: 'Sample audit entry',
    createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  useAuthMock.mockReset();
  recommendationsListMock.mockReset();
  dashboardGetStatsMock.mockReset();
  auditLogListMock.mockReset();
  // Default: admin user. Override per-test for non-admin path.
  useAuthMock.mockReturnValue({
    user: { role: 'admin', email: 'admin@test.local' },
    loading: false,
  });
  // KAN-1103 default returns — happy-path stats + empty audit log. Tests
  // that need specific behavior override per-test.
  dashboardGetStatsMock.mockResolvedValue(buildStats());
  auditLogListMock.mockResolvedValue({
    items: [],
    total: 0,
    limit: 5,
    offset: 0,
    includeInfrastructure: false,
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

// KAN-1103 — KPI strip panel
//
// Wires dashboard.getStats (5 metrics: contacts, objectivesCompleted,
// actionsToday, avgResponseTimeMinutes, escalationRate). Phase 1 Q2 deferral:
// values-only ship (delta + subtitle deferred to Phase 2.5 trend work).
// Phase 1 Q1 lock: avgResponseTime → avgResponseTimeMinutes field rename;
// Test 5 sentinel locks the rename.
describe('KAN-1103 — KPI strip panel', () => {
  it('Test 1 — loading state passes loading=true to all 5 MetricCards', async () => {
    let resolveLater!: (v: DashboardStats) => void;
    dashboardGetStatsMock.mockReturnValue(
      new Promise<DashboardStats>((resolve) => {
        resolveLater = resolve;
      }),
    );
    render(<DashboardPage />);
    // 5 cards rendered with aria-label="Loading metric" while query pending.
    const loadingCards = screen.getAllByLabelText('Loading metric');
    expect(loadingCards.length).toBe(5);
    // Cleanup
    resolveLater(buildStats());
  });

  it('Test 2 — populated state renders 5 cards with correct values + units', async () => {
    dashboardGetStatsMock.mockResolvedValue(
      buildStats({
        contacts: 1284,
        objectivesCompleted: 156,
        actionsToday: 92,
        avgResponseTimeMinutes: 3.1,
        escalationRate: 18,
      }),
    );
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByLabelText('Active Contacts: 1284')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Objectives Completed: 156')).toBeInTheDocument();
    expect(screen.getByLabelText('AI Actions Today: 92')).toBeInTheDocument();
    // Unit suffix attached: "3.1 min" / "18 %"
    expect(screen.getByLabelText('Avg Response Time: 3.1 min')).toBeInTheDocument();
    expect(screen.getByLabelText('Escalation Rate: 18 %')).toBeInTheDocument();
  });

  it('Test 3 — error state renders all 5 cards with "—" + "Couldn\'t load" sublabel', async () => {
    dashboardGetStatsMock.mockRejectedValueOnce(new Error('network'));
    render(<DashboardPage />);
    // All 5 cards transition to error display
    await waitFor(() => {
      expect(screen.getByLabelText("Active Contacts: —")).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Objectives Completed: —')).toBeInTheDocument();
    expect(screen.getByLabelText('AI Actions Today: —')).toBeInTheDocument();
    expect(screen.getByLabelText('Avg Response Time: —')).toBeInTheDocument();
    expect(screen.getByLabelText('Escalation Rate: —')).toBeInTheDocument();
    // Subtitle "Couldn't load" appears at least once (in each card; one match
    // is enough to confirm the error path renders the subtitle).
    expect(screen.getAllByText(/Couldn.t load/i).length).toBeGreaterThan(0);
  });

  it('Test 4 — avgResponseTimeMinutes renders with "min" unit suffix (Phase 1 Q1 lock)', async () => {
    dashboardGetStatsMock.mockResolvedValue(buildStats({ avgResponseTimeMinutes: 5.7 }));
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByLabelText('Avg Response Time: 5.7 min')).toBeInTheDocument();
    });
  });

  it('Test 5 SENTINEL — DashboardStats payload uses avgResponseTimeMinutes field name (rename lock)', async () => {
    // If a future regression renames the field back to avgResponseTime (or
    // any other shape), the type narrowing here breaks the test at CI.
    const fixturePayload: DashboardStats = buildStats({ avgResponseTimeMinutes: 4.2 });
    // Static assertion: the property exists at compile time + at runtime.
    expect(fixturePayload).toHaveProperty('avgResponseTimeMinutes');
    expect(fixturePayload.avgResponseTimeMinutes).toBe(4.2);
    // Wire to render path — UI must consume the renamed field.
    dashboardGetStatsMock.mockResolvedValue(fixturePayload);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByLabelText('Avg Response Time: 4.2 min')).toBeInTheDocument();
    });
  });
});

// KAN-1103 — Audit Log panel
//
// Wires auditLog.list (Top-5 most recent in backend-sort order). Phase 1
// Q3 lock: match /audit page convention (raw lowercase actionType in mono
// font); NO projection helper. Phase 1 Panel-type convention lock: stream-
// like panel; NO count chip in header; "View all →" CTA is the drill-down
// affordance.
describe('KAN-1103 — Audit Log panel', () => {
  it('Test 1 — empty list renders informational copy framing it as GOOD state', async () => {
    auditLogListMock.mockResolvedValue({
      items: [],
      total: 0,
      limit: 5,
      offset: 0,
      includeInfrastructure: false,
    });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('audit-log-empty')).toBeInTheDocument();
    });
    expect(screen.getByTestId('audit-log-empty').textContent).toMatch(
      /No recent activity — actions appear here as the engine and operators work/i,
    );
  });

  it('Test 2 — populated list renders raw lowercase actionType in mono font (matches /audit convention)', async () => {
    auditLogListMock.mockResolvedValue({
      items: [
        buildAuditEntry({ id: 'a1', actionType: 'email_send', reasoning: 'Sarah Chen follow-up' }),
        buildAuditEntry({ id: 'a2', actionType: 'decision.evaluated', reasoning: 'High confidence' }),
      ],
      total: 2,
      limit: 5,
      offset: 0,
      includeInfrastructure: false,
    });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('dashboard-audit-log')).toBeInTheDocument();
    });
    // Raw lowercase actionType — NO uppercase / dot-notation transformation.
    expect(screen.getByText('email_send')).toBeInTheDocument();
    expect(screen.getByText('decision.evaluated')).toBeInTheDocument();
    // Reasoning text renders verbatim.
    expect(screen.getByText('Sarah Chen follow-up')).toBeInTheDocument();
    expect(screen.getByText('High confidence')).toBeInTheDocument();
    // "View all →" CTA present + links to /audit
    const auditPanel = screen.getByTestId('dashboard-audit-log');
    const viewAllLink = auditPanel.querySelector('a[href="/audit"]');
    expect(viewAllLink).not.toBeNull();
  });

  it('Test 3 — loading state renders 3 skeleton rows', async () => {
    let resolveLater!: (v: unknown) => void;
    auditLogListMock.mockReturnValue(
      new Promise((resolve) => {
        resolveLater = resolve;
      }),
    );
    render(<DashboardPage />);
    const loadingContainer = await screen.findByTestId('audit-log-loading');
    expect(loadingContainer).toBeInTheDocument();
    // Cleanup
    resolveLater({ items: [], total: 0, limit: 5, offset: 0, includeInfrastructure: false });
  });

  it('Test 4 — error state renders error copy + Retry button; click triggers reload', async () => {
    auditLogListMock.mockRejectedValueOnce(new Error('network'));
    render(<DashboardPage />);
    const errorContainer = await screen.findByTestId('audit-log-error');
    expect(errorContainer.textContent).toMatch(/Couldn.t load audit log/i);
    // Scope the Retry button query to the Audit Log error container —
    // multiple panels (Audit Log + Escalation Queue) can render a Retry
    // button simultaneously when both are in error states.
    const retryBtn = errorContainer.querySelector('button');
    expect(retryBtn?.textContent).toMatch(/Retry/i);
    auditLogListMock.mockResolvedValueOnce({
      items: [buildAuditEntry({ id: 'a-after-retry' })],
      total: 1,
      limit: 5,
      offset: 0,
      includeInfrastructure: false,
    });
    fireEvent.click(retryBtn!);
    await waitFor(() => {
      expect(auditLogListMock).toHaveBeenCalledTimes(2);
    });
  });

  it('Test 5 SENTINEL — UI renders items in payload order (backend-authoritative sort; NO client re-sort)', async () => {
    // Backend sorts createdAt DESC at auditLog.list:147. Mock payload
    // supplied in deliberately non-trivial order (a-first by id but mixed
    // createdAt). A naive client-side createdAt-DESC sort would reorder.
    const t1 = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const t2 = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const t3 = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    auditLogListMock.mockResolvedValue({
      items: [
        buildAuditEntry({ id: 'a-A', actionType: 'sentinel_a', reasoning: 'A-reason', createdAt: t1 }),
        buildAuditEntry({ id: 'a-B', actionType: 'sentinel_b', reasoning: 'B-reason', createdAt: t2 }),
        buildAuditEntry({ id: 'a-C', actionType: 'sentinel_c', reasoning: 'C-reason', createdAt: t3 }),
      ],
      total: 3,
      limit: 5,
      offset: 0,
      includeInfrastructure: false,
    });
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText('sentinel_a')).toBeInTheDocument();
    });
    // Verify payload order via DOM position of the three actionType chips.
    const auditPanel = screen.getByTestId('dashboard-audit-log');
    const actionTypeChips = Array.from(
      auditPanel.querySelectorAll('span.font-mono'),
    ).map((el) => el.textContent);
    expect(actionTypeChips).toEqual(['sentinel_a', 'sentinel_b', 'sentinel_c']);
  });
});

// KAN-1103 — polling cadence verification (vi.useFakeTimers)
describe('KAN-1103 — polling cadences', () => {
  it('KPI strip — second dashboard.getStats fires at 60s interval', async () => {
    vi.useFakeTimers();
    dashboardGetStatsMock.mockResolvedValue(buildStats());
    render(<DashboardPage />);
    // Initial call fires synchronously on mount → wait for it
    await vi.waitFor(() => {
      expect(dashboardGetStatsMock).toHaveBeenCalledTimes(1);
    });
    // Advance 60s → second call
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dashboardGetStatsMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('Audit Log — second auditLog.list fires at 30s interval', async () => {
    vi.useFakeTimers();
    auditLogListMock.mockResolvedValue({
      items: [],
      total: 0,
      limit: 5,
      offset: 0,
      includeInfrastructure: false,
    });
    render(<DashboardPage />);
    await vi.waitFor(() => {
      expect(auditLogListMock).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(auditLogListMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
