'use client';

import {
  Building2, Package, Shield, HelpCircle, Plus, Edit3, Trash2,
  Save, X, Upload, FileText, Globe, Eye, ChevronDown, ChevronRight,
  AlertTriangle, CheckCircle
} from 'lucide-react';
import { useState } from 'react';

/* ── Types ───────────────────────────────────────────── */

interface Product {
  id: number;
  name: string;
  category: string;
  price: string;
  description: string;
  sku: string;
}

interface FAQ {
  id: number;
  question: string;
  answer: string;
}

interface Document {
  id: number;
  name: string;
  type: string;
  size: string;
  uploadedAt: string;
}

/* ── Mock Data ───────────────────────────────────────── */

const initialCompanyInfo = {
  vision: 'To empower every business with AI-driven revenue intelligence that thinks, acts, and learns autonomously.',
  mission: 'We build the AI Revenue System that eliminates guesswork from sales, marketing, and customer success — so teams can focus on what matters.',
  websiteUrl: 'https://www.axisone.io',
};

const initialDocuments: Document[] = [
  { id: 1, name: 'Brand Guidelines 2025.pdf', type: 'PDF', size: '2.4 MB', uploadedAt: 'Apr 10, 2025' },
  { id: 2, name: 'Product Pricing Sheet.xlsx', type: 'Excel', size: '340 KB', uploadedAt: 'Apr 8, 2025' },
  { id: 3, name: 'Sales Playbook v3.docx', type: 'Word', size: '1.1 MB', uploadedAt: 'Mar 28, 2025' },
];

const initialProducts: Product[] = [
  { id: 1, name: 'Growth Suite Pro', category: 'SaaS Platform', price: '$299/mo', description: 'Full AI revenue automation with all channels, unlimited contacts, and advanced analytics.', sku: 'GSP-001' },
  { id: 2, name: 'Growth Starter', category: 'SaaS Platform', price: '$99/mo', description: 'Essential AI revenue tools for small teams. Up to 1,000 contacts, 3 channels.', sku: 'GS-001' },
  { id: 3, name: 'Blueprint Add-on: SaaS', category: 'Blueprint', price: '$49/mo', description: 'Industry intelligence pack for SaaS companies with tailored strategies and benchmarks.', sku: 'BP-SAAS-001' },
  { id: 4, name: 'Enterprise Custom', category: 'Custom Plan', price: 'Custom', description: 'White-glove setup with dedicated AI tuning, custom integrations, and SLA.', sku: 'ENT-001' },
];

const initialWarranties = {
  warrantyPolicy: 'All SaaS subscriptions include a 30-day money-back guarantee. No questions asked. Enterprise plans include a 90-day satisfaction guarantee with dedicated support. Hardware add-ons carry a standard 1-year limited warranty.',
  financingTerms: 'Annual plans receive a 20% discount vs monthly billing. Enterprise clients may request net-30 or net-60 payment terms with approved credit. We do not offer financing through third-party lenders. All pricing is in USD.',
  rules: [
    'Never promise warranty extensions without manager approval',
    'Do not offer financing terms below net-30 without VP sign-off',
    'Always disclose the 30-day money-back guarantee on first contact',
    'Refund requests after 30 days require case-by-case review',
    'Enterprise SLA terms must reference the signed contract',
  ],
};

const initialFAQs: FAQ[] = [
  { id: 1, question: 'What is the difference between Growth Starter and Growth Suite Pro?', answer: 'Growth Starter includes up to 1,000 contacts and 3 channels, while Growth Suite Pro offers unlimited contacts, all channels, and advanced analytics including AI strategy optimization.' },
  { id: 2, question: 'How does the AI make decisions?', answer: 'The AI uses a 5-phase loop: Ingest data → Understand via the Business Brain → Decide the best action → Execute autonomously → Learn from outcomes. Every decision is logged in the Audit Trail for full transparency.' },
  { id: 3, question: 'Is there a free trial?', answer: 'Yes, we offer a 14-day free trial on all plans. No credit card required. You get full access to all features during the trial period.' },
  { id: 4, question: 'Can I cancel anytime?', answer: 'Yes. Monthly plans can be cancelled at any time with no penalty. Annual plans can be cancelled and will remain active until the end of the billing period. We offer a 30-day money-back guarantee.' },
  { id: 5, question: 'How does data security work?', answer: 'All data is encrypted at rest and in transit. We use Google Cloud Platform with SOC 2 compliance. Each tenant\'s data is fully isolated. We never share or sell customer data.' },
];

