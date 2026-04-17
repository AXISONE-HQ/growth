'use client';

import {
  BookOpen, Brain, Building2, Package, Users, Target,
  TrendingUp, Clock, CheckCircle, AlertTriangle, RefreshCw,
  ChevronDown, ChevronRight, Search, Filter, Upload,
  FileText, Globe, Sparkles, BarChart3, Edit3, Plus,
  ArrowUpRight, Shield, Zap, Database, Eye, Star
} from 'lucide-react';
import { useState } from 'react';

/* ── Mock Data ────────────────────────────────────── */

const brainHealth = {
  overall: 92,
  lastUpdated: '2 minutes ago',
  totalFacts: 1247,
  sourcesConnected: 6,
  learningVelocity: '+12% this week',
};

const companyTruth = {
  products: [
    {
      id: 1, name: 'Growth Suite Pro', category: 'SaaS Platform', price: '$299/mo',
      description: 'Full AI revenue automation with all channels, unlimited contacts, and advanced analytics.',
      lastVerified: '1 day ago', confidence: 98,
    },
    {
      id: 2, name: 'Growth Starter', category: 'SaaS Platform', price: '$99/mo',
      description: 'Essential AI revenue tools for small teams. Up to 1,000 contacts, 3 channels.',
      lastVerified: '1 day ago', confidence: 97,
    },
    {
      id: 3, name: 'Blueprint Add-on: SaaS', category: 'Blueprint', price: '$49/mo',
      description: 'Industry intelligence pack for SaaS companies with tailored strategies and benchmarks.',
      lastVerified: '3 days ago', confidence: 95,
    },
    {
      id: 4, name: 'Enterprise Custom', category: 'Custom Plan', price: 'Custom',
      description: 'White-glove setup with dedicated AI tuning, custom integrations, and SLA.',
      lastVerified: '5 days ago', confidence: 91,
    },
  ],
  positioning: {
    tagline: 'AI Revenue System that thinks, acts, and learns',
    icp: 'B2B companies with 10-500 employees, $1M-$50M ARR',
    differentiators: [
      'Autonomous AI decisions with full transparency',
      'Living Business Brain that improves over time',
      'Industry Blueprints for instant domain expertise',
      'Complete audit trail of every AI action',
    ],
    competitors: ['HubSpot', 'Outreach', 'Salesloft', 'Apollo'],
  },
  constraints: [
    { rule: 'Never discount more than 20% without approval', category: 'Pricing', active: true },
    { rule: 'Always mention 14-day free trial in first touchpoint', category: 'Sales', active: true },
    { rule: 'Do not contact prospects before 8am or after 7pm local time', category: 'Compliance', active: true },
    { rule: 'Enterprise deals require VP+ title confirmation', category: 'Qualification', active: true },
    { rule: 'GDPR opt-in must be verified for EU contacts', category: 'Compliance', active: true },
  ],
};

const blueprintData = {
  name: 'SaaS B2B Blueprint',
  version: '2.4',
  vertical: 'Software as a Service',
  lastUpdated: 'Apr 10, 2025',
  journeys: [
    { name: 'Trial → Paid', stages: 5, avgDays: 14, conversion: '23%' },
    { name: 'Free → Pro', stages: 4, avgDays: 30, conversion: '12%' },
    { name: 'Pro → Enterprise', stages: 6, avgDays: 90, conversion: '8%' },
    { name: 'Churned → Win-back', stages: 3, avgDays: 45, conversion: '15%' },
  ],
  strategies: [
    { name: 'Direct Conversion', bestFor: 'High-intent, decision-maker engaged', winRate: '34%' },
    { name: 'Trust Building', bestFor: 'Early stage, needs social proof', winRate: '28%' },
    { name: 'Guided Assistance', bestFor: 'Technical buyer, needs demo/POC', winRate: '31%' },
    { name: 'Re-engagement', bestFor: 'Gone cold, needs new value prop', winRate: '19%' },
  ],
};

const behavioralInsights = [
  { metric: 'Best Send Time', value: 'Tue/Thu 10am', trend: 'stable', confidence: 89 },
  { metric: 'Top Channel', value: 'Email → SMS follow-up', trend: 'up', confidence: 92 },
  { metric: 'Avg Response Time', value: '2.4 hours', trend: 'down', confidence: 87 },
  { metric: 'Decision Maker Rate', value: '67% reached', trend: 'up', confidence: 84 },
  { metric: 'Multi-touch Avg', value: '4.2 touches to convert', trend: 'stable', confidence: 91 },
  { metric: 'Objection Pattern', value: 'Price → ROI reframe works 73%', trend: 'up', confidence: 86 },
];

