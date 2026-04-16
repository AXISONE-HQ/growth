'use client';

import {
  Users, Search, Filter, ChevronDown, ArrowUpRight, Mail, Phone,
  MessageCircle, Target, Brain, Clock, BarChart3, Star, Plus,
  Download, MoreHorizontal, CheckCircle, AlertTriangle, Sparkles,
  TrendingUp, ArrowRight, Eye
} from 'lucide-react';
import { useState } from 'react';

/* ─── Mock Data ─────────────────────────────────────── */
const contacts = [
  {
    id: 1, name: 'Sarah Chen', company: 'Meridian Consulting', email: 'sarah@meridian.co', phone: '+1 (415) 555-0142',
    avatar: 'SC', segment: 'Enterprise', lifecycle: 'Opportunity', score: 87, value: '$32,000',
    objective: 'Close Deal', strategy: 'Direct Conversion', lastActivity: '2m ago',
    channels: ['Email', 'WhatsApp'], subObjectives: { done: 4, total: 5 },
    tags: ['Decision Maker', 'High Intent'], dataQuality: 94,
  },
  {
    id: 2, name: 'Marcus Reid', company: 'Forge Manufacturing', email: 'marcus@forge.io', phone: '+1 (312) 555-0198',
    avatar: 'MR', segment: 'Mid-Market', lifecycle: 'Qualified', score: 74, value: '$18,500',
    objective: 'Book Meeting', strategy: 'Guided Assistance', lastActivity: '8m ago',
    channels: ['SMS', 'Email'], subObjectives: { done: 6, total: 8 },
    tags: ['Technical Buyer'], dataQuality: 88,
  },
  {
    id: 3, name: 'Brian Walker', company: 'Vertex Analytics', email: 'brian@vertex.co', phone: '+1 (206) 555-0134',
    avatar: 'BW', segment: 'Mid-Market', lifecycle: 'At Risk', score: 31, value: '$15,000',
    objective: 'Re-engage', strategy: 'Re-engagement', lastActivity: '14d ago',
    channels: ['Email'], subObjectives: { done: 1, total: 4 },
    tags: ['Complaint History', 'Escalated'], dataQuality: 72,
  },
  {
    id: 4, name: 'Lisa Park', company: 'Vantage Real Estate', email: 'lisa@vantage.com', phone: '+1 (310) 555-0167',
    avatar: 'LP', segment: 'Enterprise', lifecycle: 'Proposal', score: 92, value: '$45,000',
    objective: 'Close Deal', strategy: 'Direct Conversion', lastActivity: '2h ago',
    channels: ['WhatsApp', 'Email'], subObjectives: { done: 5, total: 6 },
    tags: ['Budget Confirmed', 'Decision Maker'], dataQuality: 96,
  },
  {
    id: 5, name: 'Jenny Liu', company: 'Catalyst Ventures', email: 'jenny@catalyst.vc', phone: '+1 (628) 555-0123',
    avatar: 'JL', segment: 'SMB', lifecycle: 'Lead', score: 58, value: '$8,500',
    objective: 'Qualify Lead', strategy: 'Trust Building', lastActivity: '3h ago',
    channels: ['Email'], subObjectives: { done: 2, total: 5 },
    tags: ['Fintech'], dataQuality: 85,
  },
  {
    id: 6, name: 'Rachel Kim', company: 'Apex Logistics', email: 'rachel@apex.io', phone: '+1 (213) 555-0189',
    avatar: 'RK', segment: 'Enterprise', lifecycle: 'Qualified', score: 81, value: '$28,000',
    objective: 'Qualify Lead', strategy: 'Guided Assistance', lastActivity: '4h ago',
    channels: ['Email'], subObjectives: { done: 3, total: 5 },
    tags: ['SAP Integration', 'Enterprise'], dataQuality: 91,
  },
  {
    id: 7, name: 'David Cho', company: 'Summit Enterprises', email: 'david@summit.com', phone: '+1 (408) 555-0156',
    avatar: 'DC', segment: 'Enterprise', lifecycle: 'Negotiation', score: 42, value: '$28,500',
    objective: 'Close Deal', strategy: 'Direct Conversion', lastActivity: '45m ago',
    channels: ['Email'], subObjectives: { done: 2, total: 4 },
    tags: ['Pricing Objection', 'Escalated'], dataQuality: 89,
  },
  {
    id: 8, name: 'Amy Tran', company: 'Beacon Health', email: 'amy@beacon.health', phone: '+1 (617) 555-0145',
    avatar: 'AT', segment: 'Mid-Market', lifecycle: 'Customer', score: 38, value: '$12,000',
    objective: 'Retain', strategy: 'Trust Building', lastActivity: '1.5h ago',
    channels: ['WhatsApp'], subObjectives: { done: 1, total: 4 },
    tags: ['Competitor Risk', 'Current Customer'], dataQuality: 82,
  },
  {
    id: 9, name: 'Tom Nguyen', company: 'Delta Supply Co', email: 'tom@delta.co', phone: '+1 (503) 555-0178',
    avatar: 'TN', segment: 'Enterprise', lifecycle: 'Negotiation', score: 55, value: '$22,000',
    objective: 'Close Deal', strategy: 'Direct Conversion', lastActivity: '3h ago',
    channels: ['Email'], subObjectives: { done: 2, total: 4 },
    tags: ['Legal Review'], dataQuality: 87,
  },
  {
    id: 10, name: 'Elena Vasquez', company: 'Prism Digital', email: 'elena@prism.io', phone: '+1 (512) 555-0134',
    avatar: 'EV', segment: 'SMB', lifecycle: 'Lead', score: 44, value: '$8,500',
    objective: 'Qualify Lead', strategy: 'Guided Assistance', lastActivity: '4h ago',
    channels: ['SMS'], subObjectives: { done: 1, total: 3 },
    tags: ['Negative Sentiment'], dataQuality: 78,
  },
];

