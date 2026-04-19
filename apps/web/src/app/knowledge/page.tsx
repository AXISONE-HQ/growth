'use client';

import {
  Building2, Package, Shield, HelpCircle, Plus, Edit3, Trash2,
  Save, X, Upload, FileText, Globe, Eye, ChevronDown, ChevronRight,
  AlertTriangle, CheckCircle, Loader2, RefreshCw, MessageSquareWarning,
  TrendingUp, TrendingDown, Flame, Zap, Sparkles, Target, Swords,
  BookOpen, Search, Filter, ExternalLink, ThumbsUp, ThumbsDown, Clock,
  Pencil, RotateCcw, UserCheck
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import {
  knowledgeApi,
  type CompanyInfo,
  type Product,
  type PolicyRule,
  type FAQ,
  type KnowledgeDocument,
} from '@/lib/api';

/* ── Tabs Config ──────────────────────────────────────── */

const tabs = [
  { id: 'company-truth', label: 'Company Truth', icon: Building2 },
  { id: 'products', label: 'Products', icon: Package },
  { id: 'warranties', label: 'Warranties & Financing', icon: Shield },
  { id: 'faq', label: 'FAQ', icon: HelpCircle },
  { id: 'objections', label: 'Sales Objections', icon: MessageSquareWarning },
];

/* ── Sales Objections Types & Mock Data ─────────────── */

type ObjectionCategory = 'pricing' | 'product' | 'trust' | 'timing' | 'competition';
type ObjectionStatus = 'active' | 'resolved' | 'new';
type ObjectionTrend = 'hot' | 'rising' | 'stable' | 'declining' | 'new';

interface ObjectionSource {
  type: 'knowledge' | 'competitive';
  title: string;
  excerpt: string;
}

type EditableField = 'recommendedResponse' | 'talkTrack' | 'differentiators';

interface SalesObjection {
  id: string;
  objection: string;
  category: ObjectionCategory;
  status: ObjectionStatus;
  trend: ObjectionTrend;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  winRate: number;
  recommendedResponse: string;
  talkTrack: string;
  differentiators: string[];
  sources: ObjectionSource[];
  editedFields?: {
    [key in EditableField]?: {
      editedBy: string;
      editedAt: string;
    };
  };
}

const OBJECTION_CATEGORIES: { value: ObjectionCategory; label: string; color: string }[] = [
  { value: 'pricing', label: 'Pricing', color: 'bg-emerald-100 text-emerald-700' },
  { value: 'product', label: 'Product', color: 'bg-blue-100 text-blue-700' },
  { value: 'trust', label: 'Trust', color: 'bg-purple-100 text-purple-700' },
  { value: 'timing', label: 'Timing', color: 'bg-amber-100 text-amber-700' },
  { value: 'competition', label: 'Competition', color: 'bg-red-100 text-red-700' },
];

const MOCK_OBJECTIONS: SalesObjection[] = [
  {
    id: 'obj-1',
    objection: "Your pricing is too high compared to competitors",
    category: 'pricing',
    status: 'active',
    trend: 'hot',
    occurrences: 47,
    firstSeen: '2026-01-15',
    lastSeen: '2026-04-18',
    winRate: 62,
    recommendedResponse: "I understand budget is important. What many clients discover is that our total cost of ownership is actually 30-40% lower when you factor in the automation savings. Our AI handles tasks that would require 2-3 additional headcount with manual tools. Let me show you the ROI calculator — most teams see payback within 60 days.",
    talkTrack: "1) Acknowledge the concern genuinely. 2) Shift from price to value — frame as investment, not cost. 3) Reference the ROI calculator with their specific metrics. 4) Share the case study from [similar industry] showing 3.2x ROI. 5) Offer the pilot program: 30-day trial at reduced rate to prove value before full commitment.",
    differentiators: [
      "AI automation replaces 2-3 FTEs worth of manual outreach",
      "Average customer sees 3.2x ROI within first quarter",
      "No-code setup means zero implementation costs vs. competitors requiring consultants",
      "30-day pilot program available to prove value risk-free",
    ],
    sources: [
      { type: 'competitive', title: 'vs. HubSpot Sales Hub', excerpt: 'HubSpot Professional starts at $450/mo but requires $3,000+ onboarding. growth includes onboarding and AI automation at $299/mo.' },
      { type: 'competitive', title: 'vs. Salesforce Sales Cloud', excerpt: 'Salesforce requires admin staff ($80K+/yr). growth is self-serve with AI-guided setup.' },
      { type: 'knowledge', title: 'ROI Calculator — Customer Results', excerpt: 'Average growth customer saves 22 hours/week on manual outreach tasks, equivalent to $2,800/mo in labor costs.' },
    ],
  },
  {
    id: 'obj-2',
    objection: "We're already using HubSpot and don't want to switch",
    category: 'competition',
    status: 'active',
    trend: 'rising',
    occurrences: 31,
    firstSeen: '2026-02-03',
    lastSeen: '2026-04-17',
    winRate: 45,
    recommendedResponse: "That's great — HubSpot is solid for marketing automation. growth isn't a replacement for HubSpot; it actually integrates with it. We sit on top of your CRM and add the AI decision layer that HubSpot doesn't have. Think of it as giving your HubSpot data a brain that acts on it autonomously. Many of our best customers run both.",
    talkTrack: "1) Validate their current investment — never bash HubSpot. 2) Position growth as complementary, not competitive. 3) Explain the AI decision loop concept — what growth does that HubSpot can't. 4) Mention the native HubSpot integration via Nango. 5) Offer a side-by-side demo showing both tools working together.",
    differentiators: [
      "Native HubSpot integration — syncs contacts, deals, and activities bidirectionally",
      "AI Decision Engine that autonomously determines next-best-action (HubSpot requires manual workflows)",
      "Learning loop that continuously optimizes — HubSpot workflows are static",
      "Complementary tool, not a replacement — enhances existing CRM investment",
    ],
    sources: [
      { type: 'competitive', title: 'vs. HubSpot Sales Hub', excerpt: 'HubSpot workflows require manual configuration for every scenario. growth AI adapts automatically based on contact behavior and outcomes.' },
      { type: 'knowledge', title: 'Integration Guide — HubSpot', excerpt: 'Full bidirectional sync via Nango SDK. Contacts, deals, activities, and custom properties all supported.' },
      { type: 'competitive', title: 'Battle Card — HubSpot', excerpt: 'Key gap: HubSpot has no autonomous AI agent capability. Their "AI" is limited to content generation, not decision-making.' },
    ],
  },
  {
    id: 'obj-3',
    objection: "How do I know the AI won't send embarrassing messages to my customers?",
    category: 'trust',
    status: 'active',
    trend: 'stable',
    occurrences: 23,
    firstSeen: '2026-01-22',
    lastSeen: '2026-04-16',
    winRate: 78,
    recommendedResponse: "That's a really important question — and honestly, it should be a dealbreaker if a vendor can't answer it well. We built growth with a 6-layer guardrail system. Every AI-generated message passes through tone validation, accuracy checks, hallucination filtering, compliance checks, confidence scoring, and injection defense before anything is sent. Plus, you set the confidence threshold — anything below it goes to your human review queue instead of sending automatically.",
    talkTrack: "1) Validate the concern — this shows they're thinking seriously about adoption. 2) Walk through the 6 guardrail layers specifically. 3) Show the confidence threshold slider in Settings. 4) Demonstrate the human review queue. 5) Share that 99.7% of messages pass all guardrails without issue.",
    differentiators: [
      "6-layer guardrail system: tone, accuracy, hallucination, compliance, confidence, injection defense",
      "Adjustable confidence threshold — you control how autonomous the AI is",
      "Human review queue for any message below your confidence threshold",
      "Full audit log of every AI decision with reasoning explanation",
    ],
    sources: [
      { type: 'knowledge', title: 'AI Guardrail Architecture', excerpt: 'Every agent action passes through 6 sequential validation checks. Failure at any layer triggers regeneration or human escalation.' },
      { type: 'knowledge', title: 'Settings — AI Configuration', excerpt: 'Global confidence threshold (20-95%) controls autonomous vs. human-reviewed actions. Default is 70%.' },
    ],
  },
  {
    id: 'obj-4',
    objection: "We need to see results before committing to an annual plan",
    category: 'timing',
    status: 'active',
    trend: 'rising',
    occurrences: 19,
    firstSeen: '2026-03-01',
    lastSeen: '2026-04-18',
    winRate: 71,
    recommendedResponse: "Completely fair. That's exactly why we offer a 30-day pilot program. You get full access to the platform with your real data, and we set up your Business Brain together. Most teams see measurable results within the first two weeks — typically a 25-40% increase in response rates and 15% more qualified pipeline. At the end of 30 days, the data speaks for itself.",
    talkTrack: "1) Agree with their caution — don't push back. 2) Present the 30-day pilot as designed for exactly this concern. 3) Set clear success metrics upfront (response rate, pipeline, time saved). 4) Offer weekly check-ins during the pilot. 5) Emphasize there's no commitment until they see results.",
    differentiators: [
      "30-day pilot program with full platform access",
      "Business Brain setup included — personalized to their industry and data",
      "Weekly performance check-ins during pilot",
      "Clear success metrics agreed upfront — data-driven decision to continue",
    ],
    sources: [
      { type: 'knowledge', title: 'Pilot Program Details', excerpt: '30-day full-access pilot. Includes onboarding, Brain setup, and weekly optimization calls. No commitment until results are proven.' },
      { type: 'knowledge', title: 'Customer Success Metrics', excerpt: 'Average pilot conversion rate: 73%. Median time to first measurable result: 11 days.' },
    ],
  },
  {
    id: 'obj-5',
    objection: "Our team doesn't have time to learn another tool",
    category: 'product',
    status: 'active',
    trend: 'declining',
    occurrences: 14,
    firstSeen: '2026-02-10',
    lastSeen: '2026-04-10',
    winRate: 82,
    recommendedResponse: "I hear you — tool fatigue is real. The good news is growth was built to require almost zero learning curve. The AI does the heavy lifting. Your team's main interaction is reviewing the AI's work in the dashboard and adjusting the confidence threshold. Most teams are fully onboarded in under 2 hours, and after that, the AI actually gives time back because it handles outreach that your team currently does manually.",
    talkTrack: "1) Acknowledge tool fatigue as a real pain point. 2) Differentiate: growth is not a tool your team 'uses' — it works FOR them. 3) Mention the 2-hour onboarding. 4) Quantify time savings (22 hrs/week average). 5) Offer a personalized demo showing their specific workflow automated.",
    differentiators: [
      "2-hour average onboarding time — the fastest in the category",
      "AI-first design means the tool works autonomously, not another inbox to check",
      "Saves average team 22 hours/week by automating manual outreach",
      "No-code setup — zero technical skills required",
    ],
    sources: [
      { type: 'knowledge', title: 'Onboarding Guide', excerpt: 'Step 1: Connect CRM (5 min). Step 2: AI builds Business Brain (30 min, automated). Step 3: Set objectives and thresholds (15 min). Step 4: Review first AI actions (30 min).' },
      { type: 'competitive', title: 'Implementation Comparison', excerpt: 'Salesforce: 3-6 months. HubSpot: 2-4 weeks. growth: 2 hours to first AI action.' },
    ],
  },
  {
    id: 'obj-6',
    objection: "What happens to our data? Is it used to train AI models?",
    category: 'trust',
    status: 'new',
    trend: 'new',
    occurrences: 3,
    firstSeen: '2026-04-12',
    lastSeen: '2026-04-18',
    winRate: 100,
    recommendedResponse: "Great question. Your data is completely isolated — every tenant has their own Business Brain, and there is zero cross-tenant data sharing. We never use customer data to train our AI models. We use Anthropic's Claude API which has the same guarantee. Your data stays yours, encrypted at rest with AES-256 and in transit with TLS 1.3, and we're fully GDPR compliant. You can see all of this in our security settings.",
    talkTrack: "1) Take the question seriously — this matters. 2) Explain tenant isolation architecture. 3) Confirm no model training on customer data. 4) Reference encryption standards (AES-256, TLS 1.3). 5) Point to GDPR compliance and audit log retention. 6) Offer to share the security whitepaper.",
    differentiators: [
      "Complete tenant data isolation — no cross-tenant data access",
      "Zero model training on customer data — guaranteed in ToS",
      "AES-256 encryption at rest, TLS 1.3 in transit",
      "GDPR compliant with 2-year immutable audit log retention",
    ],
    sources: [
      { type: 'knowledge', title: 'Security & Compliance', excerpt: 'Multi-tenant architecture with strict tenant_id isolation. pgvector embeddings namespaced per tenant. No cross-tenant retrieval possible.' },
      { type: 'knowledge', title: 'Data Processing Agreement', excerpt: 'Customer data is never used for model training. Anthropic API usage follows their enterprise data policy — no training on API inputs.' },
    ],
  },
];

/* ── Toast Component ──────────────────────────────────── */

function Toast({ message, type, onClose }: { message: string; type: 'success' | 'error'; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all ${
      type === 'success' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
    }`}>
      {type === 'success' ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
      {message}
    </div>
  );
}

/* ── Main Component ──────────────────────────────────── */

export default function KnowledgeCenterPage() {
  const [activeTab, setActiveTab] = useState('company-truth');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const showToast = (message: string, type: 'success' | 'error' = 'success') => setToast({ message, type });

  // ── Loading states ──
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // ── Company Truth state ──
  const [companyInfo, setCompanyInfo] = useState<CompanyInfo | null>(null);
  const [editingCompany, setEditingCompany] = useState(false);
  const [companyDraft, setCompanyDraft] = useState({ vision: '', mission: '', websiteUrl: '' });
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);

  // ── Products state ──
  const [products, setProducts] = useState<Product[]>([]);
  const [editingProduct, setEditingProduct] = useState<string | null>(null);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [productDraft, setProductDraft] = useState({ name: '', category: '', price: '', description: '', sku: '' });

  // ── Policies state (Warranties & Financing) ──
  const [warranties, setWarranties] = useState<PolicyRule[]>([]);
  const [financing, setFinancing] = useState<PolicyRule[]>([]);
  const [rules, setRules] = useState<PolicyRule[]>([]);
  const [editingWarranties, setEditingWarranties] = useState(false);
  const [warrantyDraft, setWarrantyDraft] = useState({ title: '', content: '' });
  const [financingDraft, setFinancingDraft] = useState({ title: '', content: '' });
  const [newRule, setNewRule] = useState('');

  // ── FAQ state ──
  const [faqs, setFaqs] = useState<FAQ[]>([]);
  const [editingFaq, setEditingFaq] = useState<string | null>(null);
  const [showAddFaq, setShowAddFaq] = useState(false);
  const [faqDraft, setFaqDraft] = useState({ question: '', answer: '' });
  const [expandedFaq, setExpandedFaq] = useState<string | null>(null);

  // ── Sales Objections state ──
  const [objections, setObjections] = useState<SalesObjection[]>(MOCK_OBJECTIONS);
  const [expandedObjection, setExpandedObjection] = useState<string | null>(null);
  const [objectionCategoryFilter, setObjectionCategoryFilter] = useState<ObjectionCategory | 'all'>('all');
  const [objectionStatusFilter, setObjectionStatusFilter] = useState<ObjectionStatus | 'all'>('all');
  const [objectionSearch, setObjectionSearch] = useState('');

  // ── Objection editing state ──
  const [editingObjField, setEditingObjField] = useState<{ objId: string; field: EditableField } | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editDraftDiffs, setEditDraftDiffs] = useState<string[]>([]);

  const startEditingField = (objId: string, field: EditableField, currentValue: string | string[]) => {
    if (field === 'differentiators') {
      setEditDraftDiffs(currentValue as string[]);
    } else {
      setEditDraft(currentValue as string);
    }
    setEditingObjField({ objId, field });
  };

  const cancelEditingField = () => {
    setEditingObjField(null);
    setEditDraft('');
    setEditDraftDiffs([]);
  };

  const saveEditedField = () => {
    if (!editingObjField) return;
    const { objId, field } = editingObjField;

    setObjections(prev => prev.map(obj => {
      if (obj.id !== objId) return obj;
      const updated = { ...obj };
      if (field === 'differentiators') {
        updated.differentiators = editDraftDiffs.filter(d => d.trim() !== '');
      } else {
        (updated as any)[field] = editDraft;
      }
      updated.editedFields = {
        ...updated.editedFields,
        [field]: {
          editedBy: 'You',
          editedAt: new Date().toISOString(),
        },
      };
      return updated;
    }));

    showToast('Response updated successfully');
    cancelEditingField();
  };

  const revertToAI = (objId: string, field: EditableField) => {
    const original = MOCK_OBJECTIONS.find(o => o.id === objId);
    if (!original) return;

    setObjections(prev => prev.map(obj => {
      if (obj.id !== objId) return obj;
      const updated = { ...obj };
      (updated as any)[field] = (original as any)[field];
      const editedFields = { ...updated.editedFields };
      delete editedFields[field];
      updated.editedFields = Object.keys(editedFields).length > 0 ? editedFields : undefined;
      return updated;
    }));

    showToast('Reverted to AI recommendation');
  };

  const filteredObjections = objections.filter(o => {
    if (objectionCategoryFilter !== 'all' && o.category !== objectionCategoryFilter) return false;
    if (objectionStatusFilter !== 'all' && o.status !== objectionStatusFilter) return false;
    if (objectionSearch.trim() && !o.objection.toLowerCase().includes(objectionSearch.toLowerCase()) && !o.recommendedResponse.toLowerCase().includes(objectionSearch.toLowerCase())) return false;
    return true;
  });

  const getTrendIcon = (trend: ObjectionTrend) => {
    switch (trend) {
      case 'hot': return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700"><Flame className="w-3 h-3" /> Hot</span>;
      case 'rising': return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-700"><TrendingUp className="w-3 h-3" /> Rising</span>;
      case 'stable': return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600"><TrendingDown className="w-3 h-3" /> Stable</span>;
      case 'declining': return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700"><TrendingDown className="w-3 h-3" /> Declining</span>;
      case 'new': return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700"><Sparkles className="w-3 h-3" /> New</span>;
    }
  };

  const getCategoryStyle = (category: ObjectionCategory) => {
    return OBJECTION_CATEGORIES.find(c => c.value === category)?.color || 'bg-gray-100 text-gray-600';
  };

  const getCategoryLabel = (category: ObjectionCategory) => {
    return OBJECTION_CATEGORIES.find(c => c.value === category)?.label || category;
  };

  /* ── Data Loading ────────────────────────────────────── */

  const loadCompanyData = useCallback(async () => {
    try {
      const [info, docs] = await Promise.all([
        knowledgeApi.getCompanyInfo(),
        knowledgeApi.listDocuments({ limit: 50 }),
      ]);
      setCompanyInfo(info);
      setDocuments(docs.documents);
    } catch (e) {
      console.error('Failed to load company data:', e);
      showToast('Failed to load company data', 'error');
    }
  }, []);

  const loadProducts = useCallback(async () => {
    try {
      const res = await knowledgeApi.listProducts({ limit: 100 });
      setProducts(res.products);
    } catch (e) {
      console.error('Failed to load products:', e);
      showToast('Failed to load products', 'error');
    }
  }, []);

  const loadPolicies = useCallback(async () => {
    try {
      const [w, f, r] = await Promise.all([
        knowledgeApi.listPolicies({ category: 'warranty', limit: 50 }),
        knowledgeApi.listPolicies({ category: 'financing', limit: 50 }),
        knowledgeApi.listPolicies({ category: 'rule', limit: 50 }),
      ]);
      setWarranties(w.policies);
      setFinancing(f.policies);
      setRules(r.policies);
    } catch (e) {
      console.error('Failed to load policies:', e);
      showToast('Failed to load policies', 'error');
    }
  }, []);

  const loadFAQs = useCallback(async () => {
    try {
      const res = await knowledgeApi.listFAQs({ limit: 100 });
      setFaqs(res.faqs);
    } catch (e) {
      console.error('Failed to load FAQs:', e);
      showToast('Failed to load FAQs', 'error');
    }
  }, []);

  // Initial load
  useEffect(() => {
    const loadAll = async () => {
      setLoading(true);
      await Promise.all([loadCompanyData(), loadProducts(), loadPolicies(), loadFAQs()]);
      setLoading(false);
    };
    loadAll();
  }, [loadCompanyData, loadProducts, loadPolicies, loadFAQs]);

  /* ── Company Truth Handlers ──────────────────────────── */

  const saveCompanyInfo = async () => {
    setSaving(true);
    try {
      const updated = await knowledgeApi.updateCompanyInfo({
        vision: companyDraft.vision,
        mission: companyDraft.mission,
        websiteUrl: companyDraft.websiteUrl || null,
      });
      setCompanyInfo(updated);
      setEditingCompany(false);
      showToast('Company info saved');
    } catch (e) {
      showToast('Failed to save company info', 'error');
    }
    setSaving(false);
  };

  const cancelCompanyEdit = () => {
    setCompanyDraft({
      vision: companyInfo?.vision || '',
      mission: companyInfo?.mission || '',
      websiteUrl: companyInfo?.websiteUrl || '',
    });
    setEditingCompany(false);
  };

  const startCompanyEdit = () => {
    setCompanyDraft({
      vision: companyInfo?.vision || '',
      mission: companyInfo?.mission || '',
      websiteUrl: companyInfo?.websiteUrl || '',
    });
    setEditingCompany(true);
  };

  const removeDocument = async (id: string) => {
    setSaving(true);
    try {
      await knowledgeApi.deleteDocument(id);
      setDocuments(documents.filter(d => d.id !== id));
      showToast('Document removed');
    } catch (e) {
      showToast('Failed to remove document', 'error');
    }
    setSaving(false);
  };

  /* ── Product Handlers ────────────────────────────────── */

  const saveProduct = async () => {
    if (!productDraft.name.trim()) return;
    setSaving(true);
    try {
      if (editingProduct) {
        const updated = await knowledgeApi.updateProduct({
          id: editingProduct,
          name: productDraft.name,
          category: productDraft.category || undefined,
          price: productDraft.price || undefined,
          description: productDraft.description || undefined,
          sku: productDraft.sku || undefined,
        });
        setProducts(products.map(p => p.id === editingProduct ? updated : p));
        setEditingProduct(null);
        showToast('Product updated');
      } else {
        const created = await knowledgeApi.createProduct({
          name: productDraft.name,
          category: productDraft.category || undefined,
          price: productDraft.price || undefined,
          description: productDraft.description || undefined,
          sku: productDraft.sku || undefined,
        });
        setProducts([...products, created]);
        setShowAddProduct(false);
        showToast('Product created');
      }
      setProductDraft({ name: '', category: '', price: '', description: '', sku: '' });
    } catch (e) {
      showToast('Failed to save product', 'error');
    }
    setSaving(false);
  };

  const startEditProduct = (p: Product) => {
    setProductDraft({
      name: p.name,
      category: p.category || '',
      price: p.price || '',
      description: p.description || '',
      sku: p.sku || '',
    });
    setEditingProduct(p.id);
    setShowAddProduct(false);
  };

  const deleteProduct = async (id: string) => {
    setSaving(true);
    try {
      await knowledgeApi.deleteProduct(id);
      setProducts(products.filter(p => p.id !== id));
      if (editingProduct === id) {
        setEditingProduct(null);
        setProductDraft({ name: '', category: '', price: '', description: '', sku: '' });
      }
      showToast('Product deleted');
    } catch (e) {
      showToast('Failed to delete product', 'error');
    }
    setSaving(false);
  };

  const cancelProductEdit = () => {
    setEditingProduct(null);
    setShowAddProduct(false);
    setProductDraft({ name: '', category: '', price: '', description: '', sku: '' });
  };

  /* ── Warranties & Financing Handlers ─────────────────── */

  const startWarrantiesEdit = () => {
    setWarrantyDraft({
      title: 'Warranty Policy',
      content: warranties[0]?.content || '',
    });
    setFinancingDraft({
      title: 'Financing Terms',
      content: financing[0]?.content || '',
    });
    setEditingWarranties(true);
  };

  const saveWarranties = async () => {
    setSaving(true);
    try {
      // Upsert warranty policy
      if (warranties[0]) {
        const updated = await knowledgeApi.updatePolicy({ id: warranties[0].id, content: warrantyDraft.content });
        setWarranties([updated]);
      } else if (warrantyDraft.content.trim()) {
        const created = await knowledgeApi.createPolicy({ category: 'warranty', title: 'Warranty Policy', content: warrantyDraft.content });
        setWarranties([created]);
      }

      // Upsert financing terms
      if (financing[0]) {
        const updated = await knowledgeApi.updatePolicy({ id: financing[0].id, content: financingDraft.content });
        setFinancing([updated]);
      } else if (financingDraft.content.trim()) {
        const created = await knowledgeApi.createPolicy({ category: 'financing', title: 'Financing Terms', content: financingDraft.content });
        setFinancing([created]);
      }

      setEditingWarranties(false);
      showToast('Policies saved');
    } catch (e) {
      showToast('Failed to save policies', 'error');
    }
    setSaving(false);
  };

  const cancelWarrantiesEdit = () => {
    setEditingWarranties(false);
    setNewRule('');
  };

  const addRule = async () => {
    if (!newRule.trim()) return;
    setSaving(true);
    try {
      const created = await knowledgeApi.createPolicy({
        category: 'rule',
        title: newRule.trim(),
        content: newRule.trim(),
        sortOrder: rules.length,
      });
      setRules([...rules, created]);
      setNewRule('');
      showToast('Rule added');
    } catch (e) {
      showToast('Failed to add rule', 'error');
    }
    setSaving(false);
  };

  const removeRule = async (id: string) => {
    setSaving(true);
    try {
      await knowledgeApi.deletePolicy(id);
      setRules(rules.filter(r => r.id !== id));
      showToast('Rule removed');
    } catch (e) {
      showToast('Failed to remove rule', 'error');
    }
    setSaving(false);
  };

  /* ── FAQ Handlers ────────────────────────────────────── */

  const saveFaq = async () => {
    if (!faqDraft.question.trim() || !faqDraft.answer.trim()) return;
    setSaving(true);
    try {
      if (editingFaq) {
        const updated = await knowledgeApi.updateFAQ({
          id: editingFaq,
          question: faqDraft.question,
          answer: faqDraft.answer,
        });
        setFaqs(faqs.map(f => f.id === editingFaq ? updated : f));
        setEditingFaq(null);
        showToast('FAQ updated');
      } else {
        const created = await knowledgeApi.createFAQ({
          question: faqDraft.question,
          answer: faqDraft.answer,
          sortOrder: faqs.length,
        });
        setFaqs([...faqs, created]);
        setShowAddFaq(false);
        showToast('FAQ created');
      }
      setFaqDraft({ question: '', answer: '' });
    } catch (e) {
      showToast('Failed to save FAQ', 'error');
    }
    setSaving(false);
  };

  const startEditFaq = (f: FAQ) => {
    setFaqDraft({ question: f.question, answer: f.answer });
    setEditingFaq(f.id);
    setShowAddFaq(false);
  };

  const deleteFaq = async (id: string) => {
    setSaving(true);
    try {
      await knowledgeApi.deleteFAQ(id);
      setFaqs(faqs.filter(f => f.id !== id));
      if (editingFaq === id) {
        setEditingFaq(null);
        setFaqDraft({ question: '', answer: '' });
      }
      showToast('FAQ deleted');
    } catch (e) {
      showToast('Failed to delete FAQ', 'error');
    }
    setSaving(false);
  };

  const cancelFaqEdit = () => {
    setEditingFaq(null);
    setShowAddFaq(false);
    setFaqDraft({ question: '', answer: '' });
  };

  /* ── Loading Screen ──────────────────────────────────── */

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
          <p className="text-sm text-gray-500">Loading Knowledge Center...</p>
        </div>
      </div>
    );
  }

  /* ── Render ──────────────────────────────────────────── */
  return (
    <div className="p-6 space-y-6">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {/* Saving overlay indicator */}
      {saving && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 rounded-lg shadow-md text-sm text-gray-600">
          <Loader2 className="w-4 h-4 animate-spin text-indigo-500" />
          Saving...
        </div>
      )}

      {/* ── Tab Bar ── */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        {tabs.map(t => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                activeTab === t.id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ══════════════════════════════════════════════════ */}
      {/* TAB 1 — Company Truth                            */}
      {/* ══════════════════════════════════════════════════ */}
      {activeTab === 'company-truth' && (
        <div className="space-y-6">
          {/* Company Info Card */}
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Company Information</h2>
                <p className="text-sm text-gray-500 mt-1">Core company details the AI uses for context in every interaction</p>
              </div>
              {!editingCompany ? (
                <button onClick={startCompanyEdit} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                  <Edit3 className="w-4 h-4" /> Edit
                </button>
              ) : (
                <div className="flex gap-2">
                  <button onClick={cancelCompanyEdit} className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
                    <X className="w-4 h-4" /> Cancel
                  </button>
                  <button onClick={saveCompanyInfo} disabled={saving} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50">
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Vision</label>
                {editingCompany ? (
                  <textarea value={companyDraft.vision} onChange={e => setCompanyDraft({ ...companyDraft, vision: e.target.value })} rows={3} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                ) : (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-4 py-3">{companyInfo?.vision || 'Not set'}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Mission</label>
                {editingCompany ? (
                  <textarea value={companyDraft.mission} onChange={e => setCompanyDraft({ ...companyDraft, mission: e.target.value })} rows={3} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                ) : (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-4 py-3">{companyInfo?.mission || 'Not set'}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Website URL</label>
                {editingCompany ? (
                  <div className="flex items-center gap-2">
                    <Globe className="w-4 h-4 text-gray-400" />
                    <input type="url" value={companyDraft.websiteUrl} onChange={e => setCompanyDraft({ ...companyDraft, websiteUrl: e.target.value })} className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-4 py-3">
                    <Globe className="w-4 h-4 text-indigo-500" />
                    {companyInfo?.websiteUrl ? (
                      <a href={companyInfo.websiteUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-indigo-600 hover:underline">{companyInfo.websiteUrl}</a>
                    ) : (
                      <span className="text-sm text-gray-400">Not set</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Documents Card */}
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Reference Documents</h2>
                <p className="text-sm text-gray-500 mt-1">Upload documents the AI will use as additional context (brand guides, playbooks, pricing sheets)</p>
              </div>
              <button className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                <Upload className="w-4 h-4" /> Upload Document
              </button>
            </div>

            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center mb-6 hover:border-indigo-400 transition-colors cursor-pointer">
              <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
              <p className="text-sm text-gray-600 font-medium">Drag and drop files here, or click to browse</p>
              <p className="text-xs text-gray-400 mt-1">PDF, DOCX, XLSX, TXT — Max 10MB per file</p>
            </div>

            {documents.length > 0 && (
              <div className="space-y-2">
                {documents.map(doc => (
                  <div key={doc.id} className="flex items-center justify-between px-4 py-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                    <div className="flex items-center gap-3">
                      <FileText className="w-5 h-5 text-indigo-500" />
                      <div>
                        <p className="text-sm font-medium text-gray-900">{doc.name}</p>
                        <p className="text-xs text-gray-400">{doc.type} · {(doc.sizeBytes / 1024).toFixed(0)} KB · Uploaded {new Date(doc.uploadedAt).toLocaleDateString()}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="p-1.5 text-gray-400 hover:text-indigo-600 rounded-md hover:bg-white transition-colors"><Eye className="w-4 h-4" /></button>
                      <button onClick={() => removeDocument(doc.id)} className="p-1.5 text-gray-400 hover:text-red-600 rounded-md hover:bg-white transition-colors"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {documents.length === 0 && (
              <div className="text-center py-8 text-gray-400">
                <FileText className="w-10 h-10 mx-auto mb-3 opacity-50" />
                <p className="text-sm font-medium">No documents uploaded yet</p>
                <p className="text-xs mt-1">Upload reference documents for the AI to use</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* TAB 2 — Products                                 */}
      {/* ══════════════════════════════════════════════════ */}
      {activeTab === 'products' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Products</h2>
                <p className="text-sm text-gray-500 mt-1">Manage your product catalog — the AI references these for pricing, descriptions, and recommendations</p>
              </div>
              {!showAddProduct && editingProduct === null && (
                <button onClick={() => { setShowAddProduct(true); setProductDraft({ name: '', category: '', price: '', description: '', sku: '' }); }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                  <Plus className="w-4 h-4" /> Add Product
                </button>
              )}
            </div>

            {(showAddProduct || editingProduct !== null) && (
              <div className="border border-indigo-200 bg-indigo-50/50 rounded-xl p-5 mb-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">{editingProduct !== null ? 'Edit Product' : 'New Product'}</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Product Name</label>
                    <input value={productDraft.name} onChange={e => setProductDraft({ ...productDraft, name: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" placeholder="e.g. Growth Suite Pro" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                    <input value={productDraft.category} onChange={e => setProductDraft({ ...productDraft, category: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" placeholder="e.g. SaaS Platform" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Price</label>
                    <input value={productDraft.price} onChange={e => setProductDraft({ ...productDraft, price: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" placeholder="e.g. $299/mo" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">SKU</label>
                    <input value={productDraft.sku} onChange={e => setProductDraft({ ...productDraft, sku: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" placeholder="e.g. GSP-001" />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
                    <textarea value={productDraft.description} onChange={e => setProductDraft({ ...productDraft, description: e.target.value })} rows={3} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" placeholder="Describe the product for the AI..." />
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <button onClick={cancelProductEdit} className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">Cancel</button>
                  <button onClick={saveProduct} disabled={!productDraft.name.trim() || saving} className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    <span className="flex items-center gap-2">
                      {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                      {editingProduct !== null ? 'Update' : 'Save'}
                    </span>
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-3">
              {products.map(p => (
                <div key={p.id} className={`border rounded-xl p-4 transition-colors ${editingProduct === p.id ? 'border-indigo-300 bg-indigo-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-1">
                        <h3 className="text-sm font-semibold text-gray-900">{p.name}</h3>
                        {p.category && <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{p.category}</span>}
                        {p.price && <span className="text-xs font-semibold text-indigo-600">{p.price}</span>}
                      </div>
                      {p.description && <p className="text-sm text-gray-500">{p.description}</p>}
                      {p.sku && <p className="text-xs text-gray-400 mt-1">SKU: {p.sku}</p>}
                    </div>
                    <div className="flex items-center gap-1 ml-4">
                      <button onClick={() => startEditProduct(p)} className="p-1.5 text-gray-400 hover:text-indigo-600 rounded-md hover:bg-gray-100 transition-colors"><Edit3 className="w-4 h-4" /></button>
                      <button onClick={() => deleteProduct(p.id)} className="p-1.5 text-gray-400 hover:text-red-600 rounded-md hover:bg-gray-100 transition-colors"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                </div>
              ))}
              {products.length === 0 && (
                <div className="text-center py-12 text-gray-400">
                  <Package className="w-10 h-10 mx-auto mb-3 opacity-50" />
                  <p className="text-sm font-medium">No products yet</p>
                  <p className="text-xs mt-1">Click &quot;Add Product&quot; to create your first product</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* TAB 3 — Warranties & Financing                   */}
      {/* ══════════════════════════════════════════════════ */}
      {activeTab === 'warranties' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Warranties & Financing</h2>
                <p className="text-sm text-gray-500 mt-1">Define guardrails for how the AI discusses warranty policies, refunds, and financing options</p>
              </div>
              {!editingWarranties ? (
                <button onClick={startWarrantiesEdit} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                  <Edit3 className="w-4 h-4" /> Edit
                </button>
              ) : (
                <div className="flex gap-2">
                  <button onClick={cancelWarrantiesEdit} className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
                    <X className="w-4 h-4" /> Cancel
                  </button>
                  <button onClick={saveWarranties} disabled={saving} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50">
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Warranty Policy</label>
                {editingWarranties ? (
                  <textarea value={warrantyDraft.content} onChange={e => setWarrantyDraft({ ...warrantyDraft, content: e.target.value })} rows={4} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                ) : (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-4 py-3">{warranties[0]?.content || 'Not set — click Edit to define your warranty policy'}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Financing Terms</label>
                {editingWarranties ? (
                  <textarea value={financingDraft.content} onChange={e => setFinancingDraft({ ...financingDraft, content: e.target.value })} rows={4} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                ) : (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-4 py-3">{financing[0]?.content || 'Not set — click Edit to define your financing terms'}</p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">AI Guardrail Rules</label>
                <p className="text-xs text-gray-400 mb-3">The AI will strictly follow these rules when discussing warranties and financing</p>

                <div className="space-y-2">
                  {rules.map(rule => (
                    <div key={rule.id} className="flex items-center gap-3 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                      <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                      <span className="text-sm text-gray-700 flex-1">{rule.content}</span>
                      {editingWarranties && (
                        <button onClick={() => removeRule(rule.id)} className="p-1 text-gray-400 hover:text-red-500 transition-colors"><X className="w-4 h-4" /></button>
                      )}
                    </div>
                  ))}
                </div>

                {editingWarranties && (
                  <div className="flex gap-2 mt-3">
                    <input value={newRule} onChange={e => setNewRule(e.target.value)} onKeyDown={e => e.key === 'Enter' && addRule()} placeholder="Add a new guardrail rule..." className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                    <button onClick={addRule} disabled={!newRule.trim() || saving} className="px-4 py-2 bg-amber-500 text-white text-sm font-medium rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                      <Plus className="w-4 h-4" />
                    </button>
                  </div>
                )}

                {rules.length === 0 && !editingWarranties && (
                  <div className="text-center py-6 text-gray-400">
                    <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No guardrail rules defined yet</p>
                    <p className="text-xs mt-1">Click Edit to add rules the AI must follow</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* TAB 4 — FAQ                                      */}
      {/* ══════════════════════════════════════════════════ */}
      {activeTab === 'faq' && (
        <div className="space-y-6">
          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Frequently Asked Questions</h2>
                <p className="text-sm text-gray-500 mt-1">Provide Q&A pairs the AI uses to answer customer questions accurately</p>
              </div>
              {!showAddFaq && editingFaq === null && (
                <button onClick={() => { setShowAddFaq(true); setFaqDraft({ question: '', answer: '' }); }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                  <Plus className="w-4 h-4" /> Add FAQ
                </button>
              )}
            </div>

            {(showAddFaq || editingFaq !== null) && (
              <div className="border border-indigo-200 bg-indigo-50/50 rounded-xl p-5 mb-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">{editingFaq !== null ? 'Edit FAQ' : 'New FAQ'}</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Question</label>
                    <input value={faqDraft.question} onChange={e => setFaqDraft({ ...faqDraft, question: e.target.value })} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" placeholder="e.g. What is the difference between plans?" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Answer</label>
                    <textarea value={faqDraft.answer} onChange={e => setFaqDraft({ ...faqDraft, answer: e.target.value })} rows={4} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" placeholder="Provide the answer the AI should give..." />
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <button onClick={cancelFaqEdit} className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">Cancel</button>
                  <button onClick={saveFaq} disabled={!faqDraft.question.trim() || !faqDraft.answer.trim() || saving} className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    <span className="flex items-center gap-2">
                      {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                      {editingFaq !== null ? 'Update' : 'Save'}
                    </span>
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {faqs.map(f => (
                <div key={f.id} className="border border-gray-200 rounded-xl overflow-hidden transition-colors hover:border-gray-300">
                  <div className="flex items-center justify-between px-4 py-3 cursor-pointer" onClick={() => setExpandedFaq(expandedFaq === f.id ? null : f.id)}>
                    <div className="flex items-center gap-3 flex-1">
                      {expandedFaq === f.id ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                      <span className="text-sm font-medium text-gray-900">{f.question}</span>
                    </div>
                    <div className="flex items-center gap-1 ml-4" onClick={e => e.stopPropagation()}>
                      <button onClick={() => startEditFaq(f)} className="p-1.5 text-gray-400 hover:text-indigo-600 rounded-md hover:bg-gray-100 transition-colors"><Edit3 className="w-4 h-4" /></button>
                      <button onClick={() => deleteFaq(f.id)} className="p-1.5 text-gray-400 hover:text-red-600 rounded-md hover:bg-gray-100 transition-colors"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                  {expandedFaq === f.id && (
                    <div className="px-4 pb-4 pt-0 ml-7">
                      <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-4 py-3">{f.answer}</p>
                    </div>
                  )}
                </div>
              ))}
              {faqs.length === 0 && (
                <div className="text-center py-12 text-gray-400">
                  <HelpCircle className="w-10 h-10 mx-auto mb-3 opacity-50" />
                  <p className="text-sm font-medium">No FAQs yet</p>
                  <p className="text-xs mt-1">Click &quot;Add FAQ&quot; to create your first question and answer</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════ */}
      {/* TAB 5 — Sales Objections                         */}
      {/* ══════════════════════════════════════════════════ */}
      {activeTab === 'objections' && (
        <div className="space-y-6">

          {/* Summary Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total Objections</p>
              <p className="text-2xl font-bold text-gray-900 mt-1">{objections.length}</p>
              <p className="text-xs text-gray-400 mt-1">{objections.filter(o => o.status === 'new').length} new this month</p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Avg Win Rate</p>
              <p className="text-2xl font-bold text-emerald-600 mt-1">{Math.round(objections.reduce((sum, o) => sum + o.winRate, 0) / objections.length)}%</p>
              <p className="text-xs text-gray-400 mt-1">when objection is addressed</p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Most Common</p>
              <p className="text-2xl font-bold text-red-600 mt-1"><Flame className="w-5 h-5 inline" /> Pricing</p>
              <p className="text-xs text-gray-400 mt-1">{objections.filter(o => o.category === 'pricing').reduce((s, o) => s + o.occurrences, 0)} occurrences</p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total Mentions</p>
              <p className="text-2xl font-bold text-gray-900 mt-1">{objections.reduce((sum, o) => sum + o.occurrences, 0)}</p>
              <p className="text-xs text-gray-400 mt-1">across all conversations</p>
            </div>
          </div>

          {/* Filters & Search */}
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex flex-col md:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  value={objectionSearch}
                  onChange={e => setObjectionSearch(e.target.value)}
                  placeholder="Search objections and responses..."
                  className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                />
              </div>
              <div className="flex gap-2">
                <div className="flex items-center gap-2">
                  <Filter className="w-4 h-4 text-gray-400" />
                  <select
                    value={objectionCategoryFilter}
                    onChange={e => setObjectionCategoryFilter(e.target.value as ObjectionCategory | 'all')}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
                  >
                    <option value="all">All Categories</option>
                    {OBJECTION_CATEGORIES.map(c => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </div>
                <select
                  value={objectionStatusFilter}
                  onChange={e => setObjectionStatusFilter(e.target.value as ObjectionStatus | 'all')}
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white"
                >
                  <option value="all">All Statuses</option>
                  <option value="active">Active</option>
                  <option value="new">New</option>
                  <option value="resolved">Resolved</option>
                </select>
              </div>
            </div>
          </div>

          {/* Objections List */}
          <div className="space-y-3">
            {filteredObjections.sort((a, b) => b.occurrences - a.occurrences).map(obj => (
              <div key={obj.id} className={`bg-white border rounded-xl overflow-hidden transition-all ${expandedObjection === obj.id ? 'border-indigo-300 shadow-md' : 'border-gray-200 hover:border-gray-300'}`}>
                {/* Collapsed Header */}
                <div
                  className="flex items-center gap-4 px-5 py-4 cursor-pointer"
                  onClick={() => setExpandedObjection(expandedObjection === obj.id ? null : obj.id)}
                >
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {expandedObjection === obj.id ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">&quot;{obj.objection}&quot;</p>
                    <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getCategoryStyle(obj.category)}`}>
                        {getCategoryLabel(obj.category)}
                      </span>
                      {getTrendIcon(obj.trend)}
                      <span className="text-xs text-gray-400 flex items-center gap-1">
                        <MessageSquareWarning className="w-3 h-3" /> {obj.occurrences} mentions
                      </span>
                      <span className="text-xs text-gray-400 flex items-center gap-1">
                        <Clock className="w-3 h-3" /> Last: {new Date(obj.lastSeen).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 flex-shrink-0">
                    <div className="text-right">
                      <p className="text-xs text-gray-500">Win Rate</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${obj.winRate >= 70 ? 'bg-emerald-500' : obj.winRate >= 50 ? 'bg-amber-500' : 'bg-red-500'}`}
                            style={{ width: `${obj.winRate}%` }}
                          />
                        </div>
                        <span className={`text-xs font-semibold ${obj.winRate >= 70 ? 'text-emerald-600' : obj.winRate >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                          {obj.winRate}%
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Expanded Battle Card */}
                {expandedObjection === obj.id && (
                  <div className="border-t border-gray-100 px-5 py-5 space-y-5 bg-gray-50/50">

                    {/* AI Recommended Response */}
                    <div className={`bg-white border rounded-xl p-5 ${obj.editedFields?.recommendedResponse ? 'border-amber-200' : 'border-indigo-200'}`}>
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <Sparkles className="w-4 h-4 text-indigo-500" />
                          <h4 className="text-sm font-semibold text-gray-900">AI Recommended Response</h4>
                          {obj.editedFields?.recommendedResponse ? (
                            <span className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                              <UserCheck className="w-3 h-3" /> Edited by {obj.editedFields.recommendedResponse.editedBy}
                            </span>
                          ) : (
                            <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">Auto-generated</span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {obj.editedFields?.recommendedResponse && (
                            <button
                              onClick={(e) => { e.stopPropagation(); revertToAI(obj.id, 'recommendedResponse'); }}
                              className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                              title="Revert to AI recommendation"
                            >
                              <RotateCcw className="w-3 h-3" /> Revert
                            </button>
                          )}
                          {editingObjField?.objId === obj.id && editingObjField.field === 'recommendedResponse' ? (
                            <div className="flex items-center gap-1">
                              <button onClick={(e) => { e.stopPropagation(); saveEditedField(); }} className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 transition-colors">
                                <Save className="w-3 h-3" /> Save
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); cancelEditingField(); }} className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-gray-500 hover:bg-gray-100 transition-colors">
                                <X className="w-3 h-3" /> Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); startEditingField(obj.id, 'recommendedResponse', obj.recommendedResponse); }}
                              className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                            >
                              <Pencil className="w-3 h-3" /> Edit
                            </button>
                          )}
                        </div>
                      </div>
                      {editingObjField?.objId === obj.id && editingObjField.field === 'recommendedResponse' ? (
                        <textarea
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          rows={5}
                          className="w-full text-sm text-gray-700 leading-relaxed border border-gray-300 rounded-lg p-3 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none resize-y"
                          placeholder="Edit the recommended response..."
                        />
                      ) : (
                        <p className="text-sm text-gray-700 leading-relaxed">{obj.recommendedResponse}</p>
                      )}
                    </div>

                    {/* Talk Track */}
                    <div className={`bg-white border rounded-xl p-5 ${obj.editedFields?.talkTrack ? 'border-amber-200' : 'border-gray-200'}`}>
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <Target className="w-4 h-4 text-amber-500" />
                          <h4 className="text-sm font-semibold text-gray-900">Talk Track</h4>
                          {obj.editedFields?.talkTrack && (
                            <span className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                              <UserCheck className="w-3 h-3" /> Edited by {obj.editedFields.talkTrack.editedBy}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {obj.editedFields?.talkTrack && (
                            <button
                              onClick={(e) => { e.stopPropagation(); revertToAI(obj.id, 'talkTrack'); }}
                              className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                              title="Revert to AI recommendation"
                            >
                              <RotateCcw className="w-3 h-3" /> Revert
                            </button>
                          )}
                          {editingObjField?.objId === obj.id && editingObjField.field === 'talkTrack' ? (
                            <div className="flex items-center gap-1">
                              <button onClick={(e) => { e.stopPropagation(); saveEditedField(); }} className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 transition-colors">
                                <Save className="w-3 h-3" /> Save
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); cancelEditingField(); }} className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-gray-500 hover:bg-gray-100 transition-colors">
                                <X className="w-3 h-3" /> Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); startEditingField(obj.id, 'talkTrack', obj.talkTrack); }}
                              className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                            >
                              <Pencil className="w-3 h-3" /> Edit
                            </button>
                          )}
                        </div>
                      </div>
                      {editingObjField?.objId === obj.id && editingObjField.field === 'talkTrack' ? (
                        <textarea
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          rows={5}
                          className="w-full text-sm text-gray-600 leading-relaxed border border-gray-300 rounded-lg p-3 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none resize-y"
                          placeholder="Edit the talk track..."
                        />
                      ) : (
                        <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-line">{obj.talkTrack}</p>
                      )}
                    </div>

                    {/* Competitive Differentiators */}
                    <div className={`bg-white border rounded-xl p-5 ${obj.editedFields?.differentiators ? 'border-amber-200' : 'border-gray-200'}`}>
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <Swords className="w-4 h-4 text-red-500" />
                          <h4 className="text-sm font-semibold text-gray-900">Key Differentiators</h4>
                          {obj.editedFields?.differentiators && (
                            <span className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                              <UserCheck className="w-3 h-3" /> Edited by {obj.editedFields.differentiators.editedBy}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {obj.editedFields?.differentiators && (
                            <button
                              onClick={(e) => { e.stopPropagation(); revertToAI(obj.id, 'differentiators'); }}
                              className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                              title="Revert to AI recommendation"
                            >
                              <RotateCcw className="w-3 h-3" /> Revert
                            </button>
                          )}
                          {editingObjField?.objId === obj.id && editingObjField.field === 'differentiators' ? (
                            <div className="flex items-center gap-1">
                              <button onClick={(e) => { e.stopPropagation(); saveEditedField(); }} className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-emerald-600 text-white hover:bg-emerald-700 transition-colors">
                                <Save className="w-3 h-3" /> Save
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); cancelEditingField(); }} className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-gray-500 hover:bg-gray-100 transition-colors">
                                <X className="w-3 h-3" /> Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); startEditingField(obj.id, 'differentiators', obj.differentiators); }}
                              className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
                            >
                              <Pencil className="w-3 h-3" /> Edit
                            </button>
                          )}
                        </div>
                      </div>
                      {editingObjField?.objId === obj.id && editingObjField.field === 'differentiators' ? (
                        <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                          {editDraftDiffs.map((d, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                              <input
                                type="text"
                                value={d}
                                onChange={(e) => {
                                  const updated = [...editDraftDiffs];
                                  updated[i] = e.target.value;
                                  setEditDraftDiffs(updated);
                                }}
                                className="flex-1 text-sm text-gray-700 border border-gray-300 rounded-lg px-3 py-1.5 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                              />
                              <button
                                onClick={() => setEditDraftDiffs(editDraftDiffs.filter((_, idx) => idx !== i))}
                                className="p-1 text-gray-400 hover:text-red-500 transition-colors"
                                title="Remove differentiator"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                          <button
                            onClick={() => setEditDraftDiffs([...editDraftDiffs, ''])}
                            className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 mt-1"
                          >
                            <Plus className="w-3 h-3" /> Add differentiator
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {obj.differentiators.map((d, i) => (
                            <div key={i} className="flex items-start gap-2">
                              <CheckCircle className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                              <p className="text-sm text-gray-700">{d}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Supporting Evidence / Sources */}
                    <div className="bg-white border border-gray-200 rounded-xl p-5">
                      <div className="flex items-center gap-2 mb-3">
                        <BookOpen className="w-4 h-4 text-purple-500" />
                        <h4 className="text-sm font-semibold text-gray-900">Supporting Evidence</h4>
                        <span className="text-xs text-gray-400">{obj.sources.length} sources</span>
                      </div>
                      <div className="space-y-3">
                        {obj.sources.map((src, i) => (
                          <div key={i} className={`border rounded-lg p-3 ${src.type === 'competitive' ? 'border-red-100 bg-red-50/30' : 'border-indigo-100 bg-indigo-50/30'}`}>
                            <div className="flex items-center gap-2 mb-1">
                              {src.type === 'competitive' ? (
                                <Swords className="w-3.5 h-3.5 text-red-500" />
                              ) : (
                                <BookOpen className="w-3.5 h-3.5 text-indigo-500" />
                              )}
                              <span className="text-xs font-semibold text-gray-700">{src.title}</span>
                              <span className={`text-xs px-1.5 py-0.5 rounded ${src.type === 'competitive' ? 'bg-red-100 text-red-600' : 'bg-indigo-100 text-indigo-600'}`}>
                                {src.type === 'competitive' ? 'Competitive Set' : 'Knowledge Center'}
                              </span>
                            </div>
                            <p className="text-xs text-gray-600 leading-relaxed">{src.excerpt}</p>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Meta Info */}
                    <div className="flex items-center justify-between text-xs text-gray-400 pt-2">
                      <div className="flex items-center gap-4">
                        <span>First seen: {new Date(obj.firstSeen).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
                        <span>Last seen: {new Date(obj.lastSeen).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
                        <span>{obj.occurrences} total occurrences</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button className="flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100 transition-colors text-gray-500 hover:text-emerald-600">
                          <ThumbsUp className="w-3.5 h-3.5" /> Helpful
                        </button>
                        <button className="flex items-center gap-1 px-2 py-1 rounded hover:bg-gray-100 transition-colors text-gray-500 hover:text-red-600">
                          <ThumbsDown className="w-3.5 h-3.5" /> Improve
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {filteredObjections.length === 0 && (
              <div className="bg-white border border-gray-200 rounded-xl p-12 text-center text-gray-400">
                <MessageSquareWarning className="w-10 h-10 mx-auto mb-3 opacity-50" />
                <p className="text-sm font-medium">No objections match your filters</p>
                <p className="text-xs mt-1">Try adjusting your search or filter criteria</p>
              </div>
            )}
          </div>

          {/* AI Learning Note */}
          <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 flex items-start gap-3">
            <Sparkles className="w-5 h-5 text-indigo-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-indigo-900">AI-Powered Objection Intelligence</p>
              <p className="text-xs text-indigo-700 mt-1">
                Objections are automatically captured from lead conversations and enriched with responses from your Knowledge Center and Competitive Set.
                The AI continuously learns which responses win deals and adjusts recommendations accordingly. Occurrence weights and trends update in real-time.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
