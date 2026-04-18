'use client';

import {
  Settings, Brain, Shield, Zap, Mail, Phone, MessageCircle,
  Key, Users, Bell, Palette, Globe, Database, ChevronRight,
  CheckCircle, AlertTriangle, Sparkles, Link, ToggleLeft,
  ToggleRight, Save, RefreshCw, Lock, Eye, Plug
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { settingsApi } from '@/lib/api';

/* ─── Component ─────────────────────────────────────── */
export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('ai');
  const [confidenceThreshold, setConfidenceThreshold] = useState(70);
  const [autoApprove, setAutoApprove] = useState(true);
  const [dailyLimit, setDailyLimit] = useState(200);
  const [channels, setChannels] = useState({
    email: { enabled: true, provider: 'SendGrid', status: 'connected' },
    sms: { enabled: true, provider: 'Twilio', status: 'connected' },
    whatsapp: { enabled: false, provider: 'Twilio', status: 'not_configured' },
  });
  const [notifications, setNotifications] = useState({
    escalations: true,
    dailyDigest: true,
    weeklyReport: true,
    brainUpdates: false,
  });

  const tabs = [
    { id: 'ai', label: 'AI Configuration', icon: Brain },
    { id: 'channels', label: 'Channels', icon: Mail },
    { id: 'integrations', label: 'Integrations', icon: Plug },
    { id: 'team', label: 'Team & Roles', icon: Users },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'security', label: 'Security', icon: Shield },
  ];

  const integrations = [
    { name: 'HubSpot', category: 'CRM', status: 'connected', icon: '🔶', lastSync: '5 min ago' },
    { name: 'Salesforce', category: 'CRM', status: 'available', icon: '☁️', lastSync: null },
    { name: 'Stripe', category: 'Payments', status: 'connected', icon: '💳', lastSync: '1 hr ago' },
    { name: 'Cal.com', category: 'Calendar', status: 'connected', icon: '📅', lastSync: '12 min ago' },
    { name: 'Pipedrive', category: 'CRM', status: 'available', icon: '🟢', lastSync: null },
    { name: 'Shopify', category: 'Commerce', status: 'available', icon: '🛒', lastSync: null },
  ];

  const teamMembers = [
    { name: 'You', email: 'admin@company.com', role: 'Owner', avatar: 'YO', status: 'active' },
    { name: 'Jordan Mitchell', email: 'jordan@company.com', role: 'Admin', avatar: 'JM', status: 'active' },
    { name: 'Casey Brooks', email: 'casey@company.com', role: 'Agent', avatar: 'CB', status: 'active' },
    { name: 'Alex Rivera', email: 'alex@company.com', role: 'Viewer', avatar: 'AR', status: 'invited' },
  ];

  const roleColors: Record<string, string> = {
    Owner: 'bg-indigo-50 text-indigo-700',
    Admin: 'bg-purple-50 text-purple-700',
    Agent: 'bg-emerald-50 text-emerald-700',
    Viewer: 'bg-gray-100 text-gray-600',
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
        {/* AI Configuration */}
        {activeTab === 'ai' && (
          <div className="flex flex-col gap-6">
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">AI Decision Controls</h2>
              <p className="text-sm text-gray-500 mb-6">Control how autonomously the AI operates across all pipelines</p>

              {/* Confidence Threshold */}
              <div className="mb-6">
                <label className="text-sm font-medium text-gray-700 mb-2 block">
                  Global Confidence Threshold: <strong className="text-indigo-500">{confidenceThreshold}%</strong>
                </label>
                <p className="text-xs text-gray-500 mb-3">
                  Actions below this confidence level will be escalated for human review
                </p>
                <input
                  type="range"
                  min="20"
                  max="95"
                  value={confidenceThreshold}
                  onChange={(e) => setConfidenceThreshold(Number(e.target.value))}
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
                <button
                  onClick={() => setAutoApprove(!autoApprove)}
                  className={`w-11 h-6 rounded-full transition-colors flex items-center ${
                    autoApprove ? 'bg-indigo-500 justify-end' : 'bg-gray-300 justify-start'
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
                  value={dailyLimit}
                  onChange={(e) => setDailyLimit(Number(e.target.value))}
                  className="w-24 px-3 py-1.5 text-sm text-right border border-gray-200 rounded-lg focus:border-indigo-500 outline-none"
                />
              </div>
            </div>

            {/* AI Strategies */}
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">Strategy Permissions</h2>
              <p className="text-sm text-gray-500 mb-4">Enable or disable AI strategies globally</p>
              <div className="flex flex-col gap-3">
                {[
                  { name: 'Direct Conversion', desc: 'Push toward conversion for high-intent contacts', enabled: true },
                  { name: 'Guided Assistance', desc: 'Educational approach for evaluating contacts', enabled: true },
                  { name: 'Trust Building', desc: 'Relationship-building for early-stage or at-risk contacts', enabled: true },
                  { name: 'Re-engagement', desc: 'Win-back dormant or churned contacts', enabled: true },
                ].map((s) => (
                  <div key={s.name} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div>
                      <div className="text-sm font-medium text-gray-900">{s.name}</div>
                      <div className="text-xs text-gray-500">{s.desc}</div>
                    </div>
                    <div className={`w-11 h-6 rounded-full transition-colors flex items-center ${
                      s.enabled ? 'bg-indigo-500 justify-end' : 'bg-gray-300 justify-start'
                    }`}>
                      <div className="w-5 h-5 bg-white rounded-full shadow mx-0.5" />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Guardrails */}
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">Guardrails</h2>
              <p className="text-sm text-gray-500 mb-4">Safety checks applied before every AI action</p>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { name: 'Tone Validator', status: 'Active', desc: 'Checks brand voice compliance' },
                  { name: 'Accuracy Check', status: 'Active', desc: 'Validates against Company Truth' },
                  { name: 'Hallucination Filter', status: 'Active', desc: 'Ensures claims grounded in context' },
                  { name: 'Compliance (CAN-SPAM/CASL)', status: 'Active', desc: 'Legal compliance enforcement' },
                  { name: 'Injection Defense', status: 'Active', desc: 'Blocks prompt injection attempts' },
                  { name: 'Confidence Gate', status: 'Active', desc: 'Threshold-based auto-escalation' },
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
        {activeTab === 'channels' && (
          <div className="flex flex-col gap-6">
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">Communication Channels</h2>
              <p className="text-sm text-gray-500 mb-6">Configure channels the AI can use to reach contacts</p>

              <div className="flex flex-col gap-4">
                {/* Email */}
                <div className="p-4 border border-gray-200 rounded-xl">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-indigo-50 rounded-lg flex items-center justify-center">
                        <Mail className="w-5 h-5 text-indigo-600" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-gray-900">Email</div>
                        <div className="text-xs text-gray-500">SendGrid · SPF/DKIM configured</div>
                      </div>
                    </div>
                    <span className="text-xs bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-full font-medium flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" /> Connected
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div className="p-2 bg-gray-50 rounded-lg"><span className="text-gray-500">Sent today:</span> <strong className="text-gray-900">47</strong></div>
                    <div className="p-2 bg-gray-50 rounded-lg"><span className="text-gray-500">Open rate:</span> <strong className="text-gray-900">34%</strong></div>
                    <div className="p-2 bg-gray-50 rounded-lg"><span className="text-gray-500">Bounce rate:</span> <strong className="text-gray-900">1.2%</strong></div>
                  </div>
                </div>

                {/* SMS */}
                <div className="p-4 border border-gray-200 rounded-xl">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-emerald-50 rounded-lg flex items-center justify-center">
                        <Phone className="w-5 h-5 text-emerald-600" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-gray-900">SMS</div>
                        <div className="text-xs text-gray-500">Twilio · 10DLC registered</div>
                      </div>
                    </div>
                    <span className="text-xs bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-full font-medium flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" /> Connected
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <div className="p-2 bg-gray-50 rounded-lg"><span className="text-gray-500">Sent today:</span> <strong className="text-gray-900">23</strong></div>
                    <div className="p-2 bg-gray-50 rounded-lg"><span className="text-gray-500">Response rate:</span> <strong className="text-gray-900">28%</strong></div>
                    <div className="p-2 bg-gray-50 rounded-lg"><span className="text-gray-500">Opt-out rate:</span> <strong className="text-gray-900">0.3%</strong></div>
                  </div>
                </div>

                {/* WhatsApp */}
                <div className="p-4 border border-gray-200 rounded-xl border-dashed">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center">
                        <MessageCircle className="w-5 h-5 text-gray-400" />
                      </div>
                      <div>
                        <div className="text-sm font-semibold text-gray-900">WhatsApp</div>
                        <div className="text-xs text-gray-500">Twilio WhatsApp Business API</div>
                      </div>
                    </div>
                    <button className="text-xs bg-indigo-500 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-indigo-600 transition-colors">
                      Configure
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Integrations */}
        {activeTab === 'integrations' && (
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-1">Integrations</h2>
            <p className="text-sm text-gray-500 mb-6">Connect your tools to power the AI loop</p>
            <div className="flex flex-col gap-3">
              {integrations.map((int) => (
                <div key={int.name} className="flex items-center justify-between p-4 border border-gray-200 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center text-xl">
                      {int.icon}
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-gray-900">{int.name}</div>
                      <div className="text-xs text-gray-500">{int.category}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {int.lastSync && <span className="text-[11px] text-gray-400">Synced {int.lastSync}</span>}
                    {int.status === 'connected' ? (
                      <span className="text-xs bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-full font-medium flex items-center gap-1">
                        <CheckCircle className="w-3 h-3" /> Connected
                      </span>
                    ) : (
                      <button className="text-xs bg-white border border-gray-200 text-gray-600 px-3 py-1.5 rounded-lg font-medium hover:bg-gray-50 transition-colors">
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
        {activeTab === 'team' && (
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Team & Roles</h2>
                <p className="text-sm text-gray-500 mt-0.5">Manage who has access and what they can do</p>
              </div>
              <button className="text-xs bg-indigo-500 text-white px-3 py-1.5 rounded-lg font-medium hover:bg-indigo-600 transition-colors">
                Invite Member
              </button>
            </div>
            <div className="flex flex-col gap-3">
              {teamMembers.map((m) => (
                <div key={m.email} className="flex items-center justify-between p-4 border border-gray-200 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold">
                      {m.avatar}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">{m.name}</div>
                      <div className="text-xs text-gray-500">{m.email}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[11px] px-2.5 py-1 rounded-full font-medium ${roleColors[m.role]}`}>{m.role}</span>
                    {m.status === 'invited' && (
                      <span className="text-[11px] text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">Pending</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Notifications */}
        {activeTab === 'notifications' && (
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-1">Notification Preferences</h2>
            <p className="text-sm text-gray-500 mb-6">Choose what alerts and reports you receive</p>
            <div className="flex flex-col gap-4">
              {[
                { key: 'escalations', label: 'Escalation alerts', desc: 'Get notified when the AI escalates a contact for human review', enabled: notifications.escalations },
                { key: 'dailyDigest', label: 'Daily digest', desc: 'Summary of all AI actions, decisions, and outcomes from the day', enabled: notifications.dailyDigest },
                { key: 'weeklyReport', label: 'Weekly performance report', desc: 'Strategy performance, conversion rates, and pipeline health', enabled: notifications.weeklyReport },
                { key: 'brainUpdates', label: 'Brain update notifications', desc: 'Get notified when the Business Brain completes a learning cycle', enabled: notifications.brainUpdates },
              ].map((n) => (
                <div key={n.key} className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                  <div>
                    <div className="text-sm font-medium text-gray-900">{n.label}</div>
                    <div className="text-xs text-gray-500">{n.desc}</div>
                  </div>
                  <button
                    onClick={() => setNotifications({ ...notifications, [n.key]: !n.enabled })}
                    className={`w-11 h-6 rounded-full transition-colors flex items-center ${
                      n.enabled ? 'bg-indigo-500 justify-end' : 'bg-gray-300 justify-start'
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
        {activeTab === 'security' && (
          <div className="flex flex-col gap-6">
            <div className="bg-white border border-gray-200 rounded-xl p-6">
              <h2 className="text-base font-semibold text-gray-900 mb-1">Security & Compliance</h2>
              <p className="text-sm text-gray-500 mb-6">Data protection and access controls</p>
              <div className="flex flex-col gap-3">
                {[
                  { name: 'Two-factor authentication', desc: 'Require 2FA for all team members', status: 'Enabled', icon: Shield },
                  { name: 'SSO (SAML)', desc: 'Single sign-on via your identity provider', status: 'Available', icon: Key },
                  { name: 'Data encryption', desc: 'AES-256 at rest, TLS 1.3 in transit', status: 'Active', icon: Lock },
                  { name: 'Audit log retention', desc: 'Immutable logs retained for 2 years', status: '2 years', icon: Database },
                  { name: 'GDPR compliance', desc: 'Data processing agreement on file', status: 'Compliant', icon: Globe },
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
