'use client';

import { useState } from 'react';
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
  ArrowUp,
  ArrowDown,
  ChevronRight,
} from 'lucide-react';

/* âââ Stats Row ââââââââââââââââââââââââââââââââââââââââââââ */
const stats = [
  { label: 'Active Contacts', value: '847', delta: 'â 23 this week', up: true },
  { label: 'Objectives Completed', value: '142', delta: 'â 18% vs last week', up: true },
  { label: 'AI Actions Today', value: '87', delta: 'â 12 vs yesterday', up: true },
  { label: 'Avg Response Time', value: '2.4', unit: 'min', delta: 'â from 3.1 min', up: true, color: 'text-emerald-400' },
  { label: 'Escalation Rate', value: '14', unit: '%', delta: 'â from 22% (Week 1)', up: true },
];

/* âââ Pipeline Health ââââââââââââââââââââââââââââââââââââââ */
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

/* âââ Brain Layers âââââââââââââââââââââââââââââââââââââââââ */
const brainLayers = [
  { label: 'Blueprint', pct: 100, display: 'Active', level: 'high' },
  { label: 'Company Truth', pct: 82, display: '82%', level: 'high' },
  { label: 'Behavioral Learning', pct: 61, display: '61%', level: 'mid' },
  { label: 'Outcome Learning', pct: 43, display: '43%', level: 'low' },
];

/* âââ Decision Feed ââââââââââââââââââââââââââââââââââââââââ */
const decisions = [
  {
    type: 'ai', headline: 'Follow-up SMS to', contact: 'Sarah Chen',
    strategy: 'Direct Conversion', strategyClass: 'strategy-direct', channel: 'SMS',
    confidence: 87, confClass: 'conf-high', time: '2m ago',
    reasoning: 'Budget confirmed ($12K). Timeline Q2. Decision maker reached. Missing: pricing tolerance. 3 of 5 sub-objectives complete â direct path to booking selected.',
  },
  {
    type: 'ai', headline: 'Re-engagement email to', contact: 'Mark Thompson',
    strategy: 'Re-engagement', strategyClass: 'strategy-reengage', channel: 'Email',
    confidence: 71, confClass: 'conf-normal', time: '8m ago',
    reasoning: 'Contact dormant 34 days. Previously showed interest in enterprise plan. New angle: reference recent case study in similar industry.',
  },
  {
    type: 'ai', headline: 'Qualification questions to', contact: 'Emma Davis',
    strategy: 'Guided Assistance', strategyClass: 'strategy-guided', channel: 'Email',
    confidence: 62, confClass: 'conf-normal', time: '14m ago',
    reasoning: 'New inbound lead from website form. Need identified (HR consulting) but budget and timeline unknown. Guided approach: ask qualifying questions before direct conversion attempt.',
  },
  {
    type: 'human', headline: 'Escalated:', contact: 'James Rivera â deal value $28,000',
    confidence: 34, confClass: 'conf-critical', time: '22m ago',
    note: 'Above $15K threshold â human review',
  },
  {
    type: 'ai', headline: 'Book meeting for', contact: 'Lisa Park',
    strategy: 'Direct Conversion', strategyClass: 'strategy-direct', channel: 'Calendar',
    confidence: 94, confClass: 'conf-high', time: '31m ago',
    reasoning: 'All 5 sub-objectives complete. Budget: $8K. Timeline: this month. Decision maker confirmed. Direct path â send calendar link with 3 available slots this week.',
  },
];

