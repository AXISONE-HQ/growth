'use client';

/**
 * KAN-985 Phase C.2 — Dashboard reskin.
 *   - Top Stats Row → MetricCard (KAN-979 primitive)
 *   - AssistantCard (KAN-983) added below the stats row
 *   - Pre-existing mojibake fixed on trend arrows + Show reasoning toggle
 *     + section-divider comments + checkmarks + em-dashes + middle-dot
 *     separators (UTF-8 → Latin-1 corruption from the original Apr-16 commit)
 *   - Hardcoded bg-white / border-gray-200 / text-gray-* / bg-indigo-* /
 *     text-indigo-* migrated to token-based classes (bg-card / border-border
 *     / text-foreground / text-muted-foreground / --ds-violet-*)
 *
 * Demo data preserved; behavior preserved (expand/collapse decision rows).
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  Brain,
  Activity,
  Megaphone,
  Clock,
  AlertTriangle,
  MessageSquare,
  Mail,
  Calendar,
  Flag,
  BarChart3,
  FileText,
  ChevronRight,
  ChevronDown,
  Users,
  Target,
} from 'lucide-react';
import { MetricCard } from '@/components/growth/metric-card';
import { AssistantCard } from '@/components/ui/assistant-card';
// KAN-1102 — Escalation Queue wire-up to recommendations.list (KAN-754
// adminProcedure). Three-layer admin defense: server adminProcedure (already
// in place) + client useAuth check (this file) + panel-level conditional
// render. Mirrors the KAN-1100 moverLinks pattern for admin-conditional UI.
import { useAuth } from '@/lib/AuthContext';
import {
  recommendationsApi,
  type RecommendationListItem,
  // KAN-1103 — Dashboard v2 PR 2: KPI strip + Audit Log wire-up adapters.
  dashboardApi,
  type DashboardStats,
  auditLogApi,
  type AuditLogEntry,
} from '@/lib/api';
import { severityBadge } from '@/lib/severity-projection';
import { formatRelativeTime } from '@/lib/format-relative-time';
import { Badge } from '@/components/ui/badge';

// ─── KPI strip (KAN-1103 — wired to dashboard.getStats) ───────────────
// KAN-1103 — fixture removed; data flows from dashboard.getStats via the
// useKpis hook inside DashboardPage. Render block at line ~ "Stats Row"
// consumes the hook result.
//
// Phase 1 Q2 deferral: all 5 KPIs ship values-only (delta=undefined,
// subtitle=undefined). Trend sub-labels ("+ 23 this week", "↑ 18%", etc.)
// are Phase 2.5 backend work post-Designer-activation.

// KAN-1103 — KPI polling cadence: 60s. KPIs change slowly; aggressive
// polling burns Prisma without operator benefit.
const KPI_POLL_MS = 60_000;

// KAN-1103 — KPI card config keys map 1:1 to DashboardStats fields. Order
// matches the fixture's visual layout (Active Contacts → Escalation Rate).
const KPI_CARDS: Array<{
  key: keyof DashboardStats;
  label: string;
  unit?: string;
  icon: typeof Users;
}> = [
  { key: 'contacts', label: 'Active Contacts', icon: Users },
  { key: 'objectivesCompleted', label: 'Objectives Completed', icon: Target },
  { key: 'actionsToday', label: 'AI Actions Today', icon: Activity },
  { key: 'avgResponseTimeMinutes', label: 'Avg Response Time', unit: 'min', icon: Clock },
  { key: 'escalationRate', label: 'Escalation Rate', unit: '%', icon: AlertTriangle },
];

// ─── Audit Log (KAN-1103 — wired to auditLog.list) ────────────────────
// KAN-1103 — fixture removed; data flows from auditLog.list via the
// useAuditLog hook inside DashboardPage. Render block consumes the result.
//
// Phase 1 Q3 lock: match /audit page convention. Render raw lowercase
// actionType in monospace font; NO projection helper. Sibling /audit
// page renders the same shape; consistency > prettification.
//
// Phase 1 Q4 lock: empty copy frames it as informational (audit log
// grows continuously; "no recent" is temporal state, not failure).
// Designer refines in Phase 4 polish.
//
// Phase 1 Panel-type convention: stream-like panel. NO count chip in
// header (chips imply queue semantics). "View all →" CTA at footer is
// the drill-down affordance.
const AUDIT_LOG_POLL_MS = 30_000;
const AUDIT_LOG_LIMIT = 5;

// ─── Pipeline Health ──────────────────────────────────────────────────
const pipelines = [
  {
    name: 'Sales Pipeline', color: 'bg-indigo-500', value: '$124,900', leads: '16', confidence: '62%',
    progressLabel: 'Revenue Won', progressValue: '$41,200 / $125K', progressPct: 33, progressColor: 'from-emerald-500 to-emerald-400',
    objectives: [
      { text: 'First 10 leads ingested', status: 'done' },
      { text: 'Automation rules configured', status: 'done' },
      { text: 'Close 5 deals this quarter', status: 'active', tag: '2/5' },
      { text: 'Reach $125K pipeline target', status: 'pending' },
    ],
  },
  {
    name: 'Re-engagement', color: 'bg-amber-500', value: '$56,000', leads: '8', confidence: '41%',
    progressLabel: 'Win-Back Rate', progressValue: '3 / 8 leads', progressPct: 38, progressColor: 'from-amber-500 to-amber-400',
    objectives: [
      { text: 'Dormant leads identified', status: 'done' },
      { text: 'Re-engage 5 churned accounts', status: 'active', tag: '3/5' },
      { text: 'Convert 2 win-backs to revenue', status: 'pending' },
    ],
  },
  {
    name: 'Upsell / Expansion', color: 'bg-emerald-500', value: '$38,400', leads: '6', confidence: '78%',
    progressLabel: 'Expansion Revenue', progressValue: '$14,200 / $40K', progressPct: 36, progressColor: 'from-emerald-500 to-emerald-300',
    objectives: [
      { text: 'Top 10 upsell candidates identified', status: 'done' },
      { text: 'Upgrade 3 customers to Growth plan', status: 'active', tag: '1/3' },
      { text: 'Reach $40K expansion target', status: 'pending' },
    ],
  },
];

// ─── Brain Layers ─────────────────────────────────────────────────────
const brainLayers = [
  { label: 'Blueprint', pct: 100, display: 'Active', level: 'high' },
  { label: 'Company Truth', pct: 82, display: '82%', level: 'high' },
  { label: 'Behavioral Learning', pct: 61, display: '61%', level: 'mid' },
  { label: 'Outcome Learning', pct: 43, display: '43%', level: 'low' },
];

// ─── Decision Feed ────────────────────────────────────────────────────
// KAN-973 — strategyClass/confClass already migrated to ds-chip-*.
// KAN-985 — em-dashes in note + reasoning text repaired.
const decisions = [
  {
    type: 'ai', headline: 'Follow-up SMS to', contact: 'Sarah Chen',
    strategy: 'Direct Conversion', strategyClass: 'ds-chip-base ds-chip-green', channel: 'SMS',
    confidence: 87, confClass: 'ds-chip-base ds-chip-green', time: '2m ago',
    reasoning: 'Budget confirmed ($12K). Timeline Q2. Decision maker reached. Missing: pricing tolerance. 3 of 5 sub-objectives complete — direct path to booking selected.',
  },
  {
    type: 'ai', headline: 'Re-engagement email to', contact: 'Mark Thompson',
    strategy: 'Re-engagement', strategyClass: 'ds-chip-base ds-chip-amber', channel: 'Email',
    confidence: 71, confClass: 'ds-chip-base ds-chip-ai', time: '8m ago',
    reasoning: 'Contact dormant 34 days. Previously showed interest in enterprise plan. New angle: reference recent case study in similar industry.',
  },
  {
    type: 'ai', headline: 'Qualification questions to', contact: 'Emma Davis',
    strategy: 'Guided Assistance', strategyClass: 'ds-chip-base ds-chip-ai', channel: 'Email',
    confidence: 62, confClass: 'ds-chip-base ds-chip-amber', time: '14m ago',
    reasoning: 'New inbound lead from website form. Need identified (HR consulting) but budget and timeline unknown. Guided approach: ask qualifying questions before direct conversion attempt.',
  },
  {
    type: 'human', headline: 'Escalated:', contact: 'James Rivera — deal value $28,000',
    confidence: 34, confClass: 'ds-chip-base ds-chip-rose', time: '22m ago',
    note: 'Above $15K threshold — human review',
  },
  {
    type: 'ai', headline: 'Book meeting for', contact: 'Lisa Park',
    strategy: 'Direct Conversion', strategyClass: 'ds-chip-base ds-chip-green', channel: 'Calendar',
    confidence: 94, confClass: 'ds-chip-base ds-chip-green', time: '31m ago',
    reasoning: 'All 5 sub-objectives complete. Budget: $8K. Timeline: this month. Decision maker confirmed. Direct path — send calendar link with 3 available slots this week.',
  },
];

// ─── Agent Actions ────────────────────────────────────────────────────
// KAN-985 — em-dashes + middle-dot mojibake repaired throughout.
const agentActions = [
  { icon: MessageSquare, iconClass: 'bg-blue-100 text-blue-600', text: 'SMS sent to', contact: 'Sarah Chen', detail: '— follow-up on pricing', status: '✓ Delivered', time: '2m' },
  { icon: Mail, iconClass: 'bg-purple-100 text-purple-600', text: 'Email sent to', contact: 'Mark Thompson', detail: '— re-engagement', status: '✓ Delivered', time: '8m' },
  { icon: Mail, iconClass: 'bg-purple-100 text-purple-600', text: 'Email sent to', contact: 'Emma Davis', detail: '— qualification', status: '✓ Delivered', time: '14m' },
  { icon: Calendar, iconClass: 'bg-emerald-100 text-emerald-600', text: 'Meeting booked —', contact: 'Lisa Park', detail: '· Thu 2pm', status: '✓ Confirmed', time: '31m' },
  { icon: Flag, iconClass: 'bg-indigo-100 text-indigo-600', text: 'HubSpot updated —', contact: 'Lisa Park', detail: '— Meeting Booked', status: '✓ Synced', time: '31m' },
  { icon: AlertTriangle, iconClass: 'bg-red-100 text-red-600', text: 'Escalated', contact: 'James Rivera', detail: '— above deal threshold', status: '⏳ Pending review', statusClass: 'text-amber-600', time: '22m' },
];

// ─── Contact Objective ────────────────────────────────────────────────
const subObjectives = [
  { label: 'Name confirmed', status: 'done' },
  { label: 'Phone confirmed', status: 'done' },
  { label: 'Budget: $12K range', status: 'done' },
  { label: 'Pricing tolerance', status: 'in-progress', tag: '↑ AI targeting' },
  { label: 'Meeting confirmed', status: 'pending' },
];

// ─── Escalation Queue ─────────────────────────────────────────────────
// KAN-1102 — fixture removed; data now flows from recommendations.list via
// the `useEscalationQueue` hook inside DashboardPage. Panel render at the
// "Escalation Queue" JSX block below consumes the hook result.

// KAN-1102 — Polling cadence: 30s. Verified safe per Phase 1 trace
// (listRecommendations does NOT write audit rows; no audit_log pollution).
// 30s = "live feel" without WebSocket cost; matches operator triage
// expectation of returning-to-tab freshness.
const ESCALATION_POLL_MS = 30_000;

// KAN-1102 — Top-N rendered on the dashboard. Backend supports up to 100;
// dashboard shows the most critical 5. "View all" CTA → /escalations for
// the full queue.
const ESCALATION_LIMIT = 5;

// KAN-1102 — Compose display name from contact JOIN.
// Pattern: "FirstName LastName — Company" with null-safe fallbacks to
// email or "Unknown contact". Mirrors `/escalations` page's contactName
// helper (kept page-local there for KAN-1006 scope) + adds the
// companyName segment for dashboard-tier triage signal.
function composeEscalationName(c: RecommendationListItem['contact']): string {
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  const base = name || c.email || 'Unknown contact';
  return c.companyName ? `${base} — ${c.companyName}` : base;
}

// KAN-1102 — Header chip framing per Phase 1 review item 3.
//   total === 0  → null (empty state component owns the messaging)
//   total <= 5   → "${total} pending"            (honest count; no slice framing)
//   total >  5   → "Top 5 of ${total} pending"   (operator-grade slice signal)
function escalationChipText(total: number): string | null {
  if (total === 0) return null;
  if (total <= ESCALATION_LIMIT) return `${total} pending`;
  return `Top ${ESCALATION_LIMIT} of ${total} pending`;
}

// ─── Strategy Performance ─────────────────────────────────────────────
const strategies = [
  { name: 'Direct Conversion', pct: 38, color: 'bg-emerald-500', count: '214 contacts' },
  { name: 'Guided Assistance', pct: 24, color: 'bg-indigo-500', count: '156 contacts' },
  { name: 'Trust Building', pct: 18, color: 'bg-amber-500', count: '89 contacts' },
  { name: 'Re-engagement', pct: 12, color: 'bg-red-400', count: '388 contacts' },
];

// KAN-1103 — auditEntries fixture removed (was here). Data now flows from
// auditLog.list via the useAuditLog hook inside DashboardPage. See the
// "Audit Log (KAN-1103 ...)" comment block at the top of the file for the
// panel-type convention + Q3/Q4 lock rationale.

// Shared shell class for the inline "card" sections (Pipeline Health,
// Brain Status, Decision Feed, Agent Actions, etc.). bg-card + hairline
// border-border + Phase A radius + Phase B.1 card shadow.
const CARD_SHELL = "bg-card border border-border rounded-[var(--ds-radius-card)] shadow-[var(--ds-shadow-card)]";

// ─── Component ────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [expandedDecision, setExpandedDecision] = useState<number | null>(null);

  // KAN-1102 — Escalation Queue data + admin gate. The query only fires for
  // admin users (`enabled` gate); non-admins skip the fetch entirely (server
  // would FORBIDDEN-throw anyway via adminProcedure, but skipping here
  // avoids a UI error state for non-admins and shaves the request).
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [escalations, setEscalations] = useState<RecommendationListItem[] | null>(null);
  const [escalationsTotal, setEscalationsTotal] = useState<number>(0);
  const [escalationsLoading, setEscalationsLoading] = useState<boolean>(true);
  const [escalationsError, setEscalationsError] = useState<string | null>(null);

  const reloadEscalations = useCallback(async () => {
    if (!isAdmin) {
      setEscalationsLoading(false);
      return;
    }
    try {
      setEscalationsError(null);
      const result = await recommendationsApi.list({
        status: 'open',
        limit: ESCALATION_LIMIT,
        // kind defaults to 'pending' at the backend (KAN-1005 M2-5 safety
        // boundary — excludes sampled post-hoc reviews from the actionable
        // queue). The dashboard panel intentionally consumes the default.
      });
      setEscalations(result.items);
      setEscalationsTotal(result.total);
    } catch (e) {
      setEscalationsError((e as Error).message);
      setEscalations([]);
      setEscalationsTotal(0);
    } finally {
      setEscalationsLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    void reloadEscalations();
    // 30s polling for live escalation feel + window-focus refresh so
    // operator returning to tab sees fresh state.
    const interval = setInterval(() => {
      void reloadEscalations();
    }, ESCALATION_POLL_MS);
    const onFocus = () => {
      void reloadEscalations();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [isAdmin, reloadEscalations]);

  // KAN-1103 — KPI strip data + 60s polling. dashboard.getStats is
  // protectedProcedure (all tenant-authenticated users see their tenant's
  // metrics); no admin gate at the KPI level. Window-focus refetch matches
  // the KAN-1102 pattern for return-to-tab freshness.
  const [kpis, setKpis] = useState<DashboardStats | null>(null);
  const [kpisLoading, setKpisLoading] = useState<boolean>(true);
  const [kpisError, setKpisError] = useState<string | null>(null);

  const reloadKpis = useCallback(async () => {
    try {
      setKpisError(null);
      const result = await dashboardApi.getStats();
      setKpis(result);
    } catch (e) {
      setKpisError((e as Error).message);
      setKpis(null);
    } finally {
      setKpisLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadKpis();
    const interval = setInterval(() => {
      void reloadKpis();
    }, KPI_POLL_MS);
    const onFocus = () => {
      void reloadKpis();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [reloadKpis]);

  // KAN-1103 — Audit Log data + 30s polling. auditLog.list is
  // protectedProcedure; default `includeInfrastructure=false` excludes
  // `brain.blueprint_*` noise that fires on every server restart. Backend
  // sorts createdAt DESC; no client-side re-sort (sentinel test locks).
  const [auditLog, setAuditLog] = useState<AuditLogEntry[] | null>(null);
  const [auditLogLoading, setAuditLogLoading] = useState<boolean>(true);
  const [auditLogError, setAuditLogError] = useState<string | null>(null);

  const reloadAuditLog = useCallback(async () => {
    try {
      setAuditLogError(null);
      const result = await auditLogApi.list({ limit: AUDIT_LOG_LIMIT });
      setAuditLog(result.items);
    } catch (e) {
      setAuditLogError((e as Error).message);
      setAuditLog([]);
    } finally {
      setAuditLogLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadAuditLog();
    const interval = setInterval(() => {
      void reloadAuditLog();
    }, AUDIT_LOG_POLL_MS);
    const onFocus = () => {
      void reloadAuditLog();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [reloadAuditLog]);

  return (
    <div className="p-6 flex flex-col gap-6">
      {/* KAN-1103 — KPI strip wired to dashboard.getStats. Values-only
          (Q2 trend sub-labels deferred to Phase 2.5). MetricCard wrapping
          in a <div data-testid> for unit-test reach since MetricCard's
          prop signature has no testid passthrough (verified KAN-1103
          Phase 2 pre-edit). */}
      <div className="grid grid-cols-5 gap-4">
        {KPI_CARDS.map((card) => {
          const rawValue = kpis?.[card.key];
          const displayValue = kpisError
            ? '—'
            : kpisLoading || rawValue === undefined
              ? ''
              : card.unit
                ? `${rawValue} ${card.unit}`
                : String(rawValue);
          return (
            <div key={card.key} data-testid={`kpi-card-${card.key}`}>
              <MetricCard
                label={card.label}
                value={displayValue}
                loading={kpisLoading && !kpisError}
                subtitle={kpisError ? "Couldn't load" : undefined}
                icon={card.icon}
              />
            </div>
          );
        })}
      </div>

      {/* Assistant — KAN-983 */}
      <AssistantCard
        suggestions={[
          'Summarize today',
          'Find at-risk deals',
          'Top objectives this week',
        ]}
        onSuggestionClick={() => {
          /* placeholder — real wiring in a later phase */
        }}
      />

      {/* Pipeline Health */}
      <div className="grid grid-cols-3 gap-4">
        {pipelines.map((p) => (
          <div key={p.name} className={`${CARD_SHELL} p-5 flex flex-col gap-3.5`}>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${p.color}`} />
              <span className="text-sm font-bold text-foreground flex-1">{p.name}</span>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[var(--ds-emerald-100)] text-[var(--ds-emerald-700)] uppercase tracking-wide">Active</span>
            </div>
            <div className="flex justify-between gap-1">
              {[{ val: p.value, label: 'Pipeline Value' }, { val: p.leads, label: 'Active Leads' }, { val: p.confidence, label: 'Avg Confidence' }].map((m) => (
                <div key={m.label} className="flex-1 text-center py-2 px-1 bg-[var(--ds-surface-sunken)] rounded-lg">
                  <div className="text-base font-extrabold text-foreground leading-tight">{m.val}</div>
                  <div className="text-[10px] text-muted-foreground font-medium mt-0.5">{m.label}</div>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between items-center">
                <span className="text-[11px] font-semibold text-muted-foreground">{p.progressLabel}</span>
                <span className="text-[11px] text-muted-foreground">{p.progressValue} <strong className="text-[var(--ds-emerald-700)]">{p.progressPct}%</strong></span>
              </div>
              <div className="h-2 bg-[var(--ds-surface-sunken)] rounded-full overflow-hidden">
                <div className={`h-full rounded-full bg-gradient-to-r ${p.progressColor}`} style={{ width: `${p.progressPct}%` }} />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              {p.objectives.map((obj) => (
                <div key={obj.text} className="flex items-center gap-2 text-[12px]">
                  <span className={`w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] ${
                    obj.status === 'done' ? 'bg-[var(--ds-emerald-500)] text-white' :
                    obj.status === 'active' ? 'border-2 border-[var(--ds-violet-500)]' :
                    'border-2 border-border'
                  }`}>{obj.status === 'done' ? '✓' : ''}</span>
                  <span className={obj.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground'}>{obj.text}</span>
                  {obj.tag && <span className="ml-auto text-[10px] font-semibold text-[var(--ds-violet-500)] bg-[var(--ds-violet-100)] px-1.5 py-0.5 rounded">{obj.tag}</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Brain + Decision Feed */}
      <div className="grid grid-cols-2 gap-4">
        {/* Brain Status */}
        <div className={CARD_SHELL}>
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Brain className="w-4 h-4 text-[var(--ds-violet-500)]" />
              Business Brain
            </div>
            <span className="text-xs text-[var(--ds-violet-500)] cursor-pointer hover:underline inline-flex items-center gap-1">
              View details <ChevronRight className="w-3 h-3" />
            </span>
          </div>
          <div className="p-5 flex flex-col gap-4">
            <div className="flex flex-col gap-3">
              {brainLayers.map((l) => (
                <div key={l.label} className="flex items-center gap-3">
                  <span className="text-[12px] text-muted-foreground w-[130px] flex-shrink-0">{l.label}</span>
                  <div className="flex-1 h-2 bg-[var(--ds-surface-sunken)] rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${
                      l.level === 'high' ? 'bg-[var(--ds-emerald-500)]' : l.level === 'mid' ? 'bg-amber-500' : 'bg-red-400'
                    }`} style={{ width: `${l.pct}%` }} />
                  </div>
                  <span className={`text-[12px] font-medium w-12 text-right ${
                    l.level === 'high' ? 'text-[var(--ds-emerald-700)]' : l.level === 'mid' ? 'text-amber-600' : 'text-red-500'
                  }`}>{l.display}</span>
                </div>
              ))}
            </div>

            <div className="[background-image:var(--ds-accent-gradient)] text-white rounded-lg px-4 py-3 flex items-center justify-between">
              <span className="text-[12px] font-medium text-white/80">Overall Intelligence Score</span>
              <div className="text-2xl font-bold">72 <span className="text-base text-white/60 font-normal">/ 100</span></div>
            </div>

            <div className="bg-[var(--ds-warning-soft)] border border-[var(--ds-warning)] rounded-lg p-3">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[var(--ds-warning-text)] mb-2">
                <AlertTriangle className="w-3.5 h-3.5" />
                Gaps detected
              </div>
              <ul className="list-disc list-inside text-[12px] text-[var(--ds-warning-text)] space-y-1">
                <li>Pricing data incomplete — 40% of deals missing value</li>
                <li>Competitor positioning not yet ingested</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Decision Feed */}
        <div className={CARD_SHELL}>
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Activity className="w-4 h-4 text-[var(--ds-violet-500)]" />
              Decision Feed
            </div>
            <span className="text-xs text-[var(--ds-violet-500)] cursor-pointer hover:underline inline-flex items-center gap-1">
              View all <ChevronRight className="w-3 h-3" />
            </span>
          </div>
          <div className="divide-y divide-border">
            {decisions.map((d, i) => (
              <div key={i} className="flex items-start gap-3 px-5 py-3 hover:bg-accent transition-colors cursor-pointer"
                onClick={() => d.reasoning && setExpandedDecision(expandedDecision === i ? null : i)}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 ${
                  d.type === 'ai' ? 'bg-[var(--ds-violet-100)] text-[var(--ds-violet-500)]' : 'bg-amber-100 text-amber-600'
                }`}>{d.type === 'ai' ? 'AI' : 'H'}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-foreground">
                    {d.headline} <strong>{d.contact}</strong>
                  </div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {d.strategy && (
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded ${d.strategyClass}`}>{d.strategy}</span>
                    )}
                    {d.channel && (
                      <span className="ds-chip-base ds-chip-muted">{d.channel}</span>
                    )}
                    {d.note && (
                      <span className="text-[12px] text-muted-foreground">{d.note}</span>
                    )}
                    {d.reasoning && (
                      <span className="text-[11px] text-muted-foreground cursor-pointer inline-flex items-center gap-0.5">
                        {expandedDecision === i ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        Show reasoning
                      </span>
                    )}
                  </div>
                  {expandedDecision === i && d.reasoning && (
                    <div className="mt-2 text-[12px] text-muted-foreground bg-[var(--ds-surface-sunken)] rounded-lg p-3 border border-border">
                      {d.reasoning}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 ${d.confClass}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      d.confidence >= 80 ? 'bg-[var(--ds-emerald-500)]' : d.confidence >= 50 ? 'bg-amber-500' : 'bg-red-500'
                    }`} />
                    {d.confidence}%
                  </span>
                  <span className="text-[11px] text-muted-foreground">{d.time}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Agent Actions + Objective + Escalations */}
      <div className="grid grid-cols-3 gap-4">
        {/* Agent Action Stream */}
        <div className={CARD_SHELL}>
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Megaphone className="w-4 h-4 text-[var(--ds-violet-500)]" />
              Agent Actions
            </div>
            <span className="text-xs text-[var(--ds-violet-500)] cursor-pointer hover:underline inline-flex items-center gap-1">
              View all <ChevronRight className="w-3 h-3" />
            </span>
          </div>
          <div className="divide-y divide-border">
            {agentActions.map((a, i) => {
              const Icon = a.icon;
              return (
                <div key={i} className="flex items-center gap-3 px-5 py-2.5">
                  <div className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 ${a.iconClass}`}>
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <span className="text-[12px] text-foreground flex-1 min-w-0 truncate">
                    {a.text} <strong>{a.contact}</strong> {a.detail}
                  </span>
                  <span className={`text-[11px] flex-shrink-0 ${a.statusClass || 'text-[var(--ds-emerald-700)]'}`}>{a.status}</span>
                  <span className="text-[11px] text-muted-foreground flex-shrink-0 w-8 text-right">{a.time}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Contact Objective Gap */}
        <div className={CARD_SHELL}>
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Clock className="w-4 h-4 text-[var(--ds-violet-500)]" />
              Contact: Sarah Chen
            </div>
            <span className="text-xs text-[var(--ds-violet-500)] cursor-pointer hover:underline inline-flex items-center gap-1">
              View profile <ChevronRight className="w-3 h-3" />
            </span>
          </div>
          <div className="p-5">
            <div className="bg-[var(--ds-violet-100)] border border-[var(--ds-violet-500)]/30 rounded-lg p-4">
              <div className="text-sm font-bold text-foreground mb-1">Book Consultation Meeting</div>
              <div className="text-[12px] text-muted-foreground mb-4">Strategy: Direct Conversion · Confidence: 87%</div>
              <div className="flex flex-col gap-2.5">
                {subObjectives.map((obj) => (
                  <div key={obj.label} className="flex items-center gap-2.5">
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] ${
                      obj.status === 'done' ? 'bg-[var(--ds-emerald-500)] text-white' :
                      obj.status === 'in-progress' ? 'border-2 border-[var(--ds-violet-500)] bg-[var(--ds-violet-100)]' :
                      'border-2 border-border'
                    }`}>{obj.status === 'done' ? '✓' : ''}</div>
                    <span className={`text-[13px] ${obj.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{obj.label}</span>
                    {obj.tag && <span className="text-[11px] text-[var(--ds-violet-500)] font-medium">{obj.tag}</span>}
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3 mt-4">
                <span className="text-[11px] font-semibold text-muted-foreground">Progress</span>
                <div className="flex-1 h-2 bg-card rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-[var(--ds-violet-500)]" style={{ width: '60%' }} />
                </div>
                <span className="text-[12px] font-bold text-[var(--ds-violet-500)]">60%</span>
              </div>
            </div>
          </div>
        </div>

        {/* KAN-1102 — Escalation Queue (admin-only). Three-layer admin defense:
            server adminProcedure (recommendations.list) + client useAuth check
            (the {isAdmin && ...} wrap) + panel-level conditional render. Non-
            admins don't see the container at all; mirrors KAN-1100 moverLinks
            adminOnly pattern. */}
        {isAdmin && (
          <div className={CARD_SHELL} data-testid="dashboard-escalation-queue">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <AlertTriangle className="w-4 h-4 text-[var(--ds-danger)]" />
                Escalation Queue
              </div>
              {(() => {
                const chipText = escalationChipText(escalationsTotal);
                return chipText ? (
                  <span className="text-xs font-semibold text-[var(--ds-danger)]">{chipText}</span>
                ) : null;
              })()}
            </div>

            {escalationsLoading && escalations === null ? (
              // Loading — 3 skeleton rows matching the row layout below.
              <div className="divide-y divide-border" data-testid="escalation-queue-loading">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-5 py-3 animate-pulse">
                    <div className="w-1 h-10 rounded-full bg-muted flex-shrink-0" />
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="h-3 w-2/3 bg-muted rounded" />
                      <div className="h-3 w-1/2 bg-muted rounded" />
                    </div>
                    <div className="h-7 w-16 bg-muted rounded-lg flex-shrink-0" />
                  </div>
                ))}
              </div>
            ) : escalationsError ? (
              // Error state — show message + Retry button.
              <div className="px-5 py-6 text-center" data-testid="escalation-queue-error">
                <div className="text-[13px] text-foreground mb-2">Couldn&apos;t load escalations</div>
                <button
                  onClick={() => void reloadEscalations()}
                  className="text-[12px] font-semibold text-[var(--ds-violet-500)] bg-[var(--ds-violet-100)] px-3 py-1.5 rounded-lg hover:bg-[var(--ds-violet-100)]/80"
                >
                  Retry
                </button>
              </div>
            ) : escalations && escalations.length === 0 ? (
              // Empty state — Phase 1 strawman copy frames empty as GOOD.
              // Designer refines in Phase 4 polish per v2 PRD Q4.
              <div className="px-5 py-6 text-center text-[12px] text-muted-foreground" data-testid="escalation-queue-empty">
                No escalations right now — the engine is acting autonomously.
              </div>
            ) : (
              // Populated — render top-N in backend-authoritative sort order
              // (severity DESC, createdAt DESC at recommendations.ts:147).
              // No client-side sort; sentinel test locks this assumption.
              <>
                <div className="divide-y divide-border">
                  {(escalations ?? []).map((esc) => {
                    const sev = severityBadge(esc.severity);
                    const name = composeEscalationName(esc.contact);
                    const reason = esc.triggerReason ?? '(no reason recorded)';
                    return (
                      <div key={esc.id} className="flex items-center gap-3 px-5 py-3">
                        <div className="flex-shrink-0">
                          <Badge variant={sev.variant}>{sev.label}</Badge>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] font-medium text-foreground truncate">{name}</div>
                          <div className="text-[12px] text-muted-foreground truncate">{reason}</div>
                        </div>
                        <span className="text-[11px] text-muted-foreground flex-shrink-0 whitespace-nowrap">
                          {formatRelativeTime(esc.createdAt)}
                        </span>
                        <Link
                          href={`/escalations?id=${esc.id}`}
                          className="text-[12px] font-semibold text-[var(--ds-violet-500)] bg-[var(--ds-violet-100)] px-3 py-1.5 rounded-lg hover:bg-[var(--ds-violet-100)]/80 flex-shrink-0"
                        >
                          Review
                        </Link>
                      </div>
                    );
                  })}
                </div>
                <div className="px-5 py-3 border-t border-border text-right">
                  <Link
                    href="/escalations"
                    className="text-xs text-[var(--ds-violet-500)] cursor-pointer hover:underline inline-flex items-center gap-1"
                  >
                    View all <ChevronRight className="w-3 h-3" />
                  </Link>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Strategy Performance + Audit Log */}
      <div className="grid grid-cols-2 gap-4">
        {/* Strategy Performance */}
        <div className={CARD_SHELL}>
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <BarChart3 className="w-4 h-4 text-[var(--ds-violet-500)]" />
              Strategy Performance
            </div>
            <span className="text-xs text-[var(--ds-violet-500)] cursor-pointer hover:underline inline-flex items-center gap-1">
              Full report <ChevronRight className="w-3 h-3" />
            </span>
          </div>
          <div className="p-5 flex flex-col gap-4">
            {strategies.map((s) => (
              <div key={s.name} className="flex items-center gap-3">
                <span className="text-[12px] text-muted-foreground w-[130px] flex-shrink-0">{s.name}</span>
                <div className="flex-1 h-6 bg-[var(--ds-surface-sunken)] rounded overflow-hidden relative">
                  <div className={`h-full ${s.color} rounded flex items-center justify-center text-[11px] font-bold text-white`}
                    style={{ width: `${s.pct}%`, minWidth: '32px' }}>
                    {s.pct}%
                  </div>
                </div>
                <span className="text-[11px] text-muted-foreground w-[80px] text-right flex-shrink-0">{s.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* KAN-1103 — Audit Log wired to auditLog.list (stream-like panel;
            NO count chip in header per the panel-type convention from
            Phase 1 review item +1; "View all →" CTA is the drill-down
            affordance). Top-5 most recent in backend-authoritative sort
            order (createdAt DESC at auditLog.list:147); sentinel test
            locks the no-client-sort assumption.

            Timestamp display: formatRelativeTime ("2m ago") for scannable
            activity-feed UX. /audit page uses absolute timestamps for
            forensic deep-dive UX — intentional divergence per Phase 1
            review item 3 reasoning. */}
        <div className={CARD_SHELL} data-testid="dashboard-audit-log">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <FileText className="w-4 h-4 text-[var(--ds-violet-500)]" />
              Audit Log
            </div>
            {/* No count chip — stream-like panel convention (KAN-1103 forward lock) */}
          </div>

          {auditLogLoading && auditLog === null ? (
            <div className="divide-y divide-border" data-testid="audit-log-loading">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 px-5 py-2 animate-pulse">
                  <div className="h-3 w-[65px] bg-muted rounded flex-shrink-0" />
                  <div className="h-5 w-[140px] bg-muted rounded flex-shrink-0" />
                  <div className="h-3 flex-1 bg-muted rounded" />
                </div>
              ))}
            </div>
          ) : auditLogError ? (
            <div className="px-5 py-6 text-center" data-testid="audit-log-error">
              <div className="text-[13px] text-foreground mb-2">Couldn&apos;t load audit log</div>
              <button
                onClick={() => void reloadAuditLog()}
                className="text-[12px] font-semibold text-[var(--ds-violet-500)] bg-[var(--ds-violet-100)] px-3 py-1.5 rounded-lg hover:bg-[var(--ds-violet-100)]/80"
              >
                Retry
              </button>
            </div>
          ) : auditLog && auditLog.length === 0 ? (
            <div className="px-5 py-6 text-center text-[12px] text-muted-foreground" data-testid="audit-log-empty">
              No recent activity — actions appear here as the engine and operators work.
            </div>
          ) : (
            <>
              <div className="divide-y divide-border">
                {(auditLog ?? []).map((entry) => (
                  <div key={entry.id} className="flex items-center gap-3 px-5 py-2">
                    <span className="text-[11px] text-muted-foreground w-[65px] flex-shrink-0">
                      {formatRelativeTime(entry.createdAt)}
                    </span>
                    <span className="text-[11px] font-mono text-foreground bg-[var(--ds-surface-sunken)] px-2 py-0.5 rounded w-[140px] flex-shrink-0 truncate">
                      {entry.actionType}
                    </span>
                    <span className="text-[12px] text-muted-foreground flex-1 min-w-0 truncate">
                      {entry.reasoning ?? '(no reasoning)'}
                    </span>
                  </div>
                ))}
              </div>
              <div className="px-5 py-3 border-t border-border text-right">
                <Link
                  href="/audit"
                  className="text-xs text-[var(--ds-violet-500)] cursor-pointer hover:underline inline-flex items-center gap-1"
                >
                  View all <ChevronRight className="w-3 h-3" />
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
