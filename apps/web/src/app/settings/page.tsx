'use client';

import {
  Brain, Shield, Mail, Phone, MessageCircle, MessagesSquare,
  Key, Users, Bell, Globe, Database, CheckCircle,
  Lock, Plug, Loader2, RefreshCw, X, AlertCircle,
  UserPlus
} from 'lucide-react';
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

/* âââ Helpers ââââââââââââââââââââââââââââââââââââââââââââââââ */
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

function Toggle({ enabled, onChange, disabled }: { enabled: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={`w-11 h-6 rounded-full transition-colors flex items-center ${
        enabled ? 'bg-indigo-500 justify-end' : 'bg-gray-300 justify-start'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <div className="w-5 h-5 bg-white rounded-full shadow mx-0.5" />
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    connected: 'bg-emerald-50 text-emerald-700',
    disconnected: 'bg-gray-100 text-gray-500',
    syncing: 'bg-blue-50 text-blue-600',
    error: 'bg-red-50 text-red-600',
    pending: 'bg-amber-50 text-amber-600',
  };
  return (
    <span className={`text-xs px-2.5 py-1 rounded-full font-medium flex items-center gap-1 ${styles[status] || styles.disconnected}`}>
      {status === 'connected' && <CheckCircle className="w-3 h-3" />}
      {status === 'syncing' && <Loader2 className="w-3 h-3 animate-spin" />}
      {status === 'error' && <AlertCircle className="w-3 h-3" />}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function SaveButton({ saving, dirty, onClick }: { saving: boolean; dirty: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={saving || !dirty}
      className={`text-xs px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${
        dirty
          ? 'bg-indigo-500 text-white hover:bg-indigo-600'
          : 'bg-gray-100 text-gray-400 cursor-not-allowed'
      }`}
    >
      {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
      {saving ? 'Savingâ¦' : 'Save Changes'}
    </button>
  );
}

/* âââ Main Component âââââââââââââââââââââââââââââââââââââââââ */
export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('ai');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // ââ AI Config state ââ
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null);
  const [aiDirty, setAiDirty] = useState(false);
  const [confidenceThreshold, setConfidenceThreshold] = useState(70);
  const [autoApprove, setAutoApprove] = useState(true);
  const [dailyLimit, setDailyLimit] = useState(200);
  const [strategies, setStrategies] = useState({
    directConversion: true, guidedAssistance: true, trustBuilding: true, reengagement: true,
  });
  const [guardrails, setGuardrails] = useState({
    toneValidator: true, accuracyCheck: true, hallucinationFilter: true,
    complianceCheck: true, injectionDefense: true, confidenceGate: true,
  });

  // ââ Channels state ââ
  const [channels, setChannels] = useState<CommunicationChannel[]>([]);

  // ââ Integrations state ââ
  const [integrations, setIntegrations] = useState<Integration[]>([]);

  // Available integrations catalog (static list â actual connection status comes from API)
  const integrationCatalog = [
    { provider: 'HubSpot', category: 'crm' as const, icon: 'ð¶' },
    { provider: 'Salesforce', category: 'crm' as const, icon: 'âï¸' },
    { provider: 'Stripe', category: 'payments' as const, icon: 'ð³' },
    { provider: 'Cal.com', category: 'calendar' as const, icon: 'ð' },
    { provider: 'Pipedrive', category: 'crm' as const, icon: 'ð¢' },
    { provider: 'Shopify', category: 'commerce' as const, icon: 'ð' },
    { provider: 'Meta Lead Ads', category: 'advertising' as const, icon: 'ð£' },
    { provider: 'Facebook Messenger', category: 'messaging' as const, icon: '💬' },
  ];

  // ââ Team state ââ
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'owner' | 'admin' | 'agent' | 'viewer'>('viewer');

  // ââ Notifications state ââ
  const [notifPrefs, setNotifPrefs] = useState<NotificationPrefs>({
    escalation: true, daily_digest: true, weekly_report: true, brain_update: false,
  });

  // ââ Security state ââ
  const [security, setSecurity] = useState<SecuritySetting | null>(null);

  const roleColors: Record<string, string> = {
    owner: 'bg-indigo-50 text-indigo-700',
    admin: 'bg-purple-50 text-purple-700',
    agent: 'bg-emerald-50 text-emerald-700',
    viewer: 'bg-gray-100 text-gray-600',
  };

  const tabs = [
    { id: 'ai', label: 'AI Configuration', icon: Brain },
    { id: 'channels', label: 'Channels', icon: Mail },
    { id: 'integrations', label: 'Integrations', icon: Plug },
    { id: 'team', label: 'Team & Roles', icon: Users },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'security', label: 'Security', icon: Shield },
  ];

  /* ââ Flash messages âââââââââââââââââââââââââââââââââââââââ */
  const flash = useCallback((msg: string) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 3000);
  }, []);

  const flashError = useCallback((msg: string) => {
    setError(msg);
    setTimeout(() => setError(null), 5000);
  }, []);

  /* ââ Data loaders âââââââââââââââââââââââââââââââââââââââââ */
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
    } catch (e: any) { flashError(e.message); }
  }, [flashError]);

  const loadChannels = useCallback(async () => {
    try { setChannels(await settingsApi.listChannels()); }
    catch (e: any) { flashError(e.message); }
  }, [flashError]);

  const loadIntegrations = useCallback(async () => {
    try { setIntegrations(await settingsApi.listIntegrations()); }
    catch (e: any) { flashError(e.message); }
  }, [flashError]);

  const loadTeam = useCallback(async () => {
    try {
      const data = await settingsApi.listTeam();
      setMembers(data.members);
      setInvitations(data.invitations);
    } catch (e: any) { flashError(e.message); }
  }, [flashError]);

  const loadNotifications = useCallback(async () => {
    try { setNotifPrefs(await settingsApi.getNotifications()); }
    catch (e: any) { flashError(e.message); }
  }, [flashError]);

  const loadSecurity = useCallback(async () => {
    try { setSecurity(await settingsApi.getSecurity()); }
    catch (e: any) { flashError(e.message); }
  }, [flashError]);

  // Load data for active tab
  useEffect(() => {
    setLoading(true);
    setError(null);
    const load = async () => {
      switch (activeTab) {
        case 'ai': await loadAI(); break;
        case 'channels': await loadChannels(); break;
        case 'integrations': await loadIntegrations(); break;
        case 'team': await loadTeam(); break;
        case 'notifications': await loadNotifications(); break;
        case 'security': await loadSecurity(); break;
      }
      setLoading(false);
    };
    load();
  }, [activeTab, loadAI, loadChannels, loadIntegrations, loadTeam, loadNotifications, loadSecurity]);


  /*  Meta OAuth redirect handling  */
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
        invalid_state: 'Invalid OAuth state — please try again',
        no_pages: 'No Facebook Pages found on your account',
        exchange_failed: 'Failed to connect — please try again',
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
        invalid_state: 'Invalid OAuth state  please try again',
        no_pages: 'No Facebook Pages found on your account',
        exchange_failed: 'Failed to connect  please try again',
      };
      setError(messages[metaError] || `Meta connection failed: ${metaError}`);
      setActiveTab('integrations');
      window.history.replaceState({}, '', '/settings');
    }
  }, []);

  /* ââ Mutations ââââââââââââââââââââââââââââââââââââââââââââ */
  const saveAI = async () => {
    setSaving(true);
    try {
      await settingsApi.updateAIConfig({
        confidenceThreshold, autoApproveEnabled: autoApprove, dailyActionLimit: dailyLimit,
        strategyPermissions: strategies, guardrailSettings: guardrails,
      });
      setAiDirty(false);
      flash('AI configuration saved');
    } catch (e: any) { flashError(e.message); }
    setSaving(false);
  };

  const toggleNotification = async (type: 'escalation' | 'daily_digest' | 'weekly_report' | 'brain_update') => {
    setSaving(true);
    try {
      const updated = await settingsApi.updateNotification({ type, enabled: !notifPrefs[type] });
      setNotifPrefs(updated);
      flash('Notification preference updated');
    } catch (e: any) { flashError(e.message); }
    setSaving(false);
  };

  const connectIntegration = async (provider: string, category: 'crm' | 'payments' | 'calendar' | 'commerce' | 'advertising' | 'messaging' | 'other') => {
    // Meta Lead Ads uses OAuth  redirect to the authorize endpoint
    if (provider === 'Meta Lead Ads') {
      const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
      window.location.href = `${apiBase}/api/integrations/meta/authorize`;
      return;
    }

    // Facebook Messenger uses OAuth redirect
    if (provider === 'Facebook Messenger') {
      const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://loca' + 'lhost:8080';
      window.location.href = `${apiBase}/api/integrations/messenger/authorize`;
      return;
    }
    setSaving(true);
    try {
      await settingsApi.connectIntegration({ provider, category });
      await loadIntegrations();
      flash(`${provider} connected`);
    } catch (e: any) { flashError(e.message); }
    setSaving(false);
  };

  const disconnectIntegration = async (id: string, name: string) => {
    setSaving(true);
    try {
      await settingsApi.disconnectIntegration(id);
      await loadIntegrations();
      flash(`${name} disconnected`);
    } catch (e: any) { flashError(e.message); }
    setSaving(false);
  };

  const syncIntegration = async (id: string, name: string) => {
    setSaving(true);
    try {
      await settingsApi.syncIntegration(id);
      await loadIntegrations();
      flash(`${name} synced`);
    } catch (e: any) { flashError(e.message); }
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
    } catch (e: any) { flashError(e.message); }
    setSaving(false);
  };

  const removeMember = async (id: string) => {
    setSaving(true);
    try {
      await settingsApi.removeMember(id);
      await loadTeam();
      flash('Member removed');
    } catch (e: any) { flashError(e.message); }
    setSaving(false);
  };

  const cancelInvite = async (id: string) => {
    setSaving(true);
    try {
      await settingsApi.cancelInvite(id);
      await loadTeam();
      flash('Invitation cancelled');
    } catch (e: any) { flashError(e.message); }
    setSaving(false);
  };

  const updateSecurity = async (field: string, value: boolean | number) => {
    setSaving(true);
    try {
      const updated = await settingsApi.updateSecurity({ [field]: value });
      setSecurity(updated);
      flash('Security setting updated');
    } catch (e: any) { flashError(e.message); }
    setSaving(false);
  };

  /* ââ Helper: get integration status from API data âââââââââ */
  const getIntegrationStatus = (provider: string) => {
    return integrations.find((i) => i.provider === provider);
  };

  const channelIcons: Record<string, { icon: typeof Mail; color: string }> = {
    email: { icon: Mail, color: 'bg-indigo-50 text-indigo-600' },
    sms: { icon: Phone, color: 'bg-emerald-50 text-emerald-600' },
    whatsapp: { icon: MessageCircle, color: 'bg-green-50 text-green-600' },
    messenger: { icon: MessagesSquare, color: 'bg-blue-50 text-blue-600' },
  };

  return (
    <div className="p-6 flex gap-6">
      {/* Sidebar Tabs */}
      <div className="w-[220px] flex-shrink-0">
        <h1 className="text-xl font-bold text-gray-900 mb-1">Settings</h1>
        <p className="text-sm text-gray-500 mb-5">Configure your growth workspace</p>
        <div className="flex flex-col gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left ${
                activeTab === tab.id
                  ? 'bg-indigo-50 text-indigo-700'
                  : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 max-w-3xl">
        {/* Toast Messages */}
        {success && (
          <div className="mb-4 flex items-center gap-2 px-4 py-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">
            <CheckCircle className="w-4 h-4" /> {success}
          </div>
        )}
        {error && (
          <div className="mb-4 flex items-center gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            <AlertCircle className="w-4 h-4" /> {error}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
            <span className="ml-2 text-sm text-gray-500">Loading settingsâ¦</span>
          </div>
        )}

        {/* âââ AI Configuration âââ */}
        {!loading && activeTab === 'ai' && (
          <div className="flex flex-col gap-6">
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-base font-semibold text-gray-900">AI Decision Controls</h2>
                <SaveButton saving={saving} dirty={aiDirty} onClick={saveAI} />
              </div>
              <p className="text-sm text-gray-500 mb-6">Control how autonomously the AI operates across all pipelines</p>

              {/* Confidence Threshold */}
              <div className="mb-6">
                <label className="text-sm font-medium text-gray-700 mb-2 block">
                  Global Confidence Threshold: <strong className="text-indigo-500">{confidenceThreshold}%</strong>
                </label>
                <p className="text-xs text-gray-500 mb-3">Actions below this confidence level will be escalated for human review</p>
                <input type="range" min="20" max="95" value={confidenceThreshold}
                  onChange={(e) => { setConfidenceThreshold(Number(e.target.value)); setAiDirty(true); }}
                  className="w-full h-2 bg-gray-200 rounded-full appearance-none cursor-pointer accent-indigo-500"
                />
                <div className="flex justify-between mt-1 text-[10px] text-gray-400">
                  <span>20% (More autonomous)</span>
                  <span>95% (More human review)</span>
                </div>
              </div>

              {/* Auto-approve toggle */}
              <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl mb-4">
                <div>
                  <div className="text-sm font-medium text-gray-900">Auto-approve high-confidence actions</div>
                  <div className="text-xs text-gray-500">Actions above {confidenceThreshold}% confidence execute without human review</div>
                </div>
                <Toggle enabled={autoApprove} onChange={() => { setAutoApprove(!autoApprove); setAiDirty(true); }} />
              </div>

              {/* Daily Limit */}
              <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                <div>
                  <div className="text-sm font-medium text-gray-900">Daily action limit</div>
                  <div className="text-xs text-gray-500">Maximum AI-initiated actions per day</div>
                </div>
                <input type="number" value={dailyLimit}
                  onChange={(e) => { setDailyLimit(Number(e.target.value)); setAiDirty(true); }}
                  className="w-24 px-3 py-1.5 text-sm text-right border border-gray-200 rounded-lg focus:border-indigo-500 outline-none"
                />
              </div>
            </div>

            {/* Strategy Permissions */}
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">Strategy Permissions</h2>
              <p className="text-sm text-gray-500 mb-4">Enable or disable AI strategies globally</p>
              <div className="flex flex-col gap-3">
                {([
                  { key: 'directConversion', name: 'Direct Conversion', desc: 'Push toward conversion for high-intent contacts' },
                  { key: 'guidedAssistance', name: 'Guided Assistance', desc: 'Educational approach for evaluating contacts' },
                  { key: 'trustBuilding', name: 'Trust Building', desc: 'Relationship-building for early-stage or at-risk contacts' },
                  { key: 'reengagement', name: 'Re-engagement', desc: 'Win-back dormant or churned contacts' },
                ] as const).map((s) => (
                  <div key={s.key} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div>
                      <div className="text-sm font-medium text-gray-900">{s.name}</div>
                      <div className="text-xs text-gray-500">{s.desc}</div>
                    </div>
                    <Toggle
                      enabled={strategies[s.key]}
                      onChange={() => { setStrategies({ ...strategies, [s.key]: !strategies[s.key] }); setAiDirty(true); }}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Guardrails */}
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">Guardrails</h2>
              <p className="text-sm text-gray-500 mb-4">Safety checks applied before every AI action</p>
              <div className="grid grid-cols-2 gap-3">
                {([
                  { key: 'toneValidator', name: 'Tone Validator', desc: 'Checks brand voice compliance' },
                  { key: 'accuracyCheck', name: 'Accuracy Check', desc: 'Validates against Company Truth' },
                  { key: 'hallucinationFilter', name: 'Hallucination Filter', desc: 'Ensures claims grounded in context' },
                  { key: 'complianceCheck', name: 'Compliance (CAN-SPAM/CASL)', desc: 'Legal compliance enforcement' },
                  { key: 'injectionDefense', name: 'Injection Defense', desc: 'Blocks prompt injection attempts' },
                  { key: 'confidenceGate', name: 'Confidence Gate', desc: 'Threshold-based auto-escalation' },
                ] as const).map((g) => (
                  <div key={g.key} className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                    <CheckCircle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${guardrails[g.key] ? 'text-emerald-500' : 'text-gray-300'}`} />
                    <div className="flex-1">
                      <div className="text-sm font-medium text-gray-900">{g.name}</div>
                      <div className="text-xs text-gray-500">{g.desc}</div>
                    </div>
                    <Toggle
                      enabled={guardrails[g.key]}
                      onChange={() => { setGuardrails({ ...guardrails, [g.key]: !guardrails[g.key] }); setAiDirty(true); }}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* âââ Channels âââ */}
        {!loading && activeTab === 'channels' && (
          <div className="flex flex-col gap-6">
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">Communication Channels</h2>
              <p className="text-sm text-gray-500 mb-6">Configure channels the AI can use to reach contacts</p>

              <div className="flex flex-col gap-4">
                {(['email', 'sms', 'whatsapp', 'messenger'] as const).map((type) => {
                  const ch = channels.find((c) => c.type === type);
                  const iconInfo = channelIcons[type];
                  const Icon = iconInfo.icon;
                  const isConnected = ch?.status === 'connected';

                  return (
                    <div key={type} className={`p-4 border rounded-xl ${ch ? 'border-gray-200' : 'border-gray-200 border-dashed'}`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${iconInfo.color}`}>
                            <Icon className="w-5 h-5" />
                          </div>
                          <div>
                            <div className="text-sm font-semibold text-gray-900 capitalize">{type}</div>
                            <div className="text-xs text-gray-500">
                              {ch ? `${ch.provider} Â· ${isConnected ? 'Active' : ch.status}` : 'Not configured'}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {ch && <StatusBadge status={ch.status} />}
                          {!ch && (
                            <button
                    onClick={() => {
                      if (type === 'messenger') {
                        const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
                        window.open(`${apiBase}/api/integrations/messenger/authorize`, '_blank');
                        return;
                      }
                      settingsApi.updateChannel({
                        type: type as 'email' | 'sms' | 'whatsapp', provider: type === 'email' ? 'SendGrid' : 'Twilio', status: 'disconnected',
                      }).then(loadChannels).then(() => flash(`${type} channel added`));
                    }}
                              className="text-xs bg-indigo-500 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-indigo-600 transition-colors"
                            >
                              Configure
                            </button>
                          )}
                        </div>
                      </div>
                      {ch && (
                        <div className="mt-3 flex items-center gap-2 text-xs text-gray-400">
                          {ch.lastTestedAt && <span>Last tested: {timeAgo(ch.lastTestedAt)}</span>}
                          <button
                            onClick={() => settingsApi.testChannel(type).then(() => { loadChannels(); flash(`${type} test successful`); })}
                            className="text-indigo-500 hover:text-indigo-700 font-medium flex items-center gap-1"
                          >
                            <RefreshCw className="w-3 h-3" /> Test Connection
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* âââ Integrations âââ */}
        {!loading && activeTab === 'integrations' && (
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-1">Integrations</h2>
            <p className="text-sm text-gray-500 mb-6">Connect your tools to power the AI loop</p>
            <div className="flex flex-col gap-3">
              {integrationCatalog.map((cat) => {
                const live = getIntegrationStatus(cat.provider);
                const isConnected = live?.status === 'connected';

                return (
                  <div key={cat.provider} className="flex items-center justify-between p-4 border border-gray-200 rounded-xl">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center text-xl">{cat.icon}</div>
                      <div>
                        <div className="text-sm font-semibold text-gray-900">{cat.provider}</div>
                        <div className="text-xs text-gray-500 capitalize">{cat.category}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {live?.lastSyncAt && <span className="text-[11px] text-gray-400">Synced {timeAgo(live.lastSyncAt)}</span>}
                      {isConnected ? (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => syncIntegration(live!.id, cat.provider)}
                            disabled={saving}
                            className="text-xs text-indigo-500 hover:text-indigo-700 font-medium flex items-center gap-1"
                          >
                            <RefreshCw className={`w-3 h-3 ${saving ? 'animate-spin' : ''}`} /> Sync
                          </button>
                          <StatusBadge status="connected" />
                          <button
                            onClick={() => disconnectIntegration(live!.id, cat.provider)}
                            disabled={saving}
                            className="text-xs text-gray-400 hover:text-red-500"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : live?.status === 'disconnected' ? (
                        <button
                          onClick={() => connectIntegration(cat.provider, cat.category)}
                          disabled={saving}
                          className="text-xs bg-indigo-500 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-indigo-600 transition-colors"
                        >
                          Reconnect
                        </button>
                      ) : (
                        <button
                          onClick={() => connectIntegration(cat.provider, cat.category)}
                          disabled={saving}
                          className="text-xs bg-white border border-gray-200 text-gray-600 px-3 py-1.5 rounded-lg font-medium hover:bg-gray-50 transition-colors"
                        >
                          Connect
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* âââ Team & Roles âââ */}
        {!loading && activeTab === 'team' && (
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Team & Roles</h2>
                <p className="text-sm text-gray-500 mt-0.5">Manage who has access and what they can do</p>
              </div>
              <button
                onClick={() => setShowInvite(true)}
                className="text-xs bg-indigo-500 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-indigo-600 transition-colors flex items-center gap-1.5"
              >
                <UserPlus className="w-3 h-3" /> Invite Member
              </button>
            </div>

            {/* Invite Modal */}
            {showInvite && (
              <div className="mb-4 p-4 bg-indigo-50 border border-indigo-200 rounded-xl">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-gray-900">Send Invitation</span>
                  <button onClick={() => setShowInvite(false)} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
                </div>
                <div className="flex gap-2">
                  <input
                    type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="email@example.com"
                    className="flex-1 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:border-indigo-500 outline-none bg-white"
                  />
                  <select
                    value={inviteRole} onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}
                    className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:border-indigo-500 outline-none"
                  >
                    <option value="viewer">Viewer</option>
                    <option value="agent">Agent</option>
                    <option value="admin">Admin</option>
                    <option value="owner">Owner</option>
                  </select>
                  <button
                    onClick={inviteMember} disabled={saving || !inviteEmail}
                    className="px-4 py-2 text-sm bg-indigo-500 text-white rounded-lg font-medium hover:bg-indigo-600 disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send'}
                  </button>
                </div>
              </div>
            )}

            {/* Members */}
            <div className="flex flex-col gap-3">
              {members.map((m) => (
                <div key={m.id} className="flex items-center justify-between p-4 border border-gray-200 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold">
                      {(m.name || m.email).slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">{m.name || m.email}</div>
                      <div className="text-xs text-gray-500">{m.email}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[11px] px-2.5 py-1 rounded-full font-medium capitalize ${roleColors[m.role]}`}>{m.role}</span>
                    {m.role !== 'owner' && (
                      <button onClick={() => removeMember(m.id)} disabled={saving} className="text-gray-400 hover:text-red-500">
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {/* Pending Invitations */}
              {invitations.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between p-4 border border-amber-200 bg-amber-50/30 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-xs font-semibold">
                      {inv.email.slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">{inv.email}</div>
                      <div className="text-xs text-gray-500">Invited Â· Expires {timeAgo(inv.expiresAt)}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[11px] px-2.5 py-1 rounded-full font-medium capitalize ${roleColors[inv.role]}`}>{inv.role}</span>
                    <StatusBadge status="pending" />
                    <button onClick={() => cancelInvite(inv.id)} disabled={saving} className="text-gray-400 hover:text-red-500">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}

              {members.length === 0 && invitations.length === 0 && (
                <div className="text-center py-8 text-sm text-gray-400">No team members yet. Invite someone to get started.</div>
              )}
            </div>
          </div>
        )}

        {/* âââ Notifications âââ */}
        {!loading && activeTab === 'notifications' && (
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-1">Notification Preferences</h2>
            <p className="text-sm text-gray-500 mb-6">Choose what alerts and reports you receive</p>
            <div className="flex flex-col gap-4">
              {([
                { key: 'escalation' as const, label: 'Escalation alerts', desc: 'Get notified when the AI escalates a contact for human review' },
                { key: 'daily_digest' as const, label: 'Daily digest', desc: 'Summary of all AI actions, decisions, and outcomes from the day' },
                { key: 'weekly_report' as const, label: 'Weekly performance report', desc: 'Strategy performance, conversion rates, and pipeline health' },
                { key: 'brain_update' as const, label: 'Brain update notifications', desc: 'Get notified when the Business Brain completes a learning cycle' },
              ]).map((n) => (
                <div key={n.key} className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                  <div>
                    <div className="text-sm font-medium text-gray-900">{n.label}</div>
                    <div className="text-xs text-gray-500">{n.desc}</div>
                  </div>
                  <Toggle enabled={!!notifPrefs[n.key]} onChange={() => toggleNotification(n.key)} disabled={saving} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* âââ Security âââ */}
        {!loading && activeTab === 'security' && security && (
          <div className="flex flex-col gap-6">
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">Security & Compliance</h2>
              <p className="text-sm text-gray-500 mb-6">Data protection and access controls</p>
              <div className="flex flex-col gap-3">
                {/* 2FA */}
                <div className="flex items-center justify-between p-4 border border-gray-200 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-gray-50 rounded-lg flex items-center justify-center"><Shield className="w-4 h-4 text-gray-600" /></div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">Two-factor authentication</div>
                      <div className="text-xs text-gray-500">Require 2FA for all team members</div>
                    </div>
                  </div>
                  <Toggle enabled={security.twoFactorEnabled} onChange={() => updateSecurity('twoFactorEnabled', !security.twoFactorEnabled)} disabled={saving} />
                </div>

                {/* SSO */}
                <div className="flex items-center justify-between p-4 border border-gray-200 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-gray-50 rounded-lg flex items-center justify-center"><Key className="w-4 h-4 text-gray-600" /></div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">SSO (SAML)</div>
                      <div className="text-xs text-gray-500">Single sign-on via your identity provider</div>
                    </div>
                  </div>
                  <Toggle enabled={security.ssoEnabled} onChange={() => updateSecurity('ssoEnabled', !security.ssoEnabled)} disabled={saving} />
                </div>

                {/* Encryption â always on */}
                <div className="flex items-center justify-between p-4 border border-gray-200 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-gray-50 rounded-lg flex items-center justify-center"><Lock className="w-4 h-4 text-gray-600" /></div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">Data encryption</div>
                      <div className="text-xs text-gray-500">AES-256 at rest, TLS 1.3 in transit</div>
                    </div>
                  </div>
                  <span className="text-xs bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-full font-medium">Always Active</span>
                </div>

                {/* Audit Log Retention */}
                <div className="flex items-center justify-between p-4 border border-gray-200 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-gray-50 rounded-lg flex items-center justify-center"><Database className="w-4 h-4 text-gray-600" /></div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">Audit log retention</div>
                      <div className="text-xs text-gray-500">Immutable logs â {Math.round(security.auditRetentionDays / 365)} year{security.auditRetentionDays > 365 ? 's' : ''}</div>
                    </div>
                  </div>
                  <span className="text-xs bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-full font-medium">
                    {security.auditRetentionDays} days
                  </span>
                </div>

                {/* GDPR */}
                <div className="flex items-center justify-between p-4 border border-gray-200 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 bg-gray-50 rounded-lg flex items-center justify-center"><Globe className="w-4 h-4 text-gray-600" /></div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">GDPR compliance</div>
                      <div className="text-xs text-gray-500">Data processing agreement on file</div>
                    </div>
                  </div>
                  <Toggle enabled={security.gdprCompliant} onChange={() => updateSecurity('gdprCompliant', !security.gdprCompliant)} disabled={saving} />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