/* âââ Agent Actions ââââââââââââââââââââââââââââââââââââââââ */
const agentActions = [
  { icon: MessageSquare, iconClass: 'bg-blue-100 text-blue-600', text: 'SMS sent to', contact: 'Sarah Chen', detail: 'â follow-up on pricing', status: 'â Delivered', time: '2m' },
  { icon: Mail, iconClass: 'bg-purple-100 text-purple-600', text: 'Email sent to', contact: 'Mark Thompson', detail: 'â re-engagement', status: 'â Delivered', time: '8m' },
  { icon: Mail, iconClass: 'bg-purple-100 text-purple-600', text: 'Email sent to', contact: 'Emma Davis', detail: 'â qualification', status: 'â Delivered', time: '14m' },
  { icon: Calendar, iconClass: 'bg-emerald-100 text-emerald-600', text: 'Meeting booked â', contact: 'Lisa Park', detail: 'Â· Thu 2pm', status: 'â Confirmed', time: '31m' },
  { icon: Flag, iconClass: 'bg-indigo-100 text-indigo-600', text: 'HubSpot updated â', contact: 'Lisa Park', detail: 'â Meeting Booked', status: 'â Synced', time: '31m' },
  { icon: AlertTriangle, iconClass: 'bg-red-100 text-red-600', text: 'Escalated', contact: 'James Rivera', detail: 'â above deal threshold', status: 'â³ Pending review', statusClass: 'text-amber-600', time: '22m' },
];

/* âââ Contact Objective ââââââââââââââââââââââââââââââââââââ */
const subObjectives = [
  { label: 'Name confirmed', status: 'done' },
  { label: 'Phone confirmed', status: 'done' },
  { label: 'Budget: $12K range', status: 'done' },
  { label: 'Pricing tolerance', status: 'in-progress', tag: 'â AI targeting' },
  { label: 'Meeting confirmed', status: 'pending' },
];

/* âââ Escalation Queue âââââââââââââââââââââââââââââââââââââ */
const escalations = [
  { name: 'James Rivera â TechFlow Inc', reason: 'Deal value $28,000 â above $15K threshold', level: 'high' },
  { name: 'Amanda Wu â Bright Solutions', reason: 'Complaint detected in reply â sentiment negative', level: 'high' },
  { name: 'David Kim â Apex Digital', reason: 'Confidence below threshold â 32% on strategy selection', level: 'medium' },
];

/* âââ Strategy Performance âââââââââââââââââââââââââââââââââ */
const strategies = [
  { name: 'Direct Conversion', pct: 38, color: 'bg-emerald-500', count: '214 contacts' },
  { name: 'Guided Assistance', pct: 24, color: 'bg-indigo-500', count: '156 contacts' },
  { name: 'Trust Building', pct: 18, color: 'bg-amber-500', count: '89 contacts' },
  { name: 'Re-engagement', pct: 12, color: 'bg-red-400', count: '388 contacts' },
];

/* âââ Audit Log ââââââââââââââââââââââââââââââââââââââââââââ */
const auditEntries = [
  { time: '14:32:08', action: 'SMS.SEND', detail: 'Sarah Chen â follow-up pricing Â· conf: 87% Â· strategy: direct' },
  { time: '14:24:41', action: 'EMAIL.SEND', detail: 'Mark Thompson â re-engagement case study Â· conf: 71%' },
  { time: '14:18:15', action: 'EMAIL.SEND', detail: 'Emma Davis â qualification questions Â· conf: 62% Â· strategy: guided' },
  { time: '14:10:33', action: 'ESCALATE', detail: 'James Rivera â deal $28K above threshold Â· routed to admin' },
  { time: '14:01:22', action: 'CALENDAR.BOOK', detail: 'Lisa Park â Thu 2:00pm consultation Â· conf: 94%' },
  { time: '14:01:22', action: 'CRM.UPDATE', detail: 'Lisa Park â HubSpot deal stage: Meeting Booked' },
  { time: '13:55:07', action: 'DECISION', detail: 'Lisa Park â strategy: direct Â· all sub-objectives complete' },
  { time: '13:48:19', action: 'BRAIN.UPDATE', detail: 'Company Truth updated â new deal pattern detected in pipeline' },
];

