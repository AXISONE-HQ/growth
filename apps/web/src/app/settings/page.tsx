'use client';

/**
 * /settings — main settings hub (6 sub-tabs).
 * KAN-990 Phase C.6 — restyled dark/slate → light DS v1 tokens. Pill
 * Tabs (KAN-976 B.1) for sub-nav, SectionCard (KAN-989 C.5) for panels,
 * FieldRow for label/value rows. All mutations preserved — every save,
 * toggle, connect/disconnect, invite, security-update path still fires
 * the exact same settingsApi calls.
 */

import {
  Brain,
  Shield,
  Mail,
  Phone,
  MessageCircle,
  MessagesSquare,
  Key,
  Users,
  Bell,
  Globe,
  Database,
  CheckCircle,
  Lock,
  Plug,
  Loader2,
  RefreshCw,
  X,
  AlertCircle,
  UserPlus,
  Link2,
  Megaphone,
  // KAN-993 Phase D.3 — icons for the 5 mover sub-tabs + the
  // navigation-affordance chevron.
  Target,
  BookOpen,
  Upload,
  FileText,
  Building2,
  ChevronRight,
  // KAN-1100 — icon for the new admin-only Cognitive Metrics moverLink.
  // BarChart3 chosen over Activity/Gauge for explicit metrics-dashboard
  // semantic + visual distinction from Brain (AI tab).
  BarChart3,
} from 'lucide-react';
import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';
import {
  settingsApi,
  type AIConfig,
  type CommunicationChannel,
  type Integration,
  type TeamMember,
  type Invitation,
  type NotificationPrefs,
  type SecuritySetting,
} from '@/lib/api';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/detail-page-shell';
// KAN-1107 — channelIcon helper consolidated into shared lib.
import { channelIcon } from '@/lib/action-icon-projection';
// KAN-1100 — useAuth surfaces user.role for the moverLinks admin-conditional
// render filter. Canonical client-side admin gate per AuthContext.tsx + the
// NEXT_PUBLIC_ADMIN_EMAILS build-time-inlined pattern (KAN-1088).
import { useAuth } from '@/lib/AuthContext';