const dataSources = [
  { name: 'HubSpot CRM', status: 'connected', lastSync: '2 min ago', records: '2,847', health: 98 },
  { name: 'Website Forms', status: 'connected', lastSync: '5 min ago', records: '1,203', health: 95 },
  { name: 'CSV Import (Apr)', status: 'processed', lastSync: '2 days ago', records: '450', health: 100 },
  { name: 'Stripe Billing', status: 'connected', lastSync: '15 min ago', records: '892', health: 97 },
  { name: 'Google Ads', status: 'connected', lastSync: '1 hr ago', records: '3,241', health: 94 },
  { name: 'Intercom Chat', status: 'pending', lastSync: 'Never', records: '0', health: 0 },
];

const recentLearnings = [
  { id: 1, type: 'strategy', insight: 'Direct Conversion win rate increased 4.2% for Enterprise segment after adding ROI calculator link to proposals.', time: '1 hour ago', impact: 'high' },
  { id: 2, type: 'behavioral', insight: 'SMS follow-up within 30 min of email open increases response rate by 2.8x for Mid-Market contacts.', time: '3 hours ago', impact: 'high' },
  { id: 3, type: 'channel', insight: 'WhatsApp outperforms email by 45% for re-engagement of contacts silent >30 days.', time: '6 hours ago', impact: 'medium' },
  { id: 4, type: 'timing', insight: 'Thursday 10-11am consistently highest engagement window. Wednesday close second.', time: '1 day ago', impact: 'medium' },
  { id: 5, type: 'content', insight: 'Case study mentions increase reply rate by 34% compared to feature-focused messages.', time: '2 days ago', impact: 'high' },
];

/* ── Component ────────────────────────────────────── */

