'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Clock,
  Users,
  BarChart3,
  AlertTriangle,
  Plus,
} from 'lucide-react';

/* âââ Types ââââââââââââââââââââââââââââââââââââââââââââââââ */
type ConfLevel = 'high' | 'normal' | 'low' | 'critical' | 'won' | 'lost' | 'retained' | 'closed';

interface KanbanCard {
  name: string;
  company: string;
  deal: string;
  source: string;
  objectives: string;
  time: string;
  confidence: string;
  confLevel: ConfLevel;
  variant?: 'risk' | 'won' | 'lost';
}

interface KanbanColumn {
  stage: string;
  count: number;
  cards: KanbanCard[];
  variant?: 'won' | 'lost';
}

interface PipelineSummary {
  value: string;
  leads: string;
  confidence: string;
  confDelta: string;
  escalations: string;
  progressPct: number;
  wonValue: string;
}

/* âââ Sales Pipeline Data ââââââââââââââââââââââââââââââââââ */
const salesColumns: KanbanColumn[] = [
  {
    stage: 'New', count: 2, cards: [
      { name: 'James Miller', company: 'Apex Digital Agency', deal: '$12,500', source: 'Inbound', objectives: '1/8 objectives', time: '2h ago', confidence: '23%', confLevel: 'low' },
      { name: 'David Park', company: 'NextGen Fitness', deal: '$5,800', source: 'Facebook', objectives: '2/8 objectives', time: '1d ago', confidence: '18%', confLevel: 'low' },
    ],
  },
  {
    stage: 'Contacted', count: 2, cards: [
      { name: 'Rachel Kim', company: 'CloudSync Solutions', deal: '$8,200', source: 'Referral', objectives: '3/8 objectives', time: '5h ago', confidence: '35%', confLevel: 'low' },
      { name: 'Kevin Wu', company: 'Orbit Labs', deal: '$9,400', source: 'Google', objectives: '2/8 objectives', time: '8h ago', confidence: '28%', confLevel: 'low' },
    ],
  },
  {
    stage: 'Qualified', count: 2, cards: [
      { name: 'Sarah Chen', company: 'Meridian Consulting', deal: '$24,000', source: 'Outbound', objectives: '5/8 objectives', time: '3h ago', confidence: '62%', confLevel: 'normal' },
      { name: 'Alex Torres', company: 'BrightPath Media', deal: '$15,000', source: 'Inbound', objectives: '4/8 objectives', time: '6h ago', confidence: '55%', confLevel: 'normal' },
    ],
  },
  {
    stage: 'Proposal', count: 2, cards: [
      { name: 'Lisa Park', company: 'Vantage Real Estate', deal: '$32,000', source: 'Referral', objectives: '6/8 objectives', time: '1d ago', confidence: '74%', confLevel: 'normal' },
      { name: 'Nina Walsh', company: 'Summit Health', deal: '$18,500', source: 'Outbound', objectives: '4/8 objectives', time: '2d ago', confidence: '52%', confLevel: 'normal' },
    ],
  },
  {
    stage: 'Negotiation', count: 2, cards: [
      { name: 'Marcus Reid', company: 'Forge Manufacturing', deal: '$45,000', source: 'Inbound', objectives: '7/8 objectives', time: '4h ago', confidence: '87%', confLevel: 'high' },
      { name: 'Jenny Liu', company: 'Catalyst Ventures', deal: '$28,000', source: 'LinkedIn', objectives: '6/8 objectives', time: '1d ago', confidence: '76%', confLevel: 'normal' },
    ],
  },
  {
    stage: 'Closed Won', count: 2, variant: 'won', cards: [
      { name: 'Emma Hayes', company: 'Bloom Botanicals', deal: '$19,200', source: 'Referral', objectives: '8/8 objectives', time: '2d ago', confidence: 'Won', confLevel: 'won', variant: 'won' },
      { name: 'Tom Nguyen', company: 'Pinnacle Legal', deal: '$22,000', source: 'Outbound', objectives: '8/8 objectives', time: '3d ago', confidence: 'Won', confLevel: 'won', variant: 'won' },
    ],
  },
  {
    stage: 'Closed Lost', count: 1, variant: 'lost', cards: [
      { name: 'Henry Stone', company: 'Granite Corp', deal: '$16,000', source: 'Budget', objectives: '2/8 objectives', time: '5d ago', confidence: 'Lost', confLevel: 'lost', variant: 'lost' },
    ],
  },
];

