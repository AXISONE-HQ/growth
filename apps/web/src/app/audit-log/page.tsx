'use client';

import {
  FileText, Search, Filter, Clock, ChevronDown, Download,
  Sparkles, Mail, Phone, MessageCircle, Target, Brain,
  AlertTriangle, CheckCircle, ArrowRight, Eye, Shield,
  User, Zap, Calendar, BarChart3, RefreshCw
} from 'lucide-react';
import { useState } from 'react';

/* ─── Mock Data ─────────────────────────────────────── */
const auditEntries = [
  {
    id: 1, timestamp: '2025-04-16 10:19:32', actor: 'AI Agent',
    actionType: 'message.sent', category: 'Communication',
    contact: 'Sarah Chen', company: 'Meridian Consulting',
    description: 'Follow-up email sent regarding proposal timeline',
    strategy: 'Direct Conversion', confidence: 92, channel: 'Email',
    reasoning: 'Contact opened proposal 3x in 24h. High-intent evaluator profile. Direct follow-up has 72% success rate for this segment.',
    approved: true, autoApproved: true,
  },
  {
    id: 2, timestamp: '2025-04-16 10:12:15', actor: 'AI Agent',
    actionType: 'meeting.scheduled', category: 'Operational',
    contact: 'Marcus Reid', company: 'Forge Manufacturing',
    description: 'Demo call scheduled for Thursday 2pm via Cal.com',
    strategy: 'Guided Assistance', confidence: 74, channel: 'Calendar',
    reasoning: 'Contact completed 6/8 sub-objectives. Primary blocker is technical evaluation. Guided demo addresses this directly.',
    approved: true, autoApproved: false,
  },
  {
    id: 3, timestamp: '2025-04-16 09:58:44', actor: 'AI Agent',
    actionType: 'escalation.triggered', category: 'Escalation',
    contact: 'Brian Walker', company: 'Vertex Analytics',
    description: 'Escalated to human queue — confidence below threshold',
    strategy: 'Re-engagement', confidence: 31, channel: 'System',
    reasoning: '14 days silent after complaint. Confidence too low for automated action. Human touch required for retention.',
    approved: true, autoApproved: true,
  },
  {
    id: 4, timestamp: '2025-04-16 09:45:22', actor: 'AI Agent',
    actionType: 'message.sent', category: 'Communication',
    contact: 'Lisa Park', company: 'Vantage Real Estate',
    description: 'Custom proposal sent with enterprise package details',
    strategy: 'Direct Conversion', confidence: 88, channel: 'WhatsApp',
    reasoning: 'All qualification criteria met. Budget confirmed at $45K. Decision maker engaged. Proposal aligns with stated needs.',
    approved: true, autoApproved: true,
  },
  {
    id: 5, timestamp: '2025-04-16 09:30:18', actor: 'AI Agent',
    actionType: 'content.sent', category: 'Communication',
    contact: 'Jenny Liu', company: 'Catalyst Ventures',
    description: 'Trust-building case study sent — fintech vertical',
    strategy: 'Trust Building', confidence: 58, channel: 'Email',
    reasoning: 'Early evaluation stage. Fintech case study matches industry. Building credibility before conversion push.',
    approved: true, autoApproved: false,
  },
  {
    id: 6, timestamp: '2025-04-16 09:15:07', actor: 'AI Agent',
    actionType: 'crm.updated', category: 'Operational',
    contact: 'Tom Nguyen', company: 'Delta Supply Co',
    description: 'CRM stage updated: Qualified → Negotiation',
    strategy: 'Direct Conversion', confidence: 82, channel: 'CRM',
    reasoning: 'Technical and budget approvals obtained. Contact requested legal review — advancing pipeline stage.',
    approved: true, autoApproved: true,
  },
  {
    id: 7, timestamp: '2025-04-16 09:02:55', actor: 'AI Agent',
    actionType: 'message.sent', category: 'Communication',
    contact: 'Rachel Kim', company: 'Apex Logistics',
    description: 'SAP integration details and setup walkthrough sent',
    strategy: 'Guided Assistance', confidence: 81, channel: 'Email',
    reasoning: 'Contact asked about SAP integration. Immediate technical response maintains engagement momentum.',
    approved: true, autoApproved: true,
  },
  {
    id: 8, timestamp: '2025-04-16 08:45:33', actor: 'AI Agent',
    actionType: 'strategy.changed', category: 'Decision',
    contact: 'Amy Tran', company: 'Beacon Health',
    description: 'Strategy changed: Guided Assistance → Trust Building',
    strategy: 'Trust Building', confidence: 38, channel: 'System',
    reasoning: 'Competitor mention detected in WhatsApp reply. Switching to trust-building approach to address retention risk.',
    approved: true, autoApproved: true,
  },
  {
    id: 9, timestamp: '2025-04-16 08:30:11', actor: 'System',
    actionType: 'brain.updated', category: 'Brain',
    contact: null, company: null,
    description: 'Business Brain refreshed — behavioral model updated with 12 new outcome signals',
    strategy: null, confidence: null, channel: 'System',
    reasoning: 'Nightly learning cycle completed. Updated strategy weights for Direct Conversion (+2.3%) and Re-engagement (-1.1%).',
    approved: true, autoApproved: true,
  },
  {
    id: 10, timestamp: '2025-04-16 08:15:00', actor: 'System',
    actionType: 'ingestion.completed', category: 'Ingestion',
    contact: null, company: null,
    description: 'CRM sync completed — 23 contacts updated, 4 new contacts ingested',
    strategy: null, confidence: null, channel: 'HubSpot',
    reasoning: 'Scheduled CRM sync via Nango. Data quality scores: 4 contacts above 90%, 19 above 70%.',
    approved: true, autoApproved: true,
  },
  {
    id: 11, timestamp: '2025-04-16 08:00:00', actor: 'AI Agent',
    actionType: 'outreach.paused', category: 'Decision',
    contact: 'Elena Vasquez', company: 'Prism Digital',
    description: 'All automated outreach paused — negative sentiment detected',
    strategy: 'Guided Assistance', confidence: 44, channel: 'System',
    reasoning: 'Contact responded to SMS with frustration about frequency. Sentiment analysis flagged negative tone. Pausing to prevent further damage.',
    approved: true, autoApproved: true,
  },
  {
    id: 12, timestamp: '2025-04-15 23:55:00', actor: 'Admin',
    actionType: 'settings.changed', category: 'Configuration',
    contact: null, company: null,
    description: 'Confidence threshold updated: 65% → 70%',
    strategy: null, confidence: null, channel: 'System',
    reasoning: 'Manual configuration change by admin user.',
    approved: true, autoApproved: false,
  },
];