export default function KnowledgeCenterPage() {
  const [activeTab, setActiveTab] = useState<'overview' | 'company' | 'blueprint' | 'learning' | 'sources'>('overview');
  const [expandedProduct, setExpandedProduct] = useState<number | null>(null);

  const tabs = [
    { id: 'overview' as const, label: 'Overview', icon: Brain },
    { id: 'company' as const, label: 'Company Truth', icon: Building2 },
    { id: 'blueprint' as const, label: 'Blueprint', icon: BookOpen },
    { id: 'learning' as const, label: 'Learning', icon: TrendingUp },
    { id: 'sources' as const, label: 'Data Sources', icon: Database },
  ];

  return (
    <div className="p-6 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Brain className="w-6 h-6 text-indigo-500" />
            <h2 className="text-xl font-semibold text-gray-900">Business Brain</h2>
            <span className="flex items-center gap-1.5 text-[13px] text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-full">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              Learning
            </span>
          </div>
          <p className="text-sm text-gray-500">Your AI&apos;s understanding of your business, market, and customers</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="flex items-center gap-2 px-3 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 transition-all">
            <Upload className="w-4 h-4 text-gray-400" />
            Upload Knowledge
          </button>
          <button className="flex items-center gap-2 px-3 py-2 text-sm bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-all">
            <RefreshCw className="w-4 h-4" />
            Sync Brain
          </button>
        </div>
      </div>

      {/* Brain Health Summary */}
      <div className="grid grid-cols-5 gap-4 mb-6">
        {[
          { label: 'Brain Health', value: `${brainHealth.overall}%`, icon: Brain, color: 'indigo' },
          { label: 'Total Facts', value: brainHealth.totalFacts.toLocaleString(), icon: Database, color: 'blue' },
          { label: 'Sources', value: brainHealth.sourcesConnected, icon: Globe, color: 'emerald' },
          { label: 'Last Updated', value: brainHealth.lastUpdated, icon: Clock, color: 'amber' },
          { label: 'Learning Rate', value: brainHealth.learningVelocity, icon: TrendingUp, color: 'violet' },
        ].map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="bg-white border border-gray-200 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Icon className={`w-4 h-4 text-${stat.color}-500`} />
                <span className="text-[12px] text-gray-500 font-medium">{stat.label}</span>
              </div>
              <div className="text-lg font-semibold text-gray-900">{stat.value}</div>
            </div>
          );
        })}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-all ${
                activeTab === tab.id
                  ? 'border-indigo-500 text-indigo-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-2 gap-6">
          {/* Recent Learnings */}
          <div className="bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-indigo-500" />
                <h3 className="font-semibold text-gray-900 text-sm">Recent Learnings</h3>
              </div>
              <span className="text-[11px] text-gray-400">Auto-discovered</span>
            </div>
            <div className="divide-y divide-gray-50">
              {recentLearnings.map((learning) => (
                <div key={learning.id} className="px-5 py-3">
                  <div className="flex items-start gap-3">
                    <div className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
                      learning.impact === 'high' ? 'bg-emerald-500' : 'bg-amber-400'
                    }`} />
                    <div>
                      <p className="text-sm text-gray-700 leading-relaxed">{learning.insight}</p>
                      <div className="flex items-center gap-3 mt-1.5">
                        <span className="text-[11px] text-gray-400">{learning.time}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                          learning.type === 'strategy' ? 'bg-indigo-50 text-indigo-600'
                            : learning.type === 'behavioral' ? 'bg-violet-50 text-violet-600'
                            : learning.type === 'channel' ? 'bg-blue-50 text-blue-600'
                            : learning.type === 'timing' ? 'bg-amber-50 text-amber-600'
                            : 'bg-emerald-50 text-emerald-600'
                        }`}>
                          {learning.type}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Behavioral Insights */}
          <div className="bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-violet-500" />
                <h3 className="font-semibold text-gray-900 text-sm">Behavioral Insights</h3>
              </div>
              <span className="text-[11px] text-gray-400">Updated continuously</span>
            </div>
            <div className="divide-y divide-gray-50">
              {behavioralInsights.map((insight, i) => (
                <div key={i} className="px-5 py-3 flex items-center justify-between">
                  <div>
                    <div className="text-[12px] text-gray-500 font-medium">{insight.metric}</div>
                    <div className="text-sm font-medium text-gray-900 mt-0.5">{insight.value}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className={`flex items-center gap-1 text-[11px] ${
                      insight.trend === 'up' ? 'text-emerald-600'
                        : insight.trend === 'down' ? 'text-red-500'
                        : 'text-gray-400'
                    }`}>
                      {insight.trend === 'up' && <ArrowUpRight className="w-3 h-3" />}
                      {insight.trend === 'up' ? 'Improving' : insight.trend === 'down' ? 'Declining' : 'Stable'}
                    </div>
                    <div className="w-10 bg-gray-100 rounded-full h-1.5">
                      <div
                        className="bg-indigo-500 h-1.5 rounded-full"
                        style={{ width: `${insight.confidence}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-gray-400 w-8">{insight.confidence}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Strategy Performance */}
          <div className="bg-white border border-gray-200 rounded-xl col-span-2">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-emerald-500" />
                <h3 className="font-semibold text-gray-900 text-sm">Strategy Performance</h3>
              </div>
              <span className="text-[11px] text-gray-400">From Blueprint + Learning</span>
            </div>
            <div className="grid grid-cols-4 divide-x divide-gray-100">
              {blueprintData.strategies.map((strategy, i) => (
                <div key={i} className="px-5 py-4">
                  <div className="text-sm font-semibold text-gray-900 mb-1">{strategy.name}</div>
                  <div className="text-[12px] text-gray-500 mb-3">{strategy.bestFor}</div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-gray-100 rounded-full h-2">
                      <div
                        className="bg-indigo-500 h-2 rounded-full"
                        style={{ width: strategy.winRate }}
                      />
                    </div>
                    <span className="text-sm font-semibold text-gray-900">{strategy.winRate}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'company' && (
        <div className="space-y-6">
          {/* Products & Pricing */}
          <div className="bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Package className="w-4 h-4 text-indigo-500" />
                <h3 className="font-semibold text-gray-900 text-sm">Products &amp; Pricing</h3>
              </div>
              <button className="flex items-center gap-1.5 text-[12px] text-indigo-600 hover:text-indigo-700">
                <Plus className="w-3.5 h-3.5" /> Add Product
              </button>
            </div>
            <div className="divide-y divide-gray-50">
              {companyTruth.products.map((product) => (
                <div key={product.id}>
                  <button
                    onClick={() => setExpandedProduct(expandedProduct === product.id ? null : product.id)}
                    className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-gray-50/50 transition-all"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
                        <Package className="w-4 h-4 text-indigo-500" />
                      </div>
                      <div className="text-left">
                        <div className="text-sm font-medium text-gray-900">{product.name}</div>
                        <div className="text-[12px] text-gray-500">{product.category}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="text-sm font-semibold text-gray-900">{product.price}</span>
                      <div className="flex items-center gap-1">
                        <div className="w-8 bg-gray-100 rounded-full h-1.5">
                          <div className="bg-emerald-500 h-1.5 rounded-full" style={{ width: `${product.confidence}%` }} />
                        </div>
                        <span className="text-[11px] text-gray-400">{product.confidence}%</span>
                      </div>
                      <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${expandedProduct === product.id ? 'rotate-180' : ''}`} />
                    </div>
                  </button>
                  {expandedProduct === product.id && (
                    <div className="px-5 pb-4 pl-[68px]">
                      <p className="text-sm text-gray-600 leading-relaxed mb-2">{product.description}</p>
                      <div className="flex items-center gap-3 text-[11px] text-gray-400">
                        <span>Last verified: {product.lastVerified}</span>
                        <button className="text-indigo-600 hover:text-indigo-700 flex items-center gap-1">
                          <Edit3 className="w-3 h-3" /> Edit
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Positioning */}
          <div className="bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Star className="w-4 h-4 text-amber-500" />
                <h3 className="font-semibold text-gray-900 text-sm">Positioning &amp; ICP</h3>
              </div>
              <button className="flex items-center gap-1.5 text-[12px] text-indigo-600 hover:text-indigo-700">
                <Edit3 className="w-3.5 h-3.5" /> Edit
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <div className="text-[12px] text-gray-500 font-medium mb-1">Tagline</div>
                <div className="text-sm text-gray-900">{companyTruth.positioning.tagline}</div>
              </div>
              <div>
                <div className="text-[12px] text-gray-500 font-medium mb-1">Ideal Customer Profile</div>
                <div className="text-sm text-gray-900">{companyTruth.positioning.icp}</div>
              </div>
              <div>
                <div className="text-[12px] text-gray-500 font-medium mb-1.5">Differentiators</div>
                <div className="flex flex-wrap gap-2">
                  {companyTruth.positioning.differentiators.map((d, i) => (
                    <span key={i} className="text-[12px] bg-indigo-50 text-indigo-700 px-2.5 py-1 rounded-full">{d}</span>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[12px] text-gray-500 font-medium mb-1.5">Known Competitors</div>
                <div className="flex flex-wrap gap-2">
                  {companyTruth.positioning.competitors.map((c, i) => (
                    <span key={i} className="text-[12px] bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full">{c}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Business Rules / Constraints */}
          <div className="bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-red-500" />
                <h3 className="font-semibold text-gray-900 text-sm">Business Rules &amp; Constraints</h3>
              </div>
              <button className="flex items-center gap-1.5 text-[12px] text-indigo-600 hover:text-indigo-700">
                <Plus className="w-3.5 h-3.5" /> Add Rule
              </button>
            </div>
            <div className="divide-y divide-gray-50">
              {companyTruth.constraints.map((constraint, i) => (
                <div key={i} className="px-5 py-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${constraint.active ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                    <span className="text-sm text-gray-700">{constraint.rule}</span>
                  </div>
                  <span className="text-[11px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{constraint.category}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'blueprint' && (
        <div className="space-y-6">
          {/* Blueprint Info */}
          <div className="bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-indigo-500" />
                <h3 className="font-semibold text-gray-900 text-sm">{blueprintData.name}</h3>
                <span className="text-[11px] bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full">v{blueprintData.version}</span>
              </div>
              <div className="text-[12px] text-gray-400">
                {blueprintData.vertical} &middot; Updated {blueprintData.lastUpdated}
              </div>
            </div>
          </div>

          {/* Customer Journeys */}
          <div className="bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Target className="w-4 h-4 text-emerald-500" />
                <h3 className="font-semibold text-gray-900 text-sm">Customer Journeys</h3>
              </div>
            </div>
            <div className="grid grid-cols-4 divide-x divide-gray-100">
              {blueprintData.journeys.map((journey, i) => (
                <div key={i} className="p-5">
                  <div className="text-sm font-semibold text-gray-900 mb-2">{journey.name}</div>
                  <div className="space-y-1.5 text-[12px]">
                    <div className="flex justify-between text-gray-500">
                      <span>Stages</span>
                      <span className="text-gray-900 font-medium">{journey.stages}</span>
                    </div>
                    <div className="flex justify-between text-gray-500">
                      <span>Avg Duration</span>
                      <span className="text-gray-900 font-medium">{journey.avgDays} days</span>
                    </div>
                    <div className="flex justify-between text-gray-500">
                      <span>Conversion</span>
                      <span className="text-emerald-600 font-semibold">{journey.conversion}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Strategies from Blueprint */}
          <div className="bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-amber-500" />
                <h3 className="font-semibold text-gray-900 text-sm">Strategy Templates</h3>
              </div>
              <span className="text-[11px] text-gray-400">Blueprint-defined, AI-optimized</span>
            </div>
            <div className="divide-y divide-gray-50">
              {blueprintData.strategies.map((strategy, i) => (
                <div key={i} className="px-5 py-3.5 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-gray-900">{strategy.name}</div>
                    <div className="text-[12px] text-gray-500 mt-0.5">{strategy.bestFor}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <div className="w-20 bg-gray-100 rounded-full h-2">
                        <div className="bg-indigo-500 h-2 rounded-full" style={{ width: strategy.winRate }} />
                      </div>
                      <span className="text-sm font-semibold text-gray-900 w-10">{strategy.winRate}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'learning' && (
        <div className="space-y-6">
          {/* All Learnings */}
          <div className="bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-indigo-500" />
                <h3 className="font-semibold text-gray-900 text-sm">AI-Discovered Insights</h3>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-gray-500">{recentLearnings.length} insights this week</span>
              </div>
            </div>
            <div className="divide-y divide-gray-50">
              {recentLearnings.map((learning) => (
                <div key={learning.id} className="px-5 py-4">
                  <div className="flex items-start gap-3">
                    <div className={`mt-1 p-1 rounded-md ${
                      learning.impact === 'high' ? 'bg-emerald-50' : 'bg-amber-50'
                    }`}>
                      {learning.impact === 'high' ? (
                        <TrendingUp className={`w-3.5 h-3.5 ${learning.impact === 'high' ? 'text-emerald-500' : 'text-amber-500'}`} />
                      ) : (
                        <BarChart3 className="w-3.5 h-3.5 text-amber-500" />
                      )}
                    </div>
                    <div className="flex-1">
                      <p className="text-sm text-gray-700 leading-relaxed">{learning.insight}</p>
                      <div className="flex items-center gap-3 mt-2">
                        <span className="text-[11px] text-gray-400">{learning.time}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                          learning.type === 'strategy' ? 'bg-indigo-50 text-indigo-600'
                            : learning.type === 'behavioral' ? 'bg-violet-50 text-violet-600'
                            : learning.type === 'channel' ? 'bg-blue-50 text-blue-600'
                            : learning.type === 'timing' ? 'bg-amber-50 text-amber-600'
                            : 'bg-emerald-50 text-emerald-600'
                        }`}>
                          {learning.type}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                          learning.impact === 'high' ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-500'
                        }`}>
                          {learning.impact} impact
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Behavioral Patterns */}
          <div className="bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Eye className="w-4 h-4 text-violet-500" />
                <h3 className="font-semibold text-gray-900 text-sm">Behavioral Patterns</h3>
              </div>
            </div>
            <div className="grid grid-cols-3 divide-x divide-gray-100">
              {behavioralInsights.slice(0, 3).map((insight, i) => (
                <div key={i} className="p-5">
                  <div className="text-[12px] text-gray-500 font-medium mb-1">{insight.metric}</div>
                  <div className="text-lg font-semibold text-gray-900 mb-2">{insight.value}</div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                      <div className="bg-violet-500 h-1.5 rounded-full" style={{ width: `${insight.confidence}%` }} />
                    </div>
                    <span className="text-[11px] text-gray-400">{insight.confidence}% confidence</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'sources' && (
        <div className="space-y-6">
          {/* Connected Sources */}
          <div className="bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-blue-500" />
                <h3 className="font-semibold text-gray-900 text-sm">Data Sources</h3>
              </div>
              <button className="flex items-center gap-1.5 text-[12px] text-indigo-600 hover:text-indigo-700">
                <Plus className="w-3.5 h-3.5" /> Connect Source
              </button>
            </div>
            <div className="divide-y divide-gray-50">
              {dataSources.map((source, i) => (
                <div key={i} className="px-5 py-3.5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-2.5 h-2.5 rounded-full ${
                      source.status === 'connected' ? 'bg-emerald-500'
                        : source.status === 'processed' ? 'bg-blue-500'
                        : 'bg-gray-300'
                    }`} />
                    <div>
                      <div className="text-sm font-medium text-gray-900">{source.name}</div>
                      <div className="text-[12px] text-gray-500">
                        {source.records} records &middot; Last sync: {source.lastSync}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                      source.status === 'connected' ? 'bg-emerald-50 text-emerald-600'
                        : source.status === 'processed' ? 'bg-blue-50 text-blue-600'
                        : 'bg-gray-100 text-gray-500'
                    }`}>
                      {source.status}
                    </span>
                    {source.health > 0 && (
                      <div className="flex items-center gap-1.5">
                        <div className="w-12 bg-gray-100 rounded-full h-1.5">
                          <div
                            className={`h-1.5 rounded-full ${source.health > 90 ? 'bg-emerald-500' : 'bg-amber-400'}`}
                            style={{ width: `${source.health}%` }}
                          />
                        </div>
                        <span className="text-[11px] text-gray-400">{source.health}%</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