/* âââ Re-engagement Pipeline Data ââââââââââââââââââââââââââ */
const reengagementColumns: KanbanColumn[] = [
  {
    stage: 'At Risk', count: 2, cards: [
      { name: 'Brian Walker', company: 'Vertex Analytics', deal: '$15,000', source: 'No reply 14d', objectives: '3/8 objectives', time: '14d silent', confidence: '22%', confLevel: 'critical', variant: 'risk' },
      { name: 'Karen Scott', company: 'Horizon Education', deal: '$9,800', source: 'Complaint', objectives: '2/8 objectives', time: '7d silent', confidence: '31%', confLevel: 'critical', variant: 'risk' },
    ],
  },
  {
    stage: 'Reached Out', count: 2, cards: [
      { name: 'Paul Jensen', company: 'Atlas Freight Co.', deal: '$20,000', source: 'Email sent', objectives: '3/8 objectives', time: '1d ago', confidence: '45%', confLevel: 'low' },
      { name: 'Maria Flores', company: 'Radiant Spa', deal: '$7,500', source: 'SMS sent', objectives: '2/8 objectives', time: '3d ago', confidence: '38%', confLevel: 'low' },
    ],
  },
  {
    stage: 'Re-engaged', count: 1, cards: [
      { name: 'Angela Wright', company: 'Cascade Insurance', deal: '$11,000', source: 'Replied', objectives: '5/8 objectives', time: '12h ago', confidence: '62%', confLevel: 'normal' },
    ],
  },
  {
    stage: 'Retained', count: 1, variant: 'won', cards: [
      { name: 'Derek Olsen', company: 'Ember Creative', deal: '$14,200', source: 'Renewed', objectives: '7/8 objectives', time: '2d ago', confidence: 'Retained', confLevel: 'retained', variant: 'won' },
    ],
  },
];

/* âââ Upsell Pipeline Data âââââââââââââââââââââââââââââââââ */
const upsellColumns: KanbanColumn[] = [
  {
    stage: 'Identified', count: 2, cards: [
      { name: 'Emma Hayes', company: 'Bloom Botanicals', deal: '+$8,000', source: 'Pro â Enterprise', objectives: '4/6 objectives', time: '1d ago', confidence: '72%', confLevel: 'normal' },
      { name: 'Tom Nguyen', company: 'Pinnacle Legal', deal: '+$4,500', source: 'Add Blueprint', objectives: '3/6 objectives', time: '3d ago', confidence: '68%', confLevel: 'normal' },
    ],
  },
  {
    stage: 'Pitched', count: 1, cards: [
      { name: 'Derek Olsen', company: 'Ember Creative', deal: '+$6,000', source: 'Add 2 seats', objectives: '2/6 objectives', time: '2d ago', confidence: '58%', confLevel: 'normal' },
    ],
  },
  {
    stage: 'Evaluating', count: 1, cards: [
      { name: 'Angela Wright', company: 'Cascade Insurance', deal: '+$12,000', source: 'Enterprise tier', objectives: '5/6 objectives', time: '5d ago', confidence: '84%', confLevel: 'high' },
    ],
  },
  {
    stage: 'Closed', count: 1, variant: 'won', cards: [
      { name: 'Lisa Park', company: 'Vantage Real Estate', deal: '+$10,000', source: 'Upgraded', objectives: '6/6 objectives', time: '1w ago', confidence: 'Closed', confLevel: 'closed', variant: 'won' },
    ],
  },
];

/* âââ Pipeline summaries âââââââââââââââââââââââââââââââââââ */
const pipelineSummaries: Record<string, PipelineSummary> = {
  sales: { value: '$124,900', leads: '16', confidence: '62%', confDelta: '+8%', escalations: '3', progressPct: 33, wonValue: '$41,200' },
  reengagement: { value: '$56,000', leads: '8', confidence: '41%', confDelta: '+3%', escalations: '2', progressPct: 38, wonValue: '$21,280' },
  upsell: { value: '$38,400', leads: '6', confidence: '78%', confDelta: '+12%', escalations: '0', progressPct: 36, wonValue: '$14,200' },
};

const pipelineTabs = [
  { id: 'sales', label: 'Sales Pipeline', count: 16 },
  { id: 'reengagement', label: 'Re-engagement', count: 8 },
  { id: 'upsell', label: 'Upsell / Expansion', count: 6 },
];

const pipelineData: Record<string, KanbanColumn[]> = {
  sales: salesColumns,
  reengagement: reengagementColumns,
  upsell: upsellColumns,
};

/* âââ Helpers ââââââââââââââââââââââââââââââââââââââââââââââ */
function confBadgeClass(level: ConfLevel): string {
  switch (level) {
    case 'high': case 'won': case 'retained': case 'closed': return 'bg-emerald-50 text-emerald-600';
    case 'normal': return 'bg-amber-50 text-amber-600';
    case 'low': return 'bg-red-50 text-red-600';
    case 'critical': case 'lost': return 'bg-red-100 text-red-600';
    default: return 'bg-gray-100 text-gray-600';
  }
}
function confDotClass(level: ConfLevel): string {
  switch (level) {
    case 'high': case 'won': case 'retained': case 'closed': return 'bg-emerald-500';
    case 'normal': return 'bg-amber-500';
    case 'low': case 'critical': case 'lost': return 'bg-red-500';
    default: return 'bg-gray-500';
  }
}