/* ── Tabs Config ──────────────────────────────────────── */

const tabs = [
  { id: 'company-truth', label: 'Company Truth', icon: Building2 },
  { id: 'products', label: 'Products', icon: Package },
  { id: 'warranties', label: 'Warranties & Financing', icon: Shield },
  { id: 'faq', label: 'FAQ', icon: HelpCircle },
];

/* ── Main Component ──────────────────────────────────── */

export default function KnowledgeCenterPage() {
  const [activeTab, setActiveTab] = useState('company-truth');

  // Company Truth state
  const [companyInfo, setCompanyInfo] = useState(initialCompanyInfo);
  const [editingCompany, setEditingCompany] = useState(false);
  const [companyDraft, setCompanyDraft] = useState(initialCompanyInfo);
  const [documents, setDocuments] = useState(initialDocuments);

  // Products state
  const [products, setProducts] = useState(initialProducts);
  const [editingProduct, setEditingProduct] = useState<number | null>(null);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [productDraft, setProductDraft] = useState<Product>({ id: 0, name: '', category: '', price: '', description: '', sku: '' });

  // Warranties state
  const [warranties, setWarranties] = useState(initialWarranties);
  const [editingWarranties, setEditingWarranties] = useState(false);
  const [warrantiesDraft, setWarrantiesDraft] = useState(initialWarranties);
  const [newRule, setNewRule] = useState('');

  // FAQ state
  const [faqs, setFaqs] = useState(initialFAQs);
  const [editingFaq, setEditingFaq] = useState<number | null>(null);
  const [showAddFaq, setShowAddFaq] = useState(false);
  const [faqDraft, setFaqDraft] = useState<FAQ>({ id: 0, question: '', answer: '' });
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);

  /* ── Company Truth Handlers ── */
  const saveCompanyInfo = () => {
    setCompanyInfo(companyDraft);
    setEditingCompany(false);
  };
  const cancelCompanyEdit = () => {
    setCompanyDraft(companyInfo);
    setEditingCompany(false);
  };
  const removeDocument = (id: number) => {
    setDocuments(documents.filter(d => d.id !== id));
  };

  /* ── Product Handlers ── */
  const saveProduct = () => {
    if (editingProduct !== null) {
      setProducts(products.map(p => p.id === editingProduct ? { ...productDraft, id: editingProduct } : p));
      setEditingProduct(null);
    } else {
      const newId = Math.max(...products.map(p => p.id), 0) + 1;
      setProducts([...products, { ...productDraft, id: newId }]);
      setShowAddProduct(false);
    }
    setProductDraft({ id: 0, name: '', category: '', price: '', description: '', sku: '' });
  };
  const startEditProduct = (p: Product) => {
    setProductDraft(p);
    setEditingProduct(p.id);
    setShowAddProduct(false);
  };
  const deleteProduct = (id: number) => {
    setProducts(products.filter(p => p.id !== id));
    if (editingProduct === id) { setEditingProduct(null); setProductDraft({ id: 0, name: '', category: '', price: '', description: '', sku: '' }); }
  };
  const cancelProductEdit = () => {
    setEditingProduct(null);
    setShowAddProduct(false);
    setProductDraft({ id: 0, name: '', category: '', price: '', description: '', sku: '' });
  };

  /* ── Warranties Handlers ── */
  const saveWarranties = () => {
    setWarranties(warrantiesDraft);
    setEditingWarranties(false);
  };
  const cancelWarrantiesEdit = () => {
    setWarrantiesDraft(warranties);
    setEditingWarranties(false);
    setNewRule('');
  };
  const addRule = () => {
    if (newRule.trim()) {
      setWarrantiesDraft({ ...warrantiesDraft, rules: [...warrantiesDraft.rules, newRule.trim()] });
      setNewRule('');
    }
  };
  const removeRule = (index: number) => {
    setWarrantiesDraft({ ...warrantiesDraft, rules: warrantiesDraft.rules.filter((_, i) => i !== index) });
  };

  /* ── FAQ Handlers ── */
  const saveFaq = () => {
    if (editingFaq !== null) {
      setFaqs(faqs.map(f => f.id === editingFaq ? { ...faqDraft, id: editingFaq } : f));
      setEditingFaq(null);
    } else {
      const newId = Math.max(...faqs.map(f => f.id), 0) + 1;
      setFaqs([...faqs, { ...faqDraft, id: newId }]);
      setShowAddFaq(false);
    }
    setFaqDraft({ id: 0, question: '', answer: '' });
  };
  const startEditFaq = (f: FAQ) => {
    setFaqDraft(f);
    setEditingFaq(f.id);
    setShowAddFaq(false);
  };
  const deleteFaq = (id: number) => {
    setFaqs(faqs.filter(f => f.id !== id));
    if (editingFaq === id) { setEditingFaq(null); setFaqDraft({ id: 0, question: '', answer: '' }); }
  };
  const cancelFaqEdit = () => {
    setEditingFaq(null);
    setShowAddFaq(false);
    setFaqDraft({ id: 0, question: '', answer: '' });
  };

  /* ── Render ── */
  return (
    <div className="p-6 space-y-6">

      {/* ── Tab Bar (Pipelines style) ── */}
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
                <button onClick={() => { setCompanyDraft(companyInfo); setEditingCompany(true); }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                  <Edit3 className="w-4 h-4" /> Edit
                </button>
              ) : (
                <div className="flex gap-2">
                  <button onClick={cancelCompanyEdit} className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
                    <X className="w-4 h-4" /> Cancel
                  </button>
                  <button onClick={saveCompanyInfo} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                    <Save className="w-4 h-4" /> Save
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-5">
              {/* Vision */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Vision</label>
                {editingCompany ? (
                  <textarea value={companyDraft.vision} onChange={e => setCompanyDraft({ ...companyDraft, vision: e.target.value })} rows={3} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                ) : (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-4 py-3">{companyInfo.vision}</p>
                )}
              </div>
              {/* Mission */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Mission</label>
                {editingCompany ? (
                  <textarea value={companyDraft.mission} onChange={e => setCompanyDraft({ ...companyDraft, mission: e.target.value })} rows={3} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                ) : (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-4 py-3">{companyInfo.mission}</p>
                )}
              </div>
              {/* Website URL */}
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
                    <a href={companyInfo.websiteUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-indigo-600 hover:underline">{companyInfo.websiteUrl}</a>
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

            {/* Upload Drop Zone */}
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center mb-6 hover:border-indigo-400 transition-colors cursor-pointer">
              <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
              <p className="text-sm text-gray-600 font-medium">Drag and drop files here, or click to browse</p>
              <p className="text-xs text-gray-400 mt-1">PDF, DOCX, XLSX, TXT — Max 10MB per file</p>
            </div>

            {/* Document List */}
            {documents.length > 0 && (
              <div className="space-y-2">
                {documents.map(doc => (
                  <div key={doc.id} className="flex items-center justify-between px-4 py-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors">
                    <div className="flex items-center gap-3">
                      <FileText className="w-5 h-5 text-indigo-500" />
                      <div>
                        <p className="text-sm font-medium text-gray-900">{doc.name}</p>
                        <p className="text-xs text-gray-400">{doc.type} · {doc.size} · Uploaded {doc.uploadedAt}</p>
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
                <button onClick={() => { setShowAddProduct(true); setProductDraft({ id: 0, name: '', category: '', price: '', description: '', sku: '' }); }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                  <Plus className="w-4 h-4" /> Add Product
                </button>
              )}
            </div>

            {/* Add / Edit Product Form */}
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
                  <button onClick={saveProduct} disabled={!productDraft.name.trim()} className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    <span className="flex items-center gap-2"><Save className="w-4 h-4" /> {editingProduct !== null ? 'Update' : 'Save'}</span>
                  </button>
                </div>
              </div>
            )}

            {/* Product List */}
            <div className="space-y-3">
              {products.map(p => (
                <div key={p.id} className={`border rounded-xl p-4 transition-colors ${editingProduct === p.id ? 'border-indigo-300 bg-indigo-50/30' : 'border-gray-200 hover:border-gray-300'}`}>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-1">
                        <h3 className="text-sm font-semibold text-gray-900">{p.name}</h3>
                        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{p.category}</span>
                        <span className="text-xs font-semibold text-indigo-600">{p.price}</span>
                      </div>
                      <p className="text-sm text-gray-500">{p.description}</p>
                      <p className="text-xs text-gray-400 mt-1">SKU: {p.sku}</p>
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
                  <p className="text-xs mt-1">Click "Add Product" to create your first product</p>
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
                <button onClick={() => { setWarrantiesDraft(warranties); setEditingWarranties(true); }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                  <Edit3 className="w-4 h-4" /> Edit
                </button>
              ) : (
                <div className="flex gap-2">
                  <button onClick={cancelWarrantiesEdit} className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors">
                    <X className="w-4 h-4" /> Cancel
                  </button>
                  <button onClick={saveWarranties} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                    <Save className="w-4 h-4" /> Save
                  </button>
                </div>
              )}
            </div>

            <div className="space-y-6">
              {/* Warranty Policy */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Warranty Policy</label>
                {editingWarranties ? (
                  <textarea value={warrantiesDraft.warrantyPolicy} onChange={e => setWarrantiesDraft({ ...warrantiesDraft, warrantyPolicy: e.target.value })} rows={4} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                ) : (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-4 py-3">{warranties.warrantyPolicy}</p>
                )}
              </div>

              {/* Financing Terms */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Financing Terms</label>
                {editingWarranties ? (
                  <textarea value={warrantiesDraft.financingTerms} onChange={e => setWarrantiesDraft({ ...warrantiesDraft, financingTerms: e.target.value })} rows={4} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                ) : (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-lg px-4 py-3">{warranties.financingTerms}</p>
                )}
              </div>

              {/* AI Guardrail Rules */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">AI Guardrail Rules</label>
                <p className="text-xs text-gray-400 mb-3">The AI will strictly follow these rules when discussing warranties and financing</p>

                <div className="space-y-2">
                  {(editingWarranties ? warrantiesDraft.rules : warranties.rules).map((rule, i) => (
                    <div key={i} className="flex items-center gap-3 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                      <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                      <span className="text-sm text-gray-700 flex-1">{rule}</span>
                      {editingWarranties && (
                        <button onClick={() => removeRule(i)} className="p-1 text-gray-400 hover:text-red-500 transition-colors"><X className="w-4 h-4" /></button>
                      )}
                    </div>
                  ))}
                </div>

                {editingWarranties && (
                  <div className="flex gap-2 mt-3">
                    <input value={newRule} onChange={e => setNewRule(e.target.value)} onKeyDown={e => e.key === 'Enter' && addRule()} placeholder="Add a new guardrail rule..." className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none" />
                    <button onClick={addRule} disabled={!newRule.trim()} className="px-4 py-2 bg-amber-500 text-white text-sm font-medium rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                      <Plus className="w-4 h-4" />
                    </button>
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
                <button onClick={() => { setShowAddFaq(true); setFaqDraft({ id: 0, question: '', answer: '' }); }} className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors">
                  <Plus className="w-4 h-4" /> Add FAQ
                </button>
              )}
            </div>

            {/* Add / Edit FAQ Form */}
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
                  <button onClick={saveFaq} disabled={!faqDraft.question.trim() || !faqDraft.answer.trim()} className="px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                    <span className="flex items-center gap-2"><Save className="w-4 h-4" /> {editingFaq !== null ? 'Update' : 'Save'}</span>
                  </button>
                </div>
              </div>
            )}

            {/* FAQ Accordion List */}
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
                  <p className="text-xs mt-1">Click "Add FAQ" to create your first question and answer</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
