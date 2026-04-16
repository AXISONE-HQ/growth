'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Activity,
  Target,
  Users,
  Zap,
  Settings,
  Sparkles,
} from 'lucide-react';

/* âââ Types ââââââââââââââââââââââââââââââââââââââââââââââââ */
type PipelineType = 'sales' | 'reengagement' | 'upsell' | 'custom';

interface StepConfig {
  label: string;
  icon: React.ElementType;
}

/* âââ Steps ââââââââââââââââââââââââââââââââââââââââââââââââ */
const steps: StepConfig[] = [
  { label: 'Pipeline Type', icon: Activity },
  { label: 'Objectives', icon: Target },
  { label: 'Audience', icon: Users },
  { label: 'AI Settings', icon: Zap },
  { label: 'Review', icon: Settings },
];

const pipelineTypes = [
  {
    id: 'sales' as PipelineType,
    name: 'Sales Pipeline',
    description: 'Convert new leads into customers through AI-guided outreach, qualification, and deal closing.',
    stages: ['New', 'Contacted', 'Qualified', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'],
    color: 'border-indigo-500 bg-indigo-50',
    iconBg: 'bg-indigo-100 text-indigo-600',
  },
  {
    id: 'reengagement' as PipelineType,
    name: 'Re-engagement',
    description: 'Win back dormant contacts and churned customers with personalized re-engagement campaigns.',
    stages: ['At Risk', 'Reached Out', 'Re-engaged', 'Retained'],
    color: 'border-amber-500 bg-amber-50',
    iconBg: 'bg-amber-100 text-amber-600',
  },
  {
    id: 'upsell' as PipelineType,
    name: 'Upsell / Expansion',
    description: 'Identify and convert expansion opportunities within your existing customer base.',
    stages: ['Identified', 'Pitched', 'Evaluating', 'Closed'],
    color: 'border-emerald-500 bg-emerald-50',
    iconBg: 'bg-emerald-100 text-emerald-600',
  },
  {
    id: 'custom' as PipelineType,
    name: 'Custom Pipeline',
    description: 'Build a fully custom pipeline with your own stages, objectives, and AI strategies.',
    stages: ['Stage 1', 'Stage 2', 'Stage 3'],
    color: 'border-gray-400 bg-gray-50',
    iconBg: 'bg-gray-200 text-gray-600',
  },
];

const objectiveTemplates = [
  { id: 'book_meeting', label: 'Book Consultation Meeting', description: 'AI works to schedule a meeting with the contact' },
  { id: 'close_deal', label: 'Close Deal', description: 'Progress contact from qualified to closed won' },
  { id: 'qualify_lead', label: 'Qualify Lead', description: 'Gather budget, timeline, authority, and need info' },
  { id: 'send_proposal', label: 'Send Proposal', description: 'Generate and send a tailored proposal' },
  { id: 'reengage_contact', label: 'Re-engage Dormant Contact', description: 'Win back a contact with no recent activity' },
  { id: 'upsell_plan', label: 'Upsell to Higher Plan', description: 'Upgrade existing customer to a higher tier' },
];

const audienceFilters = [
  { id: 'all', label: 'All Contacts' },
  { id: 'new', label: 'New Leads (< 7 days)' },
  { id: 'qualified', label: 'Qualified Contacts' },
  { id: 'dormant', label: 'Dormant (> 14 days no activity)' },
  { id: 'customers', label: 'Existing Customers' },
  { id: 'high_value', label: 'High Value (> $10K deal)' },
];

/* âââ Component ââââââââââââââââââââââââââââââââââââââââââââ */
export default function CreatePipelinePage() {
  const [currentStep, setCurrentStep] = useState(0);
  const [selectedType, setSelectedType] = useState<PipelineType | null>(null);
  const [pipelineName, setPipelineName] = useState('');
  const [selectedObjectives, setSelectedObjectives] = useState<string[]>([]);
  const [selectedAudience, setSelectedAudience] = useState<string[]>([]);
  const [confidenceThreshold, setConfidenceThreshold] = useState(60);
  const [autoApprove, setAutoApprove] = useState(true);

  const canNext = () => {
    if (currentStep === 0) return selectedType !== null;
    if (currentStep === 1) return selectedObjectives.length > 0;
    if (currentStep === 2) return selectedAudience.length > 0;
    return true;
  };

  const toggleObjective = (id: string) => {
    setSelectedObjectives((prev) =>
      prev.includes(id) ? prev.filter((o) => o !== id) : [...prev, id]
    );
  };

  const toggleAudience = (id: string) => {
    setSelectedAudience((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    );
  };

  const selectedTypeData = pipelineTypes.find((t) => t.id === selectedType);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Back Link */}
      <Link href="/pipelines" className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-700 mb-6">
        <ArrowLeft className="w-4 h-4" /> Back to Pipelines
      </Link>

      {/* Header */}
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-gray-900">Create New Pipeline</h2>
        <p className="text-sm text-gray-500 mt-1">Configure your AI-powered pipeline in a few steps</p>
      </div>

      {/* Stepper */}
      <div className="flex items-center gap-2 mb-8">
        {steps.map((step, i) => {
          const Icon = step.icon;
          const isComplete = i < currentStep;
          const isActive = i === currentStep;
          return (
            <div key={step.label} className="flex items-center gap-2 flex-1">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                isComplete ? 'bg-emerald-500 text-white' :
                isActive ? 'bg-indigo-500 text-white' :
                'bg-gray-200 text-gray-500'
              }`}>
                {isComplete ? <Check className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
              </div>
              <span className={`text-[12px] font-medium hidden sm:inline ${
                isActive ? 'text-gray-900' : 'text-gray-400'
              }`}>{step.label}</span>
              {i < steps.length - 1 && <div className={`flex-1 h-px ${isComplete ? 'bg-emerald-400' : 'bg-gray-200'}`} />}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 min-h-[400px]">
        {/* Step 0: Pipeline Type */}
        {currentStep === 0 && (
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Choose Pipeline Type</h3>
            <p className="text-sm text-gray-500 mb-6">Select a template or create a custom pipeline</p>
            <div className="grid grid-cols-2 gap-4">
              {pipelineTypes.map((t) => (
                <button
                  key={t.id}
                  onClick={() => { setSelectedType(t.id); setPipelineName(t.name); }}
                  className={`text-left p-5 rounded-xl border-2 transition-all ${
                    selectedType === t.id ? t.color : 'border-gray-200 hover:border-gray-300 bg-white'
                  }`}
                >
                  <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-3 ${
                    selectedType === t.id ? t.iconBg : 'bg-gray-100 text-gray-500'
                  }`}>
                    <Activity className="w-5 h-5" />
                  </div>
                  <div className="text-sm font-semibold text-gray-900 mb-1">{t.name}</div>
                  <div className="text-[12px] text-gray-500 mb-3">{t.description}</div>
                  <div className="flex flex-wrap gap-1">
                    {t.stages.map((s) => (
                      <span key={s} className="text-[10px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{s}</span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
            {selectedType && (
              <div className="mt-6">
                <label className="text-sm font-medium text-gray-700 mb-2 block">Pipeline Name</label>
                <input
                  type="text"
                  value={pipelineName}
                  onChange={(e) => setPipelineName(e.target.value)}
                  placeholder="e.g. Q2 Sales Pipeline"
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-200 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 outline-none"
                />
              </div>
            )}
          </div>
        )}

        {/* Step 1: Objectives */}
        {currentStep === 1 && (
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Set Objectives</h3>
            <p className="text-sm text-gray-500 mb-6">What should the AI work toward for contacts in this pipeline?</p>
            <div className="flex flex-col gap-3">
              {objectiveTemplates.map((obj) => (
                <button
                  key={obj.id}
                  onClick={() => toggleObjective(obj.id)}
                  className={`flex items-center gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                    selectedObjectives.includes(obj.id)
                      ? 'border-indigo-500 bg-indigo-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 ${
                    selectedObjectives.includes(obj.id) ? 'bg-indigo-500 text-white' : 'border-2 border-gray-300'
                  }`}>
                    {selectedObjectives.includes(obj.id) && <Check className="w-3.5 h-3.5" />}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-gray-900">{obj.label}</div>
                    <div className="text-[12px] text-gray-500">{obj.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 2: Audience */}
        {currentStep === 2 && (
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Define Audience</h3>
            <p className="text-sm text-gray-500 mb-6">Which contacts should flow into this pipeline?</p>
            <div className="grid grid-cols-2 gap-3">
              {audienceFilters.map((a) => (
                <button
                  key={a.id}
                  onClick={() => toggleAudience(a.id)}
                  className={`flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all ${
                    selectedAudience.includes(a.id) ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 ${
                    selectedAudience.includes(a.id) ? 'bg-indigo-500 text-white' : 'border-2 border-gray-300'
                  }`}>
                    {selectedAudience.includes(a.id) && <Check className="w-3 h-3" />}
                  </div>
                  <span className="text-sm text-gray-700">{a.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 3: AI Settings */}
        {currentStep === 3 && (
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">AI Configuration</h3>
            <p className="text-sm text-gray-500 mb-6">Control how autonomously the AI operates in this pipeline</p>

            <div className="flex flex-col gap-6">
              <div>
                <label className="text-sm font-medium text-gray-700 mb-3 block">
                  Confidence Threshold: <strong className="text-indigo-500">{confidenceThreshold}%</strong>
                </label>
                <p className="text-[12px] text-gray-500 mb-3">
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

              <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                <div>
                  <div className="text-sm font-medium text-gray-900">Auto-approve high-confidence actions</div>
                  <div className="text-[12px] text-gray-500">Actions above {confidenceThreshold}% confidence execute without human review</div>
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

              <div className="p-4 bg-indigo-50 border border-indigo-200 rounded-xl">
                <div className="flex items-center gap-2 text-sm font-medium text-indigo-700 mb-2">
                  <Sparkles className="w-4 h-4" />
                  AI Strategy Selection
                </div>
                <p className="text-[12px] text-indigo-600">
                  The AI will automatically select the best strategy (Direct Conversion, Guided Assistance,
                  Trust Building, or Re-engagement) for each contact based on their profile, behavior, and objective progress.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Step 4: Review */}
        {currentStep === 4 && (
          <div>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Review Pipeline</h3>
            <p className="text-sm text-gray-500 mb-6">Confirm your pipeline configuration before creating</p>

            <div className="flex flex-col gap-4">
              <div className="p-4 bg-gray-50 rounded-xl">
                <div className="text-[11px] text-gray-500 uppercase tracking-wide mb-1">Pipeline</div>
                <div className="text-base font-semibold text-gray-900">{pipelineName || selectedTypeData?.name}</div>
                <div className="flex flex-wrap gap-1 mt-2">
                  {selectedTypeData?.stages.map((s) => (
                    <span key={s} className="text-[10px] bg-white text-gray-600 px-2 py-0.5 rounded-full border">{s}</span>
                  ))}
                </div>
              </div>

              <div className="p-4 bg-gray-50 rounded-xl">
                <div className="text-[11px] text-gray-500 uppercase tracking-wide mb-1">Objectives ({selectedObjectives.length})</div>
                <div className="flex flex-col gap-1">
                  {objectiveTemplates.filter((o) => selectedObjectives.includes(o.id)).map((o) => (
                    <div key={o.id} className="flex items-center gap-2 text-sm text-gray-700">
                      <Check className="w-3.5 h-3.5 text-emerald-500" /> {o.label}
                    </div>
                  ))}
                </div>
              </div>

              <div className="p-4 bg-gray-50 rounded-xl">
                <div className="text-[11px] text-gray-500 uppercase tracking-wide mb-1">Audience</div>
                <div className="flex flex-wrap gap-1">
                  {audienceFilters.filter((a) => selectedAudience.includes(a.id)).map((a) => (
                    <span key={a.id} className="text-[11px] bg-white text-gray-600 px-2 py-0.5 rounded-full border">{a.label}</span>
                  ))}
                </div>
              </div>

              <div className="p-4 bg-gray-50 rounded-xl">
                <div className="text-[11px] text-gray-500 uppercase tracking-wide mb-1">AI Settings</div>
                <div className="text-sm text-gray-700">
                  Confidence threshold: <strong>{confidenceThreshold}%</strong> Â· Auto-approve: <strong>{autoApprove ? 'On' : 'Off'}</strong>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Navigation Buttons */}
      <div className="flex items-center justify-between mt-6">
        <button
          onClick={() => setCurrentStep(Math.max(0, currentStep - 1))}
          disabled={currentStep === 0}
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          <ArrowLeft className="w-4 h-4" /> Previous
        </button>
        {currentStep < steps.length - 1 ? (
          <button
            onClick={() => canNext() && setCurrentStep(currentStep + 1)}
            disabled={!canNext()}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium text-white bg-indigo-500 hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            Next <ArrowRight className="w-4 h-4" />
          </button>
        ) : (
          <button className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium text-white bg-emerald-500 hover:bg-emerald-600 transition-all">
            <Sparkles className="w-4 h-4" /> Create Pipeline
          </button>
        )}
      </div>
    </div>
  );
}