/* âââ Component ââââââââââââââââââââââââââââââââââââââââââââ */
export default function DashboardPage() {
  const [expandedDecision, setExpandedDecision] = useState<number | null>(null);

  return (
    <div className="p-6 flex flex-col gap-6">
      {/* Stats Row */}
      <div className="grid grid-cols-5 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-white border border-gray-200 rounded-xl p-5">
            <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">{s.label}</div>
            <div className={`text-[28px] font-bold tracking-tight ${s.color || 'text-gray-900'}`}>
              {s.value}
              {s.unit && <span className="text-base text-gray-500 font-normal">{s.unit}</span>}
            </div>
            <div className={`text-xs mt-1 flex items-center gap-1 ${s.up ? 'text-emerald-600' : 'text-red-600'}`}>
              {s.delta}
            </div>
          </div>
        ))}
      </div>

      {/* Pipeline Health */}
      <div className="grid grid-cols-3 gap-4">
        {pipelines.map((p) => (
          <div key={p.name} className="bg-white border border-gray-200 rounded-xl p-5 flex flex-col gap-3.5">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${p.color}`} />
              <span className="text-sm font-bold text-gray-900 flex-1">{p.name}</span>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 uppercase tracking-wide">Active</span>
            </div>
            <div className="flex justify-between gap-1">
              {[{ val: p.value, label: 'Pipeline Value' }, { val: p.leads, label: 'Active Leads' }, { val: p.confidence, label: 'Avg Confidence' }].map((m) => (
                <div key={m.label} className="flex-1 text-center py-2 px-1 bg-gray-50 rounded-lg">
                  <div className="text-base font-extrabold text-gray-900 leading-tight">{m.val}</div>
                  <div className="text-[10px] text-gray-400 font-medium mt-0.5">{m.label}</div>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between items-center">
                <span className="text-[11px] font-semibold text-gray-500">{p.progressLabel}</span>
                <span className="text-[11px] text-gray-400">{p.progressValue} <strong className="text-emerald-600">{p.progressPct}%</strong></span>
              </div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className={`h-full rounded-full bg-gradient-to-r ${p.progressColor}`} style={{ width: `${p.progressPct}%` }} />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              {p.objectives.map((obj) => (
                <div key={obj.text} className="flex items-center gap-2 text-[12px]">
                  <span className={`w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] ${
                    obj.status === 'done' ? 'bg-emerald-500 text-white' :
                    obj.status === 'active' ? 'border-2 border-indigo-500' :
                    'border-2 border-gray-300'
                  }`}>{obj.status === 'done' ? 'â' : ''}</span>
                  <span className={obj.status === 'done' ? 'text-gray-400 line-through' : 'text-gray-700'}>{obj.text}</span>
                  {obj.tag && <span className="ml-auto text-[10px] font-semibold text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded">{obj.tag}</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Brain + Decision Feed */}
      <div className="grid grid-cols-2 gap-4">
        {/* Brain Status */}
        <div className="bg-white border border-gray-200 rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <Brain className="w-4 h-4 text-indigo-500" />
              Business Brain
            </div>
            <span className="text-xs text-indigo-500 cursor-pointer hover:underline">View details â</span>
          </div>
          <div className="p-5 flex flex-col gap-4">
            <div className="flex flex-col gap-3">
              {brainLayers.map((l) => (
                <div key={l.label} className="flex items-center gap-3">
                  <span className="text-[12px] text-gray-500 w-[130px] flex-shrink-0">{l.label}</span>
                  <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${
                      l.level === 'high' ? 'bg-emerald-500' : l.level === 'mid' ? 'bg-amber-500' : 'bg-red-400'
                    }`} style={{ width: `${l.pct}%` }} />
                  </div>
                  <span className={`text-[12px] font-medium w-12 text-right ${
                    l.level === 'high' ? 'text-emerald-500' : l.level === 'mid' ? 'text-amber-500' : 'text-red-400'
                  }`}>{l.display}</span>
                </div>
              ))}
            </div>

            <div className="bg-indigo-950 text-white rounded-lg px-4 py-3 flex items-center justify-between">
              <span className="text-[12px] font-medium text-indigo-300">Overall Intelligence Score</span>
              <div className="text-2xl font-bold">72 <span className="text-base text-indigo-400 font-normal">/ 100</span></div>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-700 mb-2">
                <AlertTriangle className="w-3.5 h-3.5" />
                Gaps detected
              </div>
              <ul className="list-disc list-inside text-[12px] text-amber-800 space-y-1">
                <li>Pricing data incomplete â 40% of deals missing value</li>
                <li>Competitor positioning not yet ingested</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Decision Feed */}
        <div className="bg-white border border-gray-200 rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <Activity className="w-4 h-4 text-indigo-500" />
              Decision Feed
            </div>
            <span className="text-xs text-indigo-500 cursor-pointer hover:underline">View all â</span>
          </div>
          <div className="divide-y divide-gray-50">
            {decisions.map((d, i) => (
              <div key={i} className="flex items-start gap-3 px-5 py-3 hover:bg-gray-50 transition-colors cursor-pointer"
                onClick={() => d.reasoning && setExpandedDecision(expandedDecision === i ? null : i)}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0 ${
                  d.type === 'ai' ? 'bg-indigo-100 text-indigo-600' : 'bg-amber-100 text-amber-600'
                }`}>{d.type === 'ai' ? 'AI' : 'H'}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-gray-700">
                    {d.headline} <strong>{d.contact}</strong>
                  </div>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    {d.strategy && (
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded ${d.strategyClass}`}>{d.strategy}</span>
                    )}
                    {d.channel && (
                      <span className="channel-badge">{d.channel}</span>
                    )}
                    {d.note && (
                      <span className="text-[12px] text-gray-500">{d.note}</span>
                    )}
                    {d.reasoning && (
                      <span className="text-[11px] text-gray-400 cursor-pointer">
                        {expandedDecision === i ? 'â¼' : 'â¶'} Show reasoning
                      </span>
                    )}
                  </div>
                  {expandedDecision === i && d.reasoning && (
                    <div className="mt-2 text-[12px] text-gray-500 bg-gray-50 rounded-lg p-3 border border-gray-100">
                      {d.reasoning}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full flex items-center gap-1 ${d.confClass}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      d.confidence >= 80 ? 'bg-emerald-500' : d.confidence >= 50 ? 'bg-amber-500' : 'bg-red-500'
                    }`} />
                    {d.confidence}%
                  </span>
                  <span className="text-[11px] text-gray-400">{d.time}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Agent Actions + Objective + Escalations */}
      <div className="grid grid-cols-3 gap-4">
        {/* Agent Action Stream */}
        <div className="bg-white border border-gray-200 rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <Megaphone className="w-4 h-4 text-indigo-500" />
              Agent Actions
            </div>
            <span className="text-xs text-indigo-500 cursor-pointer hover:underline">View all â</span>
          </div>
          <div className="divide-y divide-gray-50">
            {agentActions.map((a, i) => {
              const Icon = a.icon;
              return (
                <div key={i} className="flex items-center gap-3 px-5 py-2.5">
                  <div className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 ${a.iconClass}`}>
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <span className="text-[12px] text-gray-700 flex-1 min-w-0 truncate">
                    {a.text} <strong>{a.contact}</strong> {a.detail}
                  </span>
                  <span className={`text-[11px] flex-shrink-0 ${a.statusClass || 'text-emerald-600'}`}>{a.status}</span>
                  <span className="text-[11px] text-gray-400 flex-shrink-0 w-8 text-right">{a.time}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Contact Objective Gap */}
        <div className="bg-white border border-gray-200 rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <Clock className="w-4 h-4 text-indigo-500" />
              Contact: Sarah Chen
            </div>
            <span className="text-xs text-indigo-500 cursor-pointer hover:underline">View profile â</span>
          </div>
          <div className="p-5">
            <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4">
              <div className="text-sm font-bold text-gray-900 mb-1">Book Consultation Meeting</div>
              <div className="text-[12px] text-gray-500 mb-4">Strategy: Direct Conversion Â· Confidence: 87%</div>
              <div className="flex flex-col gap-2.5">
                {subObjectives.map((obj) => (
                  <div key={obj.label} className="flex items-center gap-2.5">
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] ${
                      obj.status === 'done' ? 'bg-emerald-500 text-white' :
                      obj.status === 'in-progress' ? 'border-2 border-indigo-500 bg-indigo-100' :
                      'border-2 border-gray-300'
                    }`}>{obj.status === 'done' ? 'â' : ''}</div>
                    <span className={`text-[13px] ${obj.status === 'done' ? 'text-gray-400 line-through' : 'text-gray-700'}`}>{obj.label}</span>
                    {obj.tag && <span className="text-[11px] text-indigo-500 font-medium">{obj.tag}</span>}
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3 mt-4">
                <span className="text-[11px] font-semibold text-gray-500">Progress</span>
                <div className="flex-1 h-2 bg-white rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-indigo-500" style={{ width: '60%' }} />
                </div>
                <span className="text-[12px] font-bold text-indigo-500">60%</span>
              </div>
            </div>
          </div>
        </div>

        {/* Escalation Queue */}
        <div className="bg-white border border-gray-200 rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              Escalation Queue
            </div>
            <span className="text-xs font-semibold text-red-400">3 pending</span>
          </div>
          <div className="divide-y divide-gray-50">
            {escalations.map((e, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-3">
                <div className={`w-1 h-10 rounded-full flex-shrink-0 ${e.level === 'high' ? 'bg-red-500' : 'bg-amber-500'}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-gray-900">{e.name}</div>
                  <div className="text-[12px] text-gray-500">{e.reason}</div>
                </div>
                <button className="text-[12px] font-semibold text-indigo-500 bg-indigo-50 px-3 py-1.5 rounded-lg hover:bg-indigo-100 flex-shrink-0">
                  Review
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Strategy Performance + Audit Log */}
      <div className="grid grid-cols-2 gap-4">
        {/* Strategy Performance */}
        <div className="bg-white border border-gray-200 rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <BarChart3 className="w-4 h-4 text-indigo-500" />
              Strategy Performance
            </div>
            <span className="text-xs text-indigo-500 cursor-pointer hover:underline">Full report â</span>
          </div>
          <div className="p-5 flex flex-col gap-4">
            {strategies.map((s) => (
              <div key={s.name} className="flex items-center gap-3">
                <span className="text-[12px] text-gray-600 w-[130px] flex-shrink-0">{s.name}</span>
                <div className="flex-1 h-6 bg-gray-100 rounded overflow-hidden relative">
                  <div className={`h-full ${s.color} rounded flex items-center justify-center text-[11px] font-bold text-white`}
                    style={{ width: `${s.pct}%`, minWidth: '32px' }}>
                    {s.pct}%
                  </div>
                </div>
                <span className="text-[11px] text-gray-400 w-[80px] text-right flex-shrink-0">{s.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Audit Log */}
        <div className="bg-white border border-gray-200 rounded-xl">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <FileText className="w-4 h-4 text-indigo-500" />
              Audit Log
            </div>
            <span className="text-xs text-indigo-500 cursor-pointer hover:underline">View full log â</span>
          </div>
          <div className="divide-y divide-gray-50">
            {auditEntries.map((e, i) => (
              <div key={i} className="flex items-center gap-3 px-5 py-2">
                <span className="text-[11px] font-mono text-gray-400 w-[65px] flex-shrink-0">{e.time}</span>
                <span className="text-[11px] font-semibold text-indigo-500 bg-indigo-50 px-2 py-0.5 rounded w-[100px] text-center flex-shrink-0">{e.action}</span>
                <span className="text-[12px] text-gray-600 flex-1 min-w-0 truncate">{e.detail}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