// — Helpers —
function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function Toggle({
  enabled,
  onChange,
  disabled,
}: {
  enabled: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      aria-pressed={enabled}
      className={`flex h-6 w-11 items-center rounded-full transition-colors ${
        enabled
          ? '[background-image:var(--ds-accent-gradient)] justify-end'
          : 'bg-[var(--ds-border-default)] justify-start'
      } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <div className="mx-0.5 h-5 w-5 rounded-full bg-card shadow" />
    </button>
  );
}

function ChannelStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    connected: 'bg-[var(--ds-emerald-100)] text-[var(--ds-emerald-700)]',
    disconnected: 'bg-[var(--ds-surface-sunken)] text-muted-foreground',
    syncing: 'bg-[var(--ds-violet-100)] text-[var(--ds-violet-500)]',
    error: 'bg-[var(--ds-danger-soft)] text-[var(--ds-danger-text)]',
    pending: 'bg-[var(--ds-warning-soft)] text-[var(--ds-warning-text)]',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[var(--ds-radius-pill)] px-2.5 py-1 text-caption font-medium ${styles[status] || styles.disconnected}`}
    >
      {status === 'connected' && <CheckCircle className="h-3 w-3" />}
      {status === 'syncing' && <Loader2 className="h-3 w-3 animate-spin" />}
      {status === 'error' && <AlertCircle className="h-3 w-3" />}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function SaveButton({
  saving,
  dirty,
  onClick,
}: {
  saving: boolean;
  dirty: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      onClick={onClick}
      disabled={saving || !dirty}
      variant={dirty ? 'gradient' : 'outline'}
      size="sm"
    >
      {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
      {saving ? 'Saving…' : 'Save changes'}
    </Button>
  );
}

export default function SettingsPage() {
  // KAN-1100 — read user.role to drive admin-conditional moverLinks render.
  // useAuth is client-side only; non-admin users get filtered out of the
  // moverLinks render (server-side adminProcedure on the dashboard's tRPC
  // procedure remains the authoritative gate; this is UX polish).
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState('ai');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // AI Config state
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null);
  const [aiDirty, setAiDirty] = useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState(70);
  const [autoApprove, setAutoApprove] = useState(true);
  const [dailyLimit, setDailyLimit] = useState(200);
  const [strategies, setStrategies] = useState({
    directConversion: true,
    guidedAssistance: true,
    trustBuilding: true,
    reengagement: true,
  });
  const [guardrails, setGuardrails] = useState({
    toneValidator: true,
    accuracyCheck: true,
    hallucinationFilter: true,
    complianceCheck: true,
    injectionDefense: true,
    confidenceGate: true,
  });

  // Channels state
  const [channels, setChannels] = useState<CommunicationChannel[]>([]);
  // KAN-474: messenger Test-Connection result for inline page-name display
  // and the token_expired → Reconnect CTA branch.
  const [messengerTestResult, setMessengerTestResult] = useState<{
    success: boolean;
    message: string;
    reason?: string;
    pageName?: string;
  } | null>(null);

  // Integrations state
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [integrationSubTab, setIntegrationSubTab] = useState<'crm_erp' | 'leads' | 'productivity'>('crm_erp');

  const integrationCatalog = [
    { provider: 'HubSpot', category: 'crm' as const, subTab: 'crm_erp' as const, icon: Link2 },
    { provider: 'Meta Lead Ads', category: 'advertising' as const, subTab: 'leads' as const, icon: Megaphone },
  ];
  const integrationSubTabs = [
    { id: 'crm_erp' as const, label: 'CRM / ERP' },
    { id: 'leads' as const, label: 'Leads' },
  ];

  // Team state
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'owner' | 'admin' | 'agent' | 'viewer'>('viewer');

  // Notifications state
  const [notifPrefs, setNotifPrefs] = useState<NotificationPrefs>({
    escalation: true,
    daily_digest: true,
    weekly_report: true,
    brain_update: false,
  });

  // Security state
  const [security, setSecurity] = useState<SecuritySetting | null>(null);

  const roleColors: Record<string, string> = {
    owner: 'bg-[var(--ds-violet-100)] text-[var(--ds-violet-500)]',
    admin: 'bg-[var(--ds-violet-100)] text-[var(--ds-violet-700)]',
    agent: 'bg-[var(--ds-emerald-100)] text-[var(--ds-emerald-700)]',
    viewer: 'bg-[var(--ds-surface-sunken)] text-muted-foreground',
  };

  const tabs = [
    { id: 'ai', label: 'AI Configuration', icon: Brain },
    { id: 'channels', label: 'Channels', icon: Mail },
    { id: 'integrations', label: 'Integrations', icon: Plug },
    { id: 'team', label: 'Team & roles', icon: Users },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'security', label: 'Security', icon: Shield },
  ];

  // KAN-993 Phase D.3 — mover sub-tabs surfaced inside Settings via
  // router-push links. The 5 entries were removed from the IconRail in
  // D.2 (KAN-992) but their routes are unchanged. These render as
  // pill-styled <Link> items in a separate <nav aria-label="More
  // settings"> below the Radix TabsList — clicking navigates to the
  // existing route (some leave the Settings shell — accepted Option-B
  // tradeoff). The Radix tablist semantics stay pure (6 inline tabs);
  // these are explicitly navigation links, not tab triggers.
  // KAN-1100 — explicit type widening introduces the `adminOnly?: boolean`
  // field. This is the first admin-only moverLink; the `.filter()` idiom at
  // the render site (`!m.adminOnly || user?.role === 'admin'`) establishes
  // the canonical precedent for future admin-only moverLinks — same shape,
  // same field name, same filter at the render call. The .map() render
  // block below applies the filter before iterating.
  const moverLinks: Array<{
    href: string;
    label: string;
    icon: typeof Target;
    adminOnly?: boolean;
  }> = [
    { href: '/settings/objectives', label: 'Objectives', icon: Target },
    { href: '/settings/knowledge', label: 'Knowledge Center', icon: BookOpen },
    { href: '/imports', label: 'Data Imports', icon: Upload },
    { href: '/audit', label: 'Audit Log', icon: FileText },
    { href: '/settings/account/identity', label: 'Account', icon: Building2 },
    {
      href: '/settings/cognitive-metrics',
      label: 'Cognitive Metrics',
      icon: BarChart3,
      adminOnly: true,
    },
  ];

  // Flash messages
  const flash = useCallback((msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 3000);
  }, []);

  const flashError = useCallback((msg: string) => {
    setError(msg);
    setTimeout(() => setError(null), 5000);
  }, []);

  // Data loaders
  const loadAI = useCallback(async () => {
    try {
      const data = await settingsApi.getAIConfig();
      setAiConfig(data);
      setConfidenceThreshold(data.confidenceThreshold ?? 70);
      setAutoApprove(data.autoApproveEnabled ?? true);
      setDailyLimit(data.dailyActionLimit ?? 200);
      if (data.strategyPermissions) setStrategies(data.strategyPermissions as typeof strategies);
      if (data.guardrailSettings) setGuardrails(data.guardrailSettings as typeof guardrails);
      setAiDirty(false);
    } catch (e: any) {
      flashError(e.message);
    }
  }, [flashError]);

  const loadChannels = useCallback(async () => {
    try {
      setChannels(await settingsApi.listChannels());
    } catch (e: any) {
      flashError(e.message);
    }
  }, [flashError]);

  const loadIntegrations = useCallback(async () => {
    try {
      setIntegrations(await settingsApi.listIntegrations());
    } catch (e: any) {
      flashError(e.message);
    }
  }, [flashError]);

  const loadTeam = useCallback(async () => {
    try {
      const data = await settingsApi.listTeam();
      setMembers(data.members);
      setInvitations(data.invitations);
    } catch (e: any) {
      flashError(e.message);
    }
  }, [flashError]);

  const loadNotifications = useCallback(async () => {
    try {
      setNotifPrefs(await settingsApi.getNotifications());
    } catch (e: any) {
      flashError(e.message);
    }
  }, [flashError]);

  const loadSecurity = useCallback(async () => {
    try {
      setSecurity(await settingsApi.getSecurity());
    } catch (e: any) {
      flashError(e.message);
    }
  }, [flashError]);

  // Load data for active tab
  useEffect(() => {
    setLoading(true);
    setError(null);
    const load = async () => {
      switch (activeTab) {
        case 'ai':
          await loadAI();
          break;
        case 'channels':
          await loadChannels();
          break;
        case 'integrations':
          await loadIntegrations();
          break;
        case 'team':
          await loadTeam();
          break;
        case 'notifications':
          await loadNotifications();
          break;
        case 'security':
          await loadSecurity();
          break;
      }
      setLoading(false);
    };
    load();
  }, [activeTab, loadAI, loadChannels, loadIntegrations, loadTeam, loadNotifications, loadSecurity]);

  // Meta OAuth redirect handling
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('meta_success') === 'connected') {
      setSuccess('Meta Lead Ads connected successfully');
      setActiveTab('integrations');
      window.history.replaceState({}, '', '/settings');
    }
    if (params.get('messenger_success') === 'connected') {
      setSuccess('Facebook Messenger connected successfully');
      setActiveTab('integrations');
      window.history.replaceState({}, '', '/settings');
    }
    const messengerError = params.get('messenger_error');
    if (messengerError) {
      const msgs: Record<string, string> = {
        denied: 'Facebook Messenger permissions were denied',
        missing_params: 'OAuth callback missing parameters',
        invalid_state: 'Invalid OAuth state — try again',
        no_pages: 'No Facebook Pages found on your account',
        exchange_failed: 'Failed to connect — try again',
      };
      setError(msgs[messengerError] || 'Messenger connection failed: ' + messengerError);
      setActiveTab('integrations');
      window.history.replaceState({}, '', '/settings');
    }

    const metaError = params.get('meta_error');
    if (metaError) {
      const messages: Record<string, string> = {
        denied: 'Facebook permissions were denied',
        missing_params: 'OAuth callback missing parameters',
        invalid_state: 'Invalid OAuth state — try again',
        no_pages: 'No Facebook Pages found on your account',
        exchange_failed: 'Failed to connect — try again',
      };
      setError(messages[metaError] || `Meta connection failed: ${metaError}`);
      setActiveTab('integrations');
      window.history.replaceState({}, '', '/settings');
    }
  }, []);

  // Mutations
  const saveAI = async () => {
    setSaving(true);
    try {
      await settingsApi.updateAIConfig({
        confidenceThreshold,
        autoApproveEnabled: autoApprove,
        dailyActionLimit: dailyLimit,
        strategyPermissions: strategies,
        guardrailSettings: guardrails,
      });
      setAiDirty(false);
      flash('AI configuration saved');
    } catch (e: any) {
      flashError(e.message);
    }
    setSaving(false);
  };

  const toggleNotification = async (
    type: 'escalation' | 'daily_digest' | 'weekly_report' | 'brain_update',
  ) => {
    setSaving(true);
    try {
      const updated = await settingsApi.updateNotification({ type, enabled: !notifPrefs[type] });
      setNotifPrefs(updated);
      flash('Notification preference updated');
    } catch (e: any) {
      flashError(e.message);
    }
    setSaving(false);
  };

  const connectIntegration = async (
    provider: string,
    category: 'crm' | 'payments' | 'calendar' | 'commerce' | 'advertising' | 'messaging' | 'other',
  ) => {
    if (provider === 'Meta Lead Ads') {
      const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
      window.location.href = `${apiBase}/api/integrations/meta/authorize`;
      return;
    }

    setSaving(true);
    try {
      await settingsApi.connectIntegration({ provider, category });
      await loadIntegrations();
      flash(`${provider} connected`);
    } catch (e: any) {
      flashError(e.message);
    }
    setSaving(false);
  };

  const disconnectIntegration = async (id: string, name: string) => {
    setSaving(true);
    try {
      await settingsApi.disconnectIntegration(id);
      await loadIntegrations();
      flash(`${name} disconnected`);
    } catch (e: any) {
      flashError(e.message);
    }
    setSaving(false);
  };

  const syncIntegration = async (id: string, name: string) => {
    setSaving(true);
    try {
      await settingsApi.syncIntegration(id);
      await loadIntegrations();
      flash(`${name} synced`);
    } catch (e: any) {
      flashError(e.message);
    }
    setSaving(false);
  };

  const inviteMember = async () => {
    if (!inviteEmail) return;
    setSaving(true);
    try {
      await settingsApi.inviteMember({ email: inviteEmail, role: inviteRole });
      setShowInvite(false);
      setInviteEmail('');
      setInviteRole('viewer');
      await loadTeam();
      flash('Invitation sent');
    } catch (e: any) {
      flashError(e.message);
    }
    setSaving(false);
  };

  const removeMember = async (id: string) => {
    setSaving(true);
    try {
      await settingsApi.removeMember(id);
      await loadTeam();
      flash('Member removed');
    } catch (e: any) {
      flashError(e.message);
    }
    setSaving(false);
  };

  const cancelInvite = async (id: string) => {
    setSaving(true);
    try {
      await settingsApi.cancelInvite(id);
      await loadTeam();
      flash('Invitation cancelled');
    } catch (e: any) {
      flashError(e.message);
    }
    setSaving(false);
  };

  const updateSecurity = async (field: string, value: boolean | number) => {
    setSaving(true);
    try {
      const updated = await settingsApi.updateSecurity({ [field]: value });
      setSecurity(updated);
      flash('Security setting updated');
    } catch (e: any) {
      flashError(e.message);
    }
    setSaving(false);
  };

  const getIntegrationStatus = (provider: string) => {
    return integrations.find((i) => i.provider === provider);
  };

  // KAN-1107 — channelIcons extracted to apps/web/src/lib/action-icon-projection.ts.
  // Class-fix consolidation: dashboard Decision Feed + Agent Actions panels
  // share the same icon mapping; single source of truth in lib/.
  // Original inline mapping preserved via channelIcon() wrapper.

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-5">
        <h1 className="text-h1 text-foreground">Settings</h1>
        <p className="mt-1 text-body text-muted-foreground">Configure your growth workspace</p>
      </header>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="mb-2 flex-wrap h-auto">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id} className="gap-2">
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* KAN-993 D.3 — mover sub-tabs (router-push, navigates away from
            /settings; not Radix tab triggers). Pill-styled <Link> items
            in their own <nav aria-label="More settings"> landmark.
            ChevronRight signals "navigates away". */}
        <nav
          aria-label="More settings"
          data-testid="settings-mover-nav"
          className="mb-6 inline-flex flex-wrap items-center gap-1 rounded-full bg-muted p-1"
        >
          {moverLinks
            // KAN-1100 — admin-only filter. Canonical precedent for future
            // admin-conditional moverLinks: `!m.adminOnly || user?.role === 'admin'`.
            // user?.role evaluates undefined when unauthenticated (useAuth
            // returns user === null pre-login + during loading), so the
            // filter correctly hides admin-only entries from unauthenticated
            // users too.
            .filter((m) => !m.adminOnly || user?.role === 'admin')
            .map((m) => (
              <Link
                key={m.href}
                href={m.href}
                data-testid={`settings-mover-${m.label.toLowerCase().replace(/\s+/g, '-')}`}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <m.icon className="h-4 w-4" />
                {m.label}
                <ChevronRight className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
              </Link>
            ))}
        </nav>

        <div className="max-w-3xl">
          {success ? (
            <div className="mb-4 flex items-center gap-2 rounded-[var(--ds-radius-input)] border border-[var(--ds-emerald-100)] bg-[var(--ds-emerald-100)] px-4 py-2.5 text-body text-[var(--ds-emerald-700)]">
              <CheckCircle className="h-4 w-4" /> {success}
            </div>
          ) : null}
          {error ? (
            <div className="mb-4 flex items-center gap-2 rounded-[var(--ds-radius-input)] border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] px-4 py-2.5 text-body text-[var(--ds-danger-text)]">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-6 w-6 animate-spin text-[var(--ds-violet-500)]" />
              <span className="ml-2 text-body text-muted-foreground">Loading settings…</span>
            </div>
          ) : null}

          {/* — AI Configuration — */}
          <TabsContent value="ai" className="mt-0">
            {!loading && (
              <div className="flex flex-col gap-6">
                <SectionCard
                  title="AI decision controls"
                  headerRight={<SaveButton saving={saving} dirty={aiDirty} onClick={saveAI} />}
                >
                  <p className="mb-6 text-body text-muted-foreground">
                    Control how autonomously the AI operates across all pipelines
                  </p>

                  <div className="mb-6">
                    <label className="mb-2 block text-label text-foreground">
                      Global confidence threshold:{' '}
                      <strong className="text-[var(--ds-violet-500)]">
                        {confidenceThreshold}%
                      </strong>
                    </label>
                    <p className="mb-3 text-caption text-muted-foreground">
                      Actions below this confidence level will be escalated for human review
                    </p>
                    <input
                      type="range"
                      min="20"
                      max="95"
                      value={confidenceThreshold}
                      onChange={(e) => {
                        setConfidenceThreshold(Number(e.target.value));
                        setAiDirty(true);
                      }}
                      className="h-2 w-full cursor-pointer appearance-none rounded-full bg-[var(--ds-surface-sunken)] accent-[var(--ds-violet-500)]"
                    />
                    <div className="mt-1 flex justify-between text-micro text-muted-foreground">
                      <span>20% (More autonomous)</span>
                      <span>95% (More human review)</span>
                    </div>
                  </div>

                  <div className="mb-4 flex items-center justify-between rounded-[var(--ds-radius-input)] bg-[var(--ds-surface-sunken)] p-4">
                    <div>
                      <div className="text-label text-foreground">
                        Auto-approve high-confidence actions
                      </div>
                      <div className="text-caption text-muted-foreground">
                        Actions above {confidenceThreshold}% confidence execute without human
                        review
                      </div>
                    </div>
                    <Toggle
                      enabled={autoApprove}
                      onChange={() => {
                        setAutoApprove(!autoApprove);
                        setAiDirty(true);
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-[var(--ds-radius-input)] bg-[var(--ds-surface-sunken)] p-4">
                    <div>
                      <div className="text-label text-foreground">Daily action limit</div>
                      <div className="text-caption text-muted-foreground">
                        Maximum AI-initiated actions per day
                      </div>
                    </div>
                    <input
                      type="number"
                      value={dailyLimit}
                      onChange={(e) => {
                        setDailyLimit(Number(e.target.value));
                        setAiDirty(true);
                      }}
                      className="w-24 rounded-[var(--ds-radius-input)] border border-border bg-card px-3 py-1.5 text-right text-body text-foreground outline-none focus:border-[var(--ds-violet-500)]"
                    />
                  </div>
                </SectionCard>

                <SectionCard title="Strategy permissions">
                  <p className="mb-4 text-body text-muted-foreground">
                    Enable or disable AI strategies globally
                  </p>
                  <div className="flex flex-col gap-3">
                    {(
                      [
                        {
                          key: 'directConversion',
                          name: 'Direct conversion',
                          desc: 'Push toward conversion for high-intent contacts',
                        },
                        {
                          key: 'guidedAssistance',
                          name: 'Guided assistance',
                          desc: 'Educational approach for evaluating contacts',
                        },
                        {
                          key: 'trustBuilding',
                          name: 'Trust building',
                          desc: 'Relationship-building for early-stage or at-risk contacts',
                        },
                        {
                          key: 'reengagement',
                          name: 'Re-engagement',
                          desc: 'Win-back dormant or churned contacts',
                        },
                      ] as const
                    ).map((s) => (
                      <div
                        key={s.key}
                        className="flex items-center justify-between rounded-[var(--ds-radius-input)] bg-[var(--ds-surface-sunken)] p-3"
                      >
                        <div>
                          <div className="text-label text-foreground">{s.name}</div>
                          <div className="text-caption text-muted-foreground">{s.desc}</div>
                        </div>
                        <Toggle
                          enabled={strategies[s.key]}
                          onChange={() => {
                            setStrategies({ ...strategies, [s.key]: !strategies[s.key] });
                            setAiDirty(true);
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </SectionCard>

                <SectionCard title="Guardrails">
                  <p className="mb-4 text-body text-muted-foreground">
                    Safety checks applied before every AI action
                  </p>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    {(
                      [
                        { key: 'toneValidator', name: 'Tone validator', desc: 'Checks brand voice compliance' },
                        { key: 'accuracyCheck', name: 'Accuracy check', desc: 'Validates against Company Truth' },
                        {
                          key: 'hallucinationFilter',
                          name: 'Hallucination filter',
                          desc: 'Ensures claims grounded in context',
                        },
                        {
                          key: 'complianceCheck',
                          name: 'Compliance (CAN-SPAM/CASL)',
                          desc: 'Legal compliance enforcement',
                        },
                        {
                          key: 'injectionDefense',
                          name: 'Injection defense',
                          desc: 'Blocks prompt injection attempts',
                        },
                        {
                          key: 'confidenceGate',
                          name: 'Confidence gate',
                          desc: 'Threshold-based auto-escalation',
                        },
                      ] as const
                    ).map((g) => (
                      <div
                        key={g.key}
                        className="flex items-start gap-3 rounded-[var(--ds-radius-input)] bg-[var(--ds-surface-sunken)] p-3"
                      >
                        <CheckCircle
                          className={`mt-0.5 h-4 w-4 flex-shrink-0 ${guardrails[g.key] ? 'text-[var(--ds-emerald-500)]' : 'text-[var(--ds-ink-tertiary)]'}`}
                        />
                        <div className="flex-1">
                          <div className="text-label text-foreground">{g.name}</div>
                          <div className="text-caption text-muted-foreground">{g.desc}</div>
                        </div>
                        <Toggle
                          enabled={guardrails[g.key]}
                          onChange={() => {
                            setGuardrails({ ...guardrails, [g.key]: !guardrails[g.key] });
                            setAiDirty(true);
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </SectionCard>
              </div>
            )}
          </TabsContent>

          {/* — Channels — */}
          <TabsContent value="channels" className="mt-0">
            {!loading && (
              <SectionCard title="Communication channels">
                <p className="mb-6 text-body text-muted-foreground">
                  Configure channels the AI can use to reach contacts
                </p>
                <div className="flex flex-col gap-4">
                  {(['email', 'sms', 'whatsapp', 'messenger'] as const).map((type) => {
                    const ch = channels.find((c) => c.type === type);
                    const iconInfo = channelIcon(type) ?? { icon: Mail, color: 'bg-muted text-muted-foreground' };
                    const Icon = iconInfo.icon;
                    const isConnected = ch?.status === 'connected';

                    return (
                      <div
                        key={type}
                        className={`rounded-[var(--ds-radius-input)] border p-4 ${ch ? 'border-border' : 'border-dashed border-border'}`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${iconInfo.color}`}>
                              <Icon className="h-5 w-5" />
                            </div>
                            <div>
                              <div className="text-label text-foreground capitalize">{type}</div>
                              <div className="text-caption text-muted-foreground">
                                {ch
                                  ? type === 'messenger' && (ch.config?.pageName as string | undefined)
                                    ? `Connected as ${ch.config.pageName as string} · ${isConnected ? 'Active' : ch.status}`
                                    : `${ch.provider} · ${isConnected ? 'Active' : ch.status}`
                                  : 'Not configured'}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {ch && <ChannelStatusBadge status={ch.status} />}
                            {!ch && (
                              <Button
                                variant="gradient"
                                size="sm"
                                onClick={() => {
                                  if (type === 'messenger') {
                                    const apiBase =
                                      process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
                                    window.open(
                                      `${apiBase}/api/integrations/messenger/authorize`,
                                      '_blank',
                                    );
                                    return;
                                  }
                                  settingsApi
                                    .updateChannel({
                                      type: type as 'email' | 'sms' | 'whatsapp',
                                      provider: type === 'email' ? 'Resend' : 'Twilio',
                                      status: 'disconnected',
                                    })
                                    .then(loadChannels)
                                    .then(() => flash(`${type} channel added`));
                                }}
                              >
                                Configure
                              </Button>
                            )}
                          </div>
                        </div>
                        {ch && (
                          <div className="mt-3 flex items-center gap-2 text-caption text-muted-foreground">
                            {ch.lastTestedAt && <span>Last tested: {timeAgo(ch.lastTestedAt)}</span>}
                            <button
                              onClick={() =>
                                settingsApi.testChannel(type).then((res) => {
                                  loadChannels();
                                  if (type === 'messenger') {
                                    setMessengerTestResult(
                                      res as {
                                        success: boolean;
                                        message: string;
                                        reason?: string;
                                        pageName?: string;
                                      },
                                    );
                                  }
                                  if (res.success) flash(res.message || `${type} test successful`);
                                  else setError(res.message || `${type} test failed`);
                                })
                              }
                              className="flex items-center gap-1 font-medium text-[var(--ds-violet-500)] hover:text-[var(--ds-violet-700)]"
                            >
                              <RefreshCw className="h-3 w-3" /> Test connection
                            </button>
                            {/* KAN-474 Reconnect CTA */}
                            {type === 'messenger' &&
                              messengerTestResult?.reason === 'token_expired' && (
                                <button
                                  onClick={() => {
                                    const apiBase =
                                      process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
                                    window.open(
                                      `${apiBase}/api/integrations/messenger/authorize`,
                                      '_blank',
                                    );
                                  }}
                                  className="font-medium text-[var(--ds-warning-text)] hover:text-[var(--ds-warning)]"
                                >
                                  Reconnect
                                </button>
                              )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </SectionCard>
            )}
          </TabsContent>

          {/* — Integrations — */}
          <TabsContent value="integrations" className="mt-0">
            {!loading && (
              <SectionCard title="Integrations">
                <p className="mb-4 text-body text-muted-foreground">
                  Connect your tools to power the AI loop
                </p>

                {/* Integration sub-tabs — pill row */}
                <Tabs
                  value={integrationSubTab}
                  onValueChange={(v) => setIntegrationSubTab(v as typeof integrationSubTab)}
                  className="mb-6"
                >
                  <TabsList>
                    {integrationSubTabs.map((st) => (
                      <TabsTrigger key={st.id} value={st.id}>
                        {st.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>

                <div className="flex flex-col gap-3">
                  {integrationCatalog
                    .filter((cat) => cat.subTab === integrationSubTab)
                    .map((cat) => {
                      const live = getIntegrationStatus(cat.provider);
                      const isConnected = live?.status === 'connected';

                      return (
                        <div
                          key={cat.provider}
                          className="flex items-center justify-between rounded-[var(--ds-radius-input)] border border-border p-4"
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--ds-surface-sunken)]">
                              <cat.icon className="h-5 w-5 text-muted-foreground" />
                            </div>
                            <div>
                              <div className="text-label text-foreground">{cat.provider}</div>
                              <div className="text-caption text-muted-foreground capitalize">
                                {cat.category}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            {live?.lastSyncAt && (
                              <span className="text-micro text-muted-foreground">
                                Synced {timeAgo(live.lastSyncAt)}
                              </span>
                            )}
                            {isConnected ? (
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => syncIntegration(live!.id, cat.provider)}
                                  disabled={saving}
                                  className="flex items-center gap-1 text-caption font-medium text-[var(--ds-violet-500)] hover:text-[var(--ds-violet-700)]"
                                >
                                  <RefreshCw className={`h-3 w-3 ${saving ? 'animate-spin' : ''}`} /> Sync
                                </button>
                                <ChannelStatusBadge status="connected" />
                                <button
                                  onClick={() => disconnectIntegration(live!.id, cat.provider)}
                                  disabled={saving}
                                  className="text-muted-foreground hover:text-[var(--ds-danger-text)]"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ) : live?.status === 'disconnected' ? (
                              <Button
                                variant="gradient"
                                size="sm"
                                onClick={() => connectIntegration(cat.provider, cat.category)}
                                disabled={saving}
                              >
                                Reconnect
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => connectIntegration(cat.provider, cat.category)}
                                disabled={saving}
                              >
                                Connect
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                </div>
              </SectionCard>
            )}
          </TabsContent>

          {/* — Team & roles — */}
          <TabsContent value="team" className="mt-0">
            {!loading && (
              <SectionCard
                title="Team & roles"
                headerRight={
                  <Button
                    variant="gradient"
                    size="sm"
                    onClick={() => setShowInvite(true)}
                  >
                    <UserPlus className="h-3 w-3" /> Invite member
                  </Button>
                }
              >
                <p className="mb-6 text-body text-muted-foreground">
                  Manage who has access and what they can do
                </p>

                {showInvite && (
                  <div className="mb-4 rounded-[var(--ds-radius-input)] border border-[var(--ds-violet-100)] bg-[var(--ds-violet-100)]/40 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-label text-foreground">Send invitation</span>
                      <button
                        onClick={() => setShowInvite(false)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="email"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        placeholder="email@example.com"
                        className="flex-1 rounded-[var(--ds-radius-input)] border border-border bg-card px-3 py-2 text-body text-foreground outline-none focus:border-[var(--ds-violet-500)]"
                      />
                      <select
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}
                        className="rounded-[var(--ds-radius-input)] border border-border bg-card px-3 py-2 text-body text-foreground outline-none focus:border-[var(--ds-violet-500)]"
                      >
                        <option value="viewer">Viewer</option>
                        <option value="agent">Agent</option>
                        <option value="admin">Admin</option>
                        <option value="owner">Owner</option>
                      </select>
                      <Button
                        variant="gradient"
                        size="sm"
                        onClick={inviteMember}
                        disabled={saving || !inviteEmail}
                      >
                        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Send'}
                      </Button>
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-3">
                  {members.map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center justify-between rounded-[var(--ds-radius-input)] border border-border p-4"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--ds-violet-100)] text-caption font-medium text-[var(--ds-violet-500)]">
                          {(m.name || m.email).slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <div className="text-label text-foreground">{m.name || m.email}</div>
                          <div className="text-caption text-muted-foreground">{m.email}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-[var(--ds-radius-pill)] px-2.5 py-1 text-micro font-medium capitalize ${roleColors[m.role]}`}
                        >
                          {m.role}
                        </span>
                        {m.role !== 'owner' && (
                          <button
                            onClick={() => removeMember(m.id)}
                            disabled={saving}
                            className="text-muted-foreground hover:text-[var(--ds-danger-text)]"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}

                  {invitations.map((inv) => (
                    <div
                      key={inv.id}
                      className="flex items-center justify-between rounded-[var(--ds-radius-input)] border border-[var(--ds-warning-soft)] bg-[var(--ds-warning-soft)]/40 p-4"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--ds-warning-soft)] text-caption font-medium text-[var(--ds-warning-text)]">
                          {inv.email.slice(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <div className="text-label text-foreground">{inv.email}</div>
                          <div className="text-caption text-muted-foreground">
                            Invited · Expires {timeAgo(inv.expiresAt)}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-[var(--ds-radius-pill)] px-2.5 py-1 text-micro font-medium capitalize ${roleColors[inv.role]}`}
                        >
                          {inv.role}
                        </span>
                        <ChannelStatusBadge status="pending" />
                        <button
                          onClick={() => cancelInvite(inv.id)}
                          disabled={saving}
                          className="text-muted-foreground hover:text-[var(--ds-danger-text)]"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}

                  {members.length === 0 && invitations.length === 0 && (
                    <div className="py-8 text-center text-body text-muted-foreground">
                      No team members yet. Invite someone to get started.
                    </div>
                  )}
                </div>
              </SectionCard>
            )}
          </TabsContent>

          {/* — Notifications — */}
          <TabsContent value="notifications" className="mt-0">
            {!loading && (
              <SectionCard title="Notification preferences">
                <p className="mb-6 text-body text-muted-foreground">
                  Choose what alerts and reports you receive
                </p>
                <div className="flex flex-col gap-4">
                  {(
                    [
                      {
                        key: 'escalation' as const,
                        label: 'Escalation alerts',
                        desc: 'Get notified when the AI escalates a contact for human review',
                      },
                      {
                        key: 'daily_digest' as const,
                        label: 'Daily digest',
                        desc: 'Summary of all AI actions, decisions, and outcomes from the day',
                      },
                      {
                        key: 'weekly_report' as const,
                        label: 'Weekly performance report',
                        desc: 'Strategy performance, conversion rates, and pipeline health',
                      },
                      {
                        key: 'brain_update' as const,
                        label: 'Brain update notifications',
                        desc: 'Get notified when the Business Brain completes a learning cycle',
                      },
                    ]
                  ).map((n) => (
                    <div
                      key={n.key}
                      className="flex items-center justify-between rounded-[var(--ds-radius-input)] bg-[var(--ds-surface-sunken)] p-4"
                    >
                      <div>
                        <div className="text-label text-foreground">{n.label}</div>
                        <div className="text-caption text-muted-foreground">{n.desc}</div>
                      </div>
                      <Toggle
                        enabled={!!notifPrefs[n.key]}
                        onChange={() => toggleNotification(n.key)}
                        disabled={saving}
                      />
                    </div>
                  ))}
                </div>
              </SectionCard>
            )}
          </TabsContent>

          {/* — Security — */}
          <TabsContent value="security" className="mt-0">
            {!loading && security && (
              <SectionCard title="Security & compliance">
                <p className="mb-6 text-body text-muted-foreground">
                  Data protection and access controls
                </p>
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between rounded-[var(--ds-radius-input)] border border-border p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--ds-surface-sunken)]">
                        <Shield className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="text-label text-foreground">Two-factor authentication</div>
                        <div className="text-caption text-muted-foreground">
                          Require 2FA for all team members
                        </div>
                      </div>
                    </div>
                    <Toggle
                      enabled={security.twoFactorEnabled}
                      onChange={() => updateSecurity('twoFactorEnabled', !security.twoFactorEnabled)}
                      disabled={saving}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-[var(--ds-radius-input)] border border-border p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--ds-surface-sunken)]">
                        <Key className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="text-label text-foreground">SSO (SAML)</div>
                        <div className="text-caption text-muted-foreground">
                          Single sign-on via your identity provider
                        </div>
                      </div>
                    </div>
                    <Toggle
                      enabled={security.ssoEnabled}
                      onChange={() => updateSecurity('ssoEnabled', !security.ssoEnabled)}
                      disabled={saving}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-[var(--ds-radius-input)] border border-border p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--ds-surface-sunken)]">
                        <Lock className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="text-label text-foreground">Data encryption</div>
                        <div className="text-caption text-muted-foreground">
                          AES-256 at rest, TLS 1.3 in transit
                        </div>
                      </div>
                    </div>
                    <span className="rounded-[var(--ds-radius-pill)] bg-[var(--ds-emerald-100)] px-2.5 py-1 text-caption font-medium text-[var(--ds-emerald-700)]">
                      Always active
                    </span>
                  </div>

                  <div className="flex items-center justify-between rounded-[var(--ds-radius-input)] border border-border p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--ds-surface-sunken)]">
                        <Database className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="text-label text-foreground">Audit log retention</div>
                        <div className="text-caption text-muted-foreground">
                          Immutable logs · {Math.round(security.auditRetentionDays / 365)}{' '}
                          year{security.auditRetentionDays > 365 ? 's' : ''}
                        </div>
                      </div>
                    </div>
                    <span className="rounded-[var(--ds-radius-pill)] bg-[var(--ds-emerald-100)] px-2.5 py-1 text-caption font-medium text-[var(--ds-emerald-700)]">
                      {security.auditRetentionDays} days
                    </span>
                  </div>

                  <div className="flex items-center justify-between rounded-[var(--ds-radius-input)] border border-border p-4">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--ds-surface-sunken)]">
                        <Globe className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div>
                        <div className="text-label text-foreground">GDPR compliance</div>
                        <div className="text-caption text-muted-foreground">
                          Data processing agreement on file
                        </div>
                      </div>
                    </div>
                    <Toggle
                      enabled={security.gdprCompliant}
                      onChange={() => updateSecurity('gdprCompliant', !security.gdprCompliant)}
                      disabled={saving}
                    />
                  </div>
                </div>
              </SectionCard>
            )}
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
