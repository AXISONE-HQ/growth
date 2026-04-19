'use client';

import {
  Settings, Brain, Shield, Zap, Mail, Phone, MessageCircle, Key,
  Users, Bell, Palette, Globe, Database, ChevronRight, CheckCircle,
  AlertTriangle, Sparkles, Link, ToggleLeft, ToggleRight, Save,
  RefreshCw, Lock, Eye, Plug, Loader2
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { settingsApi } from '@/lib/api';
import type { AIConfig, ChannelRecord, IntegrationRecord, TeamMemberRecord, InvitationRecord, NotificationPrefs, SecurityConfig } from '@/lib/api';


/* âââ Helpers âââââââââââââââââââââââââââââââââââââââââââ */
const STRATEGY_META: Record<string, { name: string; desc: string }> = {
  directConversion: { name: 'Direct Conversion', desc: 'Push toward conversion for high-intent contacts' },
  guidedAssistance: { name: 'Guided Assistance', desc: 'Educational approach for evaluating contacts' },
  trustBuilding: { name: 'Trust Building', desc: 'Relationship-building for early-stage or at-risk contacts' },
  reengagement: { name: 'Re-engagement', desc: 'Win-back dormant or churned contacts' },
};

const ALL_STRATEGIES = Object.keys(STRATEGY_META) as Array<keyof AIConfig['strategyPermissions']>;

const channelIcon: Record<string, typeof Mail> = { email: Mail, sms: Phone, whatsapp: MessageCircle };

const roleColors: Record<string, string> = {
  owner: 'bg-indigo-50 text-indigo-700',
  admin: 'bg-purple-50 text-purple-700',
  agent: 'bg-emerald-50 text-emerald-700',
  viewer: 'bg-gray-100 text-gray-600',
};

const integrationIcons: Record<string, string> = {
  HubSpot: 'ð¶', Salesforce: 'âï¸', Stripe: 'ð³', 'Cal.com': 'ð', Pipedrive: 'ð¢', Shopify: 'ð',
};

/* âââ Component âââââââââââââââââââââââââââââââââââââââ */
export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('ai');

  /* ââ Loading / saving state ââââââââââââââââ */
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* ââ AI âââââââââââââââââââââââââââââââââââââ */
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null);

  /* ââ Channels âââââââââââââââââââââââââââââââ */
  const [channels, setChannels] = useState<ChannelRecord[]>([]);

  /* ââ Integrations âââââââââââââââââââââââââââ */
  const [integrations, setIntegrations] = useState<IntegrationRecord[]>([]);

  /* ââ Team ââââââââââââââââââââââââââââââââââââ */
  const [teamMembers, setTeamMembers] = useState<TeamMemberRecord[]>([]);
  const [invitations, setInvitations] = useState<InvitationRecord[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('viewer');

  /* ââ Notifications ââââââââââââââââââââââââââ */
  const [notifPrefs, setNotifPrefs] = useState<NotificationPrefs | null>(null);

  /* ââ Security âââââââââââââââââââââââââââââââ */
  const [securityConfig, setSecurityConfig] = useState<SecurityConfig | null>(null);

  /* ââ Data fetching per tab ââââââââââââââââââ */
  const loadTab = useCallback(async (tab: string) => {
    setLoading(true);
    setError(null);
    try {
      switch (tab) {
        case 'ai': {
          const data = await settingsApi.ai.get();
          setAiConfig(data);
          break;
        }
        case 'channels': {
          const data = await settingsApi.channels.list();
          setChannels(data);
          break;
        }
        case 'integrations': {
          const data = await settingsApi.integrations.list();
          setIntegrations(data);
          break;
        }
        case 'team': {
          const data = await settingsApi.team.list();
          setTeamMembers(data.members);
          setInvitations(data.invitations ?? []);
          break;
        }
        case 'notifications': {
          const data = await settingsApi.notifications.get();
          setNotifPrefs(data);
          break;
        }
        case 'security': {
          const data = await settingsApi.security.get();
          setSecurityConfig(data);
          break;
        }
      }
    } catch (e: unknown) {
      console.error(`Settings load error (${tab}):`, e);
      setError(e instanceof Error ? e.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTab(activeTab); }, [activeTab, loadTab]);

  /* ââ Save helpers âââââââââââââââââââââââââââ */
  const flash = (msg: string) => { setSaveMsg(msg); setTimeout(() => setSaveMsg(null), 2500); };

  const saveAI = async () => {
    if (!aiConfig) return;
    setSaving(true);
    try {
      await settingsApi.ai.update(aiConfig);
      flash('AI settings saved');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  };

  const saveNotifications = async () => {
    if (!notifPrefs) return;
    setSaving(true);
    try {
      const prefMap: Record<string, boolean> = {
        escalation: notifPrefs.escalation,
        daily_digest: notifPrefs.daily_digest,
        weekly_report: notifPrefs.weekly_report,
        brain_update: notifPrefs.brain_update,
      };
      for (const [type, enabled] of Object.entries(prefMap)) {
        await settingsApi.notifications.update({ type, enabled });
      }
      flash('Notification preferences saved');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleInvite = async () => {
    if (!inviteEmail) return;
    setSaving(true);
    try {
      await settingsApi.team.invite({ email: inviteEmail, role: inviteRole });
      flash(`Invitation sent to ${inviteEmail}`);
      setInviteEmail('');
      loadTab('team');
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Invite failed'); }
    finally { setSaving(false); }
  };

  /* ââ Tab config âââââââââââââââââââââââââââââ */
  const tabs = [
    { id: 'ai', label: 'AI Configuration', icon: Brain },
    { id: 'channels', label: 'Channels', icon: Mail },
    { id: 'integrations', label: 'Integrations', icon: Plug },
    { id: 'team', label: 'Team & Roles', icon: Users },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'security', label: 'Security', icon: Shield },
  ];

  /* ââ Toggle helper for strategies âââââââââââ */
  const toggleStrategy = (key: keyof AIConfig['strategyPermissions']) => {
    if (!aiConfig) return;
    setAiConfig({
      ...aiConfig,
      strategyPermissions: {
        ...aiConfig.strategyPermissions,
        [key]: !aiConfig.strategyPermissions[key],
      },
    });
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
                activeTab === tab.id ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50'
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
        {/* Status bar */}
        {(saveMsg || error) && (
          <div className={`mb-4 px-4 py-2 rounded-lg text-sm font-medium ${
            error ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'
          }`}>
            {error ?? saveMsg}
            {error && (
              <button onClick={() => setError(null)} className="ml-3 underline text-xs">Dismiss</button>
            )}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
            <span className="ml-2 text-sm text-gray-500">Loadingâ¦</span>
          </div>
        )}

        {/* AI Configuration */}
        {activeTab === 'ai' && !loading && aiConfig && (
          <div className="flex flex-col gap-6">
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-base font-semibold text-gray-900">AI Decision Controls</h2>
                <button
                  onClick={saveAI}
                  disabled={saving}
                  className="flex items-center gap-1.5 text-xs bg-indigo-500 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-indigo-600 transition-colors disabled:opacity-50"
                >
                  {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  Save
                </button>
              </div>
              <p className="text-sm text-gray-500 mb-6">Control how autonomously the AI operates across all pipelines</p>
              {/* Confidence Threshold */}
              <div className="mb-6">
                <label className="text-sm font-medium text-gray-700 mb-2 block">
                  Global Confidence Threshold: <strong className="text-indigo-500">{aiConfig.confidenceThreshold}%</strong>
                </label>
                <p className="text-xs text-gray-500 mb-3">Actions below this confidence level will be escalated for human review</p>
                <input
                  type="range" min="20" max="95"
                  value={aiConfig.confidenceThreshold}
                  onChange={(e) => setAiConfig({ ...aiConfig, confidenceThreshold: Number(e.target.value) })}
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
                  <div className="text-xs text-gray-500">Actions above {aiConfig.confidenceThreshold}% confidence execute without human review</div>
                </div>
                <button
                  onClick={() => setAiConfig({ ...aiConfig, autoApproveEnabled: !aiConfig.autoApproveEnabled })}
                  className={`w-11 h-6 rounded-full transition-colors flex items-center ${
                    aiConfig.autoApproveEnabled ? 'bg-indigo-500 justify-end' : 'bg-gray-300 justify-start'
                  }`}
                >
                  <div className="w-5 h-5 bg-white rounded-full shadow mx-0.5" />
                </button>
              </div>

              {/* Daily Limit */}
              <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                <div>
                  <div className="text-sm font-medium text-gray-900">Daily action limit</div>
                  <div className="text-xs text-gray-500">Maximum AI-initiated actions per day</div>
                </div>
                <input
                  type="number"
                  value={aiConfig.dailyActionLimit}
                  onChange={(e) => setAiConfig({ ...aiConfig, dailyActionLimit: Number(e.target.value) })}
                  className="w-24 px-3 py-1.5 text-sm text-right border border-gray-200 rounded-lg focus:border-indigo-500 outline-none"
                />
              </div>
            </div>

            {/* AI Strategies */}
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">Strategy Permissions</h2>
              <p className="text-sm text-gray-500 mb-4">Enable or disable AI strategies globally</p>
              <div className="flex flex-col gap-3">
                {ALL_STRATEGIES.map((key) => {
                  const meta = STRATEGY_META[key];
                  const enabled = aiConfig.strategyPermissions[key];
                  return (
                    <div key={key} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                      <div>
                        <div className="text-sm font-medium text-gray-900">{meta.name}</div>
                        <div className="text-xs text-gray-500">{meta.desc}</div>
                      </div>
                      <button
                        onClick={() => toggleStrategy(key)}
                        className={`w-11 h-6 rounded-full transition-colors flex items-center ${
                          enabled ? 'bg-indigo-500 justify-end' : 'bg-gray-300 justify-start'
                        }`}
                      >
                        <div className="w-5 h-5 bg-white rounded-full shadow mx-0.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Guardrails */}
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">Guardrails</h2>
              <p className="text-sm text-gray-500 mb-4">Safety checks applied before every AI action</p>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { name: 'Tone Validator', desc: 'Checks brand voice compliance' },
                  { name: 'Accuracy Check', desc: 'Validates against Company Truth' },
                  { name: 'Hallucination Filter', desc: 'Ensures claims grounded in context' },
                  { name: 'Compliance (CAN-SPAM/CASL)', desc: 'Legal compliance enforcement' },
                  { name: 'Injection Defense', desc: 'Blocks prompt injection attempts' },
                  { name: 'Confidence Gate', desc: 'Threshold-based auto-escalation' },
                ].map((g) => (
                  <div key={g.name} className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                    <CheckCircle className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-gray-900">{g.name}</div>
                      <div className="text-xs text-gray-500">{g.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Channels */}
        {activeTab === 'channels' && !loading && (
          <div className="flex flex-col gap-6">
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">Communication Channels</h2>
              <p className="text-sm text-gray-500 mb-6">Configure channels the AI can use to reach contacts</p>
              <div className="flex flex-col gap-4">
                {channels.length === 0 && !loading && (
                  <p className="text-sm text-gray-400 py-8 text-center">No channels configured yet.</p>
                )}
                {channels.map((ch) => {
                  const Icon = channelIcon[ch.type] ?? Mail;
                  const connected = ch.status === 'connected';
                  return (
                    <div key={ch.id} className={`p-4 border rounded-xl ${connected ? 'border-gray-200' : 'border-gray-200 border-dashed'}`}>
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${connected ? 'bg-indigo-50' : 'bg-gray-50'}`}>
                            <Icon className={`w-5 h-5 ${connected ? 'text-indigo-600' : 'text-gray-400'}`} />
                          </div>
                          <div>
                            <div className="text-sm font-semibold text-gray-900 capitalize">{ch.type}</div>
                            <div className="text-xs text-gray-500">{ch.provider}</div>
                          </div>
                        </div>
                        {connected ? (
                          <span className="text-xs bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-full font-medium flex items-center gap-1">
                            <CheckCircle className="w-3 h-3" /> Connected
                          </span>
                        ) : (
                          <button className="text-xs bg-indigo-500 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-indigo-600 transition-colors">
                            Configure
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Integrations */}
        {activeTab === 'integrations' && !loading && (
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-1">Integrations</h2>
            <p className="text-sm text-gray-500 mb-6">Connect your tools to power the AI loop</p>
            <div className="flex flex-col gap-3">
              {integrations.length === 0 && (
                <p className="text-sm text-gray-400 py-8 text-center">No integrations available.</p>
              )}
              {integrations.map((int) => (
                <div key={int.id} className="flex items-center justify-between p-4 border border-gray-200 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center text-xl">
                      {integrationIcons[int.provider] ?? 'ð'}
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-gray-900">{int.provider}</div>
                      <div className="text-xs text-gray-500">{int.category}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {int.lastSyncAt && (
                      <span className="text-[11px] text-gray-400">
                        Synced {new Date(int.lastSyncAt).toLocaleString()}
                      </span>
                    )}
                    {int.status === 'connected' ? (
                      <span className="text-xs bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-full font-medium flex items-center gap-1">
                        <CheckCircle className="w-3 h-3" /> Connected
                      </span>
                    ) : (
                      <button
                        onClick={async () => {
                          try {
                            await settingsApi.integrations.connect({ provider: int.provider, category: int.category });
                            flash('Integration connected');
                            loadTab('integrations');
                          } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Connect failed'); }
                        }}
                        className="text-xs bg-white border border-gray-200 text-gray-600 px-3 py-1.5 rounded-lg font-medium hover:bg-gray-50 transition-colors"
                      >
                        Connect
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Team & Roles */}
        {activeTab === 'team' && !loading && (
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Team & Roles</h2>
                <p className="text-sm text-gray-500 mt-0.5">Manage who has access and what they can do</p>
              </div>
            </div>

            {/* Invite form */}
            <div className="flex gap-2 mb-6">
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="Email address"
                className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:border-indigo-500 outline-none"
              />
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:border-indigo-500 outline-none"
              >
                <option value="viewer">Viewer</option>
                <option value="agent">Agent</option>
                <option value="admin">Admin</option>
              </select>
              <button
                onClick={handleInvite}
                disabled={saving || !inviteEmail}
                className="text-xs bg-indigo-500 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-indigo-600 transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Invite'}
              </button>
            </div>

            <div className="flex flex-col gap-3">
              {teamMembers.map((m) => (
                <div key={m.id} className="flex items-center justify-between p-4 border border-gray-200 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold">
                      {(m.name ?? m.email).split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">{m.name ?? m.email}</div>
                      <div className="text-xs text-gray-500">{m.email}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[11px] px-2.5 py-1 rounded-full font-medium ${roleColors[m.role.toLowerCase()] ?? 'bg-gray-100 text-gray-600'}`}>
                      {m.role}
                    </span>
                    {!m.active && (
                      <span className="text-[11px] text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">Inactive</span>
                    )}
                  </div>
                </div>
              ))}

              {/* Pending invitations */}
              {invitations.filter((i) => i.status === 'pending').map((inv) => (
                <div key={inv.id} className="flex items-center justify-between p-4 border border-dashed border-gray-200 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center text-xs font-semibold">
                      ?
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-500">{inv.email}</div>
                      <div className="text-xs text-gray-400">Invitation pending</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[11px] px-2.5 py-1 rounded-full font-medium ${roleColors[inv.role.toLowerCase()] ?? 'bg-gray-100 text-gray-600'}`}>
                      {inv.role}
                    </span>
                    <button
                      onClick={async () => {
                        try {
                          await settingsApi.team.cancelInvite({ id: inv.id });
                          flash('Invitation cancelled');
                          loadTab('team');
                        } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Cancel failed'); }
                      }}
                      className="text-[11px] text-red-600 hover:underline"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Notifications */}
        {activeTab === 'notifications' && !loading && notifPrefs && (
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-base font-semibold text-gray-900">Notification Preferences</h2>
              <button
                onClick={saveNotifications}
                disabled={saving}
                className="flex items-center gap-1.5 text-xs bg-indigo-500 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-indigo-600 transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                Save
              </button>
            </div>
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
                  <button
                    onClick={() => setNotifPrefs({ ...notifPrefs, [n.key]: !notifPrefs[n.key] })}
                    className={`w-11 h-6 rounded-full transition-colors flex items-center ${
                      notifPrefs[n.key] ? 'bg-indigo-500 justify-end' : 'bg-gray-300 justify-start'
                    }`}
                  >
                    <div className="w-5 h-5 bg-white rounded-full shadow mx-0.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Security */}
        {activeTab === 'security' && !loading && securityConfig && (
          <div className="flex flex-col gap-6">
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">Security & Compliance</h2>
              <p className="text-sm text-gray-500 mb-6">Data protection and access controls</p>
              <div className="flex flex-col gap-3">
                {[
                  { name: 'Two-factor authentication', desc: 'Require 2FA for all team members', status: securityConfig.twoFactorEnabled ? 'Enabled' : 'Disabled', icon: Shield },
                  { name: 'SSO (SAML)', desc: `Single sign-on${securityConfig.ssoProvider ? ` via ${securityConfig.ssoProvider}` : ''}`, status: securityConfig.ssoEnabled ? 'Active' : 'Available', icon: Key },
                  { name: 'Data encryption', desc: 'AES-256 at rest, TLS 1.3 in transit', status: 'Active', icon: Lock },
                  { name: 'Audit log retention', desc: 'Immutable logs retained', status: `${Math.round(securityConfig.auditRetentionDays / 365)} years`, icon: Database },
                  { name: 'GDPR compliance', desc: 'Data processing agreement on file', status: securityConfig.gdprCompliant ? 'Compliant' : 'Not configured', icon: Globe },
                ].map((s) => (
                  <div key={s.name} className="flex items-center justify-between p-4 border border-gray-200 rounded-xl">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 bg-gray-50 rounded-lg flex items-center justify-center">
                        <s.icon className="w-4 h-4 text-gray-600" />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-gray-900">{s.name}</div>
                        <div className="text-xs text-gray-500">{s.desc}</div>
                      </div>
                    </div>
                    <span className="text-xs bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-full font-medium">{s.status}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
