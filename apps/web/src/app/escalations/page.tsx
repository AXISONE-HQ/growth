'use client';

import {
  AlertTriangle, Clock, User, ArrowRight, CheckCircle, XCircle,
  MessageSquare, Brain, Target, ChevronDown, Filter, Search,
  Phone, Mail, Sparkles, Flag, ArrowUpRight, MoreHorizontal,
  UserCheck, Shield, Zap
} from 'lucide-react';
import { useState } from 'react';

/* ─── Mock Data ─────────────────────────────────────── */
const escalations = [
  {
    id: 1,
    contact: 'Brian Walker',
    company: 'Vertex Analytics',
    avatar: 'BW',
    reason: 'No reply 14 days + complaint history',
    priority: 'critical',
    confidence: 31,
    value: '$15,000',
    objective: 'Re-engage',
    strategy: 'Re-engagement',
    time: '15m ago',
    channel: 'Email',
    assignee: null,
    summary: 'Brian went silent after expressing concerns about integration complexity. Previous complaint about onboarding speed. AI confidence too low for automated outreach — human touch recommended for retention.',
    subObjectives: [
      { name: 'Re-establish contact', done: false },
      { name: 'Address integration concerns', done: false },
      { name: 'Present revised timeline', done: false },
      { name: 'Get verbal commitment', done: false },
    ],
    history: [
      { action: 'Email sent: Check-in after concerns', result: 'No reply', time: '14 days ago' },
      { action: 'SMS follow-up', result: 'No reply', time: '10 days ago' },
      { action: 'AI escalated to human queue', result: 'Pending', time: '15m ago' },
    ],
  },
  {
    id: 2,
    contact: 'David Cho',
    company: 'Summit Enterprises',
    avatar: 'DC',
    reason: 'Pricing objection — needs executive approval',
    priority: 'high',
    confidence: 42,
    value: '$28,500',
    objective: 'Close Deal',
    strategy: 'Direct Conversion',
    time: '45m ago',
    channel: 'Email',
    assignee: null,
    summary: 'David completed technical evaluation and is ready to buy, but quoted price exceeds his approval authority. Requested a call with his VP to discuss enterprise pricing. AI cannot negotiate pricing autonomously.',
    subObjectives: [
      { name: 'Technical evaluation', done: true },
      { name: 'Budget confirmation', done: false },
      { name: 'Executive sign-off', done: false },
      { name: 'Contract sent', done: false },
    ],
    history: [
      { action: 'Proposal sent: Enterprise package', result: 'Opened 4x', time: '3 days ago' },
      { action: 'Follow-up email', result: 'Reply: needs VP approval', time: '1 day ago' },
      { action: 'AI escalated: pricing negotiation needed', result: 'Pending', time: '45m ago' },
    ],
  },
  {
    id: 3,
    contact: 'Amy Tran',
    company: 'Beacon Health',
    avatar: 'AT',
    reason: 'Competitor mention — risk of churn',
    priority: 'high',
    confidence: 38,
    value: '$12,000',
    objective: 'Retain',
    strategy: 'Trust Building',
    time: '1.5h ago',
    channel: 'WhatsApp',
    assignee: 'You',
    summary: 'Amy mentioned evaluating a competitor (Salesloft) during a WhatsApp conversation. Current customer on Growth plan. AI flagged for human intervention to present competitive advantages and potential upgrade offer.',
    subObjectives: [
      { name: 'Acknowledge concerns', done: true },
      { name: 'Present competitive comparison', done: false },
      { name: 'Offer loyalty incentive', done: false },
      { name: 'Get renewal commitment', done: false },
    ],
    history: [
      { action: 'WhatsApp: product question', result: 'Mentioned competitor', time: '2h ago' },
      { action: 'AI flagged competitor mention', result: 'Escalated', time: '1.5h ago' },
      { action: 'Assigned to you', result: 'In progress', time: '1h ago' },
    ],
  },
  {
    id: 4,
    contact: 'Tom Nguyen',
    company: 'Delta Supply Co',
    avatar: 'TN',
    reason: 'Legal review requested before contract',
    priority: 'medium',
    confidence: 55,
    value: '$22,000',
    objective: 'Close Deal',
    strategy: 'Direct Conversion',
    time: '3h ago',
    channel: 'Email',
    assignee: null,
    summary: 'Tom\'s legal team wants to review our MSA and DPA before signing. Standard enterprise requirement but AI cannot handle legal document exchange. Need to loop in legal team.',
    subObjectives: [
      { name: 'Technical approval', done: true },
      { name: 'Budget approval', done: true },
      { name: 'Legal review', done: false },
      { name: 'Contract execution', done: false },
    ],
    history: [
      { action: 'Proposal sent', result: 'Approved by stakeholders', time: '1 week ago' },
      { action: 'Contract sent', result: 'Reply: legal review needed', time: '3h ago' },
    ],
  },
  {
    id: 5,
    contact: 'Elena Vasquez',
    company: 'Prism Digital',
    avatar: 'EV',
    reason: 'Negative sentiment detected in reply',
    priority: 'medium',
    confidence: 44,
    value: '$8,500',
    objective: 'Qualify Lead',
    strategy: 'Guided Assistance',
    time: '4h ago',
    channel: 'SMS',
    assignee: null,
    summary: 'Elena responded to an AI-sent SMS with frustration about message frequency. Sentiment analysis flagged negative tone. Recommend human apology and recalibration of contact frequency.',
    subObjectives: [
      { name: 'Initial qualification', done: true },
      { name: 'Demo scheduled', done: false },
      { name: 'Requirements gathered', done: false },
    ],
    history: [
      { action: 'SMS sent: Demo invitation', result: 'Negative reply', time: '4h ago' },
      { action: 'AI paused all outreach', result: 'Escalated', time: '4h ago' },
    ],
  },
];