const categoryIcons: Record<string, any> = {
  Communication: Mail,
  Operational: Zap,
  Escalation: AlertTriangle,
  Decision: Brain,
  Brain: Brain,
  Ingestion: RefreshCw,
  Configuration: Shield,
};

const categoryColors: Record<string, string> = {
  Communication: 'bg-indigo-50 text-indigo-600',
  Operational: 'bg-emerald-50 text-emerald-600',
  Escalation: 'bg-red-50 text-red-600',
  Decision: 'bg-purple-50 text-purple-600',
  Brain: 'bg-amber-50 text-amber-600',
  Ingestion: 'bg-blue-50 text-blue-600',
  Configuration: 'bg-gray-100 text-gray-600',
};

const categoryFilters = ['All', 'Communication', 'Operational', 'Escalation', 'Decision', 'Brain', 'Ingestion', 'Configuration'];

/* ─── Component ─────────────────────────────────────── */
export default function AuditLogPage() {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [expandedEntry, setExpandedEntry] = useState<number | null>(null);

  const filtered = auditEntries.filter((e) => {
    if (categoryFilter !== 'All' && e.category !== categoryFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (
        !e.description.toLowerCase().includes(q) &&
        !(e.contact || '').toLowerCase().includes(q) &&
        !(e.company || '').toLowerCase().includes(q) &&
        !e.actionType.toLowerCase().includes(q)
      ) return false;
    }
    return true;
  });

  const confClass = (c: number | null) => {
    if (c === null) return '';
    return c >= 80 ? 'bg-emerald-50 text-emerald-700' : c >= 50 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700';
  };

  return (
    <div className="p-6 flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Audit Log</h1>
          <p className="text-sm text-gray-500 mt-0.5">Immutable record of all AI decisions and actions</p>
        </div>
        <button className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">
          <Download className="w-4 h-4" /> Export
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search audit log..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 outline-none"
          />
        </div>
        <div className="flex gap-1 flex-wrap">
          {categoryFilters.map((c) => (
            <button
              key={c}
              onClick={() => setCategoryFilter(c)}
              className={`text-[11px] px-2.5 py-1 rounded-full font-medium transition-colors ${
                categoryFilter === c ? 'bg-indigo-500 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Log Entries */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        {filtered.map((entry, i) => {
          const Icon = categoryIcons[entry.category] || FileText;
          const colorClass = categoryColors[entry.category] || 'bg-gray-100 text-gray-600';
          const expanded = expandedEntry === entry.id;

          return (
            <div key={entry.id} className={`border-b border-gray-50 last:border-0 ${expanded ? 'bg-gray-50' : ''}`}>
              <button
                onClick={() => setExpandedEntry(expanded ? null : entry.id)}
                className="w-full flex items-center gap-4 px-5 py-3.5 text-left hover:bg-gray-50/50 transition-colors"
              >
                {/* Icon */}
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${colorClass}`}>
                  <Icon className="w-4 h-4" />
                </div>

                {/* Timestamp */}
                <div className="w-[140px] flex-shrink-0">
                  <div className="text-xs text-gray-500 font-mono">{entry.timestamp.split(' ')[1]}</div>
                  <div className="text-[10px] text-gray-400">{entry.timestamp.split(' ')[0]}</div>
                </div>

                {/* Description */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-900 truncate">{entry.description}</div>
                  <div className="text-[11px] text-gray-400">
                    {entry.contact ? `${entry.contact} · ${entry.company}` : entry.actor}
                    {' · '}{entry.actionType}
                  </div>
                </div>

                {/* Badges */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {entry.confidence !== null && (
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${confClass(entry.confidence)}`}>
                      {entry.confidence}%
                    </span>
                  )}
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${colorClass}`}>
                    {entry.category}
                  </span>
                  {entry.autoApproved ? (
                    <span className="text-[10px] text-indigo-500 flex items-center gap-0.5"><Sparkles className="w-3 h-3" /> Auto</span>
                  ) : (
                    <span className="text-[10px] text-gray-400 flex items-center gap-0.5"><User className="w-3 h-3" /> Manual</span>
                  )}
                </div>

                {/* Expand indicator */}
                <ChevronDown className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </button>

              {/* Expanded Detail */}
              {expanded && (
                <div className="px-5 pb-4 pl-[72px]">
                  <div className="p-4 bg-white border border-gray-200 rounded-xl">
                    <div className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
                      <Brain className="w-4 h-4 text-indigo-500" /> AI Reasoning
                    </div>
                    <p className="text-sm text-gray-600 leading-relaxed mb-3">{entry.reasoning}</p>
                    <div className="flex flex-wrap gap-2">
                      {entry.strategy && (
                        <span className="text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">Strategy: {entry.strategy}</span>
                      )}
                      <span className="text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">Channel: {entry.channel}</span>
                      <span className="text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">Actor: {entry.actor}</span>
                      <span className="text-[10px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                        {entry.autoApproved ? 'Auto-approved' : 'Human-approved'}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