/* âââ Component ââââââââââââââââââââââââââââââââââââââââââââ */
export default function PipelinesPage() {
  const [activeTab, setActiveTab] = useState('sales');
  const columns = pipelineData[activeTab];
  const summary = pipelineSummaries[activeTab];

  return (
    <div className="p-6 flex flex-col gap-5">
      {/* Tabs + Create Button */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
          {pipelineTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                activeTab === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}{' '}
              <span className={`ml-1 text-[11px] font-semibold px-1.5 py-0.5 rounded-full ${
                activeTab === t.id ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-200 text-gray-500'
              }`}>{t.count}</span>
            </button>
          ))}
        </div>
        <Link
          href="/pipelines/create"
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Pipeline
        </Link>
      </div>

      {/* Summary Bar */}
      <div className="flex items-center bg-white border border-gray-200 rounded-xl divide-x divide-gray-200">
        <div className="flex-[1.4] flex items-center gap-3 px-5 py-4">
          <div className="w-10 h-10 rounded-lg bg-indigo-50 text-indigo-500 flex items-center justify-center">
            <Clock className="w-[18px] h-[18px]" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-lg font-bold text-gray-900">{summary.value}</div>
            <div className="text-[11px] text-gray-500">Pipeline Value</div>
            <div className="flex items-center gap-2 mt-1">
              <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${summary.progressPct}%` }} />
              </div>
              <span className="text-[11px] text-gray-500"><strong className="text-emerald-600">{summary.wonValue}</strong> won <span className="text-emerald-600 font-semibold">{summary.progressPct}%</span></span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 px-5 py-4">
          <div className="w-10 h-10 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center">
            <Users className="w-[18px] h-[18px]" />
          </div>
          <div>
            <div className="text-lg font-bold text-gray-900">{summary.leads} <span className="text-xs text-gray-400 font-medium">active leads</span></div>
            <div className="text-[11px] text-gray-500">Leads in Pipeline</div>
          </div>
        </div>
        <div className="flex items-center gap-3 px-5 py-4">
          <div className="w-10 h-10 rounded-lg bg-indigo-50 text-indigo-500 flex items-center justify-center">
            <BarChart3 className="w-[18px] h-[18px]" />
          </div>
          <div>
            <div className="text-lg font-bold text-gray-900">{summary.confidence} <span className="text-xs text-emerald-500 font-semibold">{summary.confDelta}</span></div>
            <div className="text-[11px] text-gray-500">Avg. Confidence</div>
          </div>
        </div>
        <div className="flex items-center gap-3 px-5 py-4">
          <div className="w-10 h-10 rounded-lg bg-red-50 text-red-600 flex items-center justify-center">
            <AlertTriangle className="w-[18px] h-[18px]" />
          </div>
          <div>
            <div className="text-lg font-bold text-gray-900">{summary.escalations} <span className="text-xs text-red-500 font-semibold">at risk</span></div>
            <div className="text-[11px] text-gray-500">Escalations</div>
          </div>
        </div>
      </div>

      {/* Kanban Board */}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {columns.map((col) => (
          <div key={col.stage} className={`flex-shrink-0 w-[220px] flex flex-col rounded-xl ${
            col.variant === 'won' ? 'bg-emerald-50/50' : col.variant === 'lost' ? 'bg-red-50/50' : 'bg-gray-50'
          }`}>
            {/* Column Header */}
            <div className="flex items-center justify-between px-3 py-2.5">
              <span className={`text-[12px] font-semibold ${
                col.variant === 'won' ? 'text-emerald-700' : col.variant === 'lost' ? 'text-red-700' : 'text-gray-700'
              }`}>{col.stage}</span>
              <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded-full ${
                col.variant === 'won' ? 'bg-emerald-100 text-emerald-600' :
                col.variant === 'lost' ? 'bg-red-100 text-red-600' :
                'bg-gray-200 text-gray-500'
              }`}>{col.count}</span>
            </div>

            {/* Cards */}
            <div className="flex flex-col gap-2 px-2 pb-2">
              {col.cards.map((card) => (
                <div key={card.name + card.deal} className={`bg-white border rounded-lg p-3 cursor-pointer hover:shadow-md transition-shadow ${
                  card.variant === 'won' ? 'border-emerald-200' :
                  card.variant === 'lost' ? 'border-red-200' :
                  card.variant === 'risk' ? 'border-red-200' :
                  'border-gray-200'
                }`}>
                  <div className="text-[13px] font-semibold text-gray-900">{card.name}</div>
                  <div className="text-[11px] text-gray-500 mt-0.5">{card.company}</div>
                  <div className="flex items-center justify-between mt-2">
                    <span className={`text-[12px] font-bold ${
                      card.variant === 'won' ? 'text-emerald-600' :
                      card.variant === 'lost' ? 'text-red-500 line-through' :
                      'text-gray-900'
                    }`}>{card.deal}</span>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                      card.source === 'Budget' || card.source === 'Complaint' || card.source?.startsWith('No reply')
                        ? 'bg-red-50 text-red-600'
                        : card.source === 'Replied' || card.source === 'Renewed' || card.source === 'Upgraded'
                        ? 'bg-emerald-50 text-emerald-600'
                        : 'bg-gray-100 text-gray-500'
                    }`}>{card.source}</span>
                  </div>
                  <div className="text-[11px] text-gray-400 mt-2">{card.objectives}</div>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-[11px] text-gray-400">{card.time}</span>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex items-center gap-1 ${confBadgeClass(card.confLevel)}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${confDotClass(card.confLevel)}`} />
                      {card.confidence}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