const priorityConfig: Record<string, { bg: string; text: string; dot: string; label: string }> = {
  critical: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500', label: 'Critical' },
  high: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500', label: 'High' },
  medium: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500', label: 'Medium' },
};

/* ─── Component ─────────────────────────────────────── */
export default function EscalationsPage() {
  const [selectedEscalation, setSelectedEscalation] = useState(escalations[0]);
  const [filterPriority, setFilterPriority] = useState('All');

  const filtered = filterPriority === 'All'
    ? escalations
    : escalations.filter((e) => e.priority === filterPriority.toLowerCase());

  const confClass = (c: number) =>
    c >= 80 ? 'bg-emerald-50 text-emerald-700' : c >= 50 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700';

  const totalValue = escalations.reduce((sum, e) => sum + parseInt(e.value.replace(/[$,]/g, '')), 0);

  return (
    <div className="p-6 flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Escalation Queue</h1>
          <p className="text-sm text-gray-500 mt-0.5">Items requiring human review and intervention</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5">
            {['All', 'Critical', 'High', 'Medium'].map((p) => (
              <button
                key={p}
                onClick={() => setFilterPriority(p)}
                className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
                  filterPriority === p ? 'bg-indigo-500 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="flex gap-4">
        <div className="flex-1 bg-white border border-gray-200 rounded-xl px-4 py-3">
          <div className="text-[11px] text-gray-500 mb-1">Open Escalations</div>
          <div className="text-2xl font-bold text-gray-900">{escalations.length}</div>
        </div>
        <div className="flex-1 bg-white border border-gray-200 rounded-xl px-4 py-3">
          <div className="text-[11px] text-gray-500 mb-1">Critical</div>
          <div className="text-2xl font-bold text-red-600">{escalations.filter((e) => e.priority === 'critical').length}</div>
        </div>
        <div className="flex-1 bg-white border border-gray-200 rounded-xl px-4 py-3">
          <div className="text-[11px] text-gray-500 mb-1">At Risk Revenue</div>
          <div className="text-2xl font-bold text-gray-900">${totalValue.toLocaleString()}</div>
        </div>
        <div className="flex-1 bg-white border border-gray-200 rounded-xl px-4 py-3">
          <div className="text-[11px] text-gray-500 mb-1">Avg. Wait Time</div>
          <div className="text-2xl font-bold text-gray-900">1.8<span className="text-sm font-medium text-gray-400 ml-0.5">hrs</span></div>
        </div>
      </div>

      {/* Main Grid */}
      <div className="flex gap-5">
        {/* Left: Escalation List */}
        <div className="w-[420px] flex flex-col gap-3">
          {filtered.map((esc) => {
            const p = priorityConfig[esc.priority];
            return (
              <button
                key={esc.id}
                onClick={() => setSelectedEscalation(esc)}
                className={`bg-white border rounded-xl p-4 text-left transition-all ${
                  selectedEscalation?.id === esc.id
                    ? 'border-indigo-500 ring-2 ring-indigo-500/10'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-red-50 text-red-700 flex items-center justify-center text-xs font-semibold">
                      {esc.avatar}
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-gray-900">{esc.contact}</div>
                      <div className="text-[11px] text-gray-400">{esc.company}</div>
                    </div>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${p.bg} ${p.text}`}>
                    {p.label}
                  </span>
                </div>
                <div className="text-xs text-gray-600 mb-2">{esc.reason}</div>
                <div className="flex items-center gap-2 text-[10px]">
                  <span className={`px-2 py-0.5 rounded-full font-medium ${confClass(esc.confidence)}`}>{esc.confidence}%</span>
                  <span className="text-gray-400">{esc.value}</span>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-400">{esc.time}</span>
                  {esc.assignee && (
                    <>
                      <span className="text-gray-400">·</span>
                      <span className="text-indigo-600 font-medium">{esc.assignee}</span>
                    </>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Right: Detail Panel */}
        {selectedEscalation && (
          <div className="flex-1 flex flex-col gap-4">
            {/* Contact Header */}
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-red-50 text-red-700 flex items-center justify-center text-lg font-semibold">
                    {selectedEscalation.avatar}
                  </div>
                  <div>
                    <div className="text-base font-semibold text-gray-900">{selectedEscalation.contact}</div>
                    <div className="text-sm text-gray-500">{selectedEscalation.company} · {selectedEscalation.value}</div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button className="px-4 py-2 bg-indigo-500 text-white text-sm font-medium rounded-lg hover:bg-indigo-600 transition-colors flex items-center gap-1.5">
                    <UserCheck className="w-4 h-4" /> Claim
                  </button>
                  <button className="px-4 py-2 bg-white border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
                    Dismiss
                  </button>
                </div>
              </div>

              {/* AI Summary */}
              <div className="p-4 bg-indigo-50 border border-indigo-200 rounded-xl mb-4">
                <div className="flex items-center gap-2 text-sm font-medium text-indigo-700 mb-1.5">
                  <Sparkles className="w-4 h-4" /> AI Summary
                </div>
                <p className="text-sm text-indigo-600 leading-relaxed">{selectedEscalation.summary}</p>
              </div>

              {/* Meta */}
              <div className="flex flex-wrap gap-2">
                <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${confClass(selectedEscalation.confidence)}`}>
                  {selectedEscalation.confidence}% confidence
                </span>
                <span className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">{selectedEscalation.strategy}</span>
                <span className="text-xs bg-indigo-50 text-indigo-600 px-2.5 py-1 rounded-full">{selectedEscalation.objective}</span>
                <span className="text-xs bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">{selectedEscalation.channel}</span>
              </div>
            </div>

            {/* Sub-objectives */}
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Objective Progress</h3>
              <div className="flex flex-col gap-2.5">
                {selectedEscalation.subObjectives.map((so, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
                      so.done ? 'bg-emerald-500 text-white' : 'border-2 border-gray-300'
                    }`}>
                      {so.done && <CheckCircle className="w-3.5 h-3.5" />}
                    </div>
                    <span className={`text-sm ${so.done ? 'text-gray-500 line-through' : 'text-gray-700'}`}>{so.name}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Action History */}
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">AI Action History</h3>
              <div className="flex flex-col gap-3">
                {selectedEscalation.history.map((h, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="w-1.5 h-1.5 rounded-full bg-gray-300 mt-2 flex-shrink-0" />
                    <div>
                      <div className="text-sm text-gray-700">{h.action}</div>
                      <div className="text-[11px] text-gray-400">{h.result} · {h.time}</div>
                    </div>
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