const lifecycleColors: Record<string, string> = {
  'Lead': 'bg-gray-100 text-gray-600',
  'Qualified': 'bg-blue-50 text-blue-700',
  'Opportunity': 'bg-indigo-50 text-indigo-700',
  'Proposal': 'bg-purple-50 text-purple-700',
  'Negotiation': 'bg-amber-50 text-amber-700',
  'Customer': 'bg-emerald-50 text-emerald-700',
  'At Risk': 'bg-red-50 text-red-700',
};

const segmentFilters = ['All', 'Enterprise', 'Mid-Market', 'SMB'];
const lifecycleFilters = ['All', 'Lead', 'Qualified', 'Opportunity', 'Proposal', 'Negotiation', 'Customer', 'At Risk'];

/* ─── Component ─────────────────────────────────────── */
export default function CustomersPage() {
  const [search, setSearch] = useState('');
  const [segmentFilter, setSegmentFilter] = useState('All');
  const [lifecycleFilter, setLifecycleFilter] = useState('All');
  const [selectedContact, setSelectedContact] = useState<typeof contacts[0] | null>(null);
  const [sortBy, setSortBy] = useState<'score' | 'value' | 'name'>('score');

  const filtered = contacts
    .filter((c) => {
      if (segmentFilter !== 'All' && c.segment !== segmentFilter) return false;
      if (lifecycleFilter !== 'All' && c.lifecycle !== lifecycleFilter) return false;
      if (search && !c.name.toLowerCase().includes(search.toLowerCase()) && !c.company.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'score') return b.score - a.score;
      if (sortBy === 'value') return parseInt(b.value.replace(/[$,]/g, '')) - parseInt(a.value.replace(/[$,]/g, ''));
      return a.name.localeCompare(b.name);
    });

  const confClass = (c: number) =>
    c >= 80 ? 'text-emerald-600' : c >= 50 ? 'text-amber-600' : 'text-red-600';

  const confBg = (c: number) =>
    c >= 80 ? 'bg-emerald-50 text-emerald-700' : c >= 50 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700';

  return (
    <div className="p-6 flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Customers</h1>
          <p className="text-sm text-gray-500 mt-0.5">{contacts.length} contacts across all pipelines</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50">
            <Download className="w-4 h-4" /> Export
          </button>
          <button className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-indigo-500 rounded-lg hover:bg-indigo-600">
            <Plus className="w-4 h-4" /> Add Contact
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search contacts or companies..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-200 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 outline-none"
          />
        </div>
        <div className="flex gap-1.5">
          {segmentFilters.map((s) => (
            <button
              key={s}
              onClick={() => setSegmentFilter(s)}
              className={`text-xs px-2.5 py-1.5 rounded-lg font-medium transition-colors ${
                segmentFilter === s ? 'bg-indigo-500 text-white' : 'bg-white border border-gray-200 text-gray-500 hover:bg-gray-50'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <select
          value={lifecycleFilter}
          onChange={(e) => setLifecycleFilter(e.target.value)}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-600"
        >
          {lifecycleFilters.map((l) => (
            <option key={l} value={l}>{l === 'All' ? 'All Stages' : l}</option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as any)}
          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 bg-white text-gray-600"
        >
          <option value="score">Sort: Confidence</option>
          <option value="value">Sort: Value</option>
          <option value="name">Sort: Name</option>
        </select>
      </div>

      {/* Table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="text-left text-[11px] font-medium text-gray-500 uppercase tracking-wide px-4 py-3">Contact</th>
              <th className="text-left text-[11px] font-medium text-gray-500 uppercase tracking-wide px-4 py-3">Lifecycle</th>
              <th className="text-left text-[11px] font-medium text-gray-500 uppercase tracking-wide px-4 py-3">Objective</th>
              <th className="text-center text-[11px] font-medium text-gray-500 uppercase tracking-wide px-4 py-3">Confidence</th>
              <th className="text-right text-[11px] font-medium text-gray-500 uppercase tracking-wide px-4 py-3">Value</th>
              <th className="text-center text-[11px] font-medium text-gray-500 uppercase tracking-wide px-4 py-3">Progress</th>
              <th className="text-left text-[11px] font-medium text-gray-500 uppercase tracking-wide px-4 py-3">Strategy</th>
              <th className="text-right text-[11px] font-medium text-gray-500 uppercase tracking-wide px-4 py-3">Last Active</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr
                key={c.id}
                onClick={() => setSelectedContact(selectedContact?.id === c.id ? null : c)}
                className={`border-b border-gray-50 cursor-pointer transition-colors ${
                  selectedContact?.id === c.id ? 'bg-indigo-50' : 'hover:bg-gray-50'
                }`}
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold flex-shrink-0">
                      {c.avatar}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-900">{c.name}</div>
                      <div className="text-[11px] text-gray-400">{c.company}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${lifecycleColors[c.lifecycle] || 'bg-gray-100 text-gray-600'}`}>
                    {c.lifecycle}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs text-gray-700">{c.objective}</span>
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`text-sm font-semibold ${confClass(c.score)}`}>{c.score}%</span>
                </td>
                <td className="px-4 py-3 text-right">
                  <span className="text-sm font-medium text-gray-900">{c.value}</span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${(c.subObjectives.done / c.subObjectives.total) * 100}%` }} />
                    </div>
                    <span className="text-[10px] text-gray-400">{c.subObjectives.done}/{c.subObjectives.total}</span>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs text-gray-500">{c.strategy}</span>
                </td>
                <td className="px-4 py-3 text-right">
                  <span className="text-xs text-gray-400">{c.lastActivity}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Expanded Detail Panel */}
      {selectedContact && (
        <div className="bg-white border border-indigo-200 rounded-xl p-5 ring-2 ring-indigo-500/10">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xl font-semibold">
                {selectedContact.avatar}
              </div>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">{selectedContact.name}</h3>
                <p className="text-sm text-gray-500">{selectedContact.company} · {selectedContact.segment}</p>
                <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                  <span className="flex items-center gap-1"><Mail className="w-3 h-3" /> {selectedContact.email}</span>
                  <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> {selectedContact.phone}</span>
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <button className="px-3 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100">View Full Profile</button>
              <button className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">
                <MoreHorizontal className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-4 mb-4">
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Confidence</div>
              <div className={`text-xl font-bold ${confClass(selectedContact.score)}`}>{selectedContact.score}%</div>
            </div>
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Value</div>
              <div className="text-xl font-bold text-gray-900">{selectedContact.value}</div>
            </div>
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Data Quality</div>
              <div className="text-xl font-bold text-gray-900">{selectedContact.dataQuality}%</div>
            </div>
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Channels</div>
              <div className="flex gap-1 mt-1">
                {selectedContact.channels.map((ch) => (
                  <span key={ch} className="text-[10px] bg-white text-gray-600 px-2 py-0.5 rounded-full border">{ch}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {selectedContact.tags.map((t) => (
              <span key={t} className="text-[10px] bg-indigo-50 text-indigo-600 px-2.5 py-1 rounded-full font-medium">{t}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
